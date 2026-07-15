<div align="center">

<img src="public/logo.svg" width="76" height="76" alt="Claude Key Pool logo" />

# Claude Key Pool

**A fast, local proxy that pools your Anthropic-compatible API keys and rotates to the next one the moment a key hits a rate or usage limit — including mid-stream.**

[![License: MIT](https://img.shields.io/badge/License-MIT-181d26?style=flat-square)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-181d26?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-181d26?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-181d26?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Platform](https://img.shields.io/badge/Windows-ready-aa2d00?style=flat-square&logo=windows&logoColor=white)](#-install-on-windows-one-command)
[![Port](https://img.shields.io/badge/port-9999-fcab79?style=flat-square&labelColor=181d26)](http://localhost:9999)

</div>

---

## What it does

Claude Key Pool sits between the Claude Code CLI (or any Anthropic-compatible SDK) and an upstream endpoint. You give it a **group** of API keys; it forwards each request through one of them and **automatically rotates to the next available key** whenever the current key is rate-limited, out of quota, or invalid — so a single exhausted key never interrupts your session.

- **Automatic rotation** — 429s, `rate_limit_error` / `overloaded_error`, quota/credit/usage-limit messages all trigger a transparent switch to the next key.
- **Mid-stream aware** — detects error events emitted *inside* a streaming (SSE) response before any content reaches you, and silently retries on a working key. You see one clean stream.
- **Honors `retry-after`** — cooldowns respect the upstream's `retry-after` and `anthropic-ratelimit-*-reset` headers; a limited key auto-recovers when its cooldown ends.
- **Robust & fast** — reads config from an in-memory cache on the hot path, never writes to disk per request, and forwards request bodies without needless re-serialization.
- **Groups** — organize keys by upstream endpoint and switch the active pool with one click.
- **Minimal dashboard** — a calm, editorial UI at `http://localhost:9999`. No token counters, no noise — just your groups, keys, and each key's live status (Ready / Rate-limited + countdown / Invalid).

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

---

## Using the dashboard

1. **Create a group** — click `+`, give it a name and the upstream URL (e.g. `https://api.anthropic.com`).
2. **Add keys** — one at a time, with an optional email/label. Keys are stored locally in `config.json` (which is git-ignored and never leaves your machine).
3. **Connect Claude Code** — click **Connect** in the top bar. It rewrites your Claude CLI `settings.json` to route through the proxy (and backs up the original, restored on **Disconnect**).

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
| `429 Too Many Requests` | Mark key rate-limited, honor `retry-after`, rotate |
| `401` / `403` | Mark key **invalid** (won't auto-recover — fix the key), rotate |
| Error body: `rate_limit_error`, `overloaded_error`, quota/credit/usage/token limit | Mark limited, rotate |
| SSE error event **before** any content | Silently retry next key — client sees one clean stream |
| SSE error event **after** content started | Forward as-is (can't swap mid-answer), but mark limited so the *next* request rotates |
| `5xx` / network / timeout | Transient — try next key; `502` only if all keys fail transiently |
| All keys exhausted | Clean `429` to the client |

Keys are selected round-robin across the currently-active keys, so load spreads evenly.

---

## Where your keys live

Your keys are stored **only** in a local `config.json` at the project root. This file is **git-ignored** — it is never committed or pushed. A safe template lives in [`config.example.json`](config.example.json). Runtime status (rate-limited / cooldown) is kept in memory and never written to disk.

---

## Tech

Next.js 16 (App Router) · React 19 · Tailwind CSS v4 · TypeScript · lucide-react. Runs on port **9999**.

## License

[MIT](LICENSE) © 2026 Ns81000
