import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, markInvalid } from '@/lib/config';
import {
  CONNECT_TIMEOUT_MS,
  buildResponseHeaders,
  buildUpstreamHeaders,
  classifyErrorPayload,
  computeCooldownUntil,
  limitKeyFromHeaders,
  selectActiveKeys,
} from '@/lib/proxy';
import { markLimited } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const config = loadConfig();

  if (!config.activeGroupId) {
    return NextResponse.json({ error: 'No active group selected' }, { status: 400 });
  }

  const group = config.groups.find((g) => g.id === config.activeGroupId);
  if (!group || group.keys.length === 0) {
    return NextResponse.json({ error: 'No keys configured in active group' }, { status: 400 });
  }

  const candidates = selectActiveKeys(group);
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'All keys are rate-limited or invalid' }, { status: 429 });
  }

  const targetUrl = `${group.targetUrl.replace(/\/$/, '')}/v1/models`;
  let transientFailures = 0;

  for (const key of candidates) {
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
        break;
      }
      transientFailures++;
      continue;
    }
    clearTimeout(timer);

    if (upstream.status === 429) {
      limitKeyFromHeaders(key.id, upstream.headers);
      continue;
    }
    if (upstream.status === 401 || upstream.status === 403) {
      markInvalid(key.id);
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
        continue;
      }
      if (upstream.status >= 500) {
        transientFailures++;
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

  if (transientFailures > 0) {
    return NextResponse.json({ error: 'Upstream models request failed' }, { status: 502 });
  }
  return NextResponse.json({ error: 'All keys exhausted' }, { status: 429 });
}
