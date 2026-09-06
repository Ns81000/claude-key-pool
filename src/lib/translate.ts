// Protocol bridge: OpenAI-compatible ⇄ Anthropic Messages API.
//
// A group with protocol: "openai" speaks /v1/chat/completions upstream while
// the client keeps talking Anthropic to POST /v1/messages. This module is the
// pure translation layer — no Next/fetch/HTTP here, fully unit-testable.
// See docs/openai-protocol-bridge.md for the event-mapping spec.

// ---------------------------------------------------------------------------
// Types (input shape only — Anthropic requests as the pool receives them)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | (Record<string, unknown> & { type: string });

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | (string & {});
  name?: string;
}

export interface AnthropicRequestBody {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type?: string; text?: string }>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: unknown;
}

export interface TranslateOptions {
  // Anthropic model name (client-facing) → OpenAI model name (upstream).
  modelMapping?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Request translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

// The harness tags a context-size label onto the model name ("glm-5.3[1m]").
// It is transport encoding, not a model name — strip before mapping.
export function stripContextSuffix(model: string): string {
  const stripped = model.replace(/\[[^\]]*\]\s*$/, '').trim();
  return stripped || model;
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAiChatRequest {
  model: string;
  max_tokens?: number;
  stream: boolean;
  stream_options?: { include_usage: true };
  messages: OpenAiMessage[];
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  stop?: string[];
}

// Flatten an Anthropic content block list into { text, toolUse, toolResult }
// streams. Unknown block types are DROPPED with no failure (forward
// compatibility: new block types must not break the bridge) — the caller
// logs a warn.
function splitBlocks(blocks: AnthropicContentBlock[]): {
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults: Array<{ tool_use_id: string; content: string }>;
  unknown: string[];
} {
  let text = '';
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const toolResults: Array<{ tool_use_id: string; content: string }> = [];
  const unknown: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    if (block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string') {
      text += (block as AnthropicTextBlock).text;
    } else if (block.type === 'tool_use') {
      const b = block as AnthropicToolUseBlock;
      toolUses.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: (b.input ?? {}) as Record<string, unknown> });
    } else if (block.type === 'tool_result') {
      const b = block as AnthropicToolResultBlock;
      toolResults.push({ tool_use_id: String(b.tool_use_id ?? ''), content: flattenToolResultContent(b.content) });
    } else {
      unknown.push(String(block.type));
    }
  }
  return { text, toolUses, toolResults, unknown };
}

// tool_result.content: string | [{type:"text", text}] → concatenated string.
function flattenToolResultContent(content: AnthropicToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .join('');
  }
  return '';
}

// Anthropic request body → OpenAI chat completions body.
// Dropped (no OpenAI equivalent, never fatal): metadata, cache_control,
// thinking blocks, unknown content block types.
export function translateRequest(
  body: AnthropicRequestBody,
  options: TranslateOptions = {},
): OpenAiChatRequest {
  const messages: OpenAiMessage[] = [];

  // system: string | [{type:"text", text}] → one leading system message.
  if (typeof body.system === 'string' && body.system !== '') {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = body.system.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('');
    if (text !== '') messages.push({ role: 'system', content: text });
  }

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const { text, toolUses, toolResults } = splitBlocks(blocks);

    if (msg.role === 'user') {
      // OpenAI requires a tool message to directly follow the assistant
      // message carrying tool_calls, so tool results come FIRST, any
      // surrounding user text AFTER them.
      for (const tr of toolResults) {
        messages.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_use_id });
      }
      if (text !== '' || toolResults.length === 0) {
        messages.push({ role: 'user', content: text });
      }
    } else {
      // assistant: text → content, tool_use → tool_calls.
      const m: OpenAiMessage = { role: 'assistant', content: text };
      if (toolUses.length > 0) {
        m.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          // Strictly JSON.stringify — escaping preserved exactly.
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }));
      }
      messages.push(m);
    }
  }

  const model = mapModel(body.model ?? '', options.modelMapping);

  const out: OpenAiChatRequest = { model, stream: body.stream === true, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

export function mapModel(model: string, modelMapping?: Record<string, string>): string {
  const stripped = stripContextSuffix(model);
  return modelMapping?.[stripped] ?? stripped;
}

// Names of unknown content block types found in the last translateRequest —
// for a warn log without putting request bodies into logs.
export function findUnknownBlockTypes(body: AnthropicRequestBody): string[] {
  const unknown: string[] = [];
  for (const msg of body.messages ?? []) {
    if (Array.isArray(msg.content)) {
      unknown.push(...splitBlocks(msg.content).unknown);
    }
  }
  return unknown;
}

// ---------------------------------------------------------------------------
// Non-streaming translation (OpenAI chat.completion JSON → Anthropic message)
// ---------------------------------------------------------------------------

interface OpenAiCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// Translate a non-streaming OpenAI chat.completion into an Anthropic message
// body. Returns null when the payload is not a recognizable completion.
export function translateOpenAiCompletion(payload: unknown): AnthropicMessageResponse | null {
  if (!payload || typeof payload !== 'object') return null;
  const completion = payload as OpenAiCompletion;
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) return null;
  const choice = completion.choices[0];
  const message = choice?.message;
  if (!message || typeof message !== 'object') return null;

  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  }
  for (const tc of message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    if (typeof tc.function?.arguments === 'string' && tc.function.arguments !== '') {
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        // Unparseable arguments (aggregator oddity) — send an empty object
        // rather than failing the whole translation.
      }
    }
    content.push({
      type: 'tool_use',
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      input,
    });
  }

  const finish = choice?.finish_reason;
  const stopReason = finish === 'length' ? 'max_tokens' : finish === 'tool_calls' || finish === 'function_call' ? 'tool_use' : 'end_turn';

  return {
    id: 'msg_' + (completion.id ?? globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)),
    type: 'message',
    role: 'assistant',
    model: completion.model ?? 'unknown',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: typeof completion.usage?.prompt_tokens === 'number' ? completion.usage.prompt_tokens : 0,
      output_tokens: typeof completion.usage?.completion_tokens === 'number' ? completion.usage.completion_tokens : 0,
    },
  };
}

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Stream translation (OpenAI SSE → Anthropic SSE)
// ---------------------------------------------------------------------------

export interface TranslateStreamOptions {
  // Emitted when the upstream stream ends without finish_reason (the client
  // gets a synthetic end_turn so claude.exe does not hang).
  onAborted?: (reason: string) => void;
}

interface OpenAiChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  model?: string;
}

// One Anthropic SSE frame.
function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function randomId(): string {
  return 'msg_' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
}

// Translate an OpenAI SSE body stream into an Anthropic SSE event stream:
// message_start → (content_block_start → delta* → stop)* → message_delta → message_stop.
//
// Guarantees:
// - nothing is emitted after message_stop (trailing junk after [DONE] is
//   discarded);
// - a stream that dies without finish_reason still gets message_delta
//   (stop_reason end_turn) + message_stop — claude.exe hangs otherwise;
// - message_start carries zero usage; the real usage rides the final
//   message_delta when the upstream sent stream_options.include_usage.
export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  options: TranslateStreamOptions = {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();

  let started = false;
  let finished = false;
  const messageId = randomId();
  let modelName = 'unknown';
  // Next Anthropic content_block index. Text block first (index 0) once any
  // content arrives; tool blocks after it.
  let blockIndex = -1;
  let textBlockOpen = false;
  // OpenAI tool_calls are streamed with `index` — map each OpenAI index to
  // its (possibly not yet opened) Anthropic block.
  const toolCallBlocks = new Map<number, { index: number; opened: boolean }>();
  let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | null = null;
  let usage: { input_tokens: number; output_tokens: number } | null = null;

  // Convert OpenAI finish_reason to the Anthropic stop_reason.
  function mapFinishReason(reason: string | null | undefined): 'end_turn' | 'max_tokens' | 'tool_use' {
    if (reason === 'length') return 'max_tokens';
    if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
    return 'end_turn';
  }

  // Emit content_block_stop for every open block, then message_delta
  // (stop_reason + usage) and message_stop; nothing after that.
  function finish(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (finished) return;
    finished = true;

    if (!started) {
      // Empty stream — still a well-formed (empty) message envelope.
      started = true;
      controller.enqueue(
        sseFrame('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    if (textBlockOpen) {
      controller.enqueue(sseFrame('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
    }
    for (const block of toolCallBlocks.values()) {
      if (block.opened) {
        controller.enqueue(sseFrame('content_block_stop', { type: 'content_block_stop', index: block.index }));
      }
    }

    controller.enqueue(
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      }),
    );
    controller.enqueue(sseFrame('message_stop', { type: 'message_stop' }));
    controller.close();
  }

  // start() + async pump (the same shape as createStallProtectedStream):
  // decouples the upstream from the consumer's pull() — closing inside
  // pull() deadlocks the read promise in Node's stream implementation.
  // Backpressure is not enforced here: the translated SSE frames of one
  // completion are modest, and the stall-protected raw stream upstream of
  // the translator already guards against a silent provider.
  let finishController: ReadableStreamDefaultController<Uint8Array> | null = null;
  void (async () => {
    const decoder = new TextDecoder();
    let lineTail = '';
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          if (!stopReason) {
            // Stream died without finish_reason — synthetic end_turn so the
            // client does not hang waiting for more events.
            options.onAborted?.('stream ended without finish_reason');
            stopReason = 'end_turn';
          }
          break;
        }
        lineTail += decoder.decode(read.value, { stream: true });
        const lines = lineTail.split(/\r?\n/);
        lineTail = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
          if (finished) break; // [DONE] already closed the envelope
        }
        if (finished) break;
      }
    } catch (err) {
      // Upstream read failure mid-stream: close the envelope.
      options.onAborted?.(err instanceof Error ? err.message : String(err));
      if (!stopReason) stopReason = 'end_turn';
    }
    if (finishController) finish(finishController);
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* reader may already be released */
    }
  })();

  function processLine(line: string): void {
    if (finished) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      // A normal stream: the finish chunk (with usage) has already been
      // processed; close the envelope. Junk after [DONE] is discarded.
      if (!stopReason) stopReason = 'end_turn';
      finish(finishController!);
      return;
    }

    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(payload) as OpenAiChunk;
    } catch {
      return; // malformed data line — ignore, keep translating
    }
    if (!chunk || typeof chunk !== 'object') return;
    if (typeof chunk.model === 'string' && modelName === 'unknown') modelName = chunk.model;

    if (!started) {
      started = true;
      finishController!.enqueue(
        sseFrame('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // Assistant text content.
    if (typeof delta?.content === 'string' && delta.content !== '') {
      if (!textBlockOpen) {
        blockIndex++;
        textBlockOpen = true;
        finishController!.enqueue(
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          }),
        );
      }
      finishController!.enqueue(
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      );
    }

    // tool_calls fragments (first carries id+name; later only arguments).
    for (const tc of delta?.tool_calls ?? []) {
      const openAiIndex = tc.index ?? 0;
      let block = toolCallBlocks.get(openAiIndex);
      if (!block) {
        // First fragment for this tool call — close any open text block.
        if (textBlockOpen) {
          textBlockOpen = false;
          finishController!.enqueue(sseFrame('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
        }
        blockIndex++;
        block = { index: blockIndex, opened: false };
        toolCallBlocks.set(openAiIndex, block);
      }
      if (!block.opened && (tc.id || tc.function?.name)) {
        block.opened = true;
        finishController!.enqueue(
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: block.index,
            content_block: {
              type: 'tool_use',
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              input: {},
            },
          }),
        );
      }
      const args = tc.function?.arguments;
      // An empty arguments string on the OPENING fragment still emits an
      // input_json_delta with partial_json "" — the real Anthropic stream
      // opens every tool_use block with one, and strict clients rely on the
      // delta cadence starting immediately.
      if (typeof args === 'string' && (args !== '' || block.opened)) {
        finishController!.enqueue(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: args },
          }),
        );
      }
    }

    // Usage rides a separate final chunk (choices: []) with
    // stream_options.include_usage.
    if (chunk.usage && typeof chunk.usage === 'object') {
      usage = {
        input_tokens: typeof chunk.usage.prompt_tokens === 'number' ? chunk.usage.prompt_tokens : 0,
        output_tokens: typeof chunk.usage.completion_tokens === 'number' ? chunk.usage.completion_tokens : 0,
      };
    }

    if (choice?.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      finishController = controller;
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}
