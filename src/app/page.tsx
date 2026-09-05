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
  Ban,
  ChevronDown,
} from 'lucide-react';
import type { AppConfigView, GroupView, KeyView, PoolStats } from '@/lib/config';
import ActivityPanel from './activity-panel';

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

function ToggleSwitch({
  enabled,
  onChange,
  size = 'md',
  title,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  size?: 'sm' | 'md';
  title?: string;
}) {
  const w = size === 'sm' ? 'w-8' : 'w-10';
  const h = size === 'sm' ? 'h-[18px]' : 'h-[22px]';
  const dot = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5';
  const travel = size === 'sm' ? 'translate-x-[14px]' : 'translate-x-[18px]';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!enabled);
      }}
      className={`${w} ${h} rounded-full relative cursor-pointer transition-colors duration-200 shrink-0 ${
        enabled
          ? 'bg-[color:var(--color-status-ready)]'
          : 'bg-[color:var(--color-border-strong)]'
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] ${dot} rounded-full bg-white shadow-sm transition-transform duration-200 ${
          enabled ? travel : 'translate-x-0'
        }`}
      />
    </button>
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
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-surface-strong/50 text-muted">
        <Ban className="w-3.5 h-3.5" />
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
    <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
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
        label="Disabled"
        value={stats.disabledKeys}
        color="var(--color-border-strong)"
        icon={<Ban className="w-3.5 h-3.5" />}
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
  const [newGroupModel, setNewGroupModel] = useState('');

  const [newKeyEmail, setNewKeyEmail] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [fastModelDropdownOpen, setFastModelDropdownOpen] = useState(false);
  const fastModelDropdownRef = useRef<HTMLDivElement>(null);
  const [testing, setTesting] = useState(false);
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
      if (res.status === 409) {
        // Our snapshot went stale (another tab changed the config) — refresh
        // to the server state; the caller's catch shows the toast.
        await fetchConfig();
        throw new Error('Config was changed by another tab — reloaded, retry your edit');
      }
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setConfig(data);
      return data;
    },
    [fetchConfig],
  );

  const saveGroups = useCallback(
    async (groups: GroupView[], activeGroupId?: string | null) => {
      const cfg = config;
      if (!cfg) return;
      // Echo the version of the snapshot we edited — the server rejects a
      // save from a stale state (409) instead of silently erasing another
      // tab's changes (e.g. a key added there).
      await post({
        action: 'save',
        config: {
          groups,
          activeGroupId: activeGroupId === undefined ? cfg.activeGroupId : activeGroupId,
          configVersion: cfg.configVersion,
        },
      });
    },
    [config, post],
  );

  const availableModels = useMemo(() => {
    if (!config) return [];
    const models = new Set<string>();
    // Disabled groups are not in the rotation — offering their models in the
    // dropdowns (main or fast) selects a model nobody can serve.
    for (const g of config.groups) {
      if (!g.disabled && g.model) models.add(g.model);
    }
    return Array.from(models).sort();
  }, [config]);

  const setSelectedModel = async (model: string | null) => {
    try {
      await post({ action: 'setModel', selectedModel: model });
      pushToast(model ? `Model set to ${model}` : 'Model cleared');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const setFastModel = async (model: string | null) => {
    try {
      await post({ action: 'setModel', smallFastModel: model });
      pushToast(model ? `Fast model set to ${model}` : 'Fast model follows the main model');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  // Live probe through the pool: same path Claude Code uses, executed
  // server-side by /api/test (the browser cannot set the claude-cli
  // User-Agent that agentrouter's client filter requires).
  const testPool = async () => {
    if (!config?.selectedModel || testing) return;
    setTesting(true);
    try {
      const res = await fetch('/api/test', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        pushToast(`Test failed: ${data?.error ?? 'HTTP ' + res.status}`, 'error');
      } else if (data?.ok) {
        const secs = ((data.latencyMs as number) / 1000).toFixed(1);
        pushToast(
          `HTTP ${data.status} · ${data.model} · ${secs}s${data.text ? ' · ' + String(data.text).slice(0, 40) : ''}`,
        );
      } else {
        pushToast(
          `Test failed: HTTP ${data?.status ?? '?'}${data?.error ? ' · ' + data.error : ''}`,
          'error',
        );
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  // Close model dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
      if (fastModelDropdownRef.current && !fastModelDropdownRef.current.contains(e.target as Node)) {
        setFastModelDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectGroup = async (groupId: string) => {
    try {
      await post({ action: 'setActiveGroup', activeGroupId: groupId });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const resetGroupRateLimit = async (groupId: string) => {
    try {
      await post({ action: 'resetGroupRateLimit', groupId });
      pushToast('Rate limit reset for group');
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
      model: newGroupModel.trim() || undefined,
      keys: [],
    };
    try {
      await saveGroups([...config.groups, group], config.activeGroupId || group.id);
      setNewGroupName('');
      setNewGroupUrl('');
      setNewGroupModel('');
      setShowNewGroup(false);
      pushToast(`Group "${group.name}" created`);
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

  const modelDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateGroupModel = (groupId: string, model: string) => {
    if (!config) return;
    const groups = config.groups.map((g) => (g.id === groupId ? { ...g, model: model || undefined } : g));
    setConfig({ ...config, groups });
    if (modelDebounce.current) clearTimeout(modelDebounce.current);
    modelDebounce.current = setTimeout(() => {
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

  const toggleGroupDisabled = async (groupId: string) => {
    if (!config) return;
    const groups = config.groups.map((g) =>
      g.id === groupId ? { ...g, disabled: !g.disabled } : g,
    );
    try {
      await saveGroups(groups);
      const group = config.groups.find((g) => g.id === groupId);
      pushToast(
        group?.disabled
          ? `Group "${group.name}" enabled`
          : `Group "${group?.name}" disabled`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const toggleKeyDisabled = async (keyId: string) => {
    if (!config || !activeGroup) return;
    const groups = config.groups.map((g) =>
      g.id === activeGroup.id
        ? {
            ...g,
            keys: g.keys.map((k) =>
              k.id === keyId ? { ...k, disabled: !k.disabled } : k,
            ),
          }
        : g,
    );
    try {
      await saveGroups(groups);
      const key = activeGroup.keys.find((k) => k.id === keyId);
      pushToast(
        key?.disabled
          ? `Key "${key.email}" enabled`
          : `Key "${key?.email}" disabled`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Error', 'error');
    }
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

  const toggleKiloConnection = async () => {
    if (!config) return;
    const action = config.kiloConnected ? 'kiloDisconnect' : 'kiloConnect';
    try {
      await post({ action });
      pushToast(
        action === 'kiloConnect'
          ? 'Connected to Kilo Code (provider "claude-key-pool" added to kilo.jsonc)'
          : 'Disconnected from Kilo Code (provider removed)',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Kilo connection failed', 'error');
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
  const kiloConnected = !!config?.kiloConnected;
  const poolStats: PoolStats = config?.poolStats ?? {
    totalKeys: 0,
    activeKeys: 0,
    rateLimitedKeys: 0,
    invalidKeys: 0,
    disabledKeys: 0,
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
            <div className="flex items-center gap-2" title="Kilo Code profile (kilo.jsonc) — independent of the Claude CLI connection">
              <Circle
                className={`w-2.5 h-2.5 ${
                  kiloConnected
                    ? 'fill-[color:var(--color-status-ready)] text-[color:var(--color-status-ready)]'
                    : 'fill-border-strong text-border-strong'
                }`}
              />
              <span className="text-[14px] text-muted">Kilo</span>
            </div>
            {/* Model selector */}
            <div ref={modelDropdownRef} className="relative">
              <button
                onClick={() => setModelDropdownOpen((v) => !v)}
                className={`inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border text-[13px] font-medium transition-colors cursor-pointer ${
                  config?.selectedModel
                    ? 'border-hairline bg-surface-soft text-ink hover:border-border-strong'
                    : 'border-[color:var(--color-status-limited)] bg-[color:var(--color-status-limited-bg)] text-[color:var(--color-status-limited)]'
                }`}
              >
                <span className="truncate max-w-[180px]">
                  {config?.selectedModel || 'Select model'}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {modelDropdownOpen && (
                <div className="absolute top-full right-0 mt-1.5 min-w-[220px] bg-canvas border border-hairline rounded-[10px] shadow-lg py-1.5 z-50">
                  {availableModels.length === 0 ? (
                    <div className="px-4 py-3 text-[13px] text-muted">
                      No models configured. Add a model to a group first.
                    </div>
                  ) : (
                    availableModels.map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setSelectedModel(m);
                          setModelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2 text-[13px] transition-colors cursor-pointer ${
                          config?.selectedModel === m
                            ? 'bg-surface-soft text-ink font-medium'
                            : 'text-body hover:bg-surface-soft'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{m}</span>
                          {config?.selectedModel === m && (
                            <Check className="w-3.5 h-3.5 text-[color:var(--color-status-ready)] shrink-0" />
                          )}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            {/* Fast (small/background) model selector */}
            <div ref={fastModelDropdownRef} className="relative">
              <button
                onClick={() => setFastModelDropdownOpen((v) => !v)}
                title="Small/fast model for background and auto-mode requests (ANTHROPIC_SMALL_FAST_MODEL)"
                className={`inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border text-[13px] font-medium transition-colors cursor-pointer ${
                  config?.smallFastModel
                    ? 'border-hairline bg-surface-soft text-ink hover:border-border-strong'
                    : 'border-hairline bg-transparent text-muted hover:border-border-strong'
                }`}
              >
                <Zap className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate max-w-[140px]">
                  {config?.smallFastModel || 'Fast: same as main'}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${fastModelDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {fastModelDropdownOpen && (
                <div className="absolute top-full right-0 mt-1.5 min-w-[220px] bg-canvas border border-hairline rounded-[10px] shadow-lg py-1.5 z-50">
                  <button
                    onClick={() => {
                      setFastModel(null);
                      setFastModelDropdownOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2 text-[13px] transition-colors cursor-pointer ${
                      !config?.smallFastModel
                        ? 'bg-surface-soft text-ink font-medium'
                        : 'text-body hover:bg-surface-soft'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>Same as main model</span>
                      {!config?.smallFastModel && (
                        <Check className="w-3.5 h-3.5 text-[color:var(--color-status-ready)] shrink-0" />
                      )}
                    </div>
                  </button>
                  {availableModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setFastModel(m);
                        setFastModelDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2 text-[13px] transition-colors cursor-pointer ${
                        config?.smallFastModel === m
                          ? 'bg-surface-soft text-ink font-medium'
                          : 'text-body hover:bg-surface-soft'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{m}</span>
                        {config?.smallFastModel === m && (
                          <Check className="w-3.5 h-3.5 text-[color:var(--color-status-ready)] shrink-0" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              className="h-10 px-3.5"
              onClick={testPool}
              disabled={!config?.selectedModel || testing}
              title="Send a live probe request through the pool"
            >
              <Activity className="w-4 h-4" />
              {testing ? 'Testing…' : 'Test'}
            </Button>
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
            <Button
              variant={kiloConnected ? 'secondary' : 'secondary'}
              onClick={toggleKiloConnection}
              title="Connect Kilo Code to the same pool (adds the 'claude-key-pool' provider to ~/.config/kilo/kilo.jsonc)"
            >
              {kiloConnected ? (
                <>
                  <Link2Off className="w-4 h-4" /> Kilo: off
                </>
              ) : (
                <>
                  <Link2 className="w-4 h-4" /> Kilo: on
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
                <TextInput
                  placeholder="Model (e.g. claude-opus-4-8)"
                  value={newGroupModel}
                  onChange={(e) => setNewGroupModel(e.target.value)}
                  mono
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
              Only groups matching the selected model are pooled for routing.
            </div>

            {config && config.groups.length === 0 ? (
              <div className="text-[14px] text-muted py-8 text-center border border-dashed border-hairline rounded-[10px]">
                No groups yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {config?.groups.map((group) => {
                  const isActive = config.activeGroupId === group.id;
                  const isGroupDisabled = !!group.disabled;
                  const inPool = !isGroupDisabled && !!group.model && group.model === config.selectedModel;
                  const groupActiveKeys = group.keys.filter(k => !k.disabled && k.status === 'active').length;
                  const groupLimitedKeys = group.keys.filter(k => !k.disabled && k.status === 'rate-limited').length;
                  const groupInvalidKeys = group.keys.filter(k => !k.disabled && k.status === 'invalid').length;
                  const groupDisabledKeys = group.keys.filter(k => k.disabled).length;
                  return (
                    <div
                      key={group.id}
                      onClick={() => selectGroup(group.id)}
                      className={`group/card px-4 py-3 rounded-[10px] border cursor-pointer transition-all duration-200 ${
                        isActive
                          ? 'border-ink bg-surface-soft'
                          : 'border-hairline hover:border-border-strong'
                      } ${isGroupDisabled ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <Circle
                            className={`w-2 h-2 shrink-0 ${
                              isGroupDisabled
                                ? 'fill-border-strong text-border-strong'
                                : isActive
                                  ? 'fill-ink text-ink'
                                  : 'fill-transparent text-border-strong'
                            }`}
                          />
                          <span className={`text-[14px] font-medium truncate ${
                            isGroupDisabled ? 'text-muted line-through' : 'text-ink'
                          }`}>
                            {group.name}
                          </span>
                          {inPool && (
                            <span
                              title="This group matches the selected model and participates in routing"
                              className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-[4px] bg-[color:var(--color-status-ready-bg)] text-[color:var(--color-status-ready)]"
                            >
                              pool
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <ToggleSwitch
                            enabled={!isGroupDisabled}
                            onChange={() => toggleGroupDisabled(group.id)}
                            size="sm"
                            title={isGroupDisabled ? 'Enable group' : 'Disable group'}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteGroup(group);
                            }}
                            className="opacity-0 group-hover/card:opacity-100 text-muted hover:text-[color:var(--color-status-invalid)] transition cursor-pointer"
                            aria-label="Delete group"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-4 mt-0.5">
                        {isGroupDisabled ? (
                          <span className="text-[12px] text-muted flex items-center gap-1">
                            <Ban className="w-3 h-3" />
                            Disabled
                          </span>
                        ) : (
                          <>
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
                            {groupDisabledKeys > 0 && (
                              <span className="text-[11px] text-muted">
                                {groupDisabledKeys} off
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      {group.model && (
                        <div className="ml-4 mt-0.5">
                          <span className="text-[11px] font-mono text-muted/70 truncate block max-w-[200px]">{group.model}</span>
                        </div>
                      )}
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
                    <div className="flex items-center gap-4">
                      <h1 className="text-[32px] leading-tight font-normal text-ink tracking-tight">
                        {activeGroup.name}
                      </h1>
                      <Button variant="secondary" className="h-8 px-3 text-[12px]" onClick={() => resetGroupRateLimit(activeGroup.id)}>
                        Reset Rate Limit
                      </Button>
                    </div>
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

                  <label className="text-[13px] font-medium text-muted mt-2">Model</label>
                  <TextInput
                    value={activeGroup.model ?? ''}
                    onChange={(e) => updateGroupModel(activeGroup.id, e.target.value)}
                    placeholder="e.g. claude-opus-4-8"
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
                      {activeGroup.keys.map((key, i) => {
                        const isKeyDisabled = !!key.disabled || !!activeGroup.disabled;
                        const isKeyOwnDisabled = !!key.disabled;
                        return (
                          <div
                            key={key.id}
                            className={`group/row flex items-center gap-4 px-4 py-3.5 transition-opacity duration-200 ${
                              i > 0 ? 'border-t border-hairline' : ''
                            } ${isKeyDisabled ? 'opacity-50' : ''}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className={`text-[14px] truncate ${
                                isKeyDisabled ? 'text-muted line-through' : 'text-ink'
                              }`}>{key.email}</div>
                              <div className="text-[13px] font-mono text-muted truncate">
                                {maskKey(key.key)}
                              </div>
                            </div>
                            <StatusChip
                              status={key.status}
                              cooldownUntil={key.cooldownUntil}
                              inFlight={key.inFlight}
                              disabled={isKeyDisabled}
                            />
                            <ToggleSwitch
                              enabled={!isKeyOwnDisabled}
                              onChange={() => toggleKeyDisabled(key.id)}
                              size="sm"
                              title={isKeyOwnDisabled ? 'Enable key' : 'Disable key'}
                            />
                            <button
                              onClick={() => deleteKey(key)}
                              className="opacity-0 group-hover/row:opacity-100 text-muted hover:text-[color:var(--color-status-invalid)] transition cursor-pointer"
                              aria-label="Delete key"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
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
              <h3 className="text-[16px] font-medium text-ink">Connecting Claude Code &amp; Kilo Code</h3>
              <p className="text-[14px] text-body">
                <span className="text-ink font-medium">Select a model</span> from the header dropdown, then click{' '}
                <span className="text-ink font-medium">Connect</span> to sync your Claude CLI
                settings.json automatically. Click{' '}
                <span className="text-ink font-medium">Disconnect</span> to restore it.
              </p>
              <p className="text-[14px] text-body">
                <span className="text-ink font-medium">Kilo: on</span> adds the provider{' '}
                <span className="font-mono text-[13px]">claude-key-pool</span> (Anthropic format,
                baseURL <span className="font-mono text-[13px]">http://127.0.0.1:9999/v1</span>) to{' '}
                <span className="font-mono text-[13px]">~/.config/kilo/kilo.jsonc</span> — pick it in
                Kilo&apos;s model selector. The two connections are independent: either, both, or
                neither. <span className="text-ink font-medium">Kilo: off</span> removes the provider
                and restores the rest of your Kilo config untouched.
              </p>
              <p className="text-[14px] text-body">
                The <Zap className="w-3.5 h-3.5 inline-block -mt-0.5" /> dropdown picks the{' '}
                <span className="text-ink font-medium">small/fast model</span> used for background and
                auto-mode requests — leave it on &quot;same as main&quot; to route everything through one model.
                The <span className="text-ink font-medium">Test</span> button sends a live probe
                request through the pool to verify routing end-to-end.
              </p>
              <p className="text-[14px] text-body">
                To point tools manually, set{' '}
                <code className="font-mono text-[13px] bg-canvas border border-hairline rounded-[6px] px-1.5 py-0.5">
                  ANTHROPIC_BASE_URL=http://localhost:9999
                </code>
                .
              </p>
              <p className="text-[14px] text-body mt-1">
                <span className="text-ink font-medium">Routing:</span> Only groups matching the selected model are used.
                Keys from matching groups are pooled and load-balanced via true round-robin.
              </p>
            </div>
          </section>
        </div>

        {/* Activity: request log + per-key statistics */}
        <ActivityPanel />
      </main>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
