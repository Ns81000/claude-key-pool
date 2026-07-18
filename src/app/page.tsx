'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Link2,
  Link2Off,
  Check,
  X,
  AlertTriangle,
  Circle,
  Power,
  Zap,
  Activity,
} from 'lucide-react';
import type { AppConfigView, GroupView, KeyView, PoolStats } from '@/lib/config';

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

const noAutofill = {
  autoComplete: 'off' as const,
  autoCorrect: 'off' as const,
  autoCapitalize: 'off' as const,
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
};

const secretAutofill = { ...noAutofill, autoComplete: 'new-password' as const };

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 11)}`;
}

function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[12px] text-[14px] font-medium leading-none transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed select-none cursor-pointer';
  const variants: Record<string, string> = {
    primary: 'bg-ink text-white px-5 py-2.5 hover:bg-ink-active active:bg-ink-active',
    secondary:
      'bg-canvas text-ink px-5 py-2.5 border border-hairline hover:border-border-strong',
    ghost: 'bg-transparent text-muted px-3 py-2 hover:text-ink hover:bg-surface-soft',
    danger:
      'bg-canvas text-[color:var(--color-status-invalid)] px-4 py-2 border border-hairline hover:border-[color:var(--color-status-invalid)]',
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

function TextInput({
  className = '',
  mono = false,
  ...props
}: { mono?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full h-11 px-4 rounded-[6px] bg-canvas text-ink text-[14px] border border-hairline focus:border-[color:var(--color-border-strong)] placeholder:text-muted/50 transition-colors ${
        mono ? 'font-mono text-[13px]' : ''
      } ${className}`}
      {...props}
    />
  );
}

function StatusChip({ status, cooldownUntil, inFlight, disabled }: { status: string; cooldownUntil: string | null; inFlight: number; disabled?: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'rate-limited' || !cooldownUntil) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status, cooldownUntil]);

  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-surface-soft border border-hairline text-muted">
        <Power className="w-3.5 h-3.5" />
        Disabled
      </span>
    );
  }

  if (status === 'rate-limited') {
    let remaining = '';
    if (cooldownUntil) {
      const secs = Math.ceil((new Date(cooldownUntil).getTime() - nowMs) / 1000);
      if (secs > 0) remaining = ` ${secs}s`;
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-[color:var(--color-status-limited-bg)] text-[color:var(--color-status-limited)]">
        <AlertTriangle className="w-3.5 h-3.5" />
        Rate-limited{remaining}
      </span>
    );
  }
  if (status === 'invalid') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-[color:var(--color-status-invalid-bg)] text-[color:var(--color-status-invalid)]">
        <X className="w-3.5 h-3.5" />
        Invalid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-[color:var(--color-status-ready-bg)] text-[color:var(--color-status-ready)]">
      <Check className="w-3.5 h-3.5" />
      Ready
      {inFlight > 0 && (
        <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-[color:var(--color-status-limited)]">
          <Zap className="w-3 h-3" />
          {inFlight}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pool stats banner
// ---------------------------------------------------------------------------

function PoolStatsBanner({ stats }: { stats: PoolStats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <StatCard label="Total Keys" value={stats.totalKeys} />
      <StatCard
        label="Active"
        value={stats.activeKeys}
        color="var(--color-status-ready)"
      />
      <StatCard
        label="Rate-Limited"
        value={stats.rateLimitedKeys}
        color="var(--color-status-limited)"
      />
      <StatCard
        label="Invalid"
        value={stats.invalidKeys}
        color="var(--color-status-invalid)"
      />
      <StatCard
        label="In-Flight"
        value={stats.totalInFlight}
        color="var(--color-status-limited)"
        icon={<Activity className="w-3.5 h-3.5" />}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-[10px] border border-hairline bg-surface-soft">
      <span className="text-[12px] text-muted font-medium">{label}</span>
      <span
        className="text-[22px] font-medium leading-none flex items-center gap-1.5"
        style={color ? { color } : undefined}
      >
        {icon}
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  message: string;
  tone: 'default' | 'error';
}

function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`cursor-pointer max-w-sm px-4 py-3 rounded-[10px] text-[14px] shadow-sm border ${
            t.tone === 'error'
              ? 'bg-[color:var(--color-status-invalid-bg)] border-[color:var(--color-status-invalid)]/30 text-[color:var(--color-status-invalid)]'
              : 'bg-ink border-ink text-white'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState | null;
  onClose: () => void;
}) {
  if (!state) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-canvas rounded-[12px] border border-hairline p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-[18px] font-medium text-ink">{state.title}</h3>
          <p className="text-[14px] text-body mt-1.5">{state.message}</p>
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="bg-[color:var(--color-status-invalid)] hover:bg-[color:var(--color-status-invalid)]"
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            {state.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}····${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const [config, setConfig] = useState<AppConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupUrl, setNewGroupUrl] = useState('');

  const [newKeyEmail, setNewKeyEmail] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const urlDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToast = useCallback((message: string, tone: Toast['tone'] = 'default') => {
    const id = genId('toast');
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('Failed to load configuration');
      setConfig(await res.json());
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to load', 'error');
    }
  }, [pushToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error('Failed to load configuration');
        const data = await res.json();
        if (!cancelled) setConfig(data);
      } catch (err) {
        if (!cancelled) pushToast(err instanceof Error ? err.message : 'Failed to load', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushToast]);

  const activeGroup: GroupView | undefined = config?.groups.find(
    (g) => g.id === config.activeGroupId,
  );

  // Bug #12 fix: always poll every 5 seconds (with visibility check), not just
  // when a cooldown is active. This ensures state changes from proxy activity
  // are reflected even when all keys were previously "Ready".
  useEffect(() => {
    function poll() {
      if (document.visibilityState === 'visible') {
        fetchConfig();
      }
    }
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [fetchConfig]);

  const post = useCallback(
    async (payload: Record<string, unknown>): Promise<AppConfigView | null> => {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setConfig(data);
      return data;
    },
    [],
  );

  const saveGroups = useCallback(
    async (groups: GroupView[], activeGroupId?: string | null) => {
      const cfg = config;
      if (!cfg) return;
      await post({
        action: 'save',
        config: {
          groups,
          activeGroupId: activeGroupId === undefined ? cfg.activeGroupId : activeGroupId,
        },
      });
    },
    [config, post],
  );

  const selectGroup = async (groupId: string) => {
    try {
      await post({ action: 'setActiveGroup', activeGroupId: groupId });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const createGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config || !newGroupName.trim() || !newGroupUrl.trim()) return;
    const group: GroupView = {
      id: genId('group'),
      name: newGroupName.trim(),
      targetUrl: newGroupUrl.trim().replace(/\/$/, ''),
      keys: [],
    };
    try {
      await saveGroups([...config.groups, group], config.activeGroupId || group.id);
      setNewGroupName('');
      setNewGroupUrl('');
      setShowNewGroup(false);
      pushToast(`Group "${group.name}" created`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const toggleGroupDisabled = async (group: GroupView) => {
    if (!config) return;
    const groups = config.groups.map((g) =>
      g.id === group.id ? { ...g, disabled: !g.disabled } : g,
    );
    try {
      await saveGroups(groups);
      pushToast(`Group ${group.disabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const toggleKeyDisabled = async (group: GroupView, key: KeyView) => {
    if (!config) return;
    const groups = config.groups.map((g) =>
      g.id === group.id
        ? {
            ...g,
            keys: g.keys.map((k) =>
              k.id === key.id ? { ...k, disabled: !k.disabled } : k,
            ),
          }
        : g,
    );
    try {
      await saveGroups(groups);
      pushToast(`Key ${key.disabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const deleteGroup = (group: GroupView) => {
    if (!config) return;
    setConfirm({
      title: 'Delete group',
      message: `Delete "${group.name}" and its ${group.keys.length} key(s)? This cannot be undone.`,
      confirmLabel: 'Delete group',
      onConfirm: async () => {
        const remaining = config.groups.filter((g) => g.id !== group.id);
        const nextActive =
          config.activeGroupId === group.id
            ? remaining[0]?.id ?? null
            : config.activeGroupId;
        try {
          await saveGroups(remaining, nextActive);
          pushToast('Group deleted');
        } catch (err) {
          pushToast(err instanceof Error ? err.message : 'Error', 'error');
        }
      },
    });
  };

  const updateGroupUrl = (groupId: string, url: string) => {
    if (!config) return;
    const groups = config.groups.map((g) => (g.id === groupId ? { ...g, targetUrl: url } : g));
    setConfig({ ...config, groups });
    if (urlDebounce.current) clearTimeout(urlDebounce.current);
    urlDebounce.current = setTimeout(() => {
      saveGroups(groups.map((g) => (g.id === groupId ? { ...g, targetUrl: url.trim() } : g))).catch(
        (err) => pushToast(err instanceof Error ? err.message : 'Error', 'error'),
      );
    }, 600);
  };

  const cooldownDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateGroupCooldown = (groupId: string, hoursStr: string) => {
    if (!config) return;
    
    const hours = hoursStr === '' ? undefined : parseFloat(hoursStr);
    
    const groups = config.groups.map((g) => (g.id === groupId ? { ...g, rateLimitCooldownHours: hours } : g));
    setConfig({ ...config, groups });
    
    if (cooldownDebounce.current) clearTimeout(cooldownDebounce.current);
    cooldownDebounce.current = setTimeout(() => {
      saveGroups(groups).catch(
        (err) => pushToast(err instanceof Error ? err.message : 'Error', 'error'),
      );
    }, 600);
  };

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config || !activeGroup) return;
    const value = newKeyValue.trim();
    if (!value) return;

    if (activeGroup.keys.some((k) => k.key === value)) {
      pushToast('That key is already in this group', 'error');
      return;
    }

    const newKey: KeyView = {
      id: genId('key'),
      email: newKeyEmail.trim() || 'Unlabeled key',
      key: value,
      status: 'active',
      cooldownUntil: null,
      inFlight: 0,
      groupName: activeGroup.name,
    };
    const groups = config.groups.map((g) =>
      g.id === activeGroup.id ? { ...g, keys: [...g.keys, newKey] } : g,
    );
    try {
      await saveGroups(groups);
      setNewKeyEmail('');
      setNewKeyValue('');
      pushToast('Key added');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const keyPrefixWarning =
    newKeyValue.trim() &&
    !newKeyValue.trim().startsWith('sk-') &&
    !newKeyValue.trim().startsWith('fe_');

  // Bug #14 fix: add confirmation dialog before deleting a key.
  const deleteKey = (key: KeyView) => {
    if (!config || !activeGroup) return;
    setConfirm({
      title: 'Delete key',
      message: `Delete the key "${key.email}"? This cannot be undone.`,
      confirmLabel: 'Delete key',
      onConfirm: async () => {
        const groups = config.groups.map((g) =>
          g.id === activeGroup.id ? { ...g, keys: g.keys.filter((k) => k.id !== key.id) } : g,
        );
        try {
          await saveGroups(groups);
          pushToast('Key deleted');
        } catch (err) {
          pushToast(err instanceof Error ? err.message : 'Error', 'error');
        }
      },
    });
  };

  const toggleConnection = async () => {
    if (!config) return;
    const action = config.isConnected ? 'disconnect' : 'connect';
    try {
      await post({ action });
      pushToast(action === 'connect' ? 'Connected to Claude CLI' : 'Disconnected from Claude CLI');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Connection failed', 'error');
    }
  };

  const [stopped, setStopped] = useState(false);
  const stopServer = () => {
    setConfirm({
      title: 'Stop the proxy server',
      message:
        'This restores your Claude settings to their original state and shuts down the local proxy. Claude Code and any tools pointed at localhost:9999 will stop working until you start it again from the desktop shortcut.',
      confirmLabel: 'Stop server',
      onConfirm: async () => {
        try {
          await fetch('/api/shutdown', { method: 'POST' });
        } catch {
          /* the server may drop the connection as it exits — that's expected */
        }
        setStopped(true);
      },
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted text-[14px]">Loading Claude Key Pool…</p>
      </div>
    );
  }

  if (stopped) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-md flex flex-col items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={48} height={48} className="rounded-[10px]" />
          <h1 className="text-[22px] font-medium text-ink">Proxy server stopped</h1>
          <p className="text-[14px] text-body">
            The local server has shut down. To use Claude Key Pool again, open the
            <span className="text-ink font-medium"> Claude Key Pool</span> shortcut on your
            desktop, then refresh this page.
          </p>
        </div>
      </div>
    );
  }

  const connected = !!config?.isConnected;
  const poolStats: PoolStats = config?.poolStats ?? {
    totalKeys: 0,
    activeKeys: 0,
    rateLimitedKeys: 0,
    invalidKeys: 0,
    totalInFlight: 0,
  };

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="h-16 border-b border-hairline bg-canvas sticky top-0 z-30">
        <div className="max-w-[1120px] mx-auto h-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" width={24} height={24} className="rounded-[6px]" />
            <span className="text-[16px] font-medium text-ink tracking-tight">Claude Key Pool</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Circle
                className={`w-2.5 h-2.5 ${
                  connected
                    ? 'fill-[color:var(--color-status-ready)] text-[color:var(--color-status-ready)]'
                    : 'fill-border-strong text-border-strong'
                }`}
              />
              <span className="text-[14px] text-muted">
                {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <Button variant={connected ? 'secondary' : 'primary'} onClick={toggleConnection}>
              {connected ? (
                <>
                  <Link2Off className="w-4 h-4" /> Disconnect
                </>
              ) : (
                <>
                  <Link2 className="w-4 h-4" /> Connect
                </>
              )}
            </Button>
            <button
              onClick={stopServer}
              title="Stop the proxy server"
              aria-label="Stop the proxy server"
              className="w-10 h-10 rounded-full border border-hairline flex items-center justify-center text-muted hover:text-[color:var(--color-status-invalid)] hover:border-[color:var(--color-status-invalid)] transition-colors cursor-pointer"
            >
              <Power className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1120px] mx-auto px-6 py-12 flex flex-col gap-8">
        {/* Pool stats banner */}
        <PoolStatsBanner stats={poolStats} />

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8 items-start">
          {/* Groups rail */}
          <aside className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-medium text-ink">
                Groups
                <span className="text-muted font-normal"> · {config?.groups.length ?? 0}</span>
              </h2>
              <button
                onClick={() => setShowNewGroup((v) => !v)}
                className="w-8 h-8 rounded-full border border-hairline flex items-center justify-center text-ink hover:border-border-strong transition-colors cursor-pointer"
                aria-label="New group"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {showNewGroup && (
              <form
                onSubmit={createGroup}
                className="flex flex-col gap-3 p-4 rounded-[10px] border border-hairline bg-surface-soft"
              >
                <TextInput
                  placeholder="Group name"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  required
                  {...noAutofill}
                />
                <TextInput
                  placeholder="Upstream URL (e.g. https://api.anthropic.com)"
                  value={newGroupUrl}
                  onChange={(e) => setNewGroupUrl(e.target.value)}
                  mono
                  required
                  {...noAutofill}
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    className="flex-1"
                    disabled={!newGroupName.trim() || !newGroupUrl.trim()}
                  >
                    Create
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setShowNewGroup(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            <div className="text-[12px] text-muted px-1">
              All keys from all groups are pooled for routing. Groups organize keys for management.
            </div>

            {config && config.groups.length === 0 ? (
              <div className="text-[14px] text-muted py-8 text-center border border-dashed border-hairline rounded-[10px]">
                No groups yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {config?.groups.map((group) => {
                  const isActive = config.activeGroupId === group.id;
                  const groupActiveKeys = group.disabled ? 0 : group.keys.filter(k => !k.disabled && k.status === 'active').length;
                  const groupLimitedKeys = group.disabled ? 0 : group.keys.filter(k => !k.disabled && k.status === 'rate-limited').length;
                  const groupInvalidKeys = group.disabled ? 0 : group.keys.filter(k => !k.disabled && k.status === 'invalid').length;
                  return (
                    <div
                      key={group.id}
                      onClick={() => selectGroup(group.id)}
                      className={`group px-4 py-3 rounded-[10px] border cursor-pointer transition-colors ${
                        isActive
                          ? 'border-ink bg-surface-soft'
                          : 'border-hairline hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <Circle
                            className={`w-2 h-2 shrink-0 ${
                              isActive
                                ? 'fill-ink text-ink'
                                : 'fill-transparent text-border-strong'
                            }`}
                          />
                          <span className={`text-[14px] font-medium truncate ${group.disabled ? 'text-muted line-through' : 'text-ink'}`}>
                            {group.name}
                          </span>
                          {group.disabled && (
                            <span className="text-[10px] uppercase font-bold text-muted ml-1 bg-surface-soft px-1.5 py-0.5 rounded-[4px] border border-hairline">Disabled</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroupDisabled(group);
                            }}
                            className={`opacity-0 group-hover:opacity-100 transition cursor-pointer ${group.disabled ? 'text-[color:var(--color-status-ready)] hover:text-ink' : 'text-muted hover:text-ink'}`}
                            aria-label={group.disabled ? 'Enable group' : 'Disable group'}
                            title={group.disabled ? 'Enable group' : 'Disable group'}
                          >
                            <Power className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteGroup(group);
                            }}
                            className="opacity-0 group-hover:opacity-100 text-muted hover:text-[color:var(--color-status-invalid)] transition cursor-pointer"
                            aria-label="Delete group"
                            title="Delete group"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-4 mt-0.5">
                        <span className="text-[12px] text-muted">
                          {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                        </span>
                        {groupActiveKeys > 0 && (
                          <span className="text-[11px] text-[color:var(--color-status-ready)]">
                            {groupActiveKeys} active
                          </span>
                        )}
                        {groupLimitedKeys > 0 && (
                          <span className="text-[11px] text-[color:var(--color-status-limited)]">
                            {groupLimitedKeys} limited
                          </span>
                        )}
                        {groupInvalidKeys > 0 && (
                          <span className="text-[11px] text-[color:var(--color-status-invalid)]">
                            {groupInvalidKeys} invalid
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>

          {/* Active group panel */}
          <section className="flex flex-col gap-8">
            {activeGroup ? (
              <>
                <div className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <h1 className="text-[32px] leading-tight font-normal text-ink tracking-tight">
                      {activeGroup.name}
                    </h1>
                    <span className="text-[14px] text-muted shrink-0">
                      {activeGroup.keys.length} key{activeGroup.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <label className="text-[13px] font-medium text-muted">Upstream URL</label>
                  <TextInput
                    value={activeGroup.targetUrl}
                    onChange={(e) => updateGroupUrl(activeGroup.id, e.target.value)}
                    placeholder="https://api.anthropic.com"
                    mono
                    {...noAutofill}
                  />
                  
                  <label className="text-[13px] font-medium text-muted mt-2">Rate Limit Cooldown (Hours)</label>
                  <TextInput
                    type="number"
                    min="0"
                    step="0.1"
                    value={activeGroup.rateLimitCooldownHours ?? ''}
                    onChange={(e) => updateGroupCooldown(activeGroup.id, e.target.value)}
                    placeholder="Leave empty for default (uses API headers)"
                    mono
                    {...noAutofill}
                  />
                </div>

                {/* Add a key */}
                <form onSubmit={addKey} className="flex flex-col gap-3">
                  <h2 className="text-[18px] font-medium text-ink">Add a key</h2>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="sm:w-1/3">
                      <TextInput
                        placeholder="Email / label (optional)"
                        value={newKeyEmail}
                        onChange={(e) => setNewKeyEmail(e.target.value)}
                        {...noAutofill}
                      />
                    </div>
                    <div className="flex-1">
                      <TextInput
                        placeholder="API key (sk-… or fe_…)"
                        value={newKeyValue}
                        onChange={(e) => setNewKeyValue(e.target.value)}
                        mono
                        required
                        {...secretAutofill}
                      />
                    </div>
                    <Button type="submit" variant="primary" disabled={!newKeyValue.trim()}>
                      <Plus className="w-4 h-4" />
                      Add key
                    </Button>
                  </div>
                  {keyPrefixWarning && (
                    <div className="text-[13px] text-[color:var(--color-status-limited)] flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>Unusual key prefix (expected sk- or fe_), but it will still be added.</span>
                    </div>
                  )}
                </form>

                {/* Key list */}
                <div className="flex flex-col">
                  {activeGroup.keys.length === 0 ? (
                    <div className="text-[14px] text-muted py-10 text-center border border-dashed border-hairline rounded-[10px]">
                      No keys in this group yet. Add one above to get started.
                    </div>
                  ) : (
                    <div className="border border-hairline rounded-[10px] overflow-hidden">
                      {activeGroup.keys.map((key, i) => (
                        <div
                          key={key.id}
                          className={`group flex items-center gap-4 px-4 py-3.5 ${
                            i > 0 ? 'border-t border-hairline' : ''
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className={`text-[14px] truncate flex items-center gap-2 ${key.disabled ? 'text-muted line-through' : 'text-ink'}`}>
                              {key.email}
                              {key.disabled && (
                                <span className="text-[10px] uppercase font-bold text-muted bg-surface-soft px-1.5 py-0.5 rounded-[4px] border border-hairline no-underline">Disabled</span>
                              )}
                            </div>
                            <div className={`text-[13px] font-mono truncate ${key.disabled ? 'text-muted opacity-60' : 'text-muted'}`}>
                              {maskKey(key.key)}
                            </div>
                          </div>
                          <StatusChip status={key.status} cooldownUntil={key.cooldownUntil} inFlight={key.inFlight} disabled={key.disabled} />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => toggleKeyDisabled(activeGroup, key)}
                              className={`opacity-0 group-hover:opacity-100 transition cursor-pointer ${key.disabled ? 'text-[color:var(--color-status-ready)] hover:text-ink' : 'text-muted hover:text-ink'}`}
                              aria-label={key.disabled ? 'Enable key' : 'Disable key'}
                              title={key.disabled ? 'Enable key' : 'Disable key'}
                            >
                              <Power className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => deleteKey(key)}
                              className="opacity-0 group-hover:opacity-100 text-muted hover:text-[color:var(--color-status-invalid)] transition cursor-pointer"
                              aria-label="Delete key"
                              title="Delete key"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="py-16 text-center border border-dashed border-hairline rounded-[12px]">
                <p className="text-[16px] text-ink">No group selected</p>
                <p className="text-[14px] text-muted mt-1">
                  Select a group on the left, or create one to begin.
                </p>
              </div>
            )}

            {/* Guide card */}
            <div className="rounded-[10px] bg-surface-soft border border-hairline p-6 flex flex-col gap-2">
              <h3 className="text-[16px] font-medium text-ink">Connecting Claude Code</h3>
              <p className="text-[14px] text-body">
                <span className="text-ink font-medium">Connect</span> syncs your Claude CLI
                settings.json automatically to route through this proxy. Click{' '}
                <span className="text-ink font-medium">Disconnect</span> to restore it.
              </p>
              <p className="text-[14px] text-body">
                To point tools manually, set{' '}
                <code className="font-mono text-[13px] bg-canvas border border-hairline rounded-[6px] px-1.5 py-0.5">
                  ANTHROPIC_BASE_URL=http://localhost:9999
                </code>
                .
              </p>
              <p className="text-[14px] text-body mt-1">
                <span className="text-ink font-medium">Routing:</span> All keys from all groups are pooled
                and load-balanced via true round-robin. Each key uses its group&apos;s upstream URL and cooldown settings.
              </p>
            </div>
          </section>
        </div>
      </main>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
