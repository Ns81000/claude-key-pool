import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

// Integration: OpenAI-protocol mock aggregator (node:http) behind the pool's
// /v1/messages POST handler. The route handler is invoked directly (same
// function the Next server calls) with a Request built exactly like the one
// a raw Anthropic client (claude.exe) sends — so the full cycle runs:
// Anthropic request → translation → upstream HTTP → OpenAI SSE → translated
// Anthropic SSE → client response stream.
//
// Rotation is exercised too: the first key gets a 429, the second serves.

const UPSTREAM_KEY_1 = 'sk-openai-key-1';
const UPSTREAM_KEY_2 = 'sk-openai-key-2';

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

let upstreamCalls: UpstreamCall[] = [];
// Per-test upstream behavior: which key gets 429 first, what stream to serve.
let behavior: { failFirstKeyWith?: { status: number; body: unknown; headers?: Record<string, string> } } = {};

function startMockAggregator(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      upstreamCalls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers['authorization'],
        body,
      });

      const auth = req.headers['authorization'] ?? '';
      if (behavior.failFirstKeyWith && auth === `Bearer ${UPSTREAM_KEY_1}`) {
        const { status, body: errBody, headers } = behavior.failFirstKeyWith;
        res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
        res.end(JSON.stringify(errBody));
        return;
      }

      if (req.url === '/v1/chat/completions') {
        const isStream = body?.stream === true;
        res.writeHead(200, { 'content-type': isStream ? 'text/event-stream' : 'application/json' });
        if (isStream) {
          const events: string[] = [
            'data: {"id":"cc1","model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
            'data: {"id":"cc1","model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":null}]}',
            'data: {"id":"cc1","model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            'data: {"id":"cc1","model":"anthropic/claude-sonnet-4.5","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
            'data: [DONE]',
            '',
          ];
          const stream = Readable.from(events.map((e) => e + '\n\n'));
          stream.pipe(res);
        } else {
          res.end(
            JSON.stringify({
              id: 'chatcmpl-1',
              model: 'anthropic/claude-sonnet-4.5',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'Hello!',
                    tool_calls: [
                      { id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3 },
            }),
          );
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', code: 404 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ReadableStream from string (for the Response body we build).
function jsonStream(obj: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

// The config module reads config.json from process.cwd() and caches it on
// globalThis — point it at a fixture and reset the cache per test.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpDir: string;
let mockServer: http.Server;
let upstreamUrl: string;

async function callMessagesRoute(anthropicBody: unknown, stream: boolean): Promise<Response> {
  const { POST } = await import('@/app/v1/messages/route');
  const req = new Request('http://127.0.0.1:9999/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-dummy-rotated-by-key-pool-proxy-9999',
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/2.0.0',
      host: '127.0.0.1:9999',
    },
    body: JSON.stringify(anthropicBody),
    signal: new AbortController().signal,
  }) as unknown as Parameters<typeof POST>[0];
  void stream;
  return POST(req);
}

async function readBody(res: Response): Promise<string> {
  const text = await res.text();
  return text;
}

function writeConfig(groups: unknown[]): void {
  writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      activeGroupId: 'group_openrouter',
      selectedModel: 'claude-sonnet-4-5',
      groups,
      isConnected: false,
      backupSettings: null,
      kiloConnected: false,
      kiloBackupSettings: null,
      kiloDisabledBackup: null,
    }),
  );
  // Reset the module-level cache so loadConfig re-reads the fixture.
  const g = globalThis as unknown as { proxyState?: { configCache: unknown; configMtimeMs: number; lastStatAt: number } };
  if (g.proxyState) {
    g.proxyState.configCache = null;
    g.proxyState.configMtimeMs = 0;
    g.proxyState.lastStatAt = 0;
  }
}

const openRouterGroup = () => ({
  id: 'group_openrouter',
  name: 'OpenRouter',
  targetUrl: upstreamUrl,
  protocol: 'openai',
  model: 'claude-sonnet-4-5',
  modelMapping: { 'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5' },
  keys: [
    { id: 'k1', email: 'or-key-1', key: UPSTREAM_KEY_1 },
    { id: 'k2', email: 'or-key-2', key: UPSTREAM_KEY_2 },
  ],
});

const anthropicClientRequest = (stream: boolean) => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 512,
  stream,
  system: 'You are helpful.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ],
  messages: [
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_01', name: 'get_weather', input: { city: 'Paris' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_01', content: 'Sunny, 21C' }] },
  ],
});

// Parse an Anthropic SSE body into typed events.
function parseAnthropicEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const evMatch = block.match(/^event:\s*(.+)$/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (!evMatch || !dataMatch) continue;
    events.push({ event: evMatch[1].trim(), data: JSON.parse(dataMatch[1]) });
  }
  return events;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ckp-int-'));
  const prevCwd = process.cwd();
  process.chdir(tmpDir);
  mockServer = await startMockAggregator();
  upstreamUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
  (globalThis as Record<string, unknown>).__prevCwd = prevCwd;
});

afterAll(async () => {
  await new Promise<void>((r) => mockServer.close(() => r()));
  const prevCwd = (globalThis as Record<string, unknown>).__prevCwd as string;
  process.chdir(prevCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  upstreamCalls = [];
  behavior = {};
  // Reset runtime key state between tests: a previous test's 429 mark would
  // take a key out of rotation and change which key serves the next test.
  const g = globalThis as unknown as { proxyState?: { roundRobinIndex: number; keys: Record<string, unknown> } };
  if (g.proxyState) {
    g.proxyState.roundRobinIndex = -1; // next pick = flat-pool index 0 (k1)
    g.proxyState.keys = {};
  }
});

describe('integration: /v1/messages → openai-protocol group', () => {
  it('full streaming cycle with tools: translated request upstream, Anthropic SSE to client', async () => {
    writeConfig([openRouterGroup()]);
    const res = await callMessagesRoute(anthropicClientRequest(true), true);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Upstream got the translated OpenAI request.
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0];
    expect(call.url).toBe('/v1/chat/completions');
    // Round-robin starts at whichever key — what matters is that ONE of the
    // pool keys was substituted (not the client's dummy).
    expect([`Bearer ${UPSTREAM_KEY_1}`, `Bearer ${UPSTREAM_KEY_2}`]).toContain(call.authorization);
    const body = call.body as Record<string, unknown>;
    expect(body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(512);
    // messages: system, user, assistant+tool_calls, tool
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Weather in Paris?' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_01', content: 'Sunny, 21C' });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);

    // Client got valid Anthropic SSE.
    const text = await readBody(res);
    const events = parseAnthropicEvents(text);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('message_start');
    expect(types[types.length - 2]).toBe('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');
    const toolStart = events.find((e) => (e.data as { content_block?: { type?: string } }).content_block?.type === 'tool_use');
    expect(toolStart).toBeDefined();
    const delta = events.find((e) => e.event === 'message_delta')!.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('tool_use');
    const finalUsage = (events.find((e) => e.event === 'message_delta')!.data as { usage: { input_tokens: number; output_tokens: number } }).usage;
    expect(finalUsage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it('non-streaming cycle: OpenAI chat.completion translated to Anthropic message JSON', async () => {
    writeConfig([openRouterGroup()]);
    const res = await callMessagesRoute(anthropicClientRequest(false), false);

    expect(res.status).toBe(200);
    const payload = JSON.parse(await readBody(res)) as {
      type: string;
      role: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(payload.type).toBe('message');
    expect(payload.role).toBe('assistant');
    expect(payload.stop_reason).toBe('tool_use');
    expect(payload.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    const textBlock = payload.content.find((b) => b.type === 'text');
    expect(textBlock?.text).toBe('Hello!');
    const toolBlock = payload.content.find((b) => b.type === 'tool_use');
    expect(toolBlock?.id).toBe('call_01');
    expect(toolBlock?.name).toBe('get_weather');
    expect(toolBlock?.input).toEqual({ city: 'Paris' });
  });

  it('429 on the first key rotates to the second within the same request', async () => {
    behavior.failFirstKeyWith = {
      status: 429,
      body: { error: { message: 'Rate limit exceeded: 20 requests per minute', type: 'requests', code: 429 } },
    };
    writeConfig([openRouterGroup()]);
    const res = await callMessagesRoute(anthropicClientRequest(true), true);

    expect(res.status).toBe(200);
    // Two upstream calls: first key 429'd, second served.
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY_1}`);
    expect(upstreamCalls[1].authorization).toBe(`Bearer ${UPSTREAM_KEY_2}`);
    // The client saw one clean translated stream.
    const text = await readBody(res);
    const events = parseAnthropicEvents(text);
    expect(events.map((e) => e.event)).toContain('message_stop');
  });
});

void jsonStream;
