import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

// Server-side live probe used by the dashboard "Test" button. It must run from
// the server process, not the browser: browsers cannot override the User-Agent
// header on fetch (it is a forbidden header name), and agentrouter rejects
// non-approved clients by UA — a browser-UA probe would 401 before any key is
// even tried. Looping back to our own /v1/messages exercises the full path
// (pool selection, key injection, upstream, rotation) exactly as Claude Code
// would see it.
// One probe at a time: parallel Test clicks (a second tab, a page reload)
// would each spend real upstream quota and, on a 429, quarantine a live key.
// Module-level on purpose — the server process is single-instance.
let probeInFlight = false;

export async function POST(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;

  if (probeInFlight) {
    return NextResponse.json(
      { ok: false, error: 'A test probe is already in progress — wait for it to finish' },
      { status: 409 },
    );
  }

  const config = loadConfig();
  if (!config.selectedModel) {
    return NextResponse.json(
      { error: 'No model selected. Pick a model in the header first.' },
      { status: 400 },
    );
  }

  // Probe our own /v1/messages through the origin the dashboard reached us
  // on — the listener's real port. process.env.PORT is the wrong source
  // here: `next start -p 9999` overrides it, so an exported PORT would send
  // the probe to a wrong (or someone else's) local service.
  const origin = new URL(req.url).origin;
  const controller = new AbortController();
  // If the dashboard tab goes away, abort the probe: without this the
  // rotation behind /v1/messages keeps cycling keys and quarantines long
  // after the client stopped waiting.
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 120_000);
  probeInFlight = true;
  const started = Date.now();
  try {
    const res = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        // agentrouter's client filter approves claude-cli; the dashboard
        // cannot send this header itself, so the probe runs here.
        'User-Agent': 'claude-cli/2.0.0 (external, cli)',
        'x-app': 'cli',
      },
      body: JSON.stringify({
        model: config.selectedModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Reply with one word: ok' }],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const reason =
        data?.error?.message ?? (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
      return NextResponse.json({ ok: false, status: res.status, latencyMs, error: reason });
    }

    const text = Array.isArray(data?.content)
      ? data.content
          .filter((b: { type?: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('')
          .trim()
      : '';
    return NextResponse.json({
      ok: true,
      status: res.status,
      model: data?.model ?? config.selectedModel,
      stopReason: data?.stop_reason ?? null,
      latencyMs,
      text: text.slice(0, 80),
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? req.signal.aborted
          ? 'Probe aborted (dashboard tab closed)'
          : 'Probe timed out after 120s'
        : err instanceof Error
          ? err.message
          : 'Probe failed';
    return NextResponse.json({ ok: false, error: message });
  } finally {
    probeInFlight = false;
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onClientAbort);
  }
}
