'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  History,
  BarChart3,
  Trash2,
  RotateCcw,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import type { ActivityEntry, ActivitySnapshot, KeyStatsView, RequestOutcome } from '@/lib/activity';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtRelative(ts: number | null): string {
  if (ts === null) return 'never';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Outcome badge
// ---------------------------------------------------------------------------

const OUTCOME_STYLES: Record<RequestOutcome, { label: string; color: string; bg: string }> = {
  success: { label: 'OK', color: 'var(--color-status-ready)', bg: 'var(--color-status-ready-bg)' },
  'rate-limited': { label: 'Limited', color: 'var(--color-status-limited)', bg: 'var(--color-status-limited-bg)' },
  invalid: { label: 'Invalid', color: 'var(--color-status-invalid)', bg: 'var(--color-status-invalid-bg)' },
  'provider-error': { label: 'Provider', color: 'var(--color-status-invalid)', bg: 'var(--color-status-invalid-bg)' },
  'client-error': { label: 'Client', color: 'var(--color-ink)', bg: 'var(--color-surface-strong)' },
  aborted: { label: 'Aborted', color: 'var(--color-muted)', bg: 'var(--color-surface-soft)' },
  exhausted: { label: 'Exhausted', color: 'var(--color-status-limited)', bg: 'var(--color-status-limited-bg)' },
  'ip-paused': { label: 'IP pause', color: 'var(--color-status-limited)', bg: 'var(--color-status-limited-bg)' },
  'no-pool': { label: 'No pool', color: 'var(--color-status-invalid)', bg: 'var(--color-status-invalid-bg)' },
  rejected: { label: 'Rejected', color: 'var(--color-status-invalid)', bg: 'var(--color-status-invalid-bg)' },
};

function OutcomeBadge({ outcome }: { outcome: RequestOutcome }) {
  const style = OUTCOME_STYLES[outcome] ?? OUTCOME_STYLES['client-error'];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-[5px] text-[11px] font-medium whitespace-nowrap"
      style={{ color: style.color, backgroundColor: style.bg }}
    >
      {style.label}
    </span>
  );
}

// Which client profile a request/key usage belongs to: Kilo Code or Claude
// Code (the default for header-less clients).
function ClientBadge({ client }: { client: 'claude' | 'kilo' }) {
  if (client !== 'kilo') {
    return <span className="text-[11px] text-muted">claude</span>;
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-[5px] text-[11px] font-medium whitespace-nowrap text-[color:var(--color-status-limited)] bg-[var(--color-status-limited-bg)]">
      kilo
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const th = 'px-3 py-2 text-[11px] font-medium text-muted text-left whitespace-nowrap';
const td = 'px-3 py-2.5 text-[13px] text-ink whitespace-nowrap';

function PanelButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[8px] border border-hairline text-[12px] font-medium text-muted hover:text-ink hover:border-border-strong transition-colors cursor-pointer"
    >
      {children}
    </button>
  );
}

function KeyStatisticsTable({ keys }: { keys: KeyStatsView[] }) {
  if (keys.length === 0) {
    return (
      <div className="py-8 text-center text-[13px] text-muted border border-dashed border-hairline rounded-[10px]">
        No key usage recorded yet. Statistics accumulate while the pool serves requests and persist across restarts.
      </div>
    );
  }
  return (
    <div className="border border-hairline rounded-[10px] overflow-x-auto">
      <table className="w-full border-collapse min-w-[760px]">
        <thead className="bg-surface-soft">
          <tr>
            <th className={th}>Key</th>
            <th className={th}>Group</th>
            <th className={`${th} text-right`}>Requests</th>
            <th className={th} title="Requests by client profile: Claude Code vs Kilo Code">Client split</th>
            <th className={`${th} text-right`}>OK</th>
            <th className={`${th} text-right`}>Limited</th>
            <th className={`${th} text-right`}>Invalid</th>
            <th className={`${th} text-right`}>Errors</th>
            <th className={`${th} text-right`} title="Average upstream latency of successful calls">Upstream</th>
            <th className={`${th} text-right`}>Tokens in / out</th>
            <th className={th}>Last used</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const errors = k.providerErrors + k.networkErrors + k.timeouts + k.slowMarks;
            const successRate = k.attempts > 0 ? Math.round((k.successes / k.attempts) * 100) : null;
            return (
              <tr key={k.keyId} className="border-t border-hairline">
                <td className={`${td} max-w-[180px] truncate`} title={k.keyId}>
                  {k.label}
                  {successRate !== null && (
                    <span className="ml-2 text-[11px] text-muted">{successRate}%</span>
                  )}
                </td>
                <td className={`${td} text-muted max-w-[140px] truncate`}>{k.groupName}</td>
                <td className={`${td} text-right font-mono text-[12px]`}>{k.attempts}</td>
                <td
                  className={`${td} text-[12px] text-muted`}
                  title={
                    `claude: ${k.attemptsClaude} req · ${fmtTokens(k.inputTokensClaude)} in / ${fmtTokens(k.outputTokensClaude)} out\n` +
                    `kilo: ${k.attemptsKilo} req · ${fmtTokens(k.inputTokensKilo)} in / ${fmtTokens(k.outputTokensKilo)} out`
                  }
                >
                  {k.attemptsKilo > 0 || k.attemptsClaude > 0 ? (
                    <>
                      claude {k.attemptsClaude}
                      <span className="mx-1 text-muted/50">·</span>
                      kilo {k.attemptsKilo}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={`${td} text-right font-mono text-[12px] text-[color:var(--color-status-ready)]`}>{k.successes}</td>
                <td className={`${td} text-right font-mono text-[12px] text-[color:var(--color-status-limited)]`}>
                  {k.rateLimited > 0 ? k.rateLimited : '—'}
                </td>
                <td className={`${td} text-right font-mono text-[12px] text-[color:var(--color-status-invalid)]`}>
                  {k.invalid > 0 ? k.invalid : '—'}
                </td>
                <td className={`${td} text-right font-mono text-[12px]`} title={
                  `provider: ${k.providerErrors} · network: ${k.networkErrors} · timeouts: ${k.timeouts} · slow: ${k.slowMarks}`
                }>
                  {errors > 0 ? errors : '—'}
                </td>
                <td className={`${td} text-right font-mono text-[12px]`} title="Average upstream latency of successful calls (fetch → first verdict)">
                  {fmtDuration(k.avgUpstreamMs)}
                </td>
                <td className={`${td} text-right font-mono text-[12px] text-muted`}>
                  {k.inputTokens > 0 || k.outputTokens > 0 ? (
                    <>
                      <ArrowDownToLine className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                      {fmtTokens(k.inputTokens)}
                      <span className="mx-1 text-muted/50">/</span>
                      <ArrowUpFromLine className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                      {fmtTokens(k.outputTokens)}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={`${td} text-muted`}>{fmtRelative(k.lastUsedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RequestsTable({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-[13px] text-muted border border-dashed border-hairline rounded-[10px]">
        No requests logged yet. The log keeps the last requests served since the server started.
      </div>
    );
  }
  return (
    <div className="border border-hairline rounded-[10px] overflow-x-auto">
      <table className="w-full border-collapse min-w-[880px]">
        <thead className="bg-surface-soft">
          <tr>
            <th className={th}>Time</th>
            <th className={th}>#</th>
            <th className={th}>Path</th>
            <th className={th}>Client</th>
            <th className={th}>Model</th>
            <th className={th}>Key</th>
            <th className={th}>Outcome</th>
            <th className={`${th} text-right`}>HTTP</th>
            <th className={`${th} text-right`}>Duration</th>
            <th className={`${th} text-right`}>Tokens</th>
            <th className={`${th} text-right`}>Tries</th>
            <th className={th}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-hairline">
              <td className={`${td} font-mono text-[12px] text-muted`}>{fmtTime(e.ts)}</td>
              <td className={`${td} font-mono text-[12px] text-muted`}>{e.id}</td>
              <td className={`${td} font-mono text-[12px]`}>
                {e.method} {e.path}
                {e.isStream && <span className="ml-1.5 text-[10px] text-[color:var(--color-status-limited)]">stream</span>}
              </td>
              <td className={td}>
                <ClientBadge client={e.client ?? 'claude'} />
              </td>
              <td className={`${td} font-mono text-[12px] max-w-[140px] truncate`}>{e.model ?? '—'}</td>
              <td className={`${td} max-w-[160px] truncate`} title={e.groupName ?? undefined}>
                {e.keyEmail ?? '—'}
              </td>
              <td className={td}>
                <OutcomeBadge outcome={e.outcome} />
              </td>
              <td className={`${td} text-right font-mono text-[12px]`}>{e.httpStatus ?? '—'}</td>
              <td className={`${td} text-right font-mono text-[12px]`}>{fmtDuration(e.durationMs)}</td>
              <td className={`${td} text-right font-mono text-[12px] text-muted`}>
                {e.inputTokens !== null || e.outputTokens !== null
                  ? `${e.inputTokens ?? '—'} / ${e.outputTokens ?? '—'}`
                  : '—'}
              </td>
              <td className={`${td} text-right font-mono text-[12px]`}>{e.attempts}</td>
              <td className={`${td} text-muted max-w-[260px] truncate`} title={e.note ?? undefined}>
                {e.note ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function ActivityPanel() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch('/api/activity?limit=150');
      if (res.ok) setSnapshot(await res.json());
    } catch {
      // The dashboard's own config polling surfaces connectivity problems —
      // silently skip this cycle and retry on the next tick.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Async IIFE (same pattern as the main page's config load): the state
    // update happens after an await, not synchronously in the effect body.
    (async () => {
      try {
        const res = await fetch('/api/activity?limit=150');
        if (!cancelled && res.ok) setSnapshot(await res.json());
      } catch {
        /* retried by the poll below */
      }
    })();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fetchActivity();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [fetchActivity]);

  const clearLogs = async () => {
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clearLogs' }),
      });
      if (res.ok) setSnapshot(await res.json());
    } catch {
      /* retried by the poll */
    }
  };

  const resetStats = async () => {
    if (!window.confirm('Reset all accumulated key statistics? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetStats' }),
      });
      if (res.ok) setSnapshot(await res.json());
    } catch {
      /* retried by the poll */
    }
  };

  const totals = snapshot?.totals;

  return (
    <section className="flex flex-col gap-6">
      {/* Key statistics */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-medium text-ink flex items-center gap-2">
            <BarChart3 className="w-4.5 h-4.5 text-muted" />
            Key statistics
            <span className="text-[13px] font-normal text-muted">
              all-time, persisted across restarts
            </span>
          </h2>
          <PanelButton onClick={resetStats} title="Reset accumulated statistics">
            <RotateCcw className="w-3.5 h-3.5" />
            Reset stats
          </PanelButton>
        </div>
        {totals && (totals.attempts > 0 || totals.inputTokens > 0) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted">
            <span>
              <span className="text-ink font-medium font-mono">{totals.attempts}</span> key attempts
            </span>
            <span>
              <span className="text-ink font-medium font-mono text-[color:var(--color-status-ready)]">{totals.successes}</span> succeeded
            </span>
            <span>
              <span className="text-ink font-medium font-mono text-[color:var(--color-status-limited)]">{totals.rateLimited}</span> rate-limited
            </span>
            <span>
              <span className="text-ink font-medium font-mono text-[color:var(--color-status-invalid)]">{totals.invalid}</span> invalid
            </span>
            <span>
              <ArrowDownToLine className="w-3 h-3 inline -mt-0.5" />{' '}
              <span className="text-ink font-medium font-mono">{fmtTokens(totals.inputTokens)}</span> in /{' '}
              <ArrowUpFromLine className="w-3 h-3 inline -mt-0.5" />{' '}
              <span className="text-ink font-medium font-mono">{fmtTokens(totals.outputTokens)}</span> out
            </span>
            {(totals.attemptsKilo > 0 || totals.attemptsClaude > 0) && (
              <span
                className="whitespace-nowrap"
                title={
                  `claude: ${totals.attemptsClaude} attempts · ${fmtTokens(totals.inputTokensClaude)} in / ${fmtTokens(totals.outputTokensClaude)} out\n` +
                  `kilo: ${totals.attemptsKilo} attempts · ${fmtTokens(totals.inputTokensKilo)} in / ${fmtTokens(totals.outputTokensKilo)} out`
                }
              >
                <span className="text-muted">·</span> claude{' '}
                <span className="text-ink font-medium font-mono">{totals.attemptsClaude}</span>
                <span className="mx-1.5 text-muted/50">/</span>
                kilo{' '}
                <span className="text-ink font-medium font-mono text-[color:var(--color-status-limited)]">{totals.attemptsKilo}</span>
              </span>
            )}
          </div>
        )}
        <KeyStatisticsTable keys={snapshot?.keys ?? []} />
      </div>

      {/* Recent requests */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-medium text-ink flex items-center gap-2">
            <History className="w-4.5 h-4.5 text-muted" />
            Recent requests
            <span className="text-[13px] font-normal text-muted">
              this server session
            </span>
          </h2>
          <PanelButton onClick={clearLogs} title="Clear the request log">
            <Trash2 className="w-3.5 h-3.5" />
            Clear log
          </PanelButton>
        </div>
        <RequestsTable entries={snapshot?.entries ?? []} />
      </div>
    </section>
  );
}
