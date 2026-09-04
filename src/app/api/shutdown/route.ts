import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, saveConfig, disconnectFromClaude } from '@/lib/config';
import { rejectCrossSiteRequest } from '@/lib/localGuard';

export const dynamic = 'force-dynamic';

// Stops the local proxy server. Intended for the "Quit" button in the dashboard
// so a user can shut the proxy down without hunting for the terminal window.
//
// Before exiting we restore the Claude CLI settings.json to its original state
// (undoing any Connect) so we never leave the user pointed at a proxy that is
// no longer running.
export async function POST(req: NextRequest) {
  const rejected = rejectCrossSiteRequest(req);
  if (rejected) return rejected;
  try {
    const config = loadConfig();
    if (config.isConnected) {
      const reverted = disconnectFromClaude(config);
      await saveConfig(reverted);
    }
  } catch (error) {
    // Best-effort: even if the revert fails, still shut down so the user isn't
    // stuck with a running process they can't stop from the UI.
    console.error('Failed to restore settings.json on shutdown:', error);
  }

  // Bug #6 fix: increased from 300ms to 1000ms for more reliable response flushing.
  // Respond before exiting so the browser gets a clean acknowledgement.
  setTimeout(() => {
    process.exit(0);
  }, 1000);
  return NextResponse.json({ ok: true, message: 'Server shutting down' });
}
