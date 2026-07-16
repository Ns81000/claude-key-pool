import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, markInvalid, markKeySlow, markLimited } from '@/lib/config';
import {
  CONNECT_TIMEOUT_MS,
  buildResponseHeaders,
  buildUpstreamHeaders,
  classifyErrorPayload,
  computeCooldownUntil,
  limitKeyFromHeaders,
  peekStreamForLimit,
  selectActiveKeys,
} from '@/lib/proxy';

export const dynamic = 'force-dynamic';

function errorJson(type: string, message: string, status: number) {
  return NextResponse.json({ error: { type, message } }, { status });
}

export async function POST(req: NextRequest) {
  const config = loadConfig();

  // Try to find the active group, fall back to the first group if not selected/found
  let activeGroup = config.activeGroupId
    ? config.groups.find((g) => g.id === config.activeGroupId)
    : undefined;

  if (!activeGroup && config.groups.length > 0) {
    activeGroup = config.groups[0];
  }

  if (!activeGroup) {
    return errorJson(
      'invalid_request_error',
      'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.',
      400,
    );
  }

  // Ordered list of groups starting from the active group
  const orderedGroups = [
    activeGroup,
    ...config.groups.filter((g) => g.id !== activeGroup!.id),
  ];

  // Read the raw body once. We must inspect `stream`, so parse a copy but forward
  // the original bytes to avoid re-serializing large payloads.
  const rawBody = await req.arrayBuffer();
  let isStream = false;
  try {
    isStream = JSON.parse(new TextDecoder().decode(rawBody))?.stream === true;
  } catch {
    return errorJson('invalid_request_error', 'Failed to parse request JSON.', 400);
  }

  let totalCandidatesTried = 0;
  let totalTransientFailures = 0;

  for (const group of orderedGroups) {
    const candidates = selectActiveKeys(group);
    if (candidates.length === 0) {
      continue;
    }

    if (!group.targetUrl) {
      console.warn(`Group ${group.name} has no target URL configured. Skipping.`);
      continue;
    }

    const targetUrl = `${group.targetUrl.replace(/\/$/, '')}/v1/messages`;

    for (const key of candidates) {
      totalCandidatesTried++;
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
        if (req.signal.aborted) {
          console.warn(`Client aborted request during fetch for ${key.email}. Stopping rotation.`);
          return new Response('Client aborted', { status: 499 });
        }

        const isTimeout = err && (err as any).name === 'AbortError';
        if (isTimeout) {
          markKeySlow(key.id);
          console.warn(`Key ${key.email} timed out after ${CONNECT_TIMEOUT_MS}ms. Rotating.`);
        } else {
          console.warn(`Key ${key.email}: upstream fetch failed (transient). Rotating. Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        totalTransientFailures++;
        continue;
      }
      clearTimeout(connectTimer);

      // 429 → limited, honor retry-after, rotate.
      if (upstream.status === 429) {
        limitKeyFromHeaders(key.id, upstream.headers);
        console.warn(`Key ${key.email}: 429 rate limit. Rotating.`);
        continue;
      }

      // Auth failure → invalid, do not auto-recover, rotate.
      if (upstream.status === 401 || upstream.status === 403) {
        markInvalid(key.id);
        console.warn(`Key ${key.email}: ${upstream.status} invalid. Rotating.`);
        continue;
      }

      // Other non-OK: classify body; if a limit error, rotate. 5xx → transient.
      if (!upstream.ok) {
        let payload: unknown = null;
        try {
          payload = await upstream.clone().json();
        } catch {
          /* non-JSON error body */
        }
        if (classifyErrorPayload(payload)) {
          markLimited(key.id, computeCooldownUntil(upstream.headers));
          console.warn(`Key ${key.email}: limit error in body. Rotating.`);
          continue;
        }
        if (upstream.status >= 500) {
          totalTransientFailures++;
          console.warn(`Key ${key.email}: ${upstream.status} upstream. Rotating.`);
          continue;
        }
        // Genuine client error (400 etc.) — forward to the client unchanged.
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: buildResponseHeaders(upstream, false),
        });
      }

      // Success path.
      if (isStream) {
        const peek = await peekStreamForLimit(upstream);
        if (peek.limited) {
          limitKeyFromHeaders(key.id, upstream.headers);
          console.warn(`Key ${key.email}: mid-stream limit before content. Rotating.`);
          continue;
        }
        return new Response(peek.stream, {
          status: 200,
          headers: buildResponseHeaders(upstream, true),
        });
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: buildResponseHeaders(upstream, false),
      });
    }
  }

  // Exhausted all candidates across all groups.
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
