// Shared test helpers: build ReadableStreams from raw strings (SSE fixtures).

export function sseStreamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Split anywhere — the stream translator must reassemble lines across
  // chunk boundaries, so arbitrary split points are part of the test.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < text.length; i += 7) {
    chunks.push(encoder.encode(text.slice(i, i + 7)));
  }
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
