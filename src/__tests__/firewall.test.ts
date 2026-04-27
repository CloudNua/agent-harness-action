import { describe, it, expect } from "vitest";
import { validateFirewallUrl } from "@/utils/firewall";

describe("validateFirewallUrl", () => {
  describe("empty input", () => {
    it("returns null for empty string", () => {
      expect(validateFirewallUrl("", false)).toBeNull();
    });

    it("returns null for whitespace-only", () => {
      expect(validateFirewallUrl("   ", false)).toBeNull();
    });
  });

  describe("when allowHttp is false", () => {
    it("accepts valid HTTPS URL (canonicalized)", () => {
      expect(validateFirewallUrl("https://firewall.example.com", false)).toBe(
        "https://firewall.example.com",
      );
    });

    it("strips trailing slash via canonicalization", () => {
      expect(validateFirewallUrl("https://firewall.example.com/", false)).toBe(
        "https://firewall.example.com",
      );
    });

    it("rejects HTTP URL", () => {
      expect(() =>
        validateFirewallUrl("http://firewall.internal:8080", false),
      ).toThrow("firewall-url must use HTTPS");
    });

    it("rejects non-HTTP protocols with specific error", () => {
      expect(() =>
        validateFirewallUrl("ftp://firewall.example.com", false),
      ).toThrow("firewall-url must use HTTP or HTTPS");
    });

    it("preserves path in canonicalized URL", () => {
      expect(
        validateFirewallUrl("https://firewall.example.com/v1/proxy", false),
      ).toBe("https://firewall.example.com/v1/proxy");
    });
  });

  describe("when allowHttp is true", () => {
    it("accepts HTTP URL", () => {
      expect(validateFirewallUrl("http://firewall.internal:8080", true)).toBe(
        "http://firewall.internal:8080",
      );
    });

    it("accepts HTTPS URL", () => {
      expect(validateFirewallUrl("https://firewall.example.com", true)).toBe(
        "https://firewall.example.com",
      );
    });

    it("rejects non-HTTP protocols", () => {
      expect(() =>
        validateFirewallUrl("ftp://firewall.example.com", true),
      ).toThrow("firewall-url must use HTTP or HTTPS");
    });
  });

  describe("security", () => {
    it("rejects malformed URL", () => {
      expect(() => validateFirewallUrl("not-a-url", false)).toThrow(
        "firewall-url is not a valid URL",
      );
    });

    it("rejects URLs with embedded credentials", () => {
      expect(() =>
        validateFirewallUrl("https://user:pass@firewall.example.com", false),
      ).toThrow("must not contain credentials");
    });

    it("rejects URLs with username only", () => {
      expect(() =>
        validateFirewallUrl("https://admin@firewall.example.com", false),
      ).toThrow("must not contain credentials");
    });

    it("returns canonicalized URL (not raw input)", () => {
      // URL with port 443 explicitly — canonical form may vary,
      // but must parse back to same origin
      const result = validateFirewallUrl(
        "https://firewall.example.com:443/path",
        false,
      );
      expect(result).toBeDefined();
      const parsed = new URL(result!);
      expect(parsed.hostname).toBe("firewall.example.com");
      expect(parsed.pathname).toBe("/path");
      expect(parsed.protocol).toBe("https:");
    });
  });
});
