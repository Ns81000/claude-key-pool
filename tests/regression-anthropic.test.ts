import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Regression: a config WITHOUT `protocol` must behave exactly as before —
// /v1/messages forwards the Anthropic body byte-for-byte to
// {targetUrl}/v1/messages with x-api-key auth, and /api/models lists group
// models unchanged.

let tmpDir: string;
let anthropicUpstream: http.Server;
const anthropicCalls: Array<{ url: string; apiKey: string | undefined; body: string }> = [];

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ckp-anthro-'));

  anthropicUpstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      anthropicCalls.push({ url: req.url ?? '', apiKey: Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'], body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => anthropicUpstream.listen(0, '127.0.0.1', () => r()));

  const prevCwd = process.cwd();
  process.chdir(tmpDir);
  (globalThis as Record<string, unknown>).__prevCwd2 = prevCwd;

  writeConfig([
    {
      id: 'g1',
      name: 'Anthropic relay',
      targetUrl: `http://127.0.0.1:${(anthropicUpstream.address() as AddressInfo).port}`,
      model: 'glm-5.3',
      keys: [{ id: 'k1', email: 'relay-1', key: 'sk-relay-1' }],
    },
  ]);
});

afterAll(async () => {
  await new Promise<void>((r) => anthropicUpstream.close(() => r()));
  process.chdir((globalThis as Record<string, unknown>).__prevCwd2 as string);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(groups: unknown[]): void {
  writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      activeGroupId: 'g1',
      selectedModel: 'glm-5.3',
      groups,
      isConnected: false,
      backupSettings: null,
      kiloConnected: false,
      kiloBackupSettings: null,
      kiloDisabledBackup: null,
    }),
  );
  const g = globalThis as unknown as { proxyState?: { configCache: unknown; configMtimeMs: number; lastStatAt: number; roundRobinIndex: number; keys: Record<string, unknown> } };
  if (g.proxyState) {
    g.proxyState.configCache = null;
    g.proxyState.configMtimeMs = 0;
    g.proxyState.lastStatAt = 0;
    g.proxyState.roundRobinIndex = -1;
    g.proxyState.keys = {};
  }
}

describe('regression: anthropic-protocol config unchanged', () => {
  it('forwards the body byte-for-byte to {targetUrl}/v1/messages with x-api-key', async () => {
    const { POST } = await import('@/app/v1/messages/route');
    const body = JSON.stringify({
      model: 'glm-5.3',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const req = new Request('http://127.0.0.1:9999/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-dummy-rotated-by-key-pool-proxy-9999',
        host: '127.0.0.1:9999',
      },
      body,
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(anthropicCalls).toHaveLength(1);
    expect(anthropicCalls[0].url).toBe('/v1/messages');
    expect(anthropicCalls[0].apiKey).toBe('sk-relay-1');
    // Byte-for-byte: the forwarded body equals what the client sent.
    expect(anthropicCalls[0].body).toBe(body);
    const payload = JSON.parse(await res.text()) as { type: string; content: Array<{ text: string }> };
    expect(payload.type).toBe('message');
    expect(payload.content[0].text).toBe('ok');
  });

  it('/api/models lists group models unchanged (no protocol field)', async () => {
    const { GET } = await import('@/app/api/models/route');
    const req = new Request('http://127.0.0.1:9999/api/models', {
      headers: { host: '127.0.0.1:9999' },
    }) as unknown as Parameters<typeof GET>[0];
    const res = await GET(req);
    const payload = (await res.json()) as { models: Array<{ model: string; name: string }> };
    expect(res.status).toBe(200);
    expect(payload.models).toEqual([{ model: 'glm-5.3', name: 'Anthropic relay' }]);
  });
});

// /api/models for an openai group: mapping keys are exposed as models.
describe('/api/models with an openai-protocol group', () => {
  it('exposes modelMapping keys as selectable models', async () => {
    writeConfig([
      {
        id: 'g1',
        name: 'Anthropic relay',
        targetUrl: 'http://127.0.0.1:1',
        model: 'glm-5.3',
        keys: [{ id: 'k1', email: 'relay-1', key: 'sk-relay-1' }],
      },
      {
        id: 'g2',
        name: 'OpenRouter',
        targetUrl: 'http://127.0.0.1:1',
        protocol: 'openai',
        model: 'claude-sonnet-4-5',
        modelMapping: { 'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5' },
        keys: [{ id: 'k2', email: 'or-1', key: 'sk-or-1' }],
      },
    ]);
    const { GET } = await import('@/app/api/models/route');
    const req = new Request('http://127.0.0.1:9999/api/models', {
      headers: { host: '127.0.0.1:9999' },
    }) as unknown as Parameters<typeof GET>[0];
    const res = await GET(req);
    const payload = (await res.json()) as { models: Array<{ model: string }> };
    expect(res.status).toBe(200);
    const names = payload.models.map((m) => m.model);
    expect(names).toContain('glm-5.3');
    expect(names).toContain('claude-sonnet-4-5');
    // The dedup: group.model and its mapping key are the same name here —
    // exactly one entry.
    expect(names.filter((n) => n === 'claude-sonnet-4-5')).toHaveLength(1);
  });
});
