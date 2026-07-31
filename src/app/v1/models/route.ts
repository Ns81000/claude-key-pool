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

export async function GET(req: NextRequest) {
  const config = loadConfig();
  const reqId = nextRequestId();
  const startTime = Date.now();

  if (!config.selectedModel) {
    return NextResponse.json(
      { error: 'No model selected. Open http://localhost:9999 and select a model from the header.' },
      { status: 400 }
    );
  }

  if (config.groups.length === 0) {
    return NextResponse.json(
      { error: 'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.' },
      { status: 400 }
    );
  }

  logSeparator();
  logRequestStart(reqId, 'GET', `/v1/models`);

  let totalCandidatesTried = 0;
  let totalTransientFailures = 0;

  const flatPoolSize = buildFlatPool(config, config.selectedModel).length;

  while (totalCandidatesTried < flatPoolSize) {
    const candidate = getNextCandidate(config, config.selectedModel);
    if (!candidate) {
      break;
    }

    const { group, key } = candidate;

    if (!group.targetUrl) {
      logRotation(reqId, key.email, `Group "${group.name}" has no target URL → marking all keys invalid`);
      group.keys.forEach(k => markInvalid(k.id));
      continue;
    }

    const targetUrl = `${group.targetUrl.replace(/\/$/, '')}/v1/models`;

    totalCandidatesTried++;
    incrementInFlight(key.id);

    const keyState = getKeyState(key.id);
    logKeySelected(reqId, key.email, group.name, keyState.inFlight);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: buildUpstreamHeaders(req.headers, key.key),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      decrementInFlight(key.id);

      if (req.signal.aborted) {
        proxyLog('WARN', key.email, `#${reqId} Client aborted models request`);
        return new Response('Client aborted', { status: 499 });
      }

      const isTimeout = err && (err as any).name === 'AbortError';
      if (isTimeout) {
        markKeySlow(key.id);
        logRotation(reqId, key.email, `Models fetch timed out (${CONNECT_TIMEOUT_MS / 1000}s) → marked slow`);
      } else {
        markKeySlow(key.id);
        logRotation(reqId, key.email, `Models fetch failed: ${err instanceof Error ? err.message : String(err)} → marked slow`);
      }
      totalTransientFailures++;
      continue;
    }
    clearTimeout(timer);

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

    if (upstream.status === 401) {
      markInvalid(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `401 → key invalid (auth failure)`);
      continue;
    }

    if (upstream.status === 403) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `403 → provider error (transient, 5-min cooldown)`);
      totalTransientFailures++;
      continue;
    }

    if (!upstream.ok) {
      let payload: unknown = null;
      try {
        payload = await upstream.json();
      } catch {
        /* non-JSON */
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
      decrementInFlight(key.id);
      return NextResponse.json(payload ?? { error: 'Unknown error' }, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream, false),
      });
    }

    const textBody = await upstream.text();
    const validation = validateNonStreamingResponseBody(textBody);
    if (!validation.valid) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      logRotation(reqId, key.email, `200 OK but ${validation.reason} → provider error (rotating key)`);
      totalTransientFailures++;
      continue;
    }

    decrementInFlight(key.id);
    logRequestComplete(reqId, key.email, Date.now() - startTime);
    return new Response(textBody, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream, false),
    });
  }

  logExhausted(reqId, totalCandidatesTried, flatPoolSize);

  if (totalCandidatesTried === 0) {
    return NextResponse.json({ error: 'All keys are rate-limited or invalid' }, { status: 429 });
  }

  if (totalTransientFailures > 0 && totalTransientFailures === totalCandidatesTried) {
    return NextResponse.json({ error: 'Upstream models request failed' }, { status: 502 });
  }
  return NextResponse.json({ error: 'All keys exhausted' }, { status: 429 });
}
