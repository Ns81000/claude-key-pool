import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

// Machine-readable model catalog for local clients (Aiagent). Read-only,
// derived from the same config the dashboard serves: enabled groups only,
// deduplicated by model id. NEVER includes keys, emails, or target URLs —
// those stay in the dashboard behind the same localGuard.
export async function GET(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;

  const config = loadConfig();
  const seen = new Set<string>();
  const models: Array<{ model: string; name: string }> = [];
  for (const group of config.groups) {
    if (group.disabled || !group.model) continue;
    if (seen.has(group.model)) continue;
    seen.add(group.model);
    models.push({ model: group.model, name: group.name });
  }
  return NextResponse.json({ models });
}
