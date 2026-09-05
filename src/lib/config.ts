import fs from 'fs';
import path from 'path';
import os from 'os';

export type KeyStatus = 'active' | 'rate-limited' | 'invalid';

// Persisted key: user-authored data only. No stats.
export interface KeyConfig {
  id: string;
  email: string;
  key: string;
  disabled?: boolean;
}

export interface GroupConfig {
  id: string;
  name: string;
  targetUrl: string;
  keys: KeyConfig[];
  model?: string;
  rateLimitCooldownHours?: number;
  disabled?: boolean;
}

export interface AppConfig {
  activeGroupId: string | null;
  selectedModel: string | null;
  smallFastModel?: string | null;
  groups: GroupConfig[];
  isConnected: boolean;
  backupSettings: string | null;
  // Kilo Code profile: independent of the Claude CLI one — both may be on,
  // either alone, or neither. The pool serves the same /v1/messages route.
  kiloConnected: boolean;
  kiloBackupSettings: string | null;
  // The user's `disabled_providers` list as it was before connect — while
  // the profile is on, every other provider is hidden from Kilo's model
  // selector so only pool models are offered; disconnect restores it.
  kiloDisabledBackup: string[] | null;
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
  // Monotonic version bumped on every dashboard write. The client echoes it
  // back on `save` so the server can reject a full-snapshot save made from a
  // stale state (409) instead of silently erasing another tab's changes.
  configVersion: number;
}

export interface PoolStats {
  totalKeys: number;
  activeKeys: number;
  rateLimitedKeys: number;
  invalidKeys: number;
  disabledKeys: number;
  totalInFlight: number;
}

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');
const CONFIG_TMP_PATH = CONFIG_FILE_PATH + '.tmp';
const CONFIG_BACKUP_PATH = path.join(process.cwd(), 'config.backup.json');
const CLAUDE_SETTINGS_PATH =
  process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
// Kilo Code config. The extension reads JSONC (comments allowed), but it
// round-trips whatever we write — we write plain JSON, which is valid JSONC.
const KILO_SETTINGS_PATH =
  process.env.KILO_SETTINGS_PATH || path.join(os.homedir(), '.config', 'kilo', 'kilo.jsonc');

const DEFAULT_CONFIG: AppConfig = {
  activeGroupId: null,
  selectedModel: null,
  smallFastModel: null,
  groups: [],
  isConnected: false,
  backupSettings: null,
  kiloConnected: false,
  kiloBackupSettings: null,
  kiloDisabledBackup: null,
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
  // Pool-wide upstream pause after an IP-level 429 (ms epoch). All keys share
  // this machine's IP, so a 429 that is not key-specific throttles every key
  // at once — while paused, /v1/* fails fast instead of sending anything up.
  upstreamPausedUntil: number;
  // Cached parsed config + invalidation metadata
  configCache: AppConfig | null;
  configMtimeMs: number;
  configVersion: number; // bumped on every dashboard write
  cachedVersion: number; // version the cache was built at
  lastStatAt: number; // ms epoch of the last filesystem stat
  writeChain: Promise<void>; // serializes config writes
}

const globalForProxy = global as unknown as { proxyState?: GlobalProxyState };
if (!globalForProxy.proxyState) {
  globalForProxy.proxyState = {
    keys: {},
    roundRobinIndex: -1,
    upstreamPausedUntil: 0,
    configCache: null,
    configMtimeMs: 0,
    configVersion: 0,
    cachedVersion: 0,
    lastStatAt: 0,
    writeChain: Promise.resolve(),
  };
}
export const proxyState = globalForProxy.proxyState;

// Pause all upstream traffic for the given duration (extends an active pause).
// Used after an IP-level rate limit: rotating keys cannot help — every key
// leaves from the same IP — and firing the rest of the pool at an already
// throttled upstream is the escalation pattern that ends in a ban.
export function pauseUpstream(ms: number): void {
  proxyState.upstreamPausedUntil = Math.max(
    proxyState.upstreamPausedUntil,
    Date.now() + ms,
  );
}

export function getUpstreamPauseRemainingMs(): number {
  return Math.max(0, proxyState.upstreamPausedUntil - Date.now());
}

function parseConfig(text: string): AppConfig {
  const parsed = JSON.parse(text) as Partial<AppConfig> & {
    groups?: Array<Partial<GroupConfig> & { keys?: Array<Record<string, unknown>> }>;
  };
  // Migrate: strip any stats fields that may exist in an older config.json.
  const groups: GroupConfig[] = (parsed.groups || []).map((g: any) => ({
    id: String(g.id),
    name: String(g.name ?? 'Untitled'),
    targetUrl: String(g.targetUrl ?? ''),
    model: typeof g.model === 'string' && g.model ? g.model : undefined,
    rateLimitCooldownHours: typeof g.rateLimitCooldownHours === 'number' ? g.rateLimitCooldownHours : undefined,
    disabled: g.disabled === true ? true : undefined,
    keys: (g.keys || []).map((k: any) => ({
      id: String(k.id),
      email: String(k.email ?? ''),
      key: String(k.key ?? ''),
      disabled: k.disabled === true ? true : undefined,
    })),
  }));
  return {
    activeGroupId: parsed.activeGroupId ?? null,
    selectedModel: typeof parsed.selectedModel === 'string' ? parsed.selectedModel : null,
    smallFastModel: typeof parsed.smallFastModel === 'string' && parsed.smallFastModel ? parsed.smallFastModel : null,
    groups,
    isConnected: parsed.isConnected ?? false,
    backupSettings: parsed.backupSettings ?? null,
    kiloConnected: (parsed as { kiloConnected?: boolean }).kiloConnected ?? false,
    kiloBackupSettings: (parsed as { kiloBackupSettings?: string | null }).kiloBackupSettings ?? null,
    kiloDisabledBackup: (parsed as { kiloDisabledBackup?: string[] | null }).kiloDisabledBackup ?? null,
  };
}

function readConfigFromDisk(): AppConfig {
  let text: string | null = null;
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      text = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    }
  } catch (error) {
    console.error('Error reading config.json:', error);
  }
  if (text === null) return { ...DEFAULT_CONFIG };

  try {
    return parseConfig(text);
  } catch (error) {
    // A corrupt config must not silently become an "empty pool" (every request
    // would 400 with nothing visible in the dashboard): fall back to the
    // backup, else fail loudly instead of pretending there are no keys.
    console.error('config.json is corrupt:', error);
    try {
      const restored = parseConfig(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf-8'));
      console.error('Serving config.backup.json instead (config.json needs fixing).');
      return restored;
    } catch (backupError) {
      throw new Error(
        `config.json is corrupt and config.backup.json is unreadable — refusing to serve an empty pool. ` +
          `Fix or restore config.json. (${backupError instanceof Error ? backupError.message : String(backupError)})`,
      );
    }
  }
}

// Fast config read: re-parse when the file mtime changed (stat throttled to
// at most once per second) or when a dashboard write bumped the in-memory
// version. The hot request path calls this.
export function loadConfig(): AppConfig {
  const now = Date.now();
  // Fast path: serve the cache when the last stat is fresh and no dashboard
  // write bumped the version since. External edits to config.json are picked
  // up within one second instead of being invisible until a restart.
  if (
    proxyState.configCache &&
    proxyState.cachedVersion === proxyState.configVersion &&
    proxyState.configMtimeMs > 0 &&
    now - proxyState.lastStatAt < 1000
  ) {
    return proxyState.configCache;
  }

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(CONFIG_FILE_PATH).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  proxyState.lastStatAt = now;

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

const INVALID_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour auto-recovery for invalid keys

export function getKeyState(keyId: string): RuntimeKeyState {
  let st = proxyState.keys[keyId];
  if (!st) {
    st = { status: 'active', cooldownUntil: null, inFlight: 0 };
    proxyState.keys[keyId] = st;
  }
  // Auto-recover from cooldown (both rate-limited and invalid keys).
  if (
    (st.status === 'rate-limited' || st.status === 'invalid') &&
    st.cooldownUntil &&
    Date.now() > st.cooldownUntil
  ) {
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
  // Auto-recover after 1 hour. Truly dead keys (revoked/deleted) will just
  // get re-flagged on the next request attempt.
  st.cooldownUntil = Date.now() + INVALID_COOLDOWN_MS;
}

export function resetKeysStatus(keyIds: string[]): void {
  for (const id of keyIds) {
    const st = getKeyState(id);
    st.status = 'active';
    st.cooldownUntil = null;
  }
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
  let disabledKeys = 0;
  let totalInFlight = 0;

  const groups = config.groups.map((g) => ({
    ...g,
    keys: g.keys.map((k) => {
      const view = keyStatusView(k.id);
      totalKeys++;
      if (k.disabled || g.disabled) {
        disabledKeys++;
      } else if (view.status === 'active') activeKeys++;
      else if (view.status === 'rate-limited') rateLimitedKeys++;
      else if (view.status === 'invalid') invalidKeys++;
      totalInFlight += view.inFlight;
      return { ...k, ...view, groupName: g.name };
    }),
  }));

  return {
    ...config,
    groups,
    poolStats: { totalKeys, activeKeys, rateLimitedKeys, invalidKeys, disabledKeys, totalInFlight },
    configVersion: proxyState.configVersion,
  };
}

// Persistence ---------------------------------------------------------------

function writeConfigAtomic(config: AppConfig): void {
  // Always snapshot the previous file before overwriting: a bad edit (not
  // just one that shrinks the key set) must stay recoverable.
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      fs.copyFileSync(CONFIG_FILE_PATH, CONFIG_BACKUP_PATH);
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

// Serialized read-modify-write for dashboard actions. saveConfig alone only
// serializes the write: two overlapping POSTs could both read the same old
// version, then the second write silently erased the first (observed with
// two dashboard tabs). Here the read, the mutation, and the write all run
// inside the chain as one step. `mutate` edits the config in place; a throw
// propagates to the caller without writing, and the chain survives.
//
// `expectedVersion` (optional): when the action's payload is a full snapshot
// taken from an older state, the optimistic-concurrency check must run
// INSIDE the chain step — checking before enqueueing leaves a TOCTOU window
// where another tab's write lands between the check and this step's turn.
// A version mismatch throws `StaleConfigVersionError` → the caller answers
// 409.
export class StaleConfigVersionError extends Error {
  constructor(expected: number, actual: number) {
    super(`Configuration was changed by another tab or action (expected version ${expected}, current ${actual})`);
    this.name = 'StaleConfigVersionError';
  }
}

export function mutateConfig(
  mutate: (config: AppConfig) => void,
  expectedVersion?: number,
): Promise<AppConfig> {
  const run = proxyState.writeChain.then(() => {
    if (
      typeof expectedVersion === 'number' &&
      expectedVersion !== proxyState.configVersion
    ) {
      throw new StaleConfigVersionError(expectedVersion, proxyState.configVersion);
    }
    const config = loadConfig();
    mutate(config);
    writeConfigAtomic(config);
    proxyState.configCache = config;
    proxyState.configVersion += 1;
    proxyState.cachedVersion = proxyState.configVersion;
    try {
      proxyState.configMtimeMs = fs.statSync(CONFIG_FILE_PATH).mtimeMs;
    } catch {
      proxyState.configMtimeMs = 0;
    }
    return config;
  });
  proxyState.writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Current dashboard-write version — `save` compares the client's echoed
// version against this to detect stale snapshots.
export function getConfigVersion(): number {
  return proxyState.configVersion;
}

// Kilo Code integration -----------------------------------------------------
//
// Kilo talks to the SAME pool (http://127.0.0.1:9999) — no separate proxy.
// The config provider we inject is an Anthropic-format client pointing at
// the pool's /v1/messages route; the pool rotates keys exactly as it does
// for Claude Code. The profile is independent of the Claude CLI one: both
// may be connected at once, either alone, or neither.

// The provider id we own inside kilo.jsonc. Everything else in the file
// (other providers, permissions, indexing, experimental flags) belongs to
// the user and is never touched.
const KILO_POOL_PROVIDER_ID = 'claude-key-pool';

// Minimal JSONC stripper: removes // line comments and /* blocks */ outside
// string literals, so the file can be compared and edited as JSON. Kilo
// itself accepts plain JSON in this file, so writing back is safe.
function parseKiloJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // consume the trailing slash of the block comment
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

export function connectToKilo(config: AppConfig): AppConfig {
  if (!fs.existsSync(KILO_SETTINGS_PATH)) {
    throw new Error(`Kilo settings file not found at ${KILO_SETTINGS_PATH}`);
  }

  const originalContent = fs.readFileSync(KILO_SETTINGS_PATH, 'utf-8');
  let kiloJson: Record<string, unknown>;
  try {
    kiloJson = parseKiloJsonc(originalContent);
  } catch {
    throw new Error('Kilo kilo.jsonc contains invalid JSON.');
  }

  if (!config.kiloConnected || !config.kiloBackupSettings) {
    config.kiloBackupSettings = originalContent;
  }

  const providers = (kiloJson.provider as Record<string, unknown> | undefined) ?? {};
  // Snapshot the existing pool provider's model list if the user customized
  // it — reconnect must not silently drop their edits. First connect builds
  // it from the pool's live groups.
  let userModels: Record<string, unknown> | undefined;
  const existing = providers[KILO_POOL_PROVIDER_ID] as
    | { models?: Record<string, unknown> }
    | undefined;
  if (existing?.models && typeof existing.models === 'object') {
    userModels = { ...existing.models };
  }

  const modelName = config.selectedModel || 'claude-opus-4-8';
  // Same slot idea as the Claude CLI: the pool's enabled models become
  // selectable models in Kilo; routing inside the pool is by request model.
  const poolModels = config.groups
    .filter((g) => !g.disabled && g.model)
    .map((g) => g.model)
    .filter((m): m is string => !!m);
  const models: Record<string, unknown> = userModels ?? {};
  if (!userModels) {
    for (const m of poolModels.length > 0 ? poolModels : [modelName]) {
      models[m] = { name: m, reasoning: true };
    }
  }

  providers[KILO_POOL_PROVIDER_ID] = {
    name: 'claude-key-pool',
    npm: '@ai-sdk/anthropic',
    options: {
      baseURL: 'http://127.0.0.1:9999/v1',
      // The pool replaces the client key with a rotated pool key; a dummy
      // value is required by the SDK but never used for auth.
      apiKey: 'sk-ant-dummy-rotated-by-key-pool-proxy-9999',
      headers: {
        // agentrouter rejects non-approved clients by User-Agent; Kilo's
        // fetch cannot set it (forbidden header), so the pool masks it
        // upstream-side anyway (buildUpstreamHeaders). The x-app marker is
        // the pool's own: it distinguishes Kilo traffic from Claude Code's
        // `x-app: cli` in logs and statistics.
        'x-app': 'kilo',
      },
    },
    models,
  };
  kiloJson.provider = providers;

  // While the profile is on, Kilo's model selector must offer ONLY pool
  // models: every other provider goes into `disabled_providers` (hides them
  // from the selector without deleting anything). The user's prior list is
  // snapshotted and restored on disconnect. On reconnect the list is rebuilt
  // from the current provider set — providers added/removed in Kilo while
  // disconnected are picked up.
  if (!config.kiloConnected || !config.kiloDisabledBackup) {
    const existingDisabled = Array.isArray(kiloJson.disabled_providers)
      ? (kiloJson.disabled_providers as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    config.kiloDisabledBackup = existingDisabled;
  }
  const otherProviderIds = Object.keys(providers).filter((id) => id !== KILO_POOL_PROVIDER_ID);
  kiloJson.disabled_providers = [
    ...new Set([...config.kiloDisabledBackup, ...otherProviderIds]),
  ];

  const tmp = KILO_SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kiloJson, null, 2), 'utf-8');
  fs.renameSync(tmp, KILO_SETTINGS_PATH);

  config.kiloConnected = true;
  return config;
}

export function disconnectFromKilo(config: AppConfig): AppConfig {
  if (!fs.existsSync(KILO_SETTINGS_PATH)) {
    throw new Error(`Kilo settings file not found at ${KILO_SETTINGS_PATH}`);
  }

  const currentContent = fs.readFileSync(KILO_SETTINGS_PATH, 'utf-8');
  let kiloJson: Record<string, unknown>;
  let parsedOk = true;
  try {
    kiloJson = parseKiloJsonc(currentContent);
  } catch {
    parsedOk = false;
    kiloJson = {};
  }
  if (!parsedOk) {
    // Unparseable (user mid-edit?) — do not risk erasing the file; restore
    // the backup verbatim only when it exists, else leave it alone.
    if (!config.kiloBackupSettings) {
      config.kiloConnected = false;
      return config;
    }
    const tmp = KILO_SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tmp, config.kiloBackupSettings, 'utf-8');
    fs.renameSync(tmp, KILO_SETTINGS_PATH);
    config.kiloConnected = false;
    config.kiloBackupSettings = null;
    config.kiloDisabledBackup = null;
    return config;
  }

  // Remove only OUR provider entry — every other provider and every other
  // setting in the file stays as the user left it. Even when the provider
  // entry is already gone (user removed it manually), the
  // disabled_providers list we hid the other providers in still needs
  // restoring — otherwise they stay invisible in Kilo forever.
  const providers = kiloJson.provider as Record<string, unknown> | undefined;
  // Snapshot the "was it there" facts BEFORE mutating: `changed` must
  // reflect what the file contained, not what we just deleted from memory.
  const poolProviderWasPresent = !!providers && KILO_POOL_PROVIDER_ID in providers;
  const disabledFieldWasPresent = 'disabled_providers' in kiloJson;

  if (poolProviderWasPresent) {
    delete providers![KILO_POOL_PROVIDER_ID];
    if (Object.keys(providers!).length === 0) delete kiloJson.provider;
  }

  // Restore the user's `disabled_providers` list: while the profile was
  // on, every other provider id was hidden there. An empty restored list
  // removes the field entirely (matches a user who never had one).
  let disabledTouched = false;
  if (config.kiloDisabledBackup !== null) {
    if (config.kiloDisabledBackup.length > 0) {
      kiloJson.disabled_providers = [...config.kiloDisabledBackup];
      disabledTouched = true;
    } else if (disabledFieldWasPresent) {
      delete kiloJson.disabled_providers;
      disabledTouched = true;
    }
  }

  // Write only when something actually changed — a disconnect of an
  // already-clean file must not rewrite it (comments would be lost).
  const changed = poolProviderWasPresent || disabledTouched;
  if (changed) {
    // Preserve the user's original file as far as possible: if the only
    // difference from the backup is our provider entry (and the
    // disabled_providers entries we added), restore the backup verbatim
    // (comments survive); otherwise write the edited JSON.
    const backupJson = config.kiloBackupSettings ? safeParseKilo(config.kiloBackupSettings) : null;
    const backupWithoutPool = backupJson ? removePoolProvider(backupJson) : null;
    const currentWithoutPool = removePoolProvider(kiloJson);

    const tmp = KILO_SETTINGS_PATH + '.tmp';
    if (
      backupWithoutPool &&
      JSON.stringify(backupWithoutPool) === JSON.stringify(currentWithoutPool)
    ) {
      fs.writeFileSync(tmp, config.kiloBackupSettings!, 'utf-8');
    } else {
      fs.writeFileSync(tmp, JSON.stringify(kiloJson, null, 2), 'utf-8');
    }
    fs.renameSync(tmp, KILO_SETTINGS_PATH);
  }

  config.kiloConnected = false;
  config.kiloBackupSettings = null;
  config.kiloDisabledBackup = null;
  return config;
}

function safeParseKilo(text: string): Record<string, unknown> | null {
  try {
    return parseKiloJsonc(text);
  } catch {
    return null;
  }
}

function removePoolProvider(json: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...json };
  const providers = copy.provider as Record<string, unknown> | undefined;
  if (providers && KILO_POOL_PROVIDER_ID in providers) {
    const { [KILO_POOL_PROVIDER_ID]: _removed, ...rest } = providers;
    copy.provider = Object.keys(rest).length > 0 ? rest : undefined;
  }
  // Normalize disabled_providers the same way connect/disconnect do, so the
  // backup-vs-current comparison is about the user's real edits, not about
  // the pool's own bookkeeping in that field.
  const disabled = copy.disabled_providers;
  if (Array.isArray(disabled)) {
    const rest = (disabled as unknown[]).filter(
      (v) => typeof v === 'string' && v !== KILO_POOL_PROVIDER_ID,
    ) as string[];
    if (rest.length > 0) copy.disabled_providers = rest;
    else delete copy.disabled_providers;
  }
  return copy;
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
  if ('ANTHROPIC_AUTH_TOKEN' in settingsJson.env) delete settingsJson.env.ANTHROPIC_AUTH_TOKEN;

  settingsJson.env.ANTHROPIC_BASE_URL = 'http://localhost:9999';
  settingsJson.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-rotated-by-key-pool-proxy-9999';
  settingsJson.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  const modelName = config.selectedModel || 'claude-opus-4-8';
  // The small/fast model serves background and auto-mode classifier requests.
  // Decoupling it from the main model keeps those tiny calls on a cheap fast
  // model and makes them fail independently of the main model's availability.
  const smallModel = config.smallFastModel || modelName;
  // Slot mapping: the CLI's model slots map onto the pool's available models
  // so /model inside a live session actually switches between them (the pool
  // routes by the request's model name, no restart needed). The main model
  // takes the top slots (Opus/Fable); other pool models fill Sonnet/Haiku.
  // Disabled groups do not participate — a slot mapped to their model would
  // show in /model but 400 on every request ("no enabled group serves
  // model"). When the pool has only the main model, every slot maps to it
  // (the previous behavior).
  const otherModels = config.groups
    .filter((g) => !g.disabled)
    .map((g) => g.model)
    .filter((m): m is string => !!m && m !== modelName && m !== smallModel);
  settingsJson.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelName;
  settingsJson.env.ANTHROPIC_DEFAULT_SONNET_MODEL = otherModels[0] ?? modelName;
  settingsJson.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = otherModels[1] ?? otherModels[0] ?? smallModel;
  settingsJson.env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
  settingsJson.env.ANTHROPIC_DEFAULT_FABLE_MODEL = modelName;
  settingsJson.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
  settingsJson.effortLevel = 'high';
  settingsJson.model = modelName;

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
    // The backup is a verbatim pre-connect snapshot. The user may have edited
    // settings.json while the pool was connected (permissions, hooks, new
    // models) — restoring the snapshot verbatim would erase those edits
    // silently. Detect foreign edits by comparing the current file with the
    // pool's own deterministic transformation of the backup (connect strips
    // apiKeyHelper/ANTHROPIC_AUTH_TOKEN and writes a known set of pool env
    // fields); anything else in the current file that differs from the
    // backup is user work and must survive.
    const currentContent = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    const untouched = poolUnrelatedSettingsEqual(config.backupSettings, currentContent);
    if (untouched) {
      // Nothing foreign changed — safe to restore the snapshot verbatim.
      fs.writeFileSync(tmp, config.backupSettings, 'utf-8');
      fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    } else {
      // Foreign edits present: strip the pool's own fields from the CURRENT
      // file (keeping everything the user added) and keep a copy of the
      // current state next to the file so nothing is lost either way.
      try {
        fs.writeFileSync(CLAUDE_SETTINGS_PATH + '.pre-disconnect', currentContent, 'utf-8');
      } catch {
        /* best-effort safety copy */
      }
      const settingsJson = JSON.parse(currentContent) as {
        env?: Record<string, string>;
        model?: unknown;
        effortLevel?: unknown;
        apiKeyHelper?: unknown;
      };
      if (settingsJson.env) {
        delete settingsJson.env.ANTHROPIC_BASE_URL;
        delete settingsJson.env.ANTHROPIC_API_KEY;
        delete settingsJson.env.ANTHROPIC_AUTH_TOKEN;
        delete settingsJson.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
        for (const name of [
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_DEFAULT_FABLE_MODEL',
          'ANTHROPIC_SMALL_FAST_MODEL',
          'CLAUDE_CODE_EFFORT_LEVEL',
        ]) {
          delete settingsJson.env[name];
        }
        if (Object.keys(settingsJson.env).length === 0) delete settingsJson.env;
      }
      delete settingsJson.model;
      delete settingsJson.effortLevel;
      delete settingsJson.apiKeyHelper;
      fs.writeFileSync(tmp, JSON.stringify(settingsJson, null, 2), 'utf-8');
      fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
      console.warn(
        '[claude-key-pool] settings.json was edited outside the pool while connected — ' +
          'Disconnect kept your edits and removed only the pool fields; ' +
          `the pre-disconnect file was saved as ${CLAUDE_SETTINGS_PATH}.pre-disconnect`,
      );
    }
  } else {
    // Bug #7 fix: fallback to official Anthropic API, not a third-party domain.
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    const settingsJson = JSON.parse(content) as {
      env?: Record<string, string>;
      model?: unknown;
      effortLevel?: unknown;
    };
    if (settingsJson.env) {
      settingsJson.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      // Strip the pool's dummy key and model overrides: leaving them would
      // point the CLI at the real API with a fake key and pool-only model
      // names — 401 / "model not found" on every request.
      delete settingsJson.env.ANTHROPIC_API_KEY;
      delete settingsJson.env.ANTHROPIC_AUTH_TOKEN;
      for (const name of [
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_CODE_EFFORT_LEVEL',
      ]) {
        delete settingsJson.env[name];
      }
    }
    // connectToClaude also wrote top-level `model`/`effortLevel`. Without the
    // backup their originals are unknown, and the pool-written values (a
    // relay-only model name like glm-5.3) break every new session against
    // api.anthropic.com — remove them and let the CLI defaults apply.
    delete settingsJson.model;
    delete settingsJson.effortLevel;
    fs.writeFileSync(tmp, JSON.stringify(settingsJson, null, 2), 'utf-8');
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
  }

  config.isConnected = false;
  config.backupSettings = null;
  return config;
}

// Fields connectToClaude owns in ~/.claude/settings.json. Everything else in
// the file belongs to the user.
const POOL_SETTINGS_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

// True when the current settings.json differs from the pre-connect backup
// only in fields the pool itself writes. Compare parsed JSON (not bytes):
// connectToClaude re-serializes the whole file, so key order and whitespace
// change even when nothing semantic did.
function poolUnrelatedSettingsEqual(backup: string, current: string): boolean {
  let backupJson: Record<string, unknown>;
  let currentJson: Record<string, unknown>;
  try {
    backupJson = JSON.parse(backup);
    currentJson = JSON.parse(current);
  } catch {
    // Unparseable current file (user mid-edit?) — do not risk erasing it.
    return false;
  }

  // The pool may DELETE apiKeyHelper / ANTHROPIC_AUTH_TOKEN on connect —
  // mirror that on the backup side before comparing.
  const backupEnv = { ...(backupJson.env as Record<string, unknown> | undefined) };
  const currentEnv = { ...(currentJson.env as Record<string, unknown> | undefined) };
  if ('apiKeyHelper' in backupJson && !('apiKeyHelper' in currentJson)) delete backupJson.apiKeyHelper;
  if (backupEnv && 'ANTHROPIC_AUTH_TOKEN' in backupEnv && currentEnv && !('ANTHROPIC_AUTH_TOKEN' in currentEnv)) {
    delete backupEnv.ANTHROPIC_AUTH_TOKEN;
  }

  for (const key of POOL_SETTINGS_ENV_KEYS) delete backupEnv[key];
  for (const key of POOL_SETTINGS_ENV_KEYS) delete currentEnv[key];

  const stripPoolFields = (obj: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...obj };
    if (copy.env !== undefined) {
      copy.env = Object.keys(copy.env as Record<string, unknown>).length > 0
        ? copy.env
        : {};
    }
    return copy;
  };

  // Top-level pool fields.
  const backupTop = { ...stripPoolFields(backupJson) };
  const currentTop = { ...stripPoolFields(currentJson) };
  delete backupTop.model;
  delete currentTop.model;
  delete backupTop.effortLevel;
  delete currentTop.effortLevel;

  return JSON.stringify(backupTop) === JSON.stringify(currentTop);
}
