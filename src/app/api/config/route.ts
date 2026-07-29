import { NextRequest, NextResponse } from 'next/server';
import {
  loadConfig,
  saveConfig,
  connectToClaude,
  disconnectFromClaude,
  buildConfigView,
  AppConfig,
  GroupConfig,
} from '@/lib/config';

export const dynamic = 'force-dynamic';

// Strip any runtime-only fields the client may echo back, keeping persisted shape.
function sanitizeGroups(groups: unknown): GroupConfig[] {
  if (!Array.isArray(groups)) return [];
  return groups.map((g: any) => ({
    id: String(g.id),
    name: String(g.name ?? 'Untitled'),
    targetUrl: String(g.targetUrl ?? ''),
    model: typeof g.model === 'string' && g.model ? g.model : undefined,
    rateLimitCooldownHours: typeof g.rateLimitCooldownHours === 'number' ? g.rateLimitCooldownHours : undefined,
    disabled: g.disabled === true ? true : undefined,
    keys: Array.isArray(g.keys)
      ? g.keys.map((k: Record<string, unknown>) => ({
          id: String(k.id),
          email: String(k.email ?? ''),
          key: String(k.key ?? ''),
          disabled: k.disabled === true ? true : undefined,
        }))
      : [],
  }));
}

export async function GET() {
  try {
    const config = loadConfig();
    return NextResponse.json(buildConfigView(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, config, activeGroupId } = body;
    let current: AppConfig = loadConfig();

    if (action === 'save') {
      if (config) {
        current = {
          ...current,
          groups: sanitizeGroups(config.groups),
          activeGroupId: config.activeGroupId ?? current.activeGroupId,
          selectedModel: typeof config.selectedModel === 'string' ? config.selectedModel : current.selectedModel,
        };
      }
      await saveConfig(current);
      if (current.isConnected) {
        try { connectToClaude(current); } catch { /* best-effort sync */ }
      }
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'setActiveGroup') {
      // Kept for dashboard display purposes — controls which group is shown
      // expanded in the UI. No longer affects proxy routing (flat pool).
      current = { ...current, activeGroupId: activeGroupId ?? null };
      await saveConfig(current);
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'connect') {
      current = connectToClaude(current);
      await saveConfig(current);
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'disconnect') {
      current = disconnectFromClaude(current);
      await saveConfig(current);
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'setModel') {
      const { selectedModel } = body;
      current = { ...current, selectedModel: typeof selectedModel === 'string' && selectedModel ? selectedModel : null };
      await saveConfig(current);
      if (current.isConnected) {
        try {
          current = connectToClaude(current);
          await saveConfig(current);
        } catch { /* best-effort sync */ }
      }
      return NextResponse.json(buildConfigView(current));
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
