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
  pauseUpstream,
  getUpstreamPauseRemainingMs,
} from '@/lib/config';
import {
  CONNECT_TIMEOUT_MS,
  IP_PAUSE_MS,
  MAX_TRANSIENT_ROTATIONS,
  buildResponseHeaders,
  buildUpstreamHeaders,
  classify429,
  classify401,
  classifyErrorPayload,
  classifyInvalidPayload,
  classifyUpstreamFailure,
  computeCooldownUntil,
  fetchErrorCode,
  isGroupLevelNetworkError,
  limitKeyFromHeaders,
  peekStreamForLimit,
  validateNonStreamingResponseBody,
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

  if (!config.selectedModel) {
    proxyLog('ERROR', undefined, `#${reqId} No model selected`);
    return errorJson(
      'invalid_request_error',
      'No model selected. Open http://localhost:9999 and select a model from the header.',
      400,
    );
  }

  if (config.groups.length === 0) {
    proxyLog('ERROR', undefined, `#${reqId} No groups or keys configured`);
    return errorJson(
      'invalid_request_error',
      'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.',
      400,
    );
  }

  // Pool-wide upstream pause (set after an IP-level 429). Sending more
  // requests from the same IP would only escalate; fail fast with retry-after
  // so the client backs off too.
  const pauseRemainingMs = getUpstreamPauseRemainingMs();
  if (pauseRemainingMs > 0) {
    proxyLog('WARN', undefined, `#${reqId} Upstream paused after IP-level rate limit (${Math.ceil(pauseRemainingMs / 1000)}s left) → failing fast`);
    return NextResponse.json(
      {
        error: {
          type: 'rate_limit_error',
          message: `Upstream is rate-limited at the IP level; the pool paused for ${Math.ceil(pauseRemainingMs / 1000)}s. Retry after the pause.`,
        },
      },
      {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(pauseRemainingMs / 1000)) },
      },
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
  proxyLog('INFO', undefined, `#${reqId} Model: ${model} (selected: ${config.selectedModel})`);

  let totalCandidatesTried = 0;
  let totalTransientFailures = 0;

  // Route by the model the request actually carries when the pool has a group
  // for it: background/auto-mode requests carry smallFastModel and must reach
  // that model's group, not the main one. Fall back to the dashboard
  // selection for anything the pool has no group for.
  const poolModel =
    model !== 'unknown' && buildFlatPool(config, model).length > 0
      ? model
      : config.selectedModel;
  if (poolModel !== config.selectedModel) {
    proxyLog('INFO', undefined, `#${reqId} Pool routed by request model "${poolModel}" (differs from selected "${config.selectedModel}")`);
  }

  const flatPoolSize = buildFlatPool(config, poolModel).length;

  if (flatPoolSize === 0) {
    // Not a rate limit: no enabled group matches the model at all (all
    // groups disabled, or the group's model was renamed). A 429 here sent
    // operators chasing key quarantines that don't exist.
    proxyLog('ERROR', undefined, `#${reqId} No enabled group serves model "${poolModel}"`);
    return errorJson(
      'invalid_request_error',
      `No enabled group in Claude Key Pool serves model "${poolModel}". Open http://localhost:9999 and check group models / the selected model.`,
      400,
    );
  }

  while (totalCandidatesTried < flatPoolSize) {
    const candidate = getNextCandidate(config, poolModel);
    if (!candidate) {
      break;
    }

    // Client (or the /api/test probe) went away mid-rotation: stop burning
    // keys, quota, and 5-minute cooldowns on a request nobody waits for.
    if (req.signal.aborted) {
      proxyLog('WARN', candidate.key.email, `#${reqId} Client aborted during rotation → stopping`);
      return new Response('Client aborted', { status: 499 });
    }

    // Transient failures (5xx / network / 403) are usually upstream-wide, not
    // key-specific. After a few, stop burning keys: each rotation fires
    // another request at the struggling upstream and quarantines a key for
    // 5 minutes.
    if (totalTransientFailures >= MAX_TRANSIENT_ROTATIONS) {
      logRotation(reqId, candidate.key.email, `Stopping rotation after ${totalTransientFailures} transient failures (cap ${MAX_TRANSIENT_ROTATIONS}) — upstream looks unhealthy`);
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

      const isTimeout = err && (err as { name?: string }).name === 'AbortError';
      if (isTimeout) {
        markKeySlow(key.id);
        logRotation(reqId, key.email, `Connection timed out (${CONNECT_TIMEOUT_MS / 1000}s) → marked slow`);
      } else if (isGroupLevelNetworkError(err)) {
        // DNS/refused/unreachable — the group's URL is the problem, not this key.
        markProviderError(key.id);
        logRotation(reqId, key.email, `Network failure (${fetchErrorCode(err)}) — group URL unreachable → 5-min cooldown`);
      } else {
        markKeySlow(key.id);
        logRotation(reqId, key.email, `Fetch failed: ${err instanceof Error ? err.message : String(err)} → marked slow`);
      }
      totalTransientFailures++;
      continue;
    }
    clearTimeout(connectTimer);

    // 429 → limited, honor retry-after, rotate.
    if (upstream.status === 429) {
      const verdict = await classify429(upstream);
      if (verdict.kind === 'invalid') {
        markInvalid(key.id);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `429 → key invalid/revoked`);
        continue;
      }
      if (verdict.kind === 'key-limited') {
        limitKeyFromHeaders(key.id, upstream.headers, group);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `429 → rate limited (key cooled down)`);
        continue;
      }
      // IP-level: every key leaves from the same IP, so rotating would fire a
      // burst of requests at an upstream that just rate-limited this IP — the
      // escalation pattern that ends in a ban. Pause the pool, let the current
      // key off (this 429 is not its fault), and return the error so the
      // client retries with its own backoff.
      pauseUpstream(IP_PAUSE_MS);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `429 → IP-level rate limit → pool paused ${IP_PAUSE_MS / 1000}s, error returned to client (key NOT cooled down)`);
      return NextResponse.json(verdict.payload ?? { error: { type: 'rate_limit_error', message: 'Upstream IP-level rate limit' } }, {
        status: 429,
        headers: { ...Object.fromEntries(buildResponseHeaders(upstream, false).entries()), 'retry-after': String(IP_PAUSE_MS / 1000) },
      });
    }

    // 401 → auth failure. Unless the upstream rejected the *client* (not the
    // key — see classify401): then forward the 401 instead of burning every
    // key in the pool on a request that would fail with any of them.
    if (upstream.status === 401) {
      const verdict = await classify401(upstream);
      if (verdict.kind === 'client-rejected') {
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `401 → upstream rejected this client (key NOT marked invalid)`);
        return NextResponse.json(verdict.payload, {
          status: 401,
          headers: buildResponseHeaders(upstream, false),
        });
      }
      markInvalid(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `401 → key invalid (auth failure)`);
      continue;
    }

    // 403 → often transient (Cloudflare, WAF, CDN challenges on third-party
    // upstreams). Treat as a provider error with a short cooldown, not permanent
    // invalidation.
    if (upstream.status === 403) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `403 → provider error (transient, 5-min cooldown)`);
      totalTransientFailures++;
      continue;
    }

    // Other non-OK: classify body; if a limit error, rotate. 5xx → transient.
    if (!upstream.ok) {
      const failure = await classifyUpstreamFailure(upstream);
      if (failure.kind === 'invalid') {
        markInvalid(key.id);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `${upstream.status} → key invalid (body)`);
        continue;
      }
      if (failure.kind === 'limited') {
        markLimited(key.id, computeCooldownUntil(upstream.headers, group));
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `${upstream.status} → rate limit (body)`);
        continue;
      }
      if (failure.kind === 'provider') {
        markProviderError(key.id);
        decrementInFlight(key.id);
        totalTransientFailures++;
        logRotation(reqId, key.email, `${upstream.status} → upstream server error`);
        continue;
      }
      // Genuine client error (400 etc.) — forward to the client unchanged.
      decrementInFlight(key.id);
      proxyLog('WARN', key.email, `#${reqId} Forwarding ${upstream.status} client error`);
      return NextResponse.json(failure.payload ?? { error: 'Unknown error' }, {
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

      if (peek.malformed) {
        markProviderError(key.id);
        decrementInFlight(key.id);
        logRotation(reqId, key.email, `200 OK but ${peek.reason || 'malformed stream'} → provider error (rotating key)`);
        totalTransientFailures++;
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
    const textBody = await upstream.text();
    const validation = validateNonStreamingResponseBody(textBody);
    if (!validation.valid) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `200 OK but ${validation.reason} → provider error (rotating key)`);
      totalTransientFailures++;
      continue;
    }

    if (classifyInvalidPayload(validation.payload)) {
      markInvalid(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `200 OK with key invalid error in payload → key invalid`);
      continue;
    }

    if (classifyErrorPayload(validation.payload)) {
      limitKeyFromHeaders(key.id, upstream.headers, group);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `200 OK with rate limit error in payload → rate limited`);
      continue;
    }

    decrementInFlight(key.id);
    logRequestComplete(reqId, key.email, Date.now() - startTime);
    return new Response(textBody, {
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
