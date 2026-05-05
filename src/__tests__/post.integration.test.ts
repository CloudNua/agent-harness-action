/**
 * Integration test for runPostStep in scan-only mode.
 *
 * Unlike post.test.ts (which mocks `@/scanner` + `@/scanner/manifests` to
 * unit-test the orchestration), this file mocks ONLY the network boundary:
 * `@/api/client` (so we don't make HTTP calls) and `@/reporting/check-run`
 * (so we don't talk to GitHub). The real scanner + manifest walker run
 * against a real fixture workspace on disk.
 *
 * This catches a bug class the unit tests cannot: regressions where the
 * walker stops finding manifests, or where the scan-only ChangedFile shape
 * silently disagrees with what `scanChanges` expects internally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const coreMocks = vi.hoisted(() => ({
  getInput: vi.fn<(name: string, options?: { required?: boolean }) => string>(),
  getState: vi.fn<(name: string) => string>(),
  saveState: vi.fn<(name: string, value: string) => void>(),
  setSecret: vi.fn<(secret: string) => void>(),
  setFailed: vi.fn<(message: string) => void>(),
  info: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  warning: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  notice: vi.fn<(msg: string, props?: Record<string, string>) => void>(),
}));

const evaluateMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(),
);
const fetchPackageIntelligenceMock = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(),
);

const checkRunMocks = vi.hoisted(() => ({
  createCheckRun: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@actions/core", () => coreMocks);
vi.mock("@/api/client", () => ({
  CloudNuaClient: vi.fn().mockImplementation(() => ({
    evaluate: evaluateMock,
    fetchPackageIntelligence: fetchPackageIntelligenceMock,
  })),
}));
vi.mock("@/reporting/check-run", () => checkRunMocks);

describe("runPostStep — scan-only integration (real walker + parser)", () => {
  let tmpRoot: string;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = mkdtempSync(join(tmpdir(), "cloudnua-post-integration-"));

    process.env = {
      ...ORIGINAL_ENV,
      GITHUB_WORKSPACE: tmpRoot,
      GITHUB_SHA: "abc123",
      GITHUB_TOKEN: "ghs_fake",
      GITHUB_REPOSITORY: "cloudnua/test-fixture",
      GITHUB_REF: "refs/pull/1/merge",
      RUNNER_TEMP: tmpRoot,
    };

    coreMocks.getInput.mockImplementation((name: string) => {
      switch (name) {
        case "api-token":
          return "tok_fake";
        case "api-url":
          return "https://app.cloudnua.com";
        case "allow-http":
          return "false";
        case "github-token":
          return "";
        case "fail-on-violation":
          return "true";
        case "policy-types":
          return "";
        default:
          return "";
      }
    });
    coreMocks.getState.mockImplementation((name: string) =>
      name === "scan-only" ? "true" : "",
    );

    evaluateMock.mockResolvedValue({
      violations: [],
      errors: [],
      summary: {
        total_violations: 0,
        block_count: 0,
        warn_count: 0,
        log_count: 0,
        has_mcp_policies: false,
      },
    });
    fetchPackageIntelligenceMock.mockResolvedValue(null);
    checkRunMocks.createCheckRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tmpRoot, { recursive: true, force: true });
    process.env = ORIGINAL_ENV;
  });

  it("walks a real workspace, parses real manifests, and forwards real dependencies to the API", async () => {
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({
        name: "fixture",
        dependencies: { lodash: "4.17.21", express: "4.19.0" },
      }),
    );
    writeFileSync(
      join(tmpRoot, "requirements.txt"),
      "requests==2.31.0\nflask>=3.0.0\n",
    );
    // Should be skipped by SKIP_DIRS — nested manifest must NOT leak into the scan.
    mkdirSync(join(tmpRoot, "node_modules", "lodash"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "node_modules", "lodash", "package.json"),
      JSON.stringify({ name: "lodash", version: "4.17.21" }),
    );

    const { runPostStep } = await import("@/post");
    await runPostStep();

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const manifestArg = evaluateMock.mock.calls[0]?.[0] as {
      dependencies: Array<{ name: string; version: string }>;
      file_paths: string[];
    };

    const depNames = manifestArg.dependencies.map((d) => d.name).sort();
    expect(depNames).toEqual(["express", "flask", "lodash", "requests"]);

    expect(manifestArg.file_paths).toContain("package.json");
    expect(manifestArg.file_paths).toContain("requirements.txt");
    // Skip-dir guard: vendored manifest must NOT appear.
    expect(
      manifestArg.file_paths.some((p) => p.startsWith("node_modules/")),
    ).toBe(false);
  });

  it("returns early without calling the API when the workspace has no manifests", async () => {
    writeFileSync(join(tmpRoot, "README.md"), "# nothing to scan\n");

    const { runPostStep } = await import("@/post");
    await runPostStep();

    expect(evaluateMock).not.toHaveBeenCalled();
    expect(checkRunMocks.createCheckRun).not.toHaveBeenCalled();
  });
});
