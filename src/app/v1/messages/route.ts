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
import { RequestTracker, startRequest } from '@/lib/activity';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

function errorJson(type: string, message: string, status: number) {
  return NextResponse.json({ error: { type, message } }, { status });
}

export async function POST(req: NextRequest) {
  // Cross-site guard (DNS-rebinding / drive-by): a web page open in a browser
  // can fire a "simple" cross-site POST that burns upstream quota and
  // quarantines keys. Transparent for header-less clients (curl, Claude Code).
  const crossSiteRejected = rejectCrossSiteRequest(req);
  if (crossSiteRejected) {
    // act not created yet — nothing to finish; the log entry is not needed
    // for requests that never reach the pool.
    return crossSiteRejected;
  }
  const config = loadConfig();
  const reqId = nextRequestId();
  const startTime = Date.now();
  // Client profile: Kilo's provider entry sends `x-app: kilo` (the pool
  // authors kilo.jsonc, so the marker is ours); Claude Code sends `cli`,
  // everything else defaults to the claude profile.
  const client = req.headers.get('x-app')?.toLowerCase() === 'kilo' ? 'kilo' as const : 'claude' as const;
  // Activity tracker: feeds the dashboard log + per-key stats. Same id as
  // the console logger prints, so #NNN lines match across terminal and panel.
  const act = startRequest(reqId, 'POST', '/v1/messages', client);

  if (!config.selectedModel) {
    proxyLog('ERROR', undefined, `#${reqId} No model selected`);
    act.finish('no-pool', 400, 'no model selected');
    return errorJson(
      'invalid_request_error',
      'No model selected. Open http://localhost:9999 and select a model from the header.',
      400,
    );
  }

  if (config.groups.length === 0) {
    proxyLog('ERROR', undefined, `#${reqId} No groups or keys configured`);
    act.finish('no-pool', 400, 'no groups or keys configured');
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
    act.finish('ip-paused', 429, `pool paused after IP-level 429 (${Math.ceil(pauseRemainingMs / 1000)}s left)`);
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
  // the original bytes to avoid re-serializing large payloads. A client that
  // drops the connection mid-upload throws here — record it honestly instead
  // of dying with a bare 500 and losing the log entry.
  let rawBody: ArrayBuffer;
  try {
    rawBody = await req.arrayBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    proxyLog('WARN', undefined, `#${reqId} Request body read failed: ${message}`);
    act.finish('rejected', 400, `request body read failed: ${message}`);
    return errorJson('invalid_request_error', 'Failed to read request body.', 400);
  }
  let isStream = false;
  let model = 'unknown';
  let parsed: { stream?: unknown; model?: unknown } | null = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
    isStream = parsed?.stream === true;
    model = typeof parsed?.model === 'string' && parsed.model ? parsed.model : 'unknown';
  } catch {
    act.finish('rejected', 400, 'request body is not valid JSON');
    return errorJson('invalid_request_error', 'Failed to parse request JSON.', 400);
  }
  act.setModel(model === 'unknown' ? null : model);
  act.setStream(isStream);

  // The harness tags requested context size onto the model name (e.g.
  // "glm-5.3[1m]" for the 1M-token window). The bracket suffix is a
  // client-side label, not a model name: forwarded verbatim, the upstream
  // rejects the unknown model, the request rotates through the pool and
  // burns transient cooldowns on key after key (observed: 9/14 keys
  // rate-limited by repeated classifier calls). Strip it for routing AND
  // rewrite the forwarded body — only when a suffix is present, so normal
  // bodies still go out byte-for-byte.
  const normalizedModel =
    typeof model === 'string' && /\[[^\]]*\]\s*$/.test(model)
      ? model.replace(/\[[^\]]*\]\s*$/, '').trim()
      : model;
  let forwardBody: ArrayBuffer | string = rawBody;
  if (parsed && normalizedModel !== model && normalizedModel) {
    parsed.model = normalizedModel;
    forwardBody = JSON.stringify(parsed);
  }

  logSeparator();
  logRequestStart(reqId, 'POST', `/v1/messages`, isStream, client);
  proxyLog('INFO', undefined, `#${reqId} Model: ${model} (selected: ${config.selectedModel})`);
  if (normalizedModel !== model) {
    // Diagnostics for the [1m]-class defect without live probes: the pool
    // terminal shows that the suffix was stripped and the body rewritten.
    proxyLog('INFO', undefined, `#${reqId} Model suffix stripped: "${model}" -> "${normalizedModel}" (context-size label, not a model name)`);
  }

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
    act.finish('no-pool', 400, `no enabled group serves model "${poolModel}"`);
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
      act.finish('aborted', 499, 'client aborted during rotation');
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
      act.note(key.id, key.email, group.name, 'invalid', `group "${group.name}" has no target URL`);
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
    const upstreamStartedAt = Date.now();
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: buildUpstreamHeaders(req.headers, key.key),
        body: forwardBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      decrementInFlight(key.id);

      if (req.signal.aborted) {
        proxyLog('WARN', key.email, `#${reqId} Client aborted request`);
        act.finish('aborted', 499, 'client aborted request');
        return new Response('Client aborted', { status: 499 });
      }

      const isTimeout = err && (err as { name?: string }).name === 'AbortError';
      if (isTimeout) {
        markKeySlow(key.id);
        act.note(key.id, key.email, group.name, 'timeout', `connection timed out (${CONNECT_TIMEOUT_MS / 1000}s)`);
        logRotation(reqId, key.email, `Connection timed out (${CONNECT_TIMEOUT_MS / 1000}s) → marked slow`);
      } else if (isGroupLevelNetworkError(err)) {
        // DNS/refused/unreachable — the group's URL is the problem, not this key.
        markProviderError(key.id);
        act.note(key.id, key.email, group.name, 'network', `network failure (${fetchErrorCode(err)}) — group URL unreachable`);
        logRotation(reqId, key.email, `Network failure (${fetchErrorCode(err)}) — group URL unreachable → 5-min cooldown`);
      } else {
        markKeySlow(key.id);
        act.note(key.id, key.email, group.name, 'slow', `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
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
      // IP-level: every key leaves from the same IP, so rotating would fire a
      // burst of requests at an upstream that just rate-limited this IP — the
      // escalation pattern that ends in a ban. Pause the pool, let the current
      // key off (this 429 is not its fault), and return the error so the
      // client retries with its own backoff.
      pauseUpstream(IP_PAUSE_MS);
      decrementInFlight(key.id);
      act.finish('ip-paused', 429, `IP-level 429 → pool paused ${IP_PAUSE_MS / 1000}s (key not blamed)`);
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

    // 403 → often transient (Cloudflare, WAF, CDN challenges on third-party
    // upstreams). Treat as a provider error with a short cooldown, not permanent
    // invalidation.
    if (upstream.status === 403) {
      markProviderError(key.id);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'provider-error', '403 → provider error (transient)');
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
      // Genuine client error (400 etc.) — forward to the client unchanged.
      decrementInFlight(key.id);
      act.finish('client-error', upstream.status, `${upstream.status} client error forwarded`);
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
        act.note(key.id, key.email, group.name, 'rate-limited', 'mid-stream limit detected before content');
        logRotation(reqId, key.email, `Mid-stream limit detected before content`);
        continue;
      }

      if (peek.malformed) {
        markProviderError(key.id);
        decrementInFlight(key.id);
        act.note(key.id, key.email, group.name, 'provider-error', `200 OK but ${peek.reason || 'malformed stream'}`);
        logRotation(reqId, key.email, `200 OK but ${peek.reason || 'malformed stream'} → provider error (rotating key)`);
        totalTransientFailures++;
        continue;
      }

      act.noteSuccess(key.id, key.email, group.name, Date.now() - upstreamStartedAt);
      act.finish('success', 200);
      logRequestComplete(reqId, key.email, Date.now() - startTime, client);
      proxyLog('SUCCESS', key.email, `#${reqId} Streaming response to client...`);

      // Decrement inFlight when the stream finishes (success or error).
      // The wrapper also watches the SSE frames for usage tokens so the
      // key statistics get input/output counts for streaming requests.
      const keyId = key.id;
      const keyEmail = key.email;
      const trackedStream = peek.stream
        ? trackStreamCompletion(peek.stream, keyId, keyEmail, reqId, act)
        : null;

      return new Response(trackedStream, {
        status: 200,
        headers: buildResponseHeaders(upstream, true),
      });
    }

    // Non-streaming success. The body read can throw (upstream sent headers
    // 200, then the connection died mid-body): without a catch the inFlight
    // counter leaks forever, the tracker never finishes, and the key skips
    // the provider-error cooldown — treat it like any other transient
    // upstream failure and rotate.
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

    if (classifyInvalidPayload(validation.payload)) {
      markInvalid(key.id);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'invalid', '200 OK with key invalid error in payload');
      logRotation(reqId, key.email, `200 OK with key invalid error in payload → key invalid`);
      continue;
    }

    if (classifyErrorPayload(validation.payload)) {
      limitKeyFromHeaders(key.id, upstream.headers, group);
      decrementInFlight(key.id);
      act.note(key.id, key.email, group.name, 'rate-limited', '200 OK with rate limit error in payload');
      logRotation(reqId, key.email, `200 OK with rate limit error in payload → rate limited`);
      continue;
    }

    decrementInFlight(key.id);
    act.noteSuccess(key.id, key.email, group.name, Date.now() - upstreamStartedAt);
    const usage = (validation.payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })?.usage;
    if (usage && typeof usage === 'object') {
      act.addTokens(
        typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
        typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      );
    }
    act.finish('success', upstream.status);
    logRequestComplete(reqId, key.email, Date.now() - startTime, client);
    return new Response(textBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream, false),
    });
  }

  // Exhausted all candidates across all groups.
  logExhausted(reqId, totalCandidatesTried, flatPoolSize);
  act.finish(
    'exhausted',
    totalCandidatesTried === 0 ? 429 : totalTransientFailures === totalCandidatesTried ? 502 : 429,
    `all keys exhausted (tried ${totalCandidatesTried}/${flatPoolSize})`,
  );

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

// Wrap a stream to decrement the inFlight counter when it finishes. Also
// scans the SSE frames for usage info (message_start carries input_tokens,
// message_delta at the end carries output_tokens) so streaming requests get
// token counts in the activity statistics too.
//
// The request outcome is decided by how the stream actually ends: the route
// marks it `success` when the 200 head is committed, and this wrapper
// rewrites the entry if the stream later dies (error/cancel mid-body) —
// otherwise a broken stream would sit in the log as a green OK forever.
function trackStreamCompletion(
  stream: ReadableStream<Uint8Array>,
  keyId: string,
  keyEmail: string,
  reqId: number,
  act?: RequestTracker,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  const decoder = new TextDecoder();
  // SSE lines can split across chunks — keep the trailing partial line only.
  let lineTail = '';

  function finish() {
    if (!finished) {
      finished = true;
      decrementInFlight(keyId);
      proxyLog('INFO', keyEmail, `#${reqId} Stream completed`);
    }
  }

  function markStreamFailed(reason: string) {
    act?.rewriteOutcome('provider-error', 200, `stream died mid-body: ${reason}`);
    proxyLog('WARN', keyEmail, `#${reqId} Stream failed mid-body: ${reason}`);
  }

  // Extract token usage from complete SSE data lines. Only message_start /
  // message_delta frames carry usage; agentrouter often sends input_tokens
  // only in the final message_delta, so both are read from both frames.
  function scanForUsage(text: string): void {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      // Cheap pre-filter before JSON.parse: ~95% of frames are content
      // deltas that carry no usage at all.
      if (!jsonStr.includes('"message_start"') && !jsonStr.includes('"message_delta"')) continue;
      try {
        const obj = JSON.parse(jsonStr) as {
          type?: string;
          message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
          usage?: { output_tokens?: unknown; input_tokens?: unknown };
        };
        if (obj.type !== 'message_start' && obj.type !== 'message_delta') continue;
        const usage = obj.type === 'message_start' ? obj.message?.usage : obj.usage;
        if (usage && typeof usage === 'object') {
          const inT = usage.input_tokens;
          const outT = usage.output_tokens;
          if (typeof inT === 'number' || typeof outT === 'number') {
            act?.addTokens(
              typeof inT === 'number' ? inT : null,
              typeof outT === 'number' ? outT : null,
            );
          }
        }
      } catch {
        // Partial JSON at a chunk boundary — the remainder arrives later.
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          // Flush the final partial line: a non-canonical relay may end its
          // last usage frame without a trailing newline, and that frame
          // would otherwise never be scanned.
          if (act && lineTail) {
            scanForUsage(lineTail + decoder.decode());
            lineTail = '';
          }
          finish();
          controller.close();
          return;
        }
        if (result.value) {
          if (act) {
            const text = lineTail + decoder.decode(result.value, { stream: true });
            const lastNewline = text.lastIndexOf('\n');
            if (lastNewline >= 0) {
              lineTail = text.slice(lastNewline + 1);
              scanForUsage(text.slice(0, lastNewline + 1));
            } else {
              lineTail = text;
            }
            // Bound the partial-line buffer: a single SSE frame far larger
            // than this is not a usage frame anyway.
            if (lineTail.length > 16 * 1024) lineTail = '';
          }
          controller.enqueue(result.value);
        }
      } catch (err) {
        finish();
        markStreamFailed(err instanceof Error ? err.message : String(err));
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      // Client-side aborts (Esc in Claude Code) are not provider failures —
      // rewrite only when the upstream itself died; a cancel carries the
      // client's reason.
      reader.cancel(reason).catch(() => {});
    },
  });
}
