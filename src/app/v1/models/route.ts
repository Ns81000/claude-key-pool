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
  classifyUpstreamFailure,
  computeCooldownUntil,
  fetchErrorCode,
  isGroupLevelNetworkError,
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
import { startRequest } from '@/lib/activity';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Cross-site guard (DNS-rebinding / drive-by): transparent for curl/CLI.
  const crossSiteRejected = rejectCrossSiteRequest(req);
  if (crossSiteRejected) return crossSiteRejected;

  const config = loadConfig();
  const reqId = nextRequestId();
  const startTime = Date.now();
  const act = startRequest(reqId, 'GET', '/v1/models');
  act.setModel(config.selectedModel);

  if (!config.selectedModel) {
    act.finish('no-pool', 400, 'no model selected');
    return NextResponse.json(
      { error: 'No model selected. Open http://localhost:9999 and select a model from the header.' },
      { status: 400 }
    );
  }

  if (config.groups.length === 0) {
    act.finish('no-pool', 400, 'no groups or keys configured');
    return NextResponse.json(
      { error: 'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.' },
      { status: 400 }
    );
  }

  // Pool-wide upstream pause (set after an IP-level 429) — fail fast, same as
  // /v1/messages.
  const pauseRemainingMs = getUpstreamPauseRemainingMs();
  if (pauseRemainingMs > 0) {
    act.finish('ip-paused', 429, `pool paused after IP-level 429 (${Math.ceil(pauseRemainingMs / 1000)}s left)`);
    return NextResponse.json(
      { error: `Upstream is rate-limited at the IP level; the pool paused for ${Math.ceil(pauseRemainingMs / 1000)}s.` },
      {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(pauseRemainingMs / 1000)) },
      },
    );
  }

  logSeparator();
  logRequestStart(reqId, 'GET', `/v1/models`);

  let totalCandidatesTried = 0;
  let totalTransientFailures = 0;

  const flatPoolSize = buildFlatPool(config, config.selectedModel).length;

  if (flatPoolSize === 0) {
    // Not a rate limit: no enabled group matches the selected model at all.
    // Mirror the /v1/messages fix — an honest 400 instead of a misleading 429.
    act.finish('no-pool', 400, `no enabled group serves model "${config.selectedModel}"`);
    return NextResponse.json(
      { error: `No enabled group in Claude Key Pool serves model "${config.selectedModel}". Open http://localhost:9999 and check group models / the selected model.` },
      { status: 400 },
    );
  }

  while (totalCandidatesTried < flatPoolSize) {
    const candidate = getNextCandidate(config, config.selectedModel);
    if (!candidate) {
      break;
    }

    // Client went away mid-rotation: stop burning keys on a request nobody
    // waits for.
    if (req.signal.aborted) {
      proxyLog('WARN', candidate.key.email, `#${reqId} Client aborted during rotation → stopping`);
      act.finish('aborted', 499, 'client aborted during rotation');
      return new Response('Client aborted', { status: 499 });
    }

    // Same transient cap as /v1/messages: transient failures are usually
    // upstream-wide; stop burning keys after a few.
    if (totalTransientFailures >= MAX_TRANSIENT_ROTATIONS) {
      logRotation(reqId, candidate.key.email, `Stopping rotation after ${totalTransientFailures} transient failures (cap ${MAX_TRANSIENT_ROTATIONS}) — upstream looks unhealthy`);
      break;
    }

    const { group, key } = candidate;

    if (!group.targetUrl) {
      logRotation(reqId, key.email, `Group "${group.name}" has no target URL → marking all keys invalid`);
      act.note(key.id, key.email, group.name, 'invalid', `group "${group.name}" has no target URL`);
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
    const upstreamStartedAt = Date.now();
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
        act.finish('aborted', 499, 'client aborted request');
        return new Response('Client aborted', { status: 499 });
      }

      const isTimeout = err && (err as { name?: string }).name === 'AbortError';
      if (isTimeout) {
        markKeySlow(key.id);
        act.note(key.id, key.email, group.name, 'timeout', `models fetch timed out (${CONNECT_TIMEOUT_MS / 1000}s)`);
        logRotation(reqId, key.email, `Models fetch timed out (${CONNECT_TIMEOUT_MS / 1000}s) → marked slow`);
      } else if (isGroupLevelNetworkError(err)) {
        markProviderError(key.id);
        act.note(key.id, key.email, group.name, 'network', `network failure (${fetchErrorCode(err)}) — group URL unreachable`);
        logRotation(reqId, key.email, `Network failure (${fetchErrorCode(err)}) — group URL unreachable → 5-min cooldown`);
      } else {
        markKeySlow(key.id);
        act.note(key.id, key.email, group.name, 'slow', `models fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        logRotation(reqId, key.email, `Models fetch failed: ${err instanceof Error ? err.message : String(err)} → marked slow`);
      }
      totalTransientFailures++;
      continue;
    }
    clearTimeout(timer);

    if (upstream.status === 429) {
      const verdict = await classify429(upstream);
      if (verdict.kind === 'invalid') {
        markInvalid(key.id);
        decrementInFlight(key.id);
        act.note(key.id, key.email, group.name, 'invalid', '429 → key invalid/revoked');
        logRotation(reqId, key.email, `429 → key invalid/revoked`);
        continue;
      }
      if (verdict.kind === 'key-limited') {
        limitKeyFromHeaders(key.id, upstream.headers, group);
        decrementInFlight(key.id);
        act.note(key.id, key.email, group.name, 'rate-limited', '429 → rate limited (key cooled down)');
        logRotation(reqId, key.email, `429 → rate limited (key cooled down)`);
        continue;
      }
      // IP-level — same as /v1/messages: pause the pool, return the error
      // instead of rotating (every key shares this machine's IP).
      pauseUpstream(IP_PAUSE_MS);
      decrementInFlight(key.id);
      act.finish('ip-paused', 429, `IP-level 429 → pool paused ${IP_PAUSE_MS / 1000}s (key not blamed)`);
      logRotation(reqId, key.email, `429 → IP-level rate limit → pool paused ${IP_PAUSE_MS / 1000}s, error returned to client (key NOT cooled down)`);
      return NextResponse.json(verdict.payload ?? { error: 'Upstream IP-level rate limit' }, {
        status: 429,
        headers: { 'retry-after': String(IP_PAUSE_MS / 1000) },
      });
    }

    if (upstream.status === 401) {
      const verdict = await classify401(upstream);
      if (verdict.kind === 'client-rejected') {
        decrementInFlight(key.id);
        act.finish('client-error', 401, 'upstream rejected this client (key not blamed)');
        logRotation(reqId, key.email, `401 → upstream rejected this client (key NOT marked invalid)`);
        return NextResponse.json(verdict.payload, {
          status: 401,
          headers: buildResponseHeaders(upstream, false),
        });
      }
      markInvalid(key.id);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'invalid', '401 → key invalid (auth failure)');
      logRotation(reqId, key.email, `401 → key invalid (auth failure)`);
      continue;
    }

    if (upstream.status === 403) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'provider-error', '403 → provider error (transient)');
      logRotation(reqId, key.email, `403 → provider error (transient, 5-min cooldown)`);
      totalTransientFailures++;
      continue;
    }

    if (!upstream.ok) {
      const failure = await classifyUpstreamFailure(upstream);
      if (failure.kind === 'invalid') {
        markInvalid(key.id);
        decrementInFlight(key.id);
        act.note(key.id, key.email, group.name, 'invalid', `${upstream.status} → key invalid (body)`);
        logRotation(reqId, key.email, `${upstream.status} → key invalid (body)`);
        continue;
      }
      if (failure.kind === 'limited') {
        markLimited(key.id, computeCooldownUntil(upstream.headers, group));
        decrementInFlight(key.id);
        act.note(key.id, key.email, group.name, 'rate-limited', `${upstream.status} → rate limit (body)`);
        logRotation(reqId, key.email, `${upstream.status} → rate limit (body)`);
        continue;
      }
      if (failure.kind === 'provider') {
        markProviderError(key.id);
        decrementInFlight(key.id);
        totalTransientFailures++;
        act.note(key.id, key.email, group.name, 'provider-error', `${upstream.status} → upstream server error`);
        logRotation(reqId, key.email, `${upstream.status} → upstream server error`);
        continue;
      }
      decrementInFlight(key.id);
      act.finish('client-error', upstream.status, `${upstream.status} client error forwarded`);
      return NextResponse.json(failure.payload ?? { error: 'Unknown error' }, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream, false),
      });
    }

    // The body read can throw (headers 200, then the connection died
    // mid-body): without a catch the inFlight counter leaks forever and the
    // tracker never finishes — treat it like a transient upstream failure.
    let textBody: string;
    try {
      textBody = await upstream.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markProviderError(key.id);
      decrementInFlight(key.id);
      totalTransientFailures++;
      act.note(key.id, key.email, group.name, 'provider-error', `body read failed: ${message}`);
      logRotation(reqId, key.email, `Body read failed: ${message} → provider error (5-min cooldown)`);
      continue;
    }
    const validation = validateNonStreamingResponseBody(textBody);
    if (!validation.valid) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'provider-error', `200 OK but ${validation.reason}`);
      logRotation(reqId, key.email, `200 OK but ${validation.reason} → provider error (rotating key)`);
      totalTransientFailures++;
      continue;
    }

    decrementInFlight(key.id);
    act.noteSuccess(key.id, key.email, group.name, Date.now() - upstreamStartedAt);
    act.finish('success', upstream.status);
    logRequestComplete(reqId, key.email, Date.now() - startTime);
    return new Response(textBody, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream, false),
    });
  }

  logExhausted(reqId, totalCandidatesTried, flatPoolSize);
  act.finish(
    'exhausted',
    totalCandidatesTried === 0 ? 429 : totalTransientFailures === totalCandidatesTried ? 502 : 429,
    `all keys exhausted (tried ${totalCandidatesTried}/${flatPoolSize})`,
  );

  if (totalCandidatesTried === 0) {
    return NextResponse.json({ error: 'All keys are rate-limited or invalid' }, { status: 429 });
  }

  if (totalTransientFailures > 0 && totalTransientFailures === totalCandidatesTried) {
    return NextResponse.json({ error: 'Upstream models request failed' }, { status: 502 });
  }
  return NextResponse.json({ error: 'All keys exhausted' }, { status: 429 });
}
