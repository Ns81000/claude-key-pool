import { NextRequest, NextResponse } from 'next/server';
import {
  getActivitySnapshot,
  clearActivityLog,
  resetKeyStats,
} from '@/lib/activity';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

// Dashboard activity feed: the recent-request log (in-memory ring buffer)
// and cumulative per-key statistics (persisted in stats.json). Read-only for
// the proxy itself — the routes in /v1/* write to the same store, this
// endpoint only reads it.
export async function GET(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;

  const limitRaw = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 150;
  return NextResponse.json(getActivitySnapshot(limit));
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;

  try {
    const { action } = await req.json();
    if (action === 'clearLogs') {
      clearActivityLog();
      return NextResponse.json(getActivitySnapshot(150));
    }
    if (action === 'resetStats') {
      resetKeyStats();
      return NextResponse.json(getActivitySnapshot(150));
    }
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
