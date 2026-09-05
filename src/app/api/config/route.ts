import { NextRequest, NextResponse } from 'next/server';
import {
  loadConfig,
  mutateConfig,
  StaleConfigVersionError,
  connectToClaude,
  disconnectFromClaude,
  connectToKilo,
  disconnectFromKilo,
  buildConfigView,
  AppConfig,
  GroupConfig,
  resetKeysStatus,
} from '@/lib/config';
import { rejectCrossSiteRequest } from '@/lib/localGuard';
import { triggerKiloReload } from '@/lib/kiloReload';

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

export async function GET(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;
  try {
    const config = loadConfig();
    return NextResponse.json(buildConfigView(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;
  try {
    const body = await req.json();
    const { action, config, activeGroupId } = body;

    // Every action below runs its read-modify-write through mutateConfig:
    // the read, the mutation, and the write are one serialized step, so two
    // overlapping POSTs cannot both start from the same old version and
    // silently overwrite each other.
    if (action === 'save') {
      // Optimistic concurrency for the one action whose payload is a full
      // snapshot: the client echoes the configVersion it edited; a mismatch
      // means the config changed since (another tab, or this tab's stale
      // poll), and saving that snapshot would erase those changes — e.g. a
      // key added in another tab. The version check runs INSIDE the write
      // chain step (mutateConfig), not here: checked outside the chain,
      // another write can land between the check and this save's turn —
      // the check would pass against a version that is already stale.
      try {
        const current = await mutateConfig(
          (cfg: AppConfig) => {
            if (config) {
              cfg.groups = sanitizeGroups(config.groups);
              cfg.activeGroupId = config.activeGroupId ?? cfg.activeGroupId;
              if (typeof config.selectedModel === 'string') {
                cfg.selectedModel = config.selectedModel || null;
              }
              // Symmetric with selectedModel: '' clears the fast model.
              if (typeof config.smallFastModel === 'string') {
                cfg.smallFastModel = config.smallFastModel || null;
              } else if (config.smallFastModel === null) {
                cfg.smallFastModel = null;
              }
            }
            if (cfg.isConnected) {
              try { connectToClaude(cfg); } catch { /* best-effort env sync */ }
            }
          },
          config && typeof config.configVersion === 'number'
            ? config.configVersion
            : undefined,
        );
        return NextResponse.json(buildConfigView(current));
      } catch (error) {
        if (error instanceof StaleConfigVersionError) {
          return NextResponse.json(
            { error: 'Configuration was changed by another tab or action — reloaded, retry your edit' },
            { status: 409 },
          );
        }
        throw error;
      }
    }

    if (action === 'setActiveGroup') {
      // Kept for dashboard display purposes — controls which group is shown
      // expanded in the UI. No longer affects proxy routing (flat pool).
      const current = await mutateConfig((cfg) => {
        cfg.activeGroupId = activeGroupId ?? null;
      });
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'resetGroupRateLimit') {
      // Runtime key state only — no config write needed.
      const current = loadConfig();
      const { groupId } = body;
      const group = current.groups.find(g => g.id === groupId);
      if (group) {
        resetKeysStatus(group.keys.map(k => k.id));
      }
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'connect') {
      const current = await mutateConfig((cfg) => {
        connectToClaude(cfg); // throws before writing on failure
      });
      return NextResponse.json(buildConfigView(current));
    }

    if (action === 'disconnect') {
      const current = await mutateConfig((cfg) => {
        disconnectFromClaude(cfg);
      });
      return NextResponse.json(buildConfigView(current));
    }

    // Kilo Code profile — independent of the Claude CLI one: both may be
    // connected at once, either alone, or neither. Same pool, same port.
    // After kilo.jsonc is written, the running Kilo server is told to
    // re-read it (the plugin's "Reload" button logic), so the model list
    // in the session window updates without a manual reload. Best-effort:
    // the outcome is reported alongside the config, never fatal.
    if (action === 'kiloConnect') {
      const current = await mutateConfig((cfg) => {
        connectToKilo(cfg); // throws before writing on failure
      });
      const kiloReload = await triggerKiloReload();
      return NextResponse.json({ ...buildConfigView(current), kiloReload });
    }

    if (action === 'kiloDisconnect') {
      const current = await mutateConfig((cfg) => {
        disconnectFromKilo(cfg);
      });
      const kiloReload = await triggerKiloReload();
      return NextResponse.json({ ...buildConfigView(current), kiloReload });
    }

    if (action === 'setModel') {
      // Each model field is optional: the dashboard updates the main model and
      // the small/fast model through independent dropdowns. No fields at all —
      // nothing to change, no write.
      const hasMain = 'selectedModel' in body;
      const hasFast = 'smallFastModel' in body;
      if (!hasMain && !hasFast) {
        return NextResponse.json(buildConfigView(loadConfig()));
      }
      const current = await mutateConfig((cfg) => {
        if (hasMain) {
          cfg.selectedModel = typeof body.selectedModel === 'string' && body.selectedModel
            ? body.selectedModel
            : null;
        }
        if (hasFast) {
          cfg.smallFastModel = typeof body.smallFastModel === 'string' && body.smallFastModel
            ? body.smallFastModel
            : null;
        }
        if (cfg.isConnected) {
          try { connectToClaude(cfg); } catch { /* best-effort env sync */ }
        }
      });
      return NextResponse.json(buildConfigView(current));
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
