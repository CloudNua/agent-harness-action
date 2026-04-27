import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isRetryable, ServerError } from "@/utils/retry";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

describe("isRetryable", () => {
  it("returns true for 5xx ServerError", () => {
    expect(isRetryable(new ServerError(500, "Internal Server Error"))).toBe(true);
    expect(isRetryable(new ServerError(502, "Bad Gateway"))).toBe(true);
    expect(isRetryable(new ServerError(503, "Service Unavailable"))).toBe(true);
  });

  it("returns false for 4xx ServerError", () => {
    expect(isRetryable(new ServerError(400, "Bad Request"))).toBe(false);
    expect(isRetryable(new ServerError(404, "Not Found"))).toBe(false);
    expect(isRetryable(new ServerError(422, "Unprocessable Entity"))).toBe(false);
    expect(isRetryable(new ServerError(429, "Too Many Requests"))).toBe(false);
  });

  it("returns true for TypeError (network errors)", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns true for DOMException (timeout)", () => {
    expect(isRetryable(new DOMException("signal timed out", "AbortError"))).toBe(true);
  });

  it("returns false for regular Error (4xx, malformed)", () => {
    expect(isRetryable(new Error("Authentication failed (401)"))).toBe(false);
    expect(isRetryable(new Error("Malformed response"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable("string")).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, "test", { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on ServerError and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError(500, "fail"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on network error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws", async () => {
    const fn = vi.fn().mockRejectedValue(new ServerError(503, "unavailable"));

    await expect(
      withRetry(fn, "test", { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("unavailable");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Auth failed (401)"));

    await expect(
      withRetry(fn, "test", { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("Auth failed (401)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxAttempts times", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError(500, "fail"))
      .mockRejectedValueOnce(new ServerError(502, "fail"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
