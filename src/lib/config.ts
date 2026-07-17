import fs from 'fs';
import path from 'path';
import os from 'os';

export type KeyStatus = 'active' | 'rate-limited' | 'invalid';

// Persisted key: user-authored data only. No stats.
export interface KeyConfig {
  id: string;
  email: string;
  key: string;
}

export interface GroupConfig {
  id: string;
  name: string;
  targetUrl: string;
  keys: KeyConfig[];
  rateLimitCooldownHours?: number;
}

export interface AppConfig {
  activeGroupId: string | null;
  groups: GroupConfig[];
  isConnected: boolean;
  backupSettings: string | null;
}

// Key with live runtime status merged in — what the dashboard consumes.
export interface KeyView extends KeyConfig {
  status: KeyStatus;
  cooldownUntil: string | null;
  inFlight: number;
  groupName: string;
}

export interface GroupView extends Omit<GroupConfig, 'keys'> {
  keys: KeyView[];
}

export interface AppConfigView extends Omit<AppConfig, 'groups'> {
  groups: GroupView[];
  poolStats: PoolStats;
}

export interface PoolStats {
  totalKeys: number;
  activeKeys: number;
  rateLimitedKeys: number;
  invalidKeys: number;
  totalInFlight: number;
}

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');
const CONFIG_TMP_PATH = CONFIG_FILE_PATH + '.tmp';
const CONFIG_BACKUP_PATH = path.join(process.cwd(), 'config.backup.json');
const CLAUDE_SETTINGS_PATH =
  process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');

const DEFAULT_CONFIG: AppConfig = {
  activeGroupId: null,
  groups: [],
  isConnected: false,
  backupSettings: null,
};

// Volatile runtime state — the source of truth for rotation while the server
// runs. Never persisted. Kept on `global` so it survives Next dev hot-reloads.
export interface RuntimeKeyState {
  status: KeyStatus;
  cooldownUntil: number | null; // ms epoch, only meaningful when rate-limited
  lastTimeoutTime?: number;
  inFlight: number; // number of in-flight requests currently using this key
}

interface GlobalProxyState {
  keys: Record<string, RuntimeKeyState>; // keyId -> state
  roundRobinIndex: number; // flat-pool round-robin pointer
  // Cached parsed config + invalidation metadata
  configCache: AppConfig | null;
  configMtimeMs: number;
  configVersion: number; // bumped on every dashboard write
  cachedVersion: number; // version the cache was built at
  writeChain: Promise<void>; // serializes config writes
}

const globalForProxy = global as unknown as { proxyState?: GlobalProxyState };
if (!globalForProxy.proxyState) {
  globalForProxy.proxyState = {
    keys: {},
    roundRobinIndex: -1,
    configCache: null,
    configMtimeMs: 0,
    configVersion: 0,
    cachedVersion: 0,
    writeChain: Promise.resolve(),
  };
}
export const proxyState = globalForProxy.proxyState;

function readConfigFromDisk(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(data) as Partial<AppConfig> & {
        groups?: Array<Partial<GroupConfig> & { keys?: Array<Record<string, unknown>> }>;
      };
      // Migrate: strip any stats fields that may exist in an older config.json.
      const groups: GroupConfig[] = (parsed.groups || []).map((g: any) => ({
        id: String(g.id),
        name: String(g.name ?? 'Untitled'),
        targetUrl: String(g.targetUrl ?? ''),
        rateLimitCooldownHours: typeof g.rateLimitCooldownHours === 'number' ? g.rateLimitCooldownHours : undefined,
        keys: (g.keys || []).map((k: any) => ({
          id: String(k.id),
          email: String(k.email ?? ''),
          key: String(k.key ?? ''),
        })),
      }));
      return {
        activeGroupId: parsed.activeGroupId ?? null,
        groups,
        isConnected: parsed.isConnected ?? false,
        backupSettings: parsed.backupSettings ?? null,
      };
    }
  } catch (error) {
    console.error('Error loading config, returning defaults:', error);
  }
  return { ...DEFAULT_CONFIG };
}

// Fast config read: re-parse only when the file mtime changed or a dashboard
// write bumped the in-memory version. The hot request path calls this.
export function loadConfig(): AppConfig {
  // Fast path: if configVersion matches cachedVersion and we have a cache,
  // skip the filesystem stat entirely (Bug #8 optimization).
  if (
    proxyState.configCache &&
    proxyState.cachedVersion === proxyState.configVersion &&
    proxyState.configMtimeMs > 0
  ) {
    return proxyState.configCache;
  }

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(CONFIG_FILE_PATH).mtimeMs;
  } catch {
    mtimeMs = 0;
  }

  const stale =
    !proxyState.configCache ||
    proxyState.configMtimeMs !== mtimeMs ||
    proxyState.cachedVersion !== proxyState.configVersion;

  if (stale) {
    proxyState.configCache = readConfigFromDisk();
    proxyState.configMtimeMs = mtimeMs;
    proxyState.cachedVersion = proxyState.configVersion;
  }
  return proxyState.configCache!;
}

// Runtime state helpers ------------------------------------------------------

export function getKeyState(keyId: string): RuntimeKeyState {
  let st = proxyState.keys[keyId];
  if (!st) {
    st = { status: 'active', cooldownUntil: null, inFlight: 0 };
    proxyState.keys[keyId] = st;
  }
  // Auto-recover from cooldown.
  if (st.status === 'rate-limited' && st.cooldownUntil && Date.now() > st.cooldownUntil) {
    st.status = 'active';
    st.cooldownUntil = null;
  }
  return st;
}

export function markLimited(keyId: string, cooldownUntilMs: number): void {
  const st = getKeyState(keyId);
  st.status = 'rate-limited';
  st.cooldownUntil = cooldownUntilMs;
}

export function markInvalid(keyId: string): void {
  const st = getKeyState(keyId);
  st.status = 'invalid';
  st.cooldownUntil = null;
}

export function markProviderError(keyId: string): void {
  const st = getKeyState(keyId);
  st.status = 'rate-limited';
  st.cooldownUntil = Date.now() + 5 * 60 * 1000; // 5 minute cooldown
}

export function markKeySlow(keyId: string): void {
  const st = getKeyState(keyId);
  st.lastTimeoutTime = Date.now();
}

export function incrementInFlight(keyId: string): void {
  const st = getKeyState(keyId);
  st.inFlight++;
}

export function decrementInFlight(keyId: string): void {
  const st = getKeyState(keyId);
  if (st.inFlight > 0) st.inFlight--;
}

export function keyStatusView(keyId: string): { status: KeyStatus; cooldownUntil: string | null; inFlight: number } {
  const st = getKeyState(keyId);
  return {
    status: st.status,
    cooldownUntil: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
    inFlight: st.inFlight,
  };
}

// Build the dashboard-facing view, merging live runtime status into the keys.
export function buildConfigView(config: AppConfig): AppConfigView {
  let totalKeys = 0;
  let activeKeys = 0;
  let rateLimitedKeys = 0;
  let invalidKeys = 0;
  let totalInFlight = 0;

  const groups = config.groups.map((g) => ({
    ...g,
    keys: g.keys.map((k) => {
      const view = keyStatusView(k.id);
      totalKeys++;
      if (view.status === 'active') activeKeys++;
      else if (view.status === 'rate-limited') rateLimitedKeys++;
      else if (view.status === 'invalid') invalidKeys++;
      totalInFlight += view.inFlight;
      return { ...k, ...view, groupName: g.name };
    }),
  }));

  return {
    ...config,
    groups,
    poolStats: { totalKeys, activeKeys, rateLimitedKeys, invalidKeys, totalInFlight },
  };
}

// Persistence ---------------------------------------------------------------

function countKeys(config: AppConfig): number {
  return config.groups.reduce((n, g) => n + g.keys.length, 0);
}

function writeConfigAtomic(config: AppConfig): void {
  // Safety net: if this write would shrink the stored key set, keep a backup
  // of the previous file so keys can never be silently lost.
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const prev = readConfigFromDisk();
      if (countKeys(prev) > countKeys(config)) {
        fs.copyFileSync(CONFIG_FILE_PATH, CONFIG_BACKUP_PATH);
      }
    }
  } catch {
    /* backup is best-effort */
  }
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_TMP_PATH, data, 'utf-8');
  fs.renameSync(CONFIG_TMP_PATH, CONFIG_FILE_PATH);
}

// Serialize all config writes through an in-process chain so concurrent
// dashboard actions cannot clobber each other. The proxy never calls this.
export function saveConfig(config: AppConfig): Promise<void> {
  const run = proxyState.writeChain.then(() => {
    writeConfigAtomic(config);
    proxyState.configCache = config;
    proxyState.configVersion += 1;
    proxyState.cachedVersion = proxyState.configVersion;
    try {
      proxyState.configMtimeMs = fs.statSync(CONFIG_FILE_PATH).mtimeMs;
    } catch {
      proxyState.configMtimeMs = 0;
    }
  });
  // Keep the chain alive even if one write throws.
  proxyState.writeChain = run.catch(() => {});
  return run;
}

// Claude CLI integration -----------------------------------------------------

export function connectToClaude(config: AppConfig): AppConfig {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    throw new Error(`Claude settings file not found at ${CLAUDE_SETTINGS_PATH}`);
  }

  const originalContent = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
  let settingsJson: Record<string, unknown> & { env?: Record<string, string> };
  try {
    settingsJson = JSON.parse(originalContent);
  } catch {
    throw new Error('Claude settings.json contains invalid JSON.');
  }

  if (!config.isConnected || !config.backupSettings) {
    config.backupSettings = originalContent;
  }

  if (!settingsJson.env) settingsJson.env = {};
  if ('apiKeyHelper' in settingsJson) delete settingsJson.apiKeyHelper;

  settingsJson.env.ANTHROPIC_BASE_URL = 'http://localhost:9999';
  settingsJson.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-rotated-by-key-pool-proxy-9999';

  const tmp = CLAUDE_SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settingsJson, null, 2), 'utf-8');
  fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);

  config.isConnected = true;
  return config;
}

export function disconnectFromClaude(config: AppConfig): AppConfig {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    throw new Error(`Claude settings file not found at ${CLAUDE_SETTINGS_PATH}`);
  }

  const tmp = CLAUDE_SETTINGS_PATH + '.tmp';
  if (config.backupSettings) {
    fs.writeFileSync(tmp, config.backupSettings, 'utf-8');
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
  } else {
    // Bug #7 fix: fallback to official Anthropic API, not a third-party domain.
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    const settingsJson = JSON.parse(content) as { env?: Record<string, string> };
    if (settingsJson.env) {
      settingsJson.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    }
    fs.writeFileSync(tmp, JSON.stringify(settingsJson, null, 2), 'utf-8');
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
  }

  config.isConnected = false;
  config.backupSettings = null;
  return config;
}
