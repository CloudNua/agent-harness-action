import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseManifestContent } from "@/scanner/manifests";
import { scanChanges, emptyScanResult } from "@/scanner/index";
import { CloudNuaClient } from "@/api/client";
import type { ChangedFile } from "@/utils/workspace";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

const defaultSummary = {
  total_violations: 0,
  block_count: 0,
  warn_count: 0,
  log_count: 0,
  has_mcp_policies: false,
};

describe("parseManifestContent", () => {
  it("parses package.json dependencies", () => {
    const content = JSON.stringify({
      dependencies: { react: "^19.0.0", lodash: "^4.17.21" },
      devDependencies: { typescript: "^5.5.0" },
    });

    const deps = parseManifestContent(content, "npm", "package.json");
    expect(deps).toHaveLength(3);
    expect(deps.map((d) => d.name)).toEqual(["react", "lodash", "typescript"]);
  });

  it("parses requirements.txt", () => {
    const content = "flask>=2.0\nrequests==2.31.0\n# comment\nnumpy";
    const deps = parseManifestContent(content, "pip", "requirements.txt");
    expect(deps).toHaveLength(3);
    expect(deps[0].name).toBe("flask");
    expect(deps[2].version).toBeNull();
  });

  it("parses go.mod", () => {
    const content = `module example.com/app

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    golang.org/x/text v0.14.0
)`;
    const deps = parseManifestContent(content, "go", "go.mod");
    expect(deps).toHaveLength(2);
    expect(deps[0].name).toBe("github.com/gin-gonic/gin");
  });

  it("parses go.mod with multiple require blocks", () => {
    const content = `module example.com/app

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)

require (
    golang.org/x/text v0.14.0
)`;
    const deps = parseManifestContent(content, "go", "go.mod");
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.name)).toEqual([
      "github.com/gin-gonic/gin",
      "golang.org/x/text",
    ]);
  });

  it("parses Cargo.toml", () => {
    const content = `[package]
name = "myapp"

[dependencies]
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }`;
    const deps = parseManifestContent(content, "cargo", "Cargo.toml");
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.name)).toEqual(["serde", "tokio"]);
  });

  it("returns empty array for invalid JSON", () => {
    const deps = parseManifestContent("not json", "npm", "package.json");
    expect(deps).toEqual([]);
  });
});

describe("emptyScanResult", () => {
  it("returns zeroed result", () => {
    const result = emptyScanResult();
    expect(result.violations).toEqual([]);
    expect(result.summary.totalDependencies).toBe(0);
    expect(result.summary.totalViolations).toBe(0);
  });
});

describe("scanChanges (delegation)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockClient(response: {
    violations: Array<Record<string, string>>;
    errors?: string[];
    summary?: Record<string, unknown>;
  }) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ...response,
          summary: response.summary ?? defaultSummary,
        }),
    });
    return new CloudNuaClient("cn_live_test123", "https://app.cloudnua.com");
  }

  it("delegates evaluation and maps granular violations", async () => {
    const client = mockClient({
      violations: [
        {
          policy_id: "p1",
          policy_name: "Block Malicious Packages",
          policy_type: "dependency",
          action: "block",
          message: 'Policy "Block Malicious Packages" matched dependency "event-stream"',
          dependency_name: "event-stream",
        },
      ],
      summary: { ...defaultSummary, total_violations: 1, block_count: 1 },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { "event-stream": "3.3.6", react: "^19.0.0" },
      }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    const result = await scanChanges(changes, tmpDir, client);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].policyId).toBe("p1");
    expect(result.violations[0].policyAction).toBe("block");
    expect(result.violations[0].dependency).toBe("event-stream");
    expect(result.violations[0].filePath).toBe("package.json");
    expect(result.summary.blockCount).toBe(1);
    expect(result.summary.totalDependencies).toBe(2);
  });

  it("returns empty result when no manifest files changed", async () => {
    const client = mockClient({ violations: [] });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    const changes: ChangedFile[] = [
      { path: "src/index.ts", status: "modified" },
      { path: "README.md", status: "added" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    expect(result.violations).toHaveLength(0);
    expect(result.summary.totalDependencies).toBe(0);
    // Should not have called evaluate (no manifests)
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("skips deleted manifest files", async () => {
    const client = mockClient({ violations: [] });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    const changes: ChangedFile[] = [
      { path: "package.json", status: "deleted" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    expect(result.violations).toHaveLength(0);
  });

  it("handles nested manifest paths", async () => {
    const client = mockClient({ violations: [] });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    mkdirSync(join(tmpDir, "services", "api"), { recursive: true });
    writeFileSync(
      join(tmpDir, "services", "api", "requirements.txt"),
      "flask>=2.0\nrequests==2.31.0\n",
    );

    const changes: ChangedFile[] = [
      { path: "services/api/requirements.txt", status: "modified" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    expect(result.violations).toHaveLength(0);
    expect(result.summary.totalDependencies).toBe(2);
  });

  it("sends manifest-only body to the policy API (no policies)", async () => {
    const client = mockClient({ violations: [] });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { express: "4.18.0" },
      }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
      { path: "src/app.ts", status: "added" },
    ];

    await scanChanges(changes, tmpDir, client);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://app.cloudnua.com/api/policies/evaluate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"dependencies"'),
      }),
    );

    // Verify the body structure — manifest only, no policies
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.manifest.dependencies).toEqual([
      { name: "express", version: "4.18.0", license: "", deprecated: false },
    ]);
    expect(body.manifest.file_paths).toEqual(["package.json", "src/app.ts"]);
    expect(body.policies).toBeUndefined();
  });

  it("surfaces evaluation errors in ScanResult", async () => {
    const client = mockClient({
      violations: [],
      errors: ['policy "p1": unknown field'],
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    expect(result.violations).toHaveLength(0);
    expect(result.evaluationErrors).toEqual(['policy "p1": unknown field']);
  });

  it("warns when has_mcp_policies is true in response", async () => {
    const core = await import("@actions/core");
    const client = mockClient({
      violations: [],
      summary: { ...defaultSummary, has_mcp_policies: true },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    await scanChanges(changes, tmpDir, client);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("MCP policies active but no MCP tools detected"),
    );
  });

  it("does not warn when has_mcp_policies is false", async () => {
    const core = await import("@actions/core");
    (core.warning as ReturnType<typeof vi.fn>).mockClear();
    const client = mockClient({
      violations: [],
      summary: { ...defaultSummary, has_mcp_policies: false },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    await scanChanges(changes, tmpDir, client);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("MCP policies active"),
    );
  });

  it("rejects unsafe file_path values from server", async () => {
    const client = mockClient({
      violations: [
        {
          policy_id: "p1",
          policy_name: "Block",
          policy_type: "dependency",
          action: "block",
          message: "blocked",
          dependency_name: "evil-pkg",
          file_path: "../../.github/workflows/ci.yml",
        },
        {
          policy_id: "p2",
          policy_name: "Block",
          policy_type: "dependency",
          action: "block",
          message: "blocked",
          dependency_name: "evil-pkg2",
          file_path: "/etc/passwd",
        },
      ],
      summary: { ...defaultSummary, total_violations: 2, block_count: 2 },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "evil-pkg": "1.0.0" } }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    // Both unsafe paths should fall back to default manifest path
    expect(result.violations[0].filePath).toBe("package.json");
    expect(result.violations[1].filePath).toBe("package.json");
  });

  it("uses file_path and dependency_name from granular violations", async () => {
    const client = mockClient({
      violations: [
        {
          policy_id: "p1",
          policy_name: "Block Malicious",
          policy_type: "dependency",
          action: "block",
          message: 'Policy "Block Malicious" matched dependency "event-stream"',
          dependency_name: "event-stream",
          file_path: "services/api/package.json",
        },
        {
          policy_id: "p2",
          policy_name: "Warn GPL",
          policy_type: "dependency",
          action: "warn",
          message: 'Policy "Warn GPL" matched dependency "gpl-lib"',
          dependency_name: "gpl-lib",
        },
      ],
      summary: { ...defaultSummary, total_violations: 2, block_count: 1, warn_count: 1 },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "event-stream": "3.3.6" } }),
    );

    const changes: ChangedFile[] = [
      { path: "package.json", status: "modified" },
    ];

    const result = await scanChanges(changes, tmpDir, client);
    expect(result.violations).toHaveLength(2);
    // First violation uses file_path from API response
    expect(result.violations[0].filePath).toBe("services/api/package.json");
    expect(result.violations[0].dependency).toBe("event-stream");
    // Second violation falls back to manifest file path
    expect(result.violations[1].filePath).toBe("package.json");
    expect(result.violations[1].dependency).toBe("gpl-lib");
    expect(result.summary.blockCount).toBe(1);
    expect(result.summary.warnCount).toBe(1);
    expect(result.summary.totalViolations).toBe(2);
  });
});
