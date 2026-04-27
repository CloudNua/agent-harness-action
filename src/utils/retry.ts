import { logger } from "./logger";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
};

export class ServerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
  }
}

function isRetryable(error: unknown): boolean {
  // Only retry 5xx server errors — 4xx are deterministic failures
  if (error instanceof ServerError) {
    return error.status >= 500 && error.status < 600;
  }
  // Network errors (TypeError: fetch failed), timeouts (AbortError/DOMException)
  if (error instanceof TypeError || error instanceof DOMException) {
    return true;
  }
  return false;
}

/**
 * Wraps an async function with retry + exponential backoff.
 * Retries on 5xx responses, network errors, and timeouts.
 * Does NOT retry on 4xx (auth failures, bad requests).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const maxAttempts = Math.min(Math.max(merged.maxAttempts, 1), 5);
  const baseDelayMs = Math.min(Math.max(merged.baseDelayMs, 100), 10_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const maxDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const half = maxDelay / 2;
      const delay = half + Math.floor(Math.random() * half);
      logger.warning(
        `${label} failed (attempt ${attempt}/${maxAttempts}): ${error instanceof Error ? error.message : "Unknown error"}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }

  // Unreachable — loop either returns or throws
  throw new Error(`${label}: exhausted retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for testing
export { isRetryable, sleep };
