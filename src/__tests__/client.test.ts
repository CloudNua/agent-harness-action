import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CloudNuaClient } from "@/api/client";
import type { PolicyExportResponse, EvaluationResponse } from "@/types/policy";

// Mock @actions/core to prevent actual GitHub Actions logging
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

const MOCK_POLICIES: PolicyExportResponse = {
  policies: [
    {
      id: "p1",
      name: "Block lodash",
      description: "Block lodash in all projects",
      type: "dependency",
      action: "block",
      conditions: {
        field: "dependency.name",
        operator: "in",
        values: ["lodash"],
      },
      enabled: true,
    },
    {
      id: "p2",
      name: "Warn on MCP",
      description: null,
      type: "mcp",
      action: "warn",
      conditions: {
        field: "mcp.tool.name",
        operator: "in",
        values: ["mcp-server-bash"],
      },
      enabled: true,
    },
  ],
};

describe("CloudNuaClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchPolicies", () => {
    it("fetches policies successfully", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient("cn_live_test123", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      const result = await client.fetchPolicies();

      expect(result.policies).toHaveLength(2);
      expect(result.policies[0].name).toBe("Block lodash");
      expect(result.policies[1].type).toBe("mcp");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://app.cloudnua.com/api/policies/export",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer cn_live_test123",
          }),
        }),
      );
    });

    it("strips trailing slash from base URL", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient("cn_live_test123", "https://app.cloudnua.com/");
      await client.fetchPolicies();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://app.cloudnua.com/api/policies/export",
        expect.anything(),
      );
    });

    it("rejects non-HTTPS URLs", () => {
      expect(
        () => new CloudNuaClient("cn_live_test", "http://app.cloudnua.com"),
      ).toThrow("api-url must use HTTPS");
    });

    it("allows HTTP when allowHttp is true", () => {
      expect(
        () => new CloudNuaClient("cn_live_test", "http://internal.test", { allowHttp: true }),
      ).not.toThrow();
    });

    it("throws on 401 auth failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const client = new CloudNuaClient("cn_live_bad", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(client.fetchPolicies()).rejects.toThrow(
        "Authentication failed (401): check your api-token input",
      );
    });

    it("throws on 403 forbidden", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const client = new CloudNuaClient("cn_live_bad", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(client.fetchPolicies()).rejects.toThrow(
        "Authentication failed (403): check your api-token input",
      );
    });

    it("retries on 500 then throws after exhausting attempts", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const client = new CloudNuaClient("cn_live_test", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(client.fetchPolicies()).rejects.toThrow(
        "Failed to fetch policies: 500 Internal Server Error",
      );
      // Should have retried 3 times
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it("throws on malformed response (no policies array)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });

      const client = new CloudNuaClient("cn_live_test", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(client.fetchPolicies()).rejects.toThrow(
        "Malformed policy response: missing policies array",
      );
    });

    it("retries on network error then throws after exhausting attempts", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      const client = new CloudNuaClient("cn_live_test", "https://unreachable.example.com", { retry: { baseDelayMs: 1 } });
      await expect(client.fetchPolicies()).rejects.toThrow("fetch failed");
      // Network errors are retryable — should have retried 3 times
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("evaluate", () => {
    it("sends manifest only (no policies), returns violations", async () => {
      const mockResponse: EvaluationResponse = {
        violations: [
          {
            policy_id: "p1",
            policy_name: "Block lodash",
            policy_type: "dependency",
            action: "block",
            message: 'Policy "Block lodash" matched dependency "lodash"',
            dependency_name: "lodash",
          },
        ],
        summary: {
          total_violations: 1,
          block_count: 1,
          warn_count: 0,
          log_count: 0,
          has_mcp_policies: false,
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

      const client = new CloudNuaClient("cn_live_test123", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      const result = await client.evaluate({
        dependencies: [{ name: "lodash", version: "4.17.21", license: "MIT", deprecated: false }],
        mcp_tools: [],
        file_paths: ["package.json"],
      });

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].policy_id).toBe("p1");
      expect(result.violations[0].dependency_name).toBe("lodash");

      // Verify body contains manifest but no policies
      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.manifest).toBeDefined();
      expect(body.policies).toBeUndefined();
    });

    it("retries on 502 then throws after exhausting attempts", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      });

      const client = new CloudNuaClient("cn_live_test", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(
        client.evaluate({ dependencies: [], mcp_tools: [], file_paths: [] }),
      ).rejects.toThrow("Evaluation failed: 502 Bad Gateway");
      // Should have retried 3 times
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it("throws on 401 auth failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const client = new CloudNuaClient("cn_live_bad", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(
        client.evaluate({ dependencies: [], mcp_tools: [], file_paths: [] }),
      ).rejects.toThrow("Authentication failed (401)");
    });

    it("throws on malformed response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: "ok" }),
      });

      const client = new CloudNuaClient("cn_live_test", "https://app.cloudnua.com", { retry: { baseDelayMs: 1 } });
      await expect(
        client.evaluate({ dependencies: [], mcp_tools: [], file_paths: [] }),
      ).rejects.toThrow("Malformed evaluation response");
    });
  });

  describe("Cloudflare Access service-token headers", () => {
    it("attaches CF-Access-Client-Id and CF-Access-Client-Secret when both are set", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app-uat.cloudnua.com",
        {
          retry: { baseDelayMs: 1 },
          cfAccessClientId: "abc123.access",
          cfAccessClientSecret: "supersecret",
        },
      );
      await client.fetchPolicies();

      const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(headers["CF-Access-Client-Id"]).toBe("abc123.access");
      expect(headers["CF-Access-Client-Secret"]).toBe("supersecret");
      expect(headers["Authorization"]).toBe("Bearer cn_live_test123");
    });

    it("omits CF-Access headers when neither input is set", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app.cloudnua.com",
        { retry: { baseDelayMs: 1 } },
      );
      await client.fetchPolicies();

      const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
    });

    it("warns and treats as unset when only client-id is provided", async () => {
      const core = await import("@actions/core");
      const warningSpy = vi.spyOn(core, "warning");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app.cloudnua.com",
        {
          retry: { baseDelayMs: 1 },
          cfAccessClientId: "abc123.access",
        },
      );
      await client.fetchPolicies();

      const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("must be set together"),
      );
    });

    it("warns and treats as unset when only client-secret is provided", async () => {
      const core = await import("@actions/core");
      const warningSpy = vi.spyOn(core, "warning");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app.cloudnua.com",
        {
          retry: { baseDelayMs: 1 },
          cfAccessClientSecret: "supersecret",
        },
      );
      await client.fetchPolicies();

      const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("must be set together"),
      );
    });

    it("treats whitespace-only credentials as unset", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app.cloudnua.com",
        {
          retry: { baseDelayMs: 1 },
          cfAccessClientId: "   ",
          cfAccessClientSecret: "   ",
        },
      );
      await client.fetchPolicies();

      const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
    });

    it("does not log the client secret in messages", async () => {
      const core = await import("@actions/core");
      const warningSpy = vi.spyOn(core, "warning");
      const debugSpy = vi.spyOn(core, "debug");
      const infoSpy = vi.spyOn(core, "info");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MOCK_POLICIES),
      });

      const SECRET = "topsecret-do-not-leak-XYZ123";
      const client = new CloudNuaClient(
        "cn_live_test123",
        "https://app.cloudnua.com",
        {
          retry: { baseDelayMs: 1 },
          cfAccessClientId: "abc123.access",
          cfAccessClientSecret: SECRET,
        },
      );
      await client.fetchPolicies();

      const allLogs = [
        ...warningSpy.mock.calls,
        ...debugSpy.mock.calls,
        ...infoSpy.mock.calls,
      ]
        .flat()
        .filter((arg) => typeof arg === "string");
      for (const msg of allLogs) {
        expect(msg).not.toContain(SECRET);
      }
    });
  });
});
