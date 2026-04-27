import { describe, it, expect } from "vitest";
import { validateUrl } from "@/utils/url";

describe("validateUrl", () => {
  it("returns null for empty input by default", () => {
    expect(validateUrl("", "test-url", { allowHttp: false })).toBeNull();
  });

  it("throws for empty input when allowEmpty is false", () => {
    expect(() =>
      validateUrl("", "api-url", { allowHttp: false, allowEmpty: false }),
    ).toThrow("api-url must not be empty");
  });

  it("uses the label in error messages", () => {
    expect(() =>
      validateUrl("not-a-url", "my-label", { allowHttp: false }),
    ).toThrow("my-label is not a valid URL");
  });

  it("rejects non-HTTP protocols before checking TLS", () => {
    // ftp:// should say "must use HTTP or HTTPS", not "must use HTTPS"
    expect(() =>
      validateUrl("ftp://example.com", "test-url", { allowHttp: false }),
    ).toThrow("must use HTTP or HTTPS");
  });

  it("rejects HTTP when allowHttp is false", () => {
    expect(() =>
      validateUrl("http://example.com", "test-url", { allowHttp: false }),
    ).toThrow("must use HTTPS");
  });

  it("accepts HTTP when allowHttp is true", () => {
    expect(
      validateUrl("http://example.com", "test-url", { allowHttp: true }),
    ).toBe("http://example.com");
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() =>
      validateUrl("https://user:pass@example.com", "test-url", {
        allowHttp: false,
      }),
    ).toThrow("must not contain credentials");
  });

  it("returns canonicalized URL", () => {
    const result = validateUrl("HTTPS://EXAMPLE.COM/path/", "test-url", {
      allowHttp: false,
    });
    // URL canonicalization lowercases the scheme and hostname
    expect(result).toBe("https://example.com/path");
  });
});
