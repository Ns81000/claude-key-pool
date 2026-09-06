import {
  AppConfig,
  GroupConfig,
  KeyConfig,
  getKeyState,
  markLimited,
  proxyState,
} from './config';

// Connect / first-byte timeout. There is intentionally no hard cap on total
// stream duration (long completions are normal), but we abort if the upstream
// produces no bytes for STALL_TIMEOUT_MS.
export const CONNECT_TIMEOUT_MS = 40_000;
export const STALL_TIMEOUT_MS = 120_000;
export const DEFAULT_COOLDOWN_MS = 1_800_000; // 30 minutes
export const SLOW_KEY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// How much of a stream we are willing to buffer while looking for an early
// error event before we give up and start forwarding to the client.
export const STREAM_PEEK_BYTES = 16 * 1024;
export const STREAM_PEEK_MS = 8_000;

// Strings/types that mean "this key is out of budget → rotate to the next".
const LIMIT_ERROR_TYPES = ['rate_limit_error', 'overloaded_error'];
const LIMIT_ERROR_SUBSTRINGS = [
  'rate limit',
  'too many requests',
  'usage limit',
  'usage limit reached',
  'token limit',
  'overloaded',
  'concurrency',
  'throttled',
  'payment required',
  // OpenAI-compatible aggregators (OpenRouter and peers):
  'rate limit exceeded',
  'exceeded your quota',
  'insufficient_quota',
  'quota exceeded',
];

// Strings/types that mean "this key is invalid/revoked/billing failed → do not use".
// NOTE: 'invalid_request_error' is intentionally NOT here — it means "bad request
// parameters" (e.g. unsupported model), not "dead key". Including it would cause
// a cascade where every key gets permanently invalidated when a client sends an
// unsupported model name.
const INVALID_ERROR_TYPES = ['authentication_error', 'permission_error'];
const INVALID_ERROR_SUBSTRINGS = [
  'invalid api key',
  'invalid key',
  'key is invalid',
  'unauthorized',
  'revoked',
  'disabled',
  'deleted',
  'inactive key',
  'insufficient credit',
  'insufficient balance',
  'out of credit',
  'exhausted credit',
  'quota exceeded',
  'credit card',
  'billing status',
  // OpenAI-compatible aggregators (OpenRouter and peers):
  'no auth credentials',
  'invalid api key provided',
  'insufficient credits',
  'account balance is too low',
  'not enough credits',
];

export function isLimitError(errType?: string, errMsg?: string): boolean {
  const t = (errType || '').toLowerCase();
  const m = (errMsg || '').toLowerCase();
  if (t && LIMIT_ERROR_TYPES.includes(t)) return true;

  // If the error message indicates an invalid key or permission issue, it is not a rate limit
  const isInvalid = INVALID_ERROR_SUBSTRINGS.some((s) => m.includes(s)) || INVALID_ERROR_TYPES.includes(t);
  if (isInvalid) return false;

  if (m && LIMIT_ERROR_SUBSTRINGS.some((s) => m.includes(s))) return true;
  return false;
}

export function isInvalidError(errType?: string, errMsg?: string): boolean {
  const t = (errType || '').toLowerCase();
  const m = (errMsg || '').toLowerCase();
  if (t && INVALID_ERROR_TYPES.includes(t)) return true;
  if (m && INVALID_ERROR_SUBSTRINGS.some((s) => m.includes(s))) return true;
  return false;
}

// Inspect a decoded error payload (from JSON body or an SSE error event).
export function classifyErrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const err = (payload as { error?: unknown }).error;
  if (!err) {
    // Some upstreams put type/message at the top level.
    const top = payload as { type?: string; message?: string };
    return isLimitError(top.type, top.message);
  }
  if (typeof err === 'string') {
    return isLimitError(undefined, err);
  }
  if (typeof err === 'object') {
    const obj = err as { type?: string; message?: string };
    return isLimitError(obj.type, obj.message);
  }
  return false;
}

// Inspect a decoded error payload for key invalidation (revoked, billing failed, etc.).
export function classifyInvalidPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const err = (payload as { error?: unknown }).error;
  if (!err) {
    const top = payload as { type?: string; message?: string };
    return isInvalidError(top.type, top.message);
  }
  if (typeof err === 'string') {
    return isInvalidError(undefined, err);
  }
  if (typeof err === 'object') {
    const obj = err as { type?: string; message?: string };
    return isInvalidError(obj.type, obj.message);
  }
  return false;
}

// Compute cooldown end (ms epoch) from response headers, honoring retry-after
// and anthropic ratelimit reset headers, falling back to a sane default.
export function computeCooldownUntil(headers: Headers, group?: GroupConfig): number {
  const now = Date.now();

  if (group && typeof group.rateLimitCooldownHours === 'number' && group.rateLimitCooldownHours > 0) {
    return now + group.rateLimitCooldownHours * 3600 * 1000;
  }

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return now + secs * 1000;
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(now + 1000, dateMs);
  }

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (lower.startsWith('anthropic-ratelimit-') && lower.endsWith('-reset')) {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) {
        // Reset headers are usually a unix timestamp; treat large values as
        // epoch. The boundary must separate epoch-SECONDS (~1.7e9) from
        // epoch-MILLISECONDS (~1.7e12): a ms-epoch read here previously
        // multiplied by 1000 again → cooldown until year ~560000.
        if (secs > 1e12) return secs; // ms epoch already
        if (secs > 1e6) return secs * 1000; // s epoch
        return now + secs * 1000; // relative seconds
      }
      const dateMs = Date.parse(value);
      if (Number.isFinite(dateMs)) return Math.max(now + 1000, dateMs);
    }
    // OpenRouter sends the reset instant as X-RateLimit-Reset (epoch
    // seconds). The same seconds/milliseconds/relative disambiguation as
    // the anthropic-ratelimit-* headers applies.
    if (lower === 'x-ratelimit-reset') {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) {
        if (secs > 1e12) return secs;
        if (secs > 1e6) return secs * 1000;
        return now + secs * 1000;
      }
      const dateMs = Date.parse(value);
      if (Number.isFinite(dateMs)) return Math.max(now + 1000, dateMs);
    }
  }

  return now + DEFAULT_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Flat-pool entry: a key paired with its parent group for routing context.
// ---------------------------------------------------------------------------
export interface FlatPoolEntry {
  group: GroupConfig;
  key: KeyConfig;
}

// Build a flat array of all keys across all groups, preserving group context.
// When selectedModel is provided, only groups whose model matches are included.
export function buildFlatPool(config: AppConfig, selectedModel?: string | null): FlatPoolEntry[] {
  const pool: FlatPoolEntry[] = [];
  for (const group of config.groups) {
    if (group.disabled) continue;
    if (selectedModel && group.model !== selectedModel) continue;
    for (const key of group.keys) {
      if (key.disabled) continue;
      pool.push({ group, key });
    }
  }
  return pool;
}

// True round-robin selection across the entire flat pool.
// - Always advances the pointer so every call gets a different key.
// - Prefers keys with zero inFlight (concurrency-aware, Bug #3 fix).
// - Deprioritizes keys that recently timed out (slow-key awareness).
// - Skips rate-limited and invalid keys.
// Returns null when all keys are exhausted.
export function getNextCandidate(config: AppConfig, selectedModel?: string | null): { group: GroupConfig; key: KeyConfig } | null {
  const pool = buildFlatPool(config, selectedModel);
  if (pool.length === 0) return null;

  const startIndex = (proxyState.roundRobinIndex + 1) % pool.length;
  const now = Date.now();

  // First pass: find the best idle (inFlight === 0), non-slow active key.
  let bestIdleIndex = -1;
  // Second pass fallback: any active key with lowest inFlight.
  let bestBusyIndex = -1;
  let bestBusyInFlight = Infinity;
  // Third pass fallback: active but slow key.
  let bestSlowIndex = -1;
  let bestSlowInFlight = Infinity;

  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const entry = pool[idx];
    const state = getKeyState(entry.key.id);

    if (state.status !== 'active') continue;

    const isSlow =
      state.lastTimeoutTime !== undefined &&
      now - state.lastTimeoutTime < SLOW_KEY_WINDOW_MS;

    if (isSlow) {
      // Track best slow key as last-resort fallback.
      if (state.inFlight < bestSlowInFlight) {
        bestSlowIndex = idx;
        bestSlowInFlight = state.inFlight;
      }
      continue;
    }

    if (state.inFlight === 0) {
      // Best case: idle, non-slow key. Take it immediately.
      bestIdleIndex = idx;
      break;
    }

    // Track the busy-but-not-slow key with fewest in-flight requests.
    if (state.inFlight < bestBusyInFlight) {
      bestBusyIndex = idx;
      bestBusyInFlight = state.inFlight;
    }
  }

  // Pick the best candidate in priority order.
  const chosenIndex =
    bestIdleIndex >= 0
      ? bestIdleIndex
      : bestBusyIndex >= 0
        ? bestBusyIndex
        : bestSlowIndex >= 0
          ? bestSlowIndex
          : -1;

  if (chosenIndex < 0) return null;

  // Advance the round-robin pointer so the next call starts after this key.
  proxyState.roundRobinIndex = chosenIndex;

  const chosen = pool[chosenIndex];
  return { group: chosen.group, key: chosen.key };
}

// agentrouter rejects non-approved client programs by User-Agent with a
// 401 "unauthorized client detected" that has nothing to do with the key.
// The pool serves local tools of any kind (browsers, curl, SDKs), so every
// upstream request goes out masked as a Claude CLI client — the same trick
// proxy_ai (port 8318) plays with codex_cli_rs for Kilo Code.
const MASK_USER_AGENT = 'claude-cli/2.0.0 (external, cli)';

// After an IP-level 429, pause ALL upstream traffic for this long. Every key
// in the pool leaves from the same machine IP, so rotating on an IP-level
// limit fires a burst of requests at an upstream that just rate-limited that
// IP — the escalation pattern that ends in a ban. The client retries with its
// own backoff; the pause lapses on its own.
export const IP_PAUSE_MS = 30_000;

// Never burn more than this many keys on transient failures (5xx / network /
// 403) within a single client request. Those failures are usually upstream-
// wide, not key-specific: rotating through the whole pool both fires a burst
// at a struggling upstream and quarantines every key for 5 minutes.
export const MAX_TRANSIENT_ROTATIONS = 3;

// Build the upstream request headers: copy client headers minus hop-by-hop and
// auth, inject the pool key.
export function buildUpstreamHeaders(clientHeaders: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of clientHeaders.entries()) {
    const lower = name.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower === 'user-agent'
    ) {
      continue;
    }
    headers.set(name, value);
  }
  headers.set('user-agent', MASK_USER_AGENT);
  headers.set('x-api-key', apiKey);
  // Ask for an uncompressed body. undici decompresses gzip transparently, but
  // peekStreamForLimit refuses to inspect a compressed stream head — without
  // this header, compressing gateways silently disabled mid-stream key
  // rotation (the skip-branch below is kept only as a safety net).
  headers.set('accept-encoding', 'identity');
  return headers;
}

// Build the response headers we forward to the client. We drop content-encoding
// and content-length because Node's fetch already decoded the body, so echoing
// them would double-decompress / mislead the client (this was the /v1/models bug).
export function buildResponseHeaders(upstream: Response, isStream: boolean): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  if (isStream) {
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('connection', 'keep-alive');
  }

  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (lower.startsWith('anthropic-') || lower.startsWith('x-anthropic-')) {
      headers.set(name, value);
    }
  }
  return headers;
}

export function isHtmlOrMalformedText(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed === '') return true;
  const lower = trimmed.toLowerCase();
  if (
    trimmed.startsWith('<') ||
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    lower.includes('<head>') ||
    lower.includes('<body>')
  ) {
    return true;
  }
  return false;
}

export function validateNonStreamingResponseBody(text: string): {
  valid: boolean;
  reason?: string;
  payload?: unknown;
} {
  if (!text || text.trim() === '') {
    return { valid: false, reason: 'empty response body (0 bytes)' };
  }
  if (isHtmlOrMalformedText(text)) {
    return { valid: false, reason: 'HTML response (gateway/proxy challenge)' };
  }
  try {
    const payload = JSON.parse(text);
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'malformed JSON response' };
  }
}

export interface StreamPeekResult {
  // A limit error was detected before any assistant content reached the client.
  limited: boolean;
  // An HTML challenge or empty response was detected on HTTP 200 before content.
  malformed?: boolean;
  reason?: string;
  // The full stream to forward to the client (buffered head re-prepended),
  // or null when limited/malformed (caller should retry with the next key instead).
  stream: ReadableStream<Uint8Array> | null;
}

// Detect the SSE error events that mean "rotate": an `event: error` frame or a
// data payload whose type/message classifies as a limit error, AS LONG AS no
// content has been emitted yet. Returns the head chunks that were consumed.
// Bug #4 fix: use JSON-parsed type field instead of raw substring for content detection.
function detectLimitInSseText(text: string): { limited: boolean; sawContent: boolean } {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    try {
      const obj = JSON.parse(jsonStr);
      const type = obj?.type;
      // Content has started flowing — the boundary has passed, do not rotate.
      if (
        type === 'message_start' ||
        type === 'content_block_start' ||
        type === 'content_block_delta'
      ) {
        return { limited: false, sawContent: true };
      }
      if (type === 'error' && classifyErrorPayload(obj)) return { limited: true, sawContent: false };
      if (classifyErrorPayload(obj)) return { limited: true, sawContent: false };
    } catch {
      // Partial JSON at the buffer edge — ignore, we'll see it in the next chunk.
    }
  }
  return { limited: false, sawContent: false };
}

// Wrap the upstream stream. Peek the head (bounded by bytes + time) for an early
// limit error. If found before any content, signal the caller to rotate.
// Otherwise return a stream that replays the buffered head then pipes the rest.
//
// Boundary note: once assistant content has been emitted to the client we can
// no longer silently swap keys, so a mid-stream limit error after content is
// forwarded as-is (the request fails) but the key is still marked limited so the
// NEXT request rotates.
export async function peekStreamForLimit(
  upstream: Response,
): Promise<StreamPeekResult> {
  const body = upstream.body;
  if (!body) return { limited: false, malformed: true, reason: 'No response body', stream: null };

  // Bug #4 fix: if the upstream sent a compressed response despite our
  // accept-encoding: identity header, we cannot text-decode the stream to
  // detect SSE error frames. Skip the peek and forward the raw stream with
  // stall protection. The key will still get marked limited on the *next*
  // request if needed.
  const encoding = (upstream.headers.get('content-encoding') || '').toLowerCase();
  if (encoding && encoding !== 'identity') {
    const reader = body.getReader();
    return { limited: false, stream: createStallProtectedStream(reader) };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const headChunks: Uint8Array[] = [];
  let headText = '';
  let bufferedBytes = 0;
  const deadline = Date.now() + STREAM_PEEK_MS;

  let sawContent = false;
  let limited = false;
  let malformed = false;
  let malformedReason = '';

  while (bufferedBytes < STREAM_PEEK_BYTES && Date.now() < deadline) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    if (chunk.value) {
      headChunks.push(chunk.value);
      bufferedBytes += chunk.value.byteLength;
      headText += decoder.decode(chunk.value, { stream: true });

      if (isHtmlOrMalformedText(headText)) {
        malformed = true;
        malformedReason = 'HTML response on SSE stream (gateway/proxy challenge)';
        break;
      }

      const result = detectLimitInSseText(headText);
      if (result.limited) {
        limited = true;
        break;
      }
      if (result.sawContent) {
        sawContent = true;
        break;
      }
    }
  }

  // Check if stream closed with 0 bytes read
  if (bufferedBytes === 0 && !limited && !sawContent) {
    malformed = true;
    malformedReason = 'Empty stream response (0 bytes)';
  }

  if (limited && !sawContent) {
    // Discard the buffered error; caller will retry with the next key.
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return { limited: true, stream: null };
  }

  if (malformed && !sawContent) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return { limited: false, malformed: true, reason: malformedReason, stream: null };
  }

  // Replay buffered head, then pipe the remainder with stall timeout.
  const stream = createStallProtectedStream(reader, headChunks);

  return { limited: false, stream };
}

// Create a ReadableStream that replays buffered head chunks, then pumps the
// remainder from the reader. Implements stall timeout (Bug #11): if the
// UPSTREAM produces no chunk within STALL_TIMEOUT_MS of being asked, the
// stream is aborted.
//
// The pump is decoupled from the consumer's pull(): a slow client that stops
// reading (backpressure, desiredSize <= 0) merely parks the pump waiting for
// drain — its silence does not count against the stall timer. The previous
// shape reset the timer only inside pull(), so a client pausing for longer
// than the timeout killed a perfectly healthy upstream stream.
export function createStallProtectedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  headChunks: Uint8Array[] = [],
): ReadableStream<Uint8Array> {
  let closed = false;
  // Resolved when the client drains the queue enough for the pump to resume.
  let drainWaiters: Array<() => void> = [];

  function releaseDrainWaiters(): void {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // One read with a stall deadline. The timer measures upstream silence only:
  // while the pump is parked waiting for a slow client, no timer runs.
  function readWithStallTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Upstream stalled: no data received for ${STALL_TIMEOUT_MS / 1000}s`));
      }, STALL_TIMEOUT_MS);
      timer.unref?.();
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        // Backpressure: the client is not keeping up. Park WITHOUT a stall
        // timer — the upstream may have plenty of data buffered in the
        // reader; only its own silence counts as a stall.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          await new Promise<void>((resolve) => drainWaiters.push(resolve));
          if (closed) return;
          continue;
        }
        const result = await readWithStallTimeout();
        if (result.done) {
          controller.close();
          return;
        }
        if (result.value) controller.enqueue(result.value);
      }
    } catch (err) {
      if (closed) return;
      closed = true;
      try {
        controller.error(err);
      } catch {
        /* controller may already be closed */
      }
      reader.cancel('stall timeout').catch(() => {});
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of headChunks) controller.enqueue(c);
      void pump(controller);
    },
    // The client read from the queue — wake the pump if it is parked.
    pull() {
      releaseDrainWaiters();
    },
    cancel(reason) {
      closed = true;
      releaseDrainWaiters();
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Mark a key limited from response headers (429 or classified error body).
export function limitKeyFromHeaders(keyId: string, headers: Headers, group?: GroupConfig): void {
  markLimited(keyId, computeCooldownUntil(headers, group));
}

// ---------------------------------------------------------------------------
// Shared rotation classification (used by both /v1/messages and /v1/models —
// the two routes used to carry ~200 duplicated lines of this logic).
// ---------------------------------------------------------------------------

// Inspect a 429: key-level (cool it down), key-invalid, or IP-level (all keys
// share the machine's IP — the caller pauses the pool and returns the error
// instead of rotating). The payload rides along so the caller can forward it.
export type RateLimit429 =
  | { kind: 'invalid'; payload: unknown }
  | { kind: 'key-limited'; payload: unknown }
  | { kind: 'ip-level'; payload: unknown };

export async function classify429(upstream: Response): Promise<RateLimit429> {
  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    /* ignore */
  }
  if (classifyInvalidPayload(payload)) return { kind: 'invalid', payload };
  if (classifyErrorPayload(payload)) return { kind: 'key-limited', payload };
  return { kind: 'ip-level', payload };
}

// Inspect a non-OK (non-429/401/403) response: what should the rotation do?
export type UpstreamFailure =
  | { kind: 'invalid' } // error body says the key is revoked/billing-failed
  | { kind: 'limited' } // error body says rate/quota limit
  | { kind: 'provider' } // 5xx / transient — try next key
  | { kind: 'forward'; payload: unknown }; // genuine client error — return it

export async function classifyUpstreamFailure(upstream: Response): Promise<UpstreamFailure> {
  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    /* non-JSON error body */
  }
  if (classifyInvalidPayload(payload)) return { kind: 'invalid' };
  if (classifyErrorPayload(payload)) return { kind: 'limited' };
  if (upstream.status >= 500) return { kind: 'provider' };
  return { kind: 'forward', payload };
}

// Inspect a 401. Some relays (agentrouter.org) reject the *client*, not the
// key, when the request does not look like an approved CLI client:
// {"error":{"message":"unauthorized client detected, contact support..."}}.
// Rotating keys on that answer is wrong twice over: every key would fail
// identically, and a plain curl health-check would poison the whole pool with
// 1-hour invalid marks. The exact wording differs per upstream, so a list of
// client-rejection markers decides; anything else is an ordinary auth failure.
const CLIENT_REJECTED_401_PATTERNS: RegExp[] = [
  /unauthorized client/i, // agentrouter.org
  /unsupported client/i,
  /blocked client/i,
  /client (?:is )?(?:not|no) (?:allowed|authorized|permitted)/i,
  /client (?:rejected|forbidden|mismatch)/i,
  // A 401 that names the User-Agent is about the client by construction.
  /user[- ]agent/i,
];

export type Unauthorized401 =
  | { kind: 'client-rejected'; payload: unknown } // the client, not the key
  | { kind: 'key-invalid' }; // ordinary auth failure

export async function classify401(upstream: Response): Promise<Unauthorized401> {
  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    /* non-JSON body — treat as an ordinary auth failure */
  }
  const err = payload as { error?: { message?: string } | string; message?: string } | null;
  const message = typeof err?.error === 'string' ? err.error : err?.error?.message ?? err?.message ?? '';
  if (CLIENT_REJECTED_401_PATTERNS.some((re) => re.test(String(message)))) {
    return { kind: 'client-rejected', payload };
  }
  return { kind: 'key-invalid' };
}

// Network-level failures that indicate a problem with the group's URL (DNS,
// connection refused, unreachable host) rather than with the individual key.
// Such keys get a short provider-error cooldown so a dead group is skipped
// fast, instead of being retried as a "slow" last resort on every request.
const GROUP_LEVEL_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export function isGroupLevelNetworkError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return typeof code === 'string' && GROUP_LEVEL_NETWORK_CODES.has(code);
}

export function fetchErrorCode(err: unknown): string {
  return String((err as { cause?: { code?: string } } | null)?.cause?.code ?? 'unknown');
}
