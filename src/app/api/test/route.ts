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
export async function POST(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;

  const config = loadConfig();
  if (!config.selectedModel) {
    return NextResponse.json(
      { error: 'No model selected. Pick a model in the header first.' },
      { status: 400 },
    );
  }

  const port = process.env.PORT || 9999;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
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
        ? 'Probe timed out after 120s'
        : err instanceof Error
          ? err.message
          : 'Probe failed';
    return NextResponse.json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
}
