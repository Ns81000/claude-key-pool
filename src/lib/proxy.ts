import {
  GroupConfig,
  KeyConfig,
  getKeyState,
  markLimited,
  proxyState,
  recordTokenUsage,
} from './config';

// Connect / first-byte timeout. There is intentionally no hard cap on total
// stream duration (long completions are normal), but we abort if the upstream
// produces no bytes for STALL_TIMEOUT_MS.
export const CONNECT_TIMEOUT_MS = 30_000;
export const STALL_TIMEOUT_MS = 120_000;
export const DEFAULT_COOLDOWN_MS = 14_400_000; // 4 hours
export const SLOW_KEY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// How much of a stream we are willing to buffer while looking for an early
// error event before we give up and start forwarding to the client.
export const STREAM_PEEK_BYTES = 16 * 1024;
export const STREAM_PEEK_MS = 8_000;

// Strings/types that mean "this key is out of budget → rotate to the next".
const LIMIT_ERROR_TYPES = ['rate_limit_error', 'overloaded_error'];
const LIMIT_ERROR_SUBSTRINGS = [
  'rate limit',
  'quota',
  'credit',
  'usage limit',
  'token limit',
  'insufficient',
  'exhausted',
  'overloaded',
];

export function isLimitError(errType?: string, errMsg?: string): boolean {
  const t = (errType || '').toLowerCase();
  const m = (errMsg || '').toLowerCase();
  if (t && LIMIT_ERROR_TYPES.includes(t)) return true;
  if (m && LIMIT_ERROR_SUBSTRINGS.some((s) => m.includes(s))) return true;
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

// Compute cooldown end (ms epoch) from response headers, honoring retry-after
// and anthropic ratelimit reset headers, falling back to a sane default.
export function computeCooldownUntil(headers: Headers): number {
  const now = Date.now();

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
        // Reset headers are usually a unix timestamp; treat large values as epoch.
        return secs > 1e6 ? secs * 1000 : now + secs * 1000;
      }
      const dateMs = Date.parse(value);
      if (Number.isFinite(dateMs)) return Math.max(now + 1000, dateMs);
    }
  }

  return now + DEFAULT_COOLDOWN_MS;
}

// Round-robin over currently-active keys. Uses runtime state only.
export function selectActiveKeys(group: GroupConfig): KeyConfig[] {
  const active = group.keys.filter((k) => getKeyState(k.id).status === 'active');
  if (active.length === 0) return [];

  const now = Date.now();
  const fast: KeyConfig[] = [];
  const slow: KeyConfig[] = [];

  for (const k of active) {
    const st = getKeyState(k.id);
    const lastTimeout = st.lastTimeoutTime || 0;
    // Keys that timed out in the last SLOW_KEY_WINDOW_MS are treated as slow
    if (now - lastTimeout < SLOW_KEY_WINDOW_MS) {
      slow.push(k);
    } else {
      fast.push(k);
    }
  }

  // Prioritize fast keys; fall back to slow keys only if no fast keys exist
  const candidates = fast.length > 0 ? fast : slow;

  if (candidates.length <= 1) return candidates;
  const start = proxyState.rrCursor % candidates.length;
  proxyState.rrCursor = (proxyState.rrCursor + 1) % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}

// Build the upstream request headers: copy client headers minus hop-by-hop and
// auth, inject the pool key, and force identity encoding.
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
      lower === 'accept-encoding'
    ) {
      continue;
    }
    headers.set(name, value);
  }
  headers.set('x-api-key', apiKey);
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

export interface StreamPeekResult {
  // A limit error was detected before any assistant content reached the client.
  limited: boolean;
  // The full stream to forward to the client (buffered head re-prepended),
  // or null when limited (caller should retry with the next key instead).
  stream: ReadableStream<Uint8Array> | null;
}

// Detect the SSE error events that mean "rotate": an `event: error` frame or a
// data payload whose type/message classifies as a limit error, AS LONG AS no
// content has been emitted yet. Returns the head chunks that were consumed.
function detectLimitInSseText(text: string): boolean {
  // SSE frames are separated by blank lines. Scan each data: line for a limit
  // error before any message_start / content_block has appeared.
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
        return false;
      }
      if (type === 'error' && classifyErrorPayload(obj)) return true;
      if (classifyErrorPayload(obj)) return true;
    } catch {
      // Partial JSON at the buffer edge — ignore, we'll see it in the next chunk.
    }
  }
  return false;
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
  if (!body) return { limited: false, stream: null };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const headChunks: Uint8Array[] = [];
  let headText = '';
  let bufferedBytes = 0;
  const deadline = Date.now() + STREAM_PEEK_MS;

  let sawContent = false;
  let limited = false;

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

      if (detectLimitInSseText(headText)) {
        limited = true;
        break;
      }
      if (
        headText.includes('message_start') ||
        headText.includes('content_block')
      ) {
        sawContent = true;
        break;
      }
    }
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

  // Replay buffered head, then pipe the remainder of the upstream stream.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of headChunks) controller.enqueue(c);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });

  return { limited: false, stream };
}

// Mark a key limited from response headers (429 or classified error body).
export function limitKeyFromHeaders(keyId: string, headers: Headers): void {
  markLimited(keyId, computeCooldownUntil(headers));
}

function parseSseLineForUsage(line: string, keyId: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const jsonStr = trimmed.slice(5).trim();
  if (!jsonStr || jsonStr === '[DONE]') return;
  try {
    const obj = JSON.parse(jsonStr);
    if (obj.usage) {
      const input = obj.usage.input_tokens || 0;
      const output = obj.usage.output_tokens || 0;
      if (input > 0 || output > 0) {
        recordTokenUsage(keyId, input, output);
      }
    } else if (obj.message?.usage) {
      const input = obj.message.usage.input_tokens || 0;
      const output = obj.message.usage.output_tokens || 0;
      if (input > 0 || output > 0) {
        recordTokenUsage(keyId, input, output);
      }
    }
  } catch {
    // Ignore partial lines at chunk boundaries
  }
}

export function trackStreamUsage(
  stream: ReadableStream<Uint8Array>,
  keyId: string
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            parseSseLineForUsage(buffer, keyId);
          }
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            parseSseLineForUsage(line, keyId);
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    }
  });
}
