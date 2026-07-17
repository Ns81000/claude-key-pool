import { NextRequest, NextResponse } from 'next/server';
import {
  loadConfig,
  markInvalid,
  markLimited,
  markProviderError,
  markKeySlow,
  incrementInFlight,
  decrementInFlight,
  getKeyState,
} from '@/lib/config';
import {
  CONNECT_TIMEOUT_MS,
  buildResponseHeaders,
  buildUpstreamHeaders,
  classifyErrorPayload,
  classifyInvalidPayload,
  computeCooldownUntil,
  limitKeyFromHeaders,
  peekStreamForLimit,
  getNextCandidate,
  buildFlatPool,
} from '@/lib/proxy';
import {
  proxyLog,
  logRequestStart,
  logKeySelected,
  logRequestComplete,
  logRotation,
  logExhausted,
  logSeparator,
  nextRequestId,
} from '@/lib/logger';

export const dynamic = 'force-dynamic';

function errorJson(type: string, message: string, status: number) {
  return NextResponse.json({ error: { type, message } }, { status });
}

export async function POST(req: NextRequest) {
  const config = loadConfig();
  const reqId = nextRequestId();
  const startTime = Date.now();

  if (config.groups.length === 0) {
    proxyLog('ERROR', undefined, `#${reqId} No groups or keys configured`);
    return errorJson(
      'invalid_request_error',
      'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.',
      400,
    );
  }

  // Read the raw body once. We must inspect `stream`, so parse a copy but forward
  // the original bytes to avoid re-serializing large payloads.
  const rawBody = await req.arrayBuffer();
  let isStream = false;
  let model = 'unknown';
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody));
    isStream = parsed?.stream === true;
    model = parsed?.model || 'unknown';
  } catch {
    return errorJson('invalid_request_error', 'Failed to parse request JSON.', 400);
  }

  logSeparator();
  logRequestStart(reqId, 'POST', `/v1/messages`, isStream);
  proxyLog('INFO', undefined, `#${reqId} Model: ${model}`);

  let totalCandidatesTried = 0;
  let totalTransientFailures = 0;

  const flatPoolSize = buildFlatPool(config).length;

  while (totalCandidatesTried < flatPoolSize) {
    const candidate = getNextCandidate(config);
    if (!candidate) {
      break;
    }

    const { group, key } = candidate;

    if (!group.targetUrl) {
      logRotation(reqId, key.email, `Group "${group.name}" has no target URL → marking all keys invalid`);
      group.keys.forEach(k => markInvalid(k.id));
      continue;
    }

    const targetUrl = `${group.targetUrl.replace(/\/$/, '')}/v1/messages`;

    totalCandidatesTried++;
    incrementInFlight(key.id);

    const keyState = getKeyState(key.id);
    logKeySelected(reqId, key.email, group.name, keyState.inFlight);

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: buildUpstreamHeaders(req.headers, key.key),
        body: rawBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      decrementInFlight(key.id);

      if (req.signal.aborted) {
        proxyLog('WARN', key.email, `#${reqId} Client aborted request`);
        return new Response('Client aborted', { status: 499 });
      }

      const isTimeout = err && (err as any).name === 'AbortError';
      if (isTimeout) {
        markProviderError(key.id);
        markKeySlow(key.id);
        logRotation(reqId, key.email, `Connection timed out (${CONNECT_TIMEOUT_MS / 1000}s) → marked slow`);
      } else {
        markProviderError(key.id);
        logRotation(reqId, key.email, `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      totalTransientFailures++;
      continue;
    }
    clearTimeout(connectTimer);

    // 429 → limited, honor retry-after, rotate.
    if (upstream.status === 429) {
      let payload: unknown = null;
      try {
        payload = await upstream.json();
      } catch {
        /* ignore */
      }

      if (classifyInvalidPayload(payload)) {
        markInvalid(key.id);
        logRotation(reqId, key.email, `429 → key invalid/revoked`);
      } else if (classifyErrorPayload(payload)) {
        limitKeyFromHeaders(key.id, upstream.headers, group);
        logRotation(reqId, key.email, `429 → rate limited (key cooled down)`);
      } else {
        logRotation(reqId, key.email, `429 → IP-level rate limit (key NOT cooled down)`);
      }
      decrementInFlight(key.id);
      continue;
    }

    // Auth failure → invalid, do not auto-recover, rotate.
    if (upstream.status === 401 || upstream.status === 403) {
      markInvalid(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `${upstream.status} → key invalid (auth failure)`);
      continue;
    }

    // Other non-OK: classify body; if a limit error, rotate. 5xx → transient.
    if (!upstream.ok) {
      let payload: unknown = null;
      try {
        payload = await upstream.json();
      } catch {
        /* non-JSON error body */
      }
      if (classifyInvalidPayload(payload)) {
        markInvalid(key.id);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `${upstream.status} → key invalid (body)`);
        continue;
      }
      if (classifyErrorPayload(payload)) {
        markLimited(key.id, computeCooldownUntil(upstream.headers, group));
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `${upstream.status} → rate limit (body)`);
        continue;
      }
      if (upstream.status >= 500) {
        markProviderError(key.id);
        decrementInFlight(key.id);
        totalTransientFailures++;
        logRotation(reqId, key.email, `${upstream.status} → upstream server error`);
        continue;
      }
      // Genuine client error (400 etc.) — forward to the client unchanged.
      decrementInFlight(key.id);
      proxyLog('WARN', key.email, `#${reqId} Forwarding ${upstream.status} client error`);
      return NextResponse.json(payload ?? { error: 'Unknown error' }, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream, false),
      });
    }

    // Success path.
    if (isStream) {
      const peek = await peekStreamForLimit(upstream);
      if (peek.limited) {
        limitKeyFromHeaders(key.id, upstream.headers, group);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `Mid-stream limit detected before content`);
        continue;
      }

      logRequestComplete(reqId, key.email, Date.now() - startTime);
      proxyLog('SUCCESS', key.email, `#${reqId} Streaming response to client...`);

      // Decrement inFlight when the stream finishes (success or error).
      const keyId = key.id;
      const keyEmail = key.email;
      const trackedStream = peek.stream
        ? trackStreamCompletion(peek.stream, keyId, keyEmail, reqId)
        : null;

      return new Response(trackedStream, {
        status: 200,
        headers: buildResponseHeaders(upstream, true),
      });
    }

    // Non-streaming success.
    decrementInFlight(key.id);
    logRequestComplete(reqId, key.email, Date.now() - startTime);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream, false),
    });
  }

  // Exhausted all candidates across all groups.
  logExhausted(reqId, totalCandidatesTried, flatPoolSize);

  if (totalCandidatesTried === 0) {
    return errorJson(
      'rate_limit_error',
      'All keys in all groups are currently rate-limited or invalid. Check the dashboard.',
      429,
    );
  }

  if (totalTransientFailures > 0 && totalTransientFailures === totalCandidatesTried) {
    return errorJson(
      'api_error',
      'All upstream requests failed (network or 5xx). Check the upstream URL and try again.',
      502,
    );
  }

  return errorJson(
    'rate_limit_error',
    'All API keys in the pool are exhausted or rate-limited. Check your credentials or limits.',
    429,
  );
}

// Wrap a stream to decrement the inFlight counter when it finishes.
function trackStreamCompletion(
  stream: ReadableStream<Uint8Array>,
  keyId: string,
  keyEmail: string,
  reqId: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;

  function finish() {
    if (!finished) {
      finished = true;
      decrementInFlight(keyId);
      proxyLog('INFO', keyEmail, `#${reqId} Stream completed`);
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        if (result.value) controller.enqueue(result.value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      reader.cancel(reason).catch(() => {});
    },
  });
}
