import { NextRequest, NextResponse } from 'next/server';

// Drive-by guard for dashboard endpoints. Any website open in a browser can
// fire a "simple" cross-site POST (content-type: text/plain skips the CORS
// preflight entirely), and POST /api/config can rewrite group target URLs —
// after which every request would silently ship a pool key to the attacker's
// server. Browsers always attach Origin / Sec-Fetch-Site to cross-site
// requests, so we reject on those; header-less clients (curl, the CLI)
// pass through untouched.
export function rejectCrossSiteRequest(req: NextRequest): NextResponse | null {
  const origin = req.headers.get('origin');
  if (origin) {
    const host = (req.headers.get('host') || '').toLowerCase();
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" (sandboxed iframe) or garbage — not a local origin.
      originHost = '';
    }
    if (!originHost || originHost !== host) {
      return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 });
    }
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return NextResponse.json({ error: 'cross-site request rejected' }, { status: 403 });
  }
  return null;
}
