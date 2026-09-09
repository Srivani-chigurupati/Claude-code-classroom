/**
 * Custom error class for review operations
 */
export class ReviewError extends Error {
  constructor(
    message: string,
    public code: string,
    public metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ReviewError';
    Error.captureStackTrace(this, ReviewError);
  }
}

/**
 * Error codes for the review system
 */
export const ErrorCodes = {
  // Configuration errors
  MISSING_API_KEY: 'MISSING_API_KEY',
  MISSING_GITHUB_TOKEN: 'MISSING_GITHUB_TOKEN',
  INVALID_CONFIG: 'INVALID_CONFIG',

  // GitHub errors
  PR_NOT_FOUND: 'PR_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  GITHUB_API_ERROR: 'GITHUB_API_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',

  // Agent errors
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_FAILED: 'AGENT_FAILED',
  STRUCTURED_OUTPUT_FAILED: 'STRUCTURED_OUTPUT_FAILED',

  // General errors
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Promise-wrapped setTimeout, so backoff can be `await`ed.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry utility with exponential backoff
 *
 * This function implements the retry pattern with exponential backoff and jitter.
 *
 * Algorithm:
 * 1. Try to execute the function
 * 2. If it succeeds, return the result
 * 3. If it fails and retries remain:
 *    - Calculate backoff delay: delayMs * 2^(attempt - 1)
 *    - Add jitter (random 0-100ms) to prevent thundering herd
 *    - Wait for the calculated duration
 *    - Retry
 * 4. If all retries exhausted, throw ReviewError with RETRY_EXHAUSTED code
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param delayMs - Base delay in milliseconds (default: 1000)
 * @param shouldRetry - Predicate deciding whether an error is worth retrying.
 *   Defaults to retrying everything. When it returns false the original error
 *   is rethrown untouched, so callers keep its error code - retrying a
 *   deterministic failure (bad schema, bad config) only wastes time and money.
 * @returns The result of the successful function execution
 * @throws ReviewError with RETRY_EXHAUSTED code if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // A deterministic failure will fail identically next time.
      if (!shouldRetry(error)) {
        throw error;
      }

      // Nothing left to wait for on the final attempt.
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 1x, 2x, 4x, 8x ... the base delay.
      const backoff = delayMs * Math.pow(2, attempt - 1);
      // Jitter spreads retries out, so callers that failed together do not
      // all wake at the same instant and stampede the API again.
      const jitter = Math.random() * 100;

      await sleep(backoff + jitter);
    }
  }

  throw new ReviewError(
    `Operation failed after ${maxRetries} attempt(s): ${formatError(lastError)}`,
    ErrorCodes.RETRY_EXHAUSTED,
    { maxRetries, delayMs, lastError: formatError(lastError) }
  );
}

/**
 * Wrap an async function with timeout
 *
 * This function races the provided function against a timeout.
 * Whichever completes first wins.
 *
 * @param fn - Async function to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Custom error message
 * @returns The result of the function if it completes before timeout
 * @throws ReviewError with AGENT_TIMEOUT code if timeout is reached
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ReviewError(errorMessage, ErrorCodes.AGENT_TIMEOUT, { timeoutMs })
      );
    }, timeoutMs);
  });

  try {
    // Whichever settles first wins. `fn()` keeps running if the timeout wins -
    // Promise.race cannot cancel it - so callers must treat a timeout as a
    // reason to abandon the whole operation, not to retry alongside it.
    return await Promise.race([fn(), timeout]);
  } finally {
    // Always clear the timer, otherwise a pending one keeps the event loop
    // (and the process) alive after a fast success.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Check if an error is a ReviewError
 */
export function isReviewError(error: unknown): error is ReviewError {
  return error instanceof ReviewError;
}

/**
 * Format error for logging/display
 */
export function formatError(error: unknown): string {
  if (isReviewError(error)) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}