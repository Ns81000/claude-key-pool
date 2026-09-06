import { describe, expect, it } from 'vitest';
import { translateStream } from '@/lib/translate';
import { sseStreamFrom } from './helpers';

// Read an Anthropic-SSE stream to the end and return the parsed events.
async function collectAnthropicEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  // SSE frames: blocks separated by a blank line; each block has `event:` and
  // `data:` lines (Anthropic format).
  for (const block of text.split(/\r?\n\r?\n/)) {
    const evMatch = block.match(/^event:\s*(.+)$/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (!evMatch || !dataMatch) continue;
    events.push({ event: evMatch[1].trim(), data: JSON.parse(dataMatch[1]) });
  }
  return { text, events };
}

function eventTypes(events: Array<{ event: string }>): string[] {
  return events.map((e) => e.event);
}

describe('translateStream (OpenAI SSE → Anthropic SSE)', () => {
  it('text stream: full Anthropic event sequence from OpenAI chunks', async () => {
    const openaiSse = [
      'data: {"id":"cc1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"cc1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"cc1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      '',
      'data: {"id":"cc1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"id":"cc1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4.5","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    expect(eventTypes(events)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = events[0].data as { type: string; message: { id: string; model: string; usage: unknown } };
    expect(start.type).toBe('message_start');
    expect(start.message.id).toMatch(/^msg_/);
    expect(start.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });

    const blockStart = events[1].data as { index: number; content_block: { type: string } };
    expect(blockStart.index).toBe(0);
    expect(blockStart.content_block.type).toBe('text');

    expect((events[2].data as { delta: { type: string; text: string } }).delta).toEqual({
      type: 'text_delta',
      text: 'Hello',
    });

    const delta = events[5].data as { delta: { stop_reason: string }; usage: unknown };
    expect(delta.delta.stop_reason).toBe('end_turn');
    expect(delta.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it('single tool_call: text then tool_use block with partial JSON arguments', async () => {
    const openaiSse = [
      '{"choices":[{"index":0,"delta":{"role":"assistant","content":"Checking."},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Paris\\"}"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9}}',
    ]
      .map((d) => `data: ${d}`)
      .join('\n\n') + '\n\ndata: [DONE]\n\n';

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    expect(eventTypes(events)).toEqual([
      'message_start',
      'content_block_start', // text
      'content_block_delta', // "Checking."
      'content_block_stop', // close text block before tool block
      'content_block_start', // tool_use
      'content_block_delta', // input_json_delta ""
      'content_block_delta', // {"ci
      'content_block_delta', // ty":"Paris"}
      'content_block_stop', // tool block
      'message_delta',
      'message_stop',
    ]);

    const toolStart = events[4].data as { index: number; content_block: { type: string; id: string; name: string } };
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toEqual({
      type: 'tool_use',
      id: 'call_01',
      name: 'get_weather',
      input: {},
    });

    const jsonDeltas = events.slice(5, 8).map((e) => (e.data as { delta: { partial_json: string } }).delta.partial_json);
    expect(jsonDeltas.join('')).toBe('{"city":"Paris"}');

    const delta = events[9].data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('tool_use');
  });

  it('multi tool_calls: several tool_use blocks with sequential indexes', async () => {
    const openaiSse = [
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"f1","arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"f2","arguments":"{\\"y\\":2}"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5}}',
    ]
      .map((d) => `data: ${d}`)
      .join('\n\n') + '\n\ndata: [DONE]\n\n';

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    const blockStarts = events.filter((e) => e.event === 'content_block_start');
    expect(blockStarts).toHaveLength(2);
    expect((blockStarts[0].data as { index: number }).index).toBe(0);
    expect((blockStarts[0].data as { content_block: { id: string } }).content_block.id).toBe('call_a');
    expect((blockStarts[1].data as { index: number }).index).toBe(1);
    expect((blockStarts[1].data as { content_block: { id: string } }).content_block.id).toBe('call_b');

    // f1 gets its arguments as one input_json_delta, f2 as another.
    const jsonDeltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { partial_json?: string } }).delta.partial_json ?? '');
    expect(jsonDeltas.join('')).toBe('{"x":1}{"y":2}');
  });

  it('finish_reason "length" maps to stop_reason max_tokens', async () => {
    const openaiSse = [
      '{"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
    ]
      .map((d) => `data: ${d}`)
      .join('\n\n') + '\n\ndata: [DONE]\n\n';

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    const delta = events.find((e) => e.event === 'message_delta')!.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('max_tokens');
  });

  it('stream broken without finish_reason: end_turn + message_stop, no hang', async () => {
    const openaiSse = [
      '{"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
      // stream ends abruptly — no finish_reason chunk, no [DONE]
    ]
      .map((d) => `data: ${d}`)
      .join('\n\n') + '\n\n';

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    const types = eventTypes(events);
    expect(types[types.length - 2]).toBe('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');
    const delta = events[events.length - 2].data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('end_turn');
  });

  it('garbage chunks after [DONE] are discarded; nothing follows message_stop', async () => {
    const openaiSse = [
      '{"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    ]
      .map((d) => `data: ${d}`)
      .join('\n\n') +
      '\n\ndata: [DONE]\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"junk after done"},"finish_reason":null}]}\n\n';

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    const types = eventTypes(events);
    expect(types[types.length - 1]).toBe('message_stop');
    // "ok" present, junk absent
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { text?: string } }).delta.text ?? '')
      .join('');
    expect(text).toBe('ok');
  });

  it('empty stream (no chunks at all) still emits a complete message envelope', async () => {
    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom('')));
    expect(eventTypes(events)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });

  it('non-JSON / malformed data lines are ignored, stream continues', async () => {
    const openaiSse = [
      'data: not json at all',
      '',
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"fine"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const { events } = await collectAnthropicEvents(translateStream(sseStreamFrom(openaiSse)));
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { text?: string } }).delta.text ?? '')
      .join('');
    expect(text).toBe('fine');
  });
});

// Read an Anthropic-SSE stream to the end and return the parsed events.
export {};
