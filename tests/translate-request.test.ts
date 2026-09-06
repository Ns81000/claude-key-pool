import { describe, expect, it } from 'vitest';
import { translateRequest, stripContextSuffix } from '@/lib/translate';

describe('translateRequest (Anthropic → OpenAI)', () => {
  it('minimal dialog: system string + user text → system message + user message', () => {
    const openai = translateRequest(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      {},
    );
    expect(openai).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });
  });

  it('array system is concatenated into one system message', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        system: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
        messages: [{ role: 'user', content: 'q' }],
      },
      {},
    );
    expect(openai.messages[0]).toEqual({ role: 'system', content: 'Part one. Part two.' });
  });

  it('assistant text message maps to role assistant with string content', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'text', text: 'a1' }, { type: 'text', text: 'a2' }] },
        ],
      },
      {},
    );
    expect(openai.messages[1]).toEqual({ role: 'assistant', content: 'a1a2' });
  });

  it('tools map to OpenAI function tools', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'q' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      },
      {},
    );
    expect(openai.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ]);
  });

  it('tool_choice maps auto/any/tool', () => {
    const base = { model: 'm', max_tokens: 10, messages: [{ role: 'user' as const, content: 'q' }] };
    expect(translateRequest({ ...base, tool_choice: { type: 'auto' } }, {}).tool_choice).toBe('auto');
    expect(translateRequest({ ...base, tool_choice: { type: 'any' } }, {}).tool_choice).toBe('required');
    expect(
      translateRequest({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } }, {}).tool_choice,
    ).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('tool_use in assistant content becomes tool_calls with JSON-stringified arguments', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'weather in Paris?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris', unit: '°C' } },
            ],
          },
        ],
      },
      {},
    );
    expect(openai.messages[1]).toEqual({
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [
        { id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris","unit":"°C"}' } },
      ],
    });
  });

  it('tool_result in user content becomes a tool message with tool_call_id', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', content: 'Sunny, 21°C' },
            ],
          },
        ],
      },
      {},
    );
    expect(openai.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_01',
      content: 'Sunny, 21°C',
    });
  });

  it('tool_result with structured content concatenates text blocks', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
              },
            ],
          },
        ],
      },
      {},
    );
    expect(openai.messages[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'line1line2' });
  });

  it('mixed tool_result + text in one user message splits into tool message + user message', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Here is the result:' },
              { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            ],
          },
        ],
      },
      {},
    );
    // The tool message must come BEFORE the trailing user text (OpenAI
    // requires tool results to immediately follow the tool_calls message).
    expect(openai.messages).toEqual([
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'user', content: 'Here is the result:' },
    ]);
  });

  it('[1m] context-size suffix is stripped before mapping', () => {
    const openai = translateRequest(
      {
        model: 'claude-sonnet-4-5[1m]',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'q' }],
      },
      { modelMapping: { 'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5' } },
    );
    expect(openai.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('modelMapping rewrites the model; without mapping the name passes through', () => {
    const base = { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user' as const, content: 'q' }] };
    expect(translateRequest({ ...base }, { modelMapping: { 'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5' } }).model).toBe(
      'anthropic/claude-sonnet-4.5',
    );
    expect(translateRequest({ ...base }, {}).model).toBe('claude-sonnet-4-5');
  });

  it('unknown content blocks are dropped, request does not fail', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'keep me' },
              { type: 'future_block', whatever: 1 } as never,
            ],
          },
        ],
      },
      {},
    );
    expect(openai.messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('assistant message with only tool_use has empty-string content (no text blocks)', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }],
          },
        ],
      },
      {},
    );
    expect(openai.messages[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    });
  });

  it('temperature and stop_sequences map to temperature and stop', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        temperature: 0.2,
        stop_sequences: ['\n\nHuman:'],
        messages: [{ role: 'user', content: 'q' }],
      },
      {},
    );
    expect(openai.temperature).toBe(0.2);
    expect(openai.stop).toEqual(['\n\nHuman:']);
  });

  it('stream: true adds stream_options.include_usage', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'q' }],
      },
      {},
    );
    expect(openai.stream).toBe(true);
    expect(openai.stream_options).toEqual({ include_usage: true });
  });

  it('metadata and cache_control fields are dropped (request survives)', () => {
    const openai = translateRequest(
      {
        model: 'm',
        max_tokens: 10,
        metadata: { user_id: 'u1' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] }],
      },
      {},
    );
    expect((openai as unknown as Record<string, unknown>).metadata).toBeUndefined();
    expect(openai.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('non-streaming request does not carry stream_options', () => {
    const openai = translateRequest(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
      {},
    );
    expect(openai.stream).toBe(false);
    expect(openai.stream_options).toBeUndefined();
  });
});

describe('stripContextSuffix', () => {
  it('strips trailing [1m]-style labels', () => {
    expect(stripContextSuffix('glm-5.3[1m]')).toBe('glm-5.3');
    expect(stripContextSuffix('claude-sonnet-4-5[200k]')).toBe('claude-sonnet-4-5');
  });
  it('leaves plain model names untouched', () => {
    expect(stripContextSuffix('glm-5.3')).toBe('glm-5.3');
    expect(stripContextSuffix('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });
});
