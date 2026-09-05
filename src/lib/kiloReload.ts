import { execFile } from 'child_process';
import path from 'path';

export interface KiloReloadResult {
  ok: boolean;
  // 'reloaded' | 'kilo-not-running' | 'session-running' | 'failed' | 'timeout' | 'unavailable'
  status: string;
  detail?: string;
}

/**
 * Replicates the Kilo Code plugin's "Reload" button: after the pool edits
 * kilo.jsonc, the running Kilo server must be told to re-read it, otherwise
 * the model list in the session window keeps the previous provider set.
 *
 * The button posts /instance/reload to the local server the plugin spawns
 * (kilo.exe serve on a loopback port) with Basic auth "kilo:<password>" —
 * the password is generated per spawn and lives only in the server process's
 * environment, so the whole call is delegated to scripts/kilo-reload.ps1,
 * which reads it from that process and makes the POST. Best-effort by
 * design: every failure mode (Kilo not running, a session in progress,
 * PowerShell blocked) is reported, never thrown.
 */
export function triggerKiloReload(): Promise<KiloReloadResult> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, status: 'unavailable', detail: 'kilo reload is Windows-only' });
      return;
    }
    const script = path.join(process.cwd(), 'scripts', 'kilo-reload.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && err.killed) {
          resolve({ ok: false, status: 'timeout', detail: 'kilo reload timed out' });
          return;
        }
        // The script prints exactly one JSON line; tolerate PowerShell noise
        // by scanning from the end.
        const lines = String(stdout).split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
        const last = lines[lines.length - 1];
        if (!last) {
          resolve({
            ok: false,
            status: 'failed',
            detail: err ? err.message : 'no JSON output from kilo-reload.ps1',
          });
          return;
        }
        try {
          const parsed = JSON.parse(last);
          resolve({
            ok: parsed.ok === true,
            status: String(parsed.status ?? 'failed'),
            detail: parsed.detail ? String(parsed.detail) : undefined,
          });
        } catch {
          resolve({ ok: false, status: 'failed', detail: 'unparseable output from kilo-reload.ps1' });
        }
      },
    );
  });
}
