import { NextRequest, NextResponse } from 'next/server';

// Drive-by guard for dashboard endpoints. Any website open in a browser can
// fire a "simple" cross-site POST (content-type: text/plain skips the CORS
// preflight entirely), and POST /api/config can rewrite group target URLs —
// after which every request would silently ship a pool key to the attacker's
// server. Browsers always attach Origin / Sec-Fetch-Site to cross-site
// requests, so we reject on those; header-less clients (curl, the CLI)
// pass through untouched.
//
// Host pinning: Origin==Host alone does not stop DNS rebinding (an
// attacker's domain resolving to 127.0.0.1 makes BOTH headers carry that
// domain, and GET /api/config returns unmasked key values). The listener is
// bound to 127.0.0.1, so every legitimate request arrives on a loopback
// Host; anything else is a rebinding probe.
export function rejectCrossSiteRequest(req: NextRequest): NextResponse | null {
  const host = (req.headers.get('host') || '').toLowerCase();
  // Strip the port, honoring the bracketed IPv6 form ("[::1]:9999").
  const ipv6 = host.match(/^\[([^\]]+)\]/);
  const hostName = ipv6 ? ipv6[1] : host.split(':')[0];
  if (hostName !== 'localhost' && hostName !== '127.0.0.1' && hostName !== '::1') {
    return NextResponse.json({ error: 'non-loopback host rejected' }, { status: 403 });
  }

  const origin = req.headers.get('origin');
  if (origin) {
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
