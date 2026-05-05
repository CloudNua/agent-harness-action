import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScanResult } from "@/scanner/index";
import type { ManifestResult } from "@/scanner/manifests";

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

const workspaceMocks = vi.hoisted(() => ({
  snapshotWorkspace: vi.fn<() => Promise<unknown>>(),
  diffSnapshots: vi.fn<(...args: unknown[]) => unknown[]>(),
}));

const scannerMocks = vi.hoisted(() => ({
  scanChanges: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

const manifestsMocks = vi.hoisted(() => ({
  parseWorkspaceManifests: vi.fn<(workspaceDir: string) => unknown[]>(),
}));

const pkgIntelMocks = vi.hoisted(() => ({
  matchPackageIntelligence: vi.fn<(...args: unknown[]) => unknown[]>(),
  deduplicateViolations: vi.fn<(...args: unknown[]) => unknown[]>(),
}));

const checkRunMocks = vi.hoisted(() => ({
  createCheckRun: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

const telemetryMocks = vi.hoisted(() => ({
  buildTelemetry: vi.fn<(...args: unknown[]) => unknown>(),
  writeTelemetryFile: vi.fn<(...args: unknown[]) => void>(),
}));

const clientMocks = vi.hoisted(() => ({
  fetchPackageIntelligence: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@actions/core", () => coreMocks);
vi.mock("@/utils/workspace", () => workspaceMocks);
vi.mock("@/scanner", () => scannerMocks);
vi.mock("@/scanner/manifests", () => manifestsMocks);
vi.mock("@/scanner/package-intelligence", () => pkgIntelMocks);
vi.mock("@/reporting/check-run", () => checkRunMocks);
vi.mock("@/reporting/telemetry", () => telemetryMocks);
vi.mock("@/api/client", () => ({
  CloudNuaClient: vi.fn().mockImplementation(() => ({
    fetchPackageIntelligence: clientMocks.fetchPackageIntelligence,
  })),
}));

function emptyResult(): ScanResult {
  return {
    violations: [],
    evaluationErrors: [],
    summary: {
      totalDependencies: 0,
      totalViolations: 0,
      blockCount: 0,
      requireApprovalCount: 0,
      warnCount: 0,
      logCount: 0,
      packageIntelligenceMatches: 0,
    },
  };
}

describe("runPostStep", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      GITHUB_WORKSPACE: "/tmp/workspace",
      GITHUB_SHA: "abc123",
      GITHUB_TOKEN: "ghs_fake",
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
    coreMocks.getState.mockReturnValue("");
    scannerMocks.scanChanges.mockResolvedValue(emptyResult());
    pkgIntelMocks.matchPackageIntelligence.mockReturnValue([]);
    pkgIntelMocks.deduplicateViolations.mockImplementation((a) => a as unknown[]);
    clientMocks.fetchPackageIntelligence.mockResolvedValue(null);
    checkRunMocks.createCheckRun.mockResolvedValue(undefined);
    telemetryMocks.buildTelemetry.mockReturnValue({});
  });

  afterEach(() => {
    vi.resetModules();
    process.env = ORIGINAL_ENV;
  });

  describe("scan-only mode", () => {
    beforeEach(() => {
      coreMocks.getState.mockImplementation((name: string) =>
        name === "scan-only" ? "true" : "",
      );
    });

    it("walks workspace for manifests and scans them when scan-only state is set", async () => {
      const manifests: ManifestResult[] = [
        {
          filePath: "package.json",
          ecosystem: "npm",
          dependencies: [
            { name: "lodash", version: "4.17.21", ecosystem: "npm", filePath: "package.json" },
          ],
        },
      ];
      manifestsMocks.parseWorkspaceManifests.mockReturnValue(manifests);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(manifestsMocks.parseWorkspaceManifests).toHaveBeenCalledWith(
        "/tmp/workspace",
      );
      expect(scannerMocks.scanChanges).toHaveBeenCalledWith(
        [{ path: "package.json", status: "added" }],
        "/tmp/workspace",
        expect.anything(),
        manifests,
      );
      expect(workspaceMocks.snapshotWorkspace).not.toHaveBeenCalled();
      expect(workspaceMocks.diffSnapshots).not.toHaveBeenCalled();
    });

    it("does not re-parse manifests for package intelligence (PERF-H1: single workspace walk)", async () => {
      manifestsMocks.parseWorkspaceManifests.mockReturnValue([
        {
          filePath: "package.json",
          ecosystem: "npm",
          dependencies: [],
        },
      ]);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      // parseWorkspaceManifests must be called exactly once: in the scan-only
      // branch. The pkg-intel branch must reuse that result, not re-walk.
      expect(manifestsMocks.parseWorkspaceManifests).toHaveBeenCalledTimes(1);
    });

    it("creates a Check Run in scan-only mode (regression: must not silently no-op)", async () => {
      manifestsMocks.parseWorkspaceManifests.mockReturnValue([
        {
          filePath: "package.json",
          ecosystem: "npm",
          dependencies: [],
        },
      ]);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(checkRunMocks.createCheckRun).toHaveBeenCalledWith(
        expect.any(Object),
        "abc123",
        "ghs_fake",
      );
    });

    it("writes telemetry artifact in scan-only mode", async () => {
      manifestsMocks.parseWorkspaceManifests.mockReturnValue([
        {
          filePath: "package.json",
          ecosystem: "npm",
          dependencies: [],
        },
      ]);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(telemetryMocks.writeTelemetryFile).toHaveBeenCalled();
    });

    it("returns early when no manifest files are found in workspace", async () => {
      manifestsMocks.parseWorkspaceManifests.mockReturnValue([]);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(scannerMocks.scanChanges).not.toHaveBeenCalled();
      expect(checkRunMocks.createCheckRun).not.toHaveBeenCalled();
      expect(telemetryMocks.writeTelemetryFile).not.toHaveBeenCalled();
    });

    it("fails the action when blocking violations are present in scan-only mode", async () => {
      manifestsMocks.parseWorkspaceManifests.mockReturnValue([
        {
          filePath: "package.json",
          ecosystem: "npm",
          dependencies: [],
        },
      ]);
      const result = emptyResult();
      result.summary.blockCount = 1;
      result.summary.totalViolations = 1;
      scannerMocks.scanChanges.mockResolvedValue(result);

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(coreMocks.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("blocking/require-approval"),
      );
    });
  });

  describe("agent-wrap mode (existing behavior)", () => {
    it("returns early when no snapshot path is saved", async () => {
      coreMocks.getState.mockImplementation((name: string) => {
        if (name === "scan-only") return "";
        if (name === "workspace-snapshot-path") return "";
        return "";
      });

      const { runPostStep } = await import("@/post");
      await runPostStep();

      expect(coreMocks.warning).toHaveBeenCalledWith(
        expect.stringContaining("No saved state from pre step"),
      );
      expect(scannerMocks.scanChanges).not.toHaveBeenCalled();
      expect(manifestsMocks.parseWorkspaceManifests).not.toHaveBeenCalled();
    });
  });
});
