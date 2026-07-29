<div align="center">

<img src="public/logo.svg" width="76" height="76" alt="Claude Key Pool logo" />

# Claude Key Pool

**A fast, local proxy that pools your Anthropic-compatible API keys and load-balances every request across the entire pool via true round-robin — rotating instantly when any key hits a rate or usage limit, including mid-stream. Select your model once in the dashboard, and only matching groups participate in routing.**

[![License: MIT](https://img.shields.io/badge/License-MIT-181d26?style=flat-square)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-181d26?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-181d26?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-181d26?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Platform](https://img.shields.io/badge/Windows-ready-aa2d00?style=flat-square&logo=windows&logoColor=white)](#-install-on-windows-one-command)
[![Port](https://img.shields.io/badge/port-9999-fcab79?style=flat-square&labelColor=181d26)](http://localhost:9999)

</div>

---

## What it does

Claude Key Pool sits between the Claude Code CLI (or any Anthropic-compatible SDK) and one or more upstream endpoints. You give it **groups** of API keys — each group with its own upstream URL and cooldown settings — and the proxy **flattens every key into a single global pool**, distributing requests evenly via true round-robin. When a key is rate-limited, out of quota, or invalid, the proxy **automatically rotates to the next available key** so a single exhausted key never interrupts your session.

### Key features

- **True round-robin** — every request gets a different key. No more burning through one key before touching the next.
- **Flat global pool** — all keys from all groups participate equally. Each key still routes through its own group's upstream URL and respects its group's cooldown settings.
- **Disable without deleting** — temporarily disable individual keys or entire groups from the dashboard. Disabled items are skipped during routing and stay off until you re-enable them.
- **Concurrency-aware** — tracks in-flight requests per key and prefers idle keys, preventing multiple simultaneous requests from piling onto the same key.
- **Mid-stream aware** — detects error events emitted *inside* a streaming (SSE) response before any content reaches you, and silently retries on a working key. You see one clean stream.
- **Stall protection** — if an upstream stops sending data mid-stream, the proxy aborts after 120 seconds instead of hanging forever.
- **Honors `retry-after`** — cooldowns respect the upstream's `retry-after` and `anthropic-ratelimit-*-reset` headers; a limited key auto-recovers when its cooldown ends.
- **Slow-key deprioritization** — keys that recently timed out are ranked last, not skipped, so they get a second chance without dragging down the pool.
- **Robust & fast** — reads config from an in-memory cache on the hot path (no filesystem stat per request), never writes to disk per request, and forwards request bodies without needless re-serialization.
- **Groups** — organize keys by upstream endpoint. Each group has its own target URL and optional custom cooldown duration.
- **Per-group model** — assign a model name to each group (e.g. `claude-opus-4-8`). Select the active model from the dashboard header; only groups matching that model are used for routing.
- **Live terminal logs** — color-coded, real-time request lifecycle logging with request IDs, key selection, rotation reasons, timing, and pool status summaries.
- **Minimal dashboard** — a calm, editorial UI at `http://localhost:9999` with a global pool stats banner showing total/active/rate-limited/invalid/disabled/in-flight counts per key.

---

## 🚀 Install on Windows (one command)

**Prerequisites** — if you don't already have them, run these first in PowerShell (or install manually):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

> pnpm is enabled automatically by the installer via `corepack` (bundled with Node). No separate install needed.

**Then run the one-command installer.** Open a **new** PowerShell window and paste:

```powershell
irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex
```

This clones the repo to `%USERPROFILE%\claude-key-pool`, installs dependencies, builds the app, and creates a **"Claude Key Pool" shortcut on your Desktop** (with the app logo). It then launches the dashboard in your browser.

**From then on, just double-click the desktop shortcut** — it starts the server and opens the UI automatically. That's it.

### Updating

To upgrade to the latest version at any time, open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/update.ps1 | iex
```

This stops any running server, pulls the latest code, reinstalls dependencies, rebuilds, and relaunches. Your saved keys in `config.json` are never touched.

---

## Using the dashboard

1. **Create a group** — click `+`, give it a name, the upstream URL (e.g. `https://api.anthropic.com`), and a model name (e.g. `claude-opus-4-8`). Optionally set a custom rate-limit cooldown duration (in hours).
2. **Add keys** — one at a time, with an optional email/label. Keys are stored locally in `config.json` (which is git-ignored and never leaves your machine).
3. **Select a model** — use the model dropdown in the header bar to choose which model to route through. Only groups with a matching model field are used.
4. **Disable/enable** — use the toggle switch next to any group or key to temporarily disable it without deleting. Disabled items are skipped during routing and shown dimmed in the UI. Re-enable any time with one click.
5. **Connect Claude Code** — click **Connect** in the top bar. It rewrites your Claude CLI `settings.json` to route through the proxy using the selected model (and backs up the original, restored on **Disconnect** — or automatically when you **Stop the server** from the dashboard).

The **pool stats banner** at the top shows the real-time health of your entire key pool: total keys, active, rate-limited, invalid, disabled, and in-flight requests.

Only groups whose model matches the selected model participate in routing. Groups are an organizational tool — they let you set different upstream URLs, cooldown settings, and model names per provider.

Prefer manual setup? Point any Anthropic SDK at the proxy:

```bat
set ANTHROPIC_BASE_URL=http://localhost:9999
```

---

## Manual / cross-platform setup

Any OS with Node 20+ and pnpm:

```bash
git clone https://github.com/Ns81000/claude-key-pool.git
cd claude-key-pool
pnpm install
pnpm build
pnpm start        # serves on http://localhost:9999
```

For development with hot reload: `pnpm dev`.

---

## How rotation works

| Condition | Action |
|---|---|
| `429 Too Many Requests` (key-level) | Mark key rate-limited, honor `retry-after`, rotate |
| `429 Too Many Requests` (IP-level) | Rotate to next key **without** cooling down the current one |
| `401 Unauthorized` | Mark key **invalid** (auto-recovers after 1 hour), rotate |
| `403 Forbidden` | Transient provider error (5-min cooldown), rotate |
| `400 invalid_request_error` | Client error (e.g. bad model name) — returned cleanly to client, keys NOT killed |
| Error body: `rate_limit_error`, `overloaded_error`, quota/credit/usage/token limit | Mark limited, rotate |
| SSE error event **before** any content | Silently retry next key — client sees one clean stream |
| SSE error event **after** content started | Forward as-is (can't swap mid-answer), but mark limited so the *next* request rotates |
| `5xx` / network / timeout | Transient — try next key (marked slow to deprioritize); `502` only if all keys fail transiently |
| Upstream stalls (no data for 120s) | Abort the connection and error to the client |
| All keys exhausted | Clean `429` to the client |

### Selection priority

The round-robin selects keys in this priority order:

1. **Idle, non-slow** — active key with zero in-flight requests and no recent timeouts (best)
2. **Busy, non-slow** — active key with the fewest in-flight requests
3. **Slow** — active key that recently timed out (last resort, still used if nothing else is available)

---

## Terminal logs

The terminal window shows color-coded, real-time logs for every request:

```
──────────────────────────────────────────────────────────────────────────
  →  16:42:03  #1 POST /v1/messages [stream]
  ℹ  16:42:03  #1 Model: claude-sonnet-4-20250514
  ℹ  16:42:03 [user@example.com] #1 Selected from group "Production" (0 in-flight)
  ✔  16:42:05 [user@example.com] #1 Completed in 1.8s
  ✔  16:42:05 [user@example.com] #1 Streaming response to client...
  ℹ  16:42:12 [user@example.com] #1 Stream completed
──────────────────────────────────────────────────────────────────────────
  →  16:42:15  #2 POST /v1/messages [stream]
  ℹ  16:42:15 [other@example.com] #2 Selected from group "Backup" (0 in-flight)
  ⚠  16:42:16 [other@example.com] #2 Rotating → 429 → rate limited (key cooled down)
  ℹ  16:42:16 [user@example.com] #2 Selected from group "Production" (0 in-flight)
  ✔  16:42:18 [user@example.com] #2 Completed in 2.9s
```

Each log line shows: level icon, timestamp, key label, request ID, and a human-readable message.

---

## Where your keys live

Your keys are stored **only** in a local `config.json` at the project root. This file is **git-ignored** — it is never committed or pushed. A safe template lives in [`config.example.json`](config.example.json). Runtime status (rate-limited / cooldown / in-flight) is kept in memory and never written to disk.

---

## Architecture

```
┌─────────────────┐      ┌──────────────────────────────┐      ┌────────────────────┐
│  Claude CLI /    │      │  Next.js App (port 9999)     │      │  Upstream API      │
│  Any SDK Client  │─────▶│                              │─────▶│  (per-group URL)   │
│                  │      │  Flat Pool Round-Robin Engine │      │                    │
│                  │      │  ┌────────────────────────┐  │      └────────────────────┘
│                  │      │  │ Group A keys ──┐       │  │
│                  │      │  │ Group B keys ──┼─ Pool │  │
│                  │      │  │ Group C keys ──┘       │  │
│                  │◀─────│  └────────────────────────┘  │
└─────────────────┘      └──────────────────────────────┘
                                    │
                             ┌──────┴──────┐
                             │ config.json  │ (keys on disk)
                             │ proxyState   │ (runtime in memory)
                             └─────────────┘
```

---

## Tech

Next.js 16 (App Router) · React 19 · Tailwind CSS v4 · TypeScript · lucide-react. Runs on port **9999**.

## License

[MIT](LICENSE) © 2026 Ns81000
