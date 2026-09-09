import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout,
  isReviewError,
  formatError
} from '../src/utils/error-handler.js';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../src/utils/rate-limiter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('returns immediately on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until it succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockResolvedValue('recovered');

    await expect(withRetry(fn, 3, 1)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('makes exactly maxRetries attempts before giving up', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, 3, 1)).rejects.toThrow(ReviewError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RETRY_EXHAUSTED carrying the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('upstream 503'));

    await expect(withRetry(fn, 2, 1)).rejects.toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED
    });

    try {
      await withRetry(fn, 2, 1);
    } catch (error) {
      expect(isReviewError(error)).toBe(true);
      if (isReviewError(error)) {
        expect(error.message).toContain('upstream 503');
        expect(error.metadata).toMatchObject({ maxRetries: 2 });
      }
    }
  });

  it('backs off exponentially, doubling each wait', async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((cb: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        // Fire immediately so the test stays fast.
        return realSetTimeout(cb, 0);
      }) as typeof globalThis.setTimeout);

    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(withRetry(fn, 4, 1000)).rejects.toThrow(ReviewError);
    spy.mockRestore();

    // 3 waits for 4 attempts. Base 1000 -> 1000, 2000, 4000 plus <100ms jitter.
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(1100);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    expect(waits[1]).toBeLessThan(2100);
    expect(waits[2]).toBeGreaterThanOrEqual(4000);
    expect(waits[2]).toBeLessThan(4100);
  });

  it('adds jitter so concurrent callers do not wake together', async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((cb: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        return realSetTimeout(cb, 0);
      }) as typeof globalThis.setTimeout);

    for (let i = 0; i < 12; i++) {
      await withRetry(vi.fn().mockRejectedValue(new Error('x')), 2, 1000).catch(() => {});
    }
    spy.mockRestore();

    // Every wait is the same 1000ms base, so any spread proves jitter is applied.
    expect(new Set(waits).size).toBeGreaterThan(1);
  });
});

describe('withTimeout', () => {
  it('returns the value when the function finishes in time', async () => {
    await expect(withTimeout(async () => 'fast', 1000)).resolves.toBe('fast');
  });

  it('rejects with AGENT_TIMEOUT when the function is too slow', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 5000));

    await expect(withTimeout(slow, 20, 'agent took too long')).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT,
      message: 'agent took too long'
    });
  });

  it('records timeoutMs in the error metadata', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      await withTimeout(slow, 15);
      expect.unreachable('should have timed out');
    } catch (error) {
      expect(isReviewError(error)).toBe(true);
      if (isReviewError(error)) {
        expect(error.metadata).toEqual({ timeoutMs: 15 });
      }
    }
  });

  it('propagates the original error rather than a timeout', async () => {
    const failing = async () => {
      throw new Error('real failure');
    };
    await expect(withTimeout(failing, 1000)).rejects.toThrow('real failure');
  });

  it('clears its timer on success so the process can exit', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(async () => 'done', 5000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe('formatError / isReviewError', () => {
  it('prefixes a ReviewError with its code', () => {
    expect(formatError(new ReviewError('bad config', ErrorCodes.INVALID_CONFIG))).toBe(
      '[INVALID_CONFIG] bad config'
    );
  });

  it('uses the message for a plain Error', () => {
    expect(formatError(new Error('plain'))).toBe('plain');
  });

  it('stringifies a non-Error', () => {
    expect(formatError('just a string')).toBe('just a string');
  });

  it('distinguishes ReviewError from Error', () => {
    expect(isReviewError(new ReviewError('x', 'CODE'))).toBe(true);
    expect(isReviewError(new Error('x'))).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('applies the default limits', () => {
    const status = new RateLimiter().getStatus();
    expect(status.availableRequests).toBe(DEFAULT_RATE_LIMITS.maxRequestsPerMinute);
    expect(status.availableTokens).toBe(DEFAULT_RATE_LIMITS.maxTokensPerMinute);
    expect(status.activeRequests).toBe(0);
  });

  it('merges a partial custom config over the defaults', () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 4 });
    const status = limiter.getStatus();
    expect(status.availableRequests).toBe(4);
    // Untouched keys keep their defaults.
    expect(status.availableTokens).toBe(DEFAULT_RATE_LIMITS.maxTokensPerMinute);
  });

  it('records a request against the window on acquire', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 10 });
    await limiter.acquire(2500);

    const status = limiter.getStatus();
    expect(status.activeRequests).toBe(1);
    expect(status.requestsInWindow).toBe(1);
    expect(status.tokensInWindow).toBe(2500);
    expect(status.availableRequests).toBe(9);
  });

  it('frees the active slot on release', async () => {
    const limiter = new RateLimiter();
    await limiter.acquire(1000);
    expect(limiter.getStatus().activeRequests).toBe(1);

    limiter.release();
    expect(limiter.getStatus().activeRequests).toBe(0);
    // The request still counts toward the window - only the slot is freed.
    expect(limiter.getStatus().requestsInWindow).toBe(1);
  });

  it('replaces the estimate with the actual token count on release', async () => {
    const limiter = new RateLimiter();
    await limiter.acquire(1000);
    limiter.release(7777);
    expect(limiter.getStatus().tokensInWindow).toBe(7777);
  });

  it('never drives activeRequests negative on an extra release', () => {
    const limiter = new RateLimiter();
    limiter.release();
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  describe('canProceed', () => {
    it('is false once the request budget is spent', async () => {
      const limiter = new RateLimiter({ maxRequestsPerMinute: 2, maxConcurrent: 10 });
      await limiter.acquire(10);
      limiter.release();
      await limiter.acquire(10);
      limiter.release();
      expect(limiter.canProceed(10)).toBe(false);
    });

    it('is false when the request would exceed the token budget', async () => {
      const limiter = new RateLimiter({ maxTokensPerMinute: 1000, maxConcurrent: 10 });
      await limiter.acquire(600);
      limiter.release();
      expect(limiter.canProceed(300)).toBe(true);
      expect(limiter.canProceed(500)).toBe(false);
    });

    it('is false while all concurrent slots are held', async () => {
      const limiter = new RateLimiter({ maxConcurrent: 1 });
      await limiter.acquire(10);
      expect(limiter.canProceed(10)).toBe(false);
      limiter.release();
      expect(limiter.canProceed(10)).toBe(true);
    });

    it('tracks requests and tokens independently', async () => {
      // Request budget is generous, token budget is not.
      const limiter = new RateLimiter({
        maxRequestsPerMinute: 100,
        maxTokensPerMinute: 500,
        maxConcurrent: 10
      });
      await limiter.acquire(500);
      limiter.release();
      expect(limiter.getStatus().availableRequests).toBe(99);
      expect(limiter.getStatus().availableTokens).toBe(0);
      expect(limiter.canProceed(1)).toBe(false);
    });
  });

  describe('sliding window', () => {
    it('drops records older than 60 seconds', async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter({ maxRequestsPerMinute: 5 });

      await limiter.acquire(1000);
      limiter.release();
      expect(limiter.getStatus().requestsInWindow).toBe(1);

      // Just inside the window.
      vi.setSystemTime(Date.now() + 59_000);
      expect(limiter.getStatus().requestsInWindow).toBe(1);

      // Now past it.
      vi.setSystemTime(Date.now() + 2_000);
      expect(limiter.getStatus().requestsInWindow).toBe(0);
      expect(limiter.getStatus().tokensInWindow).toBe(0);
    });

    it('restores capacity as the window slides', async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter({ maxRequestsPerMinute: 1, maxConcurrent: 5 });

      await limiter.acquire(10);
      limiter.release();
      expect(limiter.canProceed(10)).toBe(false);

      vi.setSystemTime(Date.now() + 61_000);
      expect(limiter.canProceed(10)).toBe(true);
    });
  });

  describe('concurrency queue', () => {
    it('parks a caller until a slot is released, in FIFO order', async () => {
      const limiter = new RateLimiter({ maxConcurrent: 1, maxRequestsPerMinute: 100 });
      const order: string[] = [];

      await limiter.acquire(10);
      order.push('first-acquired');

      const second = limiter.acquire(10).then(() => order.push('second-acquired'));

      // The second caller must still be waiting.
      await Promise.resolve();
      expect(order).toEqual(['first-acquired']);

      limiter.release();
      await second;

      expect(order).toEqual(['first-acquired', 'second-acquired']);
      expect(limiter.getStatus().activeRequests).toBe(1);
    });

    it('lets a request through when it alone exceeds the token budget', async () => {
      // Otherwise the caller would wait forever for an empty window to shrink.
      const limiter = new RateLimiter({ maxTokensPerMinute: 100, maxConcurrent: 2 });
      await expect(limiter.acquire(5000)).resolves.toBeUndefined();
    });
  });
});

describe('withRetry shouldRetry predicate', () => {
  it('rethrows a non-retryable error immediately, preserving its code', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ReviewError('bad schema', ErrorCodes.VALIDATION_FAILED));

    await expect(
      withRetry(fn, 5, 1, (e) => !(e instanceof ReviewError && e.code === ErrorCodes.VALIDATION_FAILED))
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries errors the predicate accepts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, 3, 1, () => true)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
