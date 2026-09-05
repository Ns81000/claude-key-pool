import fs from 'fs';
import path from 'path';

// Request + key activity tracking for the dashboard. Two stores:
//
// 1. A bounded in-memory ring buffer of finished requests (newest first).
//    Never persisted — it is a live tail, like the console output.
// 2. Cumulative per-key statistics, persisted to stats.json (debounced,
//    atomic) so usage history survives server restarts. Deliberately a
//    separate file: config.json is user-authored data only and strips any
//    stats fields that leak in (see config.ts parseConfig).
//
// Both live on `global` so Next dev hot-reloads do not wipe them (same
// technique as proxyState in config.ts).

// Outcome of a single key attempt inside the rotation loop.
export type AttemptOutcome =
  | 'success' // request completed on this key
  | 'rate-limited' // 429 / limit body → key cooled down
  | 'invalid' // 401 / revoked / billing → key marked invalid
  | 'provider-error' // 403 / 5xx / malformed 200 → short cooldown
  | 'network' // DNS / refused / unreachable group URL
  | 'timeout' // connect timeout → marked slow
  | 'slow'; // generic fetch failure → marked slow (not a group-URL problem)

// Final outcome of a whole client request (what the dashboard table shows).
export type RequestOutcome =
  | 'success'
  | 'rate-limited'
  | 'invalid'
  | 'provider-error'
  | 'client-error' // genuine client error forwarded unchanged (400/401 client-rejected)
  | 'aborted' // client went away mid-rotation
  | 'exhausted' // every key tried, none worked
  | 'ip-paused' // pool-wide pause after an IP-level 429
  | 'no-pool' // no model / no groups / no group serves the model
  | 'rejected'; // request refused before rotation (parse error, upstream paused)

export interface ActivityEntry {
  id: number; // same id the console logger prints (#NNN)
  ts: number; // ms epoch
  method: string;
  path: string;
  model: string | null;
  keyEmail: string | null; // key that produced the final outcome
  keyId: string | null;
  groupName: string | null;
  outcome: RequestOutcome;
  httpStatus: number | null; // status returned to the client
  durationMs: number;
  isStream: boolean;
  attempts: number; // keys tried
  inputTokens: number | null;
  outputTokens: number | null;
  note: string | null; // short reason of the deciding event
}

export interface KeyStatsData {
  // Label snapshots so stats stay readable for keys deleted from the config.
  label: string;
  groupName: string;
  attempts: number;
  successes: number;
  rateLimited: number;
  invalid: number;
  providerErrors: number;
  networkErrors: number;
  timeouts: number;
  slowMarks: number; // generic fetch failures (key marked slow, not a group-URL problem)
  inputTokens: number;
  outputTokens: number;
  // Latency of the successful upstream call only (fetch → verdict), not of
  // the whole client request: rotation retries and client-side stream
  // consumption must not inflate the key's average.
  successUpstreamMs: number;
  lastUsedAt: number | null;
}

export interface KeyStatsView extends KeyStatsData {
  keyId: string;
  avgUpstreamMs: number | null;
}

export interface ActivitySnapshot {
  entries: ActivityEntry[];
  keys: KeyStatsView[];
  totals: {
    attempts: number;
    successes: number;
    rateLimited: number;
    invalid: number;
    providerErrors: number;
    networkErrors: number;
    timeouts: number;
    slowMarks: number;
    inputTokens: number;
    outputTokens: number;
  };
  serverStartedAt: number;
  logCapacity: number;
}

const LOG_BUFFER_SIZE = 500;
const STATS_FILE_PATH = path.join(process.cwd(), 'stats.json');
const STATS_SAVE_DEBOUNCE_MS = 5_000;

interface GlobalActivityState {
  entries: ActivityEntry[]; // newest first
  keyStats: Record<string, KeyStatsData>;
  loaded: boolean; // stats.json read (or found missing) at least once
  saveTimer: ReturnType<typeof setTimeout> | null;
  saveRunning: boolean;
  serverStartedAt: number;
}

const globalForActivity = global as unknown as { activityState?: GlobalActivityState };
if (!globalForActivity.activityState) {
  globalForActivity.activityState = {
    entries: [],
    keyStats: {},
    loaded: false,
    saveTimer: null,
    saveRunning: false,
    serverStartedAt: Date.now(),
  };
}
const state = globalForActivity.activityState;

// ---------------------------------------------------------------------------
// Persisted per-key stats
// ---------------------------------------------------------------------------

function emptyKeyStats(label: string, groupName: string): KeyStatsData {
  return {
    label,
    groupName,
    attempts: 0,
    successes: 0,
    rateLimited: 0,
    invalid: 0,
    providerErrors: 0,
    networkErrors: 0,
    timeouts: 0,
    slowMarks: 0,
    inputTokens: 0,
    outputTokens: 0,
    successUpstreamMs: 0,
    lastUsedAt: null,
  };
}

function loadStatsOnce(): void {
  if (state.loaded) return;
  state.loaded = true;
  try {
    if (fs.existsSync(STATS_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE_PATH, 'utf-8')) as {
        keys?: Record<string, Partial<KeyStatsData>>;
      };
      if (parsed.keys && typeof parsed.keys === 'object') {
        for (const [keyId, raw] of Object.entries(parsed.keys)) {
          state.keyStats[keyId] = { ...emptyKeyStats(raw.label ?? 'unknown', raw.groupName ?? ''), ...raw };
        }
      }
    }
  } catch (error) {
    // A corrupt stats file must never take the proxy down — start from zero.
    console.error('stats.json is corrupt, starting stats from zero:', error);
  }
}

function persistStats(): void {
  if (state.saveRunning) {
    // A write is in flight — schedule another pass to catch this mutation.
    scheduleStatsSave();
    return;
  }
  state.saveRunning = true;
  try {
    const data = JSON.stringify({ version: 1, keys: state.keyStats }, null, 2);
    const tmp = STATS_FILE_PATH + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, STATS_FILE_PATH);
  } catch (error) {
    console.error('Failed to persist stats.json:', error);
  } finally {
    state.saveRunning = false;
  }
}

function scheduleStatsSave(): void {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    persistStats();
  }, STATS_SAVE_DEBOUNCE_MS);
  // Do not hold the process open just for a stats flush.
  state.saveTimer.unref?.();
}

function bumpKeyStat(
  keyId: string,
  label: string,
  groupName: string,
  outcome: AttemptOutcome,
): void {
  loadStatsOnce();
  const st = (state.keyStats[keyId] ??= emptyKeyStats(label, groupName));
  // Keep labels fresh — the user may rename a key or group in the dashboard.
  st.label = label;
  st.groupName = groupName;
  st.attempts++;
  st.lastUsedAt = Date.now();
  switch (outcome) {
    case 'success': st.successes++; break;
    case 'rate-limited': st.rateLimited++; break;
    case 'invalid': st.invalid++; break;
    case 'provider-error': st.providerErrors++; break;
    case 'network': st.networkErrors++; break;
    case 'timeout': st.timeouts++; break;
    case 'slow': st.slowMarks++; break;
  }
  scheduleStatsSave();
}

// ---------------------------------------------------------------------------
// Request tracker
// ---------------------------------------------------------------------------

// One tracker per client request. The route creates it right after the
// console logger's reqId, calls note() at every rotation decision point,
// sets stream/token metadata as it becomes known, and finish() exactly once
// when the response is decided. finish() pushes the ring-buffer entry.
export class RequestTracker {
  readonly id: number;
  readonly method: string;
  readonly path: string;
  readonly startedAt: number;
  model: string | null = null;
  isStream = false;
  attempts = 0;
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  // Token values already accumulated into per-key stats by addTokens() —
  // the delta base that prevents double-counting repeated usage frames.
  private prevStatIn: number | null = null;
  private prevStatOut: number | null = null;
  private lastKeyId: string | null = null;
  private lastKeyEmail: string | null = null;
  private lastGroupName: string | null = null;
  private lastNote: string | null = null;
  private finished = false;
  private entry: ActivityEntry | null = null; // set by finish(), patched later by addTokens()

  constructor(id: number, method: string, path: string) {
    this.id = id;
    this.method = method;
    this.path = path;
    this.startedAt = Date.now();
  }

  setModel(model: string | null): void {
    this.model = model;
  }

  setStream(isStream: boolean): void {
    this.isStream = isStream;
  }

  // Record token usage. Safe at any point of the request lifecycle:
  // before finish() it lands in the entry being built, after finish()
  // (streaming — usage only becomes known when the stream ends) it also
  // patches the already-pushed log entry.
  //
  // Cumulative per-key stats take the DELTA from the last recorded value,
  // not the raw number: some relays repeat usage in both message_start and
  // the final message_delta, and summing both would double-count every
  // request. The log entry always shows the latest (largest) value.
  addTokens(inputTokens: number | null, outputTokens: number | null): void {
    const inT = typeof inputTokens === 'number' ? inputTokens : null;
    const outT = typeof outputTokens === 'number' ? outputTokens : null;
    if (inT !== null) this.inputTokens = inT;
    if (outT !== null) this.outputTokens = outT;
    if (this.lastKeyId) {
      const st = state.keyStats[this.lastKeyId];
      if (st && (inT !== null || outT !== null)) {
        if (inT !== null) st.inputTokens += Math.max(0, inT - (this.prevStatIn ?? 0));
        if (outT !== null) st.outputTokens += Math.max(0, outT - (this.prevStatOut ?? 0));
        if (inT !== null) this.prevStatIn = Math.max(this.prevStatIn ?? 0, inT);
        if (outT !== null) this.prevStatOut = Math.max(this.prevStatOut ?? 0, outT);
        scheduleStatsSave();
      }
    }
    // Patch the already-pushed log entry via a direct reference (streaming:
    // usage only becomes known when the stream ends, after finish()).
    if (this.finished && this.entry) {
      if (inT !== null) this.entry.inputTokens = inT;
      if (outT !== null) this.entry.outputTokens = outT;
    }
  }

  // Record one key attempt and its per-key outcome. `note` is the human
  // reason of the deciding event (kept for the final entry only).
  note(
    keyId: string,
    keyEmail: string,
    groupName: string,
    outcome: AttemptOutcome,
    note?: string,
  ): void {
    this.attempts++;
    this.lastKeyId = keyId;
    this.lastKeyEmail = keyEmail;
    this.lastGroupName = groupName;
    this.lastNote = note ?? this.lastNote;
    bumpKeyStat(keyId, keyEmail, groupName, outcome);
  }

  // Successful attempt: per-key stats plus the upstream latency (fetch →
  // verdict), which is the honest speed of this key — rotation retries and
  // client-side stream consumption must not inflate the average. The route
  // passes `upstreamMs` it measured around its own upstream call.
  noteSuccess(
    keyId: string,
    keyEmail: string,
    groupName: string,
    upstreamMs: number,
  ): void {
    this.attempts++;
    this.lastKeyId = keyId;
    this.lastKeyEmail = keyEmail;
    this.lastGroupName = groupName;
    bumpKeyStat(keyId, keyEmail, groupName, 'success');
    const st = state.keyStats[keyId];
    if (st) {
      st.successUpstreamMs += upstreamMs;
      scheduleStatsSave();
    }
  }

  finish(outcome: RequestOutcome, httpStatus: number | null, note?: string): void {
    if (this.finished) return;
    this.finished = true;
    const entry: ActivityEntry = {
      id: this.id,
      ts: Date.now(),
      method: this.method,
      path: this.path,
      model: this.model,
      keyEmail: this.lastKeyEmail,
      keyId: this.lastKeyId,
      groupName: this.lastGroupName,
      outcome,
      httpStatus,
      durationMs: Date.now() - this.startedAt,
      isStream: this.isStream,
      attempts: this.attempts,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      note: note ?? this.lastNote,
    };
    this.entry = entry;
    state.entries.unshift(entry);
    if (state.entries.length > LOG_BUFFER_SIZE) {
      state.entries.length = LOG_BUFFER_SIZE;
    }
  }

  // Rewrite the outcome of an already-finished entry. Used by streaming
  // responses: the route commits `success` when the 200 head is decided, but
  // the real outcome becomes known only when the stream ends — a stream that
  // dies mid-body must not sit in the log as a green OK. No-op before
  // finish() or on a fresh tracker.
  rewriteOutcome(outcome: RequestOutcome, httpStatus: number | null, note?: string): void {
    if (!this.finished || !this.entry) return;
    this.entry.outcome = outcome;
    this.entry.httpStatus = httpStatus;
    this.entry.durationMs = Date.now() - this.startedAt;
    if (note !== undefined) this.entry.note = note;
  }
}

export function startRequest(reqId: number, method: string, path: string): RequestTracker {
  return new RequestTracker(reqId, method, path);
}

// ---------------------------------------------------------------------------
// Snapshot / reset (dashboard API)
// ---------------------------------------------------------------------------

export function getActivitySnapshot(limit: number): ActivitySnapshot {
  loadStatsOnce();
  const keys: KeyStatsView[] = Object.entries(state.keyStats).map(([keyId, st]) => ({
    keyId,
    ...st,
    avgUpstreamMs: st.successes > 0 ? Math.round(st.successUpstreamMs / st.successes) : null,
  }));
  // Most recently used first — matches how an operator scans the table.
  keys.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  const totals = { attempts: 0, successes: 0, rateLimited: 0, invalid: 0, providerErrors: 0, networkErrors: 0, timeouts: 0, slowMarks: 0, inputTokens: 0, outputTokens: 0 };
  for (const st of Object.values(state.keyStats)) {
    totals.attempts += st.attempts;
    totals.successes += st.successes;
    totals.rateLimited += st.rateLimited;
    totals.invalid += st.invalid;
    totals.providerErrors += st.providerErrors;
    totals.networkErrors += st.networkErrors;
    totals.timeouts += st.timeouts;
    totals.slowMarks += st.slowMarks;
    totals.inputTokens += st.inputTokens;
    totals.outputTokens += st.outputTokens;
  }

  return {
    entries: state.entries.slice(0, Math.max(0, Math.min(limit, LOG_BUFFER_SIZE))),
    keys,
    totals,
    serverStartedAt: state.serverStartedAt,
    logCapacity: LOG_BUFFER_SIZE,
  };
}

// Clear the in-memory request log only — cumulative key stats stay.
export function clearActivityLog(): void {
  state.entries = [];
}

// Wipe cumulative key stats (memory + stats.json). Irreversible. If the
// unlink fails (EPERM from an indexer / AV holding the file), rewrite the
// file with the now-empty stats instead: `loaded` stays true so a later
// lazy load would not re-read it, but a fresh process must not resurrect
// the wiped counters from the stale file.
export function resetKeyStats(): void {
  state.keyStats = {};
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  try {
    if (fs.existsSync(STATS_FILE_PATH)) fs.unlinkSync(STATS_FILE_PATH);
  } catch (error) {
    console.error('Failed to remove stats.json, rewriting it empty:', error);
    persistStats();
  }
}

// Flush pending stats synchronously. Called on server shutdown: the save
// timer is unref'd and debounced for 5s, so without this the last few
// seconds of statistics (tokens of streams that just ended, late successes)
// would be lost to process.exit().
export function flushStatsNow(): void {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (state.loaded) persistStats();
}
