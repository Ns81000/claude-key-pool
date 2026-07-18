import { getKeyState, loadConfig, proxyState } from './config';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'REQUEST' | 'POOL';

// ANSI color codes for rich terminal output
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const WHITE = '\x1b[37m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';
const BG_YELLOW = '\x1b[43m';
const BG_CYAN = '\x1b[46m';
const BG_MAGENTA = '\x1b[45m';
const BG_BLUE = '\x1b[44m';
const BLACK = '\x1b[30m';

// Icons for each log level (Unicode)
const ICONS: Record<LogLevel, string> = {
  INFO:    '  ℹ ',
  WARN:    '  ⚠ ',
  ERROR:   '  ✖ ',
  SUCCESS: '  ✔ ',
  REQUEST: '  → ',
  POOL:    '  ◎ ',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  INFO:    `${BG_CYAN}${BLACK}${BOLD}`,
  WARN:    `${BG_YELLOW}${BLACK}${BOLD}`,
  ERROR:   `${BG_RED}${WHITE}${BOLD}`,
  SUCCESS: `${BG_GREEN}${BLACK}${BOLD}`,
  REQUEST: `${BG_BLUE}${WHITE}${BOLD}`,
  POOL:    `${BG_MAGENTA}${WHITE}${BOLD}`,
};

const TEXT_COLORS: Record<LogLevel, string> = {
  INFO:    CYAN,
  WARN:    YELLOW,
  ERROR:   RED,
  SUCCESS: GREEN,
  REQUEST: BLUE,
  POOL:    MAGENTA,
};

function getTimestamp() {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const HH = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${HH}:${mm}:${ss}`;
}

// Monotonically increasing request counter for easy tracking
let requestCounter = 0;
export function nextRequestId(): number {
  return ++requestCounter;
}

export function proxyLog(level: LogLevel, keyEmail: string | undefined, message: string) {
  const ts = getTimestamp();
  const icon = ICONS[level];
  const levelColor = LEVEL_COLORS[level];
  const textColor = TEXT_COLORS[level];
  const keyLabel = keyEmail
    ? `${DIM}[${RESET}${WHITE}${keyEmail}${RESET}${DIM}]${RESET}`
    : '';

  const badge = `${levelColor}${icon}${RESET}`;
  const timestamp = `${DIM}${ts}${RESET}`;
  const msg = `${textColor}${message}${RESET}`;

  const logStr = `${badge} ${timestamp} ${keyLabel} ${msg}`;

  if (level === 'ERROR') {
    console.error(logStr);
  } else if (level === 'WARN') {
    console.warn(logStr);
  } else {
    console.log(logStr);
  }
}

// Log a separator line for visual grouping
export function logSeparator() {
  console.log(`${DIM}${'─'.repeat(70)}${RESET}`);
}

// Log incoming request with a tracking ID
export function logRequestStart(reqId: number, method: string, path: string, isStream?: boolean) {
  const streamTag = isStream ? ` ${CYAN}[stream]${RESET}` : '';
  proxyLog('REQUEST', undefined, `#${reqId} ${BOLD}${method} ${path}${RESET}${streamTag}`);
}

// Log which key was selected for a request
export function logKeySelected(reqId: number, keyEmail: string, groupName: string, inFlight: number) {
  const flightTag = inFlight > 0 ? ` ${YELLOW}(${inFlight} in-flight)${RESET}` : '';
  proxyLog('INFO', keyEmail, `#${reqId} Selected from group "${groupName}"${flightTag}`);
}

// Log request completion
export function logRequestComplete(reqId: number, keyEmail: string, durationMs: number) {
  const dur = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`;
  proxyLog('SUCCESS', keyEmail, `#${reqId} Completed in ${BOLD}${dur}${RESET}`);
}

// Log a rotation event
export function logRotation(reqId: number, fromEmail: string, reason: string) {
  proxyLog('WARN', fromEmail, `#${reqId} Rotating → ${reason}`);
}

// Log when all keys are exhausted
export function logExhausted(reqId: number, totalTried: number, totalKeys: number) {
  proxyLog('ERROR', undefined, `#${reqId} All keys exhausted (tried ${totalTried}/${totalKeys})`);
}

// Print a pool status summary (great for startup and periodic status)
export function logPoolStatus() {
  try {
    const config = loadConfig();
    const flatKeys: { email: string; groupName: string; keyId: string }[] = [];
    for (const g of config.groups) {
      if (g.disabled) continue;
      for (const k of g.keys) {
        if (k.disabled) continue;
        flatKeys.push({ email: k.email, groupName: g.name, keyId: k.id });
      }
    }

    // Count disabled items for the summary line
    let disabledGroups = 0;
    let disabledKeys = 0;
    for (const g of config.groups) {
      if (g.disabled) {
        disabledGroups++;
        disabledKeys += g.keys.length;
      } else {
        disabledKeys += g.keys.filter(k => k.disabled).length;
      }
    }

    if (flatKeys.length === 0 && disabledKeys === 0) {
      proxyLog('POOL', undefined, 'No keys configured. Add keys at http://localhost:9999');
      return;
    }

    let active = 0, limited = 0, invalid = 0, totalInFlight = 0;
    for (const fk of flatKeys) {
      const st = getKeyState(fk.keyId);
      if (st.status === 'active') active++;
      else if (st.status === 'rate-limited') limited++;
      else if (st.status === 'invalid') invalid++;
      totalInFlight += st.inFlight;
    }

    const parts: string[] = [
      `${BOLD}${flatKeys.length}${RESET}${MAGENTA} total`,
      `${GREEN}${active} active${RESET}`,
    ];
    if (limited > 0) parts.push(`${YELLOW}${limited} rate-limited${RESET}`);
    if (invalid > 0) parts.push(`${RED}${invalid} invalid${RESET}`);
    if (disabledKeys > 0) parts.push(`${DIM}${disabledKeys} disabled${RESET}`);
    if (totalInFlight > 0) parts.push(`${CYAN}${totalInFlight} in-flight${RESET}`);

    proxyLog('POOL', undefined, `Pool: ${parts.join(`${DIM} · ${RESET}`)}`);

    // Show groups summary
    for (const g of config.groups) {
      if (g.disabled) {
        proxyLog('POOL', undefined, `  ${DIM}├─${RESET} ${g.name} ${DIM}(disabled — ${g.keys.length} keys)${RESET}`);
        continue;
      }
      const enabledKeys = g.keys.filter(k => !k.disabled);
      const gDisabled = g.keys.length - enabledKeys.length;
      const gActive = enabledKeys.filter(k => getKeyState(k.id).status === 'active').length;
      const gTotal = enabledKeys.length;
      const statusColor = gActive === gTotal ? GREEN : gActive > 0 ? YELLOW : RED;
      const disabledTag = gDisabled > 0 ? ` ${DIM}(${gDisabled} disabled)${RESET}` : '';
      proxyLog('POOL', undefined, `  ${DIM}├─${RESET} ${g.name} ${statusColor}(${gActive}/${gTotal} active)${RESET}${disabledTag} → ${DIM}${g.targetUrl || '(no URL)'}${RESET}`);
    }
  } catch {
    // Config not loaded yet — skip
  }
}

// Startup banner
export function logStartupBanner() {
  console.log('');
  console.log(`${BOLD}${CYAN}  ╔═══════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}  ║                                                   ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║   ${WHITE}⚡ Claude Key Pool Proxy${CYAN}                        ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║   ${DIM}True Round-Robin · Flat Pool · Auto-Rotate${CYAN}      ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║                                                   ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║   ${GREEN}Dashboard:  ${WHITE}http://localhost:9999${CYAN}                ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║   ${GREEN}Proxy:      ${WHITE}http://localhost:9999/v1/messages${CYAN}    ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ║                                                   ║${RESET}`);
  console.log(`${BOLD}${CYAN}  ╚═══════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  logPoolStatus();
  logSeparator();
  console.log(`${DIM}  Waiting for requests...${RESET}`);
  console.log('');
}
