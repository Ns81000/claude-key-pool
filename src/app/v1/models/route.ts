import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, markInvalid, markKeySlow, markLimited } from '@/lib/config';
import {
  CONNECT_TIMEOUT_MS,
  buildResponseHeaders,
  buildUpstreamHeaders,
  classifyErrorPayload,
  computeCooldownUntil,
  limitKeyFromHeaders,
  selectActiveKeys,
} from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const config = loadConfig();

  // Try to find the active group, fall back to the first group if not selected/found
  let activeGroup = config.activeGroupId
    ? config.groups.find((g) => g.id === config.activeGroupId)
    : undefined;

  if (!activeGroup && config.groups.length > 0) {
    activeGroup = config.groups[0];
  }

  if (!activeGroup) {
    return NextResponse.json(
      { error: 'No groups or keys configured in Claude Key Pool. Open http://localhost:9999 and configure them.' },
      { status: 400 }
    );
  }

  // Ordered list of groups starting from the active group
  const orderedGroups = [
    activeGroup,
    ...config.groups.filter((g) => g.id !== activeGroup!.id),
  ];

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

    const targetUrl = `${group.targetUrl.replace(/\/$/, '')}/v1/models`;

    for (const key of candidates) {
      totalCandidatesTried++;
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
        if (req.signal.aborted) {
          console.warn(`Client aborted request during models fetch for ${key.email}. Stopping rotation.`);
          return new Response('Client aborted', { status: 499 });
        }

        const isTimeout = err && (err as any).name === 'AbortError';
        if (isTimeout) {
          markKeySlow(key.id);
          console.warn(`Key ${key.email} models fetch timed out after ${CONNECT_TIMEOUT_MS}ms. Rotating.`);
        } else {
          console.warn(`Key ${key.email}: models fetch failed (transient). Rotating. Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        totalTransientFailures++;
        continue;
      }
      clearTimeout(timer);

      if (upstream.status === 429) {
        limitKeyFromHeaders(key.id, upstream.headers);
        console.warn(`Key ${key.email}: models fetch 429 rate limit. Rotating.`);
        continue;
      }
      if (upstream.status === 401 || upstream.status === 403) {
        markInvalid(key.id);
        console.warn(`Key ${key.email}: models fetch ${upstream.status} invalid. Rotating.`);
        continue;
      }
      if (!upstream.ok) {
        let payload: unknown = null;
        try {
          payload = await upstream.clone().json();
        } catch {
          /* non-JSON */
        }
        if (classifyErrorPayload(payload)) {
          markLimited(key.id, computeCooldownUntil(upstream.headers));
          console.warn(`Key ${key.email}: models fetch limit error in body. Rotating.`);
          continue;
        }
        if (upstream.status >= 500) {
          totalTransientFailures++;
          console.warn(`Key ${key.email}: models fetch ${upstream.status} upstream. Rotating.`);
          continue;
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: buildResponseHeaders(upstream, false),
        });
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream, false),
      });
    }
  }

  if (totalCandidatesTried === 0) {
    return NextResponse.json({ error: 'All keys are rate-limited or invalid' }, { status: 429 });
  }

  if (totalTransientFailures > 0 && totalTransientFailures === totalCandidatesTried) {
    return NextResponse.json({ error: 'Upstream models request failed' }, { status: 502 });
  }
  return NextResponse.json({ error: 'All keys exhausted' }, { status: 429 });
}
