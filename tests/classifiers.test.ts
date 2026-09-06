import { describe, expect, it } from 'vitest';
import { classifyErrorPayload, classifyInvalidPayload, computeCooldownUntil } from '@/lib/proxy';

// OpenAI-compatible error shape: {"error": {"message", "type", "code"}}.
// The existing classifiers must keep rotating correctly on it.

describe('classifiers on OpenAI-format errors', () => {
  it('429 rate limit (OpenRouter code 429) classifies as limit → rotate', () => {
    expect(
      classifyErrorPayload({
        error: { message: 'Rate limit exceeded: 20 requests per minute', type: 'requests', code: 429 },
      }),
    ).toBe(true);
  });

  it('quota exceeded / insufficient credits classify correctly (quota=limit, credits=invalid)', () => {
    expect(
      classifyErrorPayload({ error: { message: 'You exceeded your quota', type: 'insufficient_quota', code: 'insufficient_quota' } }),
    ).toBe(true);
    // "insufficient credits" is a billing/dead-key situation: the OpenAI
    // invalid-key list must claim it BEFORE the limit classifier runs
    // (isLimitError explicitly steps aside for invalid markers).
    const payload = { error: { message: 'Insufficient credits: add more credits', code: 402 } };
    expect(classifyInvalidPayload(payload)).toBe(true);
    expect(classifyErrorPayload(payload)).toBe(false);
  });

  it('401 invalid api key classifies as invalid (not limit)', () => {
    const payload = { error: { message: 'Invalid API key provided', type: 'invalid_request_error', code: 401 } };
    expect(classifyInvalidPayload(payload)).toBe(true);
    expect(classifyErrorPayload(payload)).toBe(false);
  });

  it('OpenRouter "No auth credentials found" classifies as invalid', () => {
    expect(
      classifyInvalidPayload({ error: { message: 'No auth credentials found', code: 401 } }),
    ).toBe(true);
  });

  it('5xx generic server error classifies as neither limit nor invalid (provider)', () => {
    const payload = { error: { message: 'Provider returned error', code: 500 } };
    expect(classifyErrorPayload(payload)).toBe(false);
    expect(classifyInvalidPayload(payload)).toBe(false);
  });

  it('400 bad request does not invalidate the key', () => {
    const payload = { error: { message: 'Invalid model name', type: 'invalid_request_error', code: 400 } };
    expect(classifyInvalidPayload(payload)).toBe(false);
    expect(classifyErrorPayload(payload)).toBe(false);
  });
});

describe('computeCooldownUntil on OpenRouter headers', () => {
  it('X-RateLimit-Reset (epoch seconds) is honored', () => {
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 60; // s epoch
    const headers = new Headers({ 'x-ratelimit-reset': String(reset) });
    const until = computeCooldownUntil(headers);
    // The OpenRouter epoch is within a minute of now+60s.
    expect(Math.abs(until - reset * 1000)).toBeLessThan(5_000);
    expect(until).toBeGreaterThan(now);
  });
});
