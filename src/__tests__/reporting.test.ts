import { describe, it, expect, vi } from "vitest";
import {
  determineConclusion,
  buildSummary,
  buildAnnotations,
  escapeMarkdown,
} from "@/reporting/check-run";
import { buildTelemetry, writeTelemetryFile } from "@/reporting/telemetry";
import { emptyScanResult } from "@/scanner/index";
import type { ScanResult, Violation } from "@/scanner/index";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock @actions/core and @actions/github
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "CloudNua", repo: "test-repo" },
    ref: "refs/heads/main",
    sha: "abc123def456",
    workflow: "CI",
    runId: 12345,
  },
  getOctokit: vi.fn(),
}));

function makeResult(violations: Violation[], evaluationErrors: string[] = []): ScanResult {
  return {
    violations,
    evaluationErrors,
    summary: {
      totalDependencies: 10,
      totalViolations: violations.length,
      blockCount: violations.filter((v) => v.policyAction === "block").length,
      requireApprovalCount: violations.filter((v) => v.policyAction === "require_approval").length,
      warnCount: violations.filter((v) => v.policyAction === "warn").length,
      logCount: violations.filter((v) => v.policyAction === "log").length,
      packageIntelligenceMatches: 0,
    },
  };
}

const blockViolation: Violation = {
  policyId: "p1",
  policyType: "dependency",
  policyAction: "block",
  filePath: "package.json",
  dependency: "lodash",
  message: 'Blocked dependency "lodash" found',
};

const warnViolation: Violation = {
  policyId: "p2",
  policyType: "mcp",
  policyAction: "warn",
  filePath: "package.json",
  dependency: "mcp-server-github",
  message: 'MCP-related package "mcp-server-github" detected',
};

const logViolation: Violation = {
  policyId: "p3",
  policyType: "compliance",
  policyAction: "log",
  filePath: "package.json",
  dependency: null,
  message: "Total dependencies exceeds limit",
};

describe("determineConclusion", () => {
  it("returns failure when block violations exist", () => {
    expect(determineConclusion(makeResult([blockViolation]))).toBe("failure");
  });

  it("returns neutral when only warn violations", () => {
    expect(determineConclusion(makeResult([warnViolation]))).toBe("neutral");
  });

  it("returns success when only log violations", () => {
    expect(determineConclusion(makeResult([logViolation]))).toBe("success");
  });

  it("returns success when no violations", () => {
    expect(determineConclusion(makeResult([]))).toBe("success");
  });

  it("returns failure when mixed block + warn", () => {
    expect(
      determineConclusion(makeResult([blockViolation, warnViolation])),
    ).toBe("failure");
  });
});

describe("buildSummary", () => {
  it("shows clean message when no violations", () => {
    const summary = buildSummary(makeResult([]));
    expect(summary).toContain("No policy violations found");
  });

  it("includes violation table and details", () => {
    const summary = buildSummary(makeResult([blockViolation, warnViolation]));
    expect(summary).toContain("Policy Scan Results");
    expect(summary).toContain("| Block | 1 |");
    expect(summary).toContain("| Warn | 1 |");
    expect(summary).toContain("**package.json**");
    expect(summary).toContain("lodash");
  });

  it("shows evaluation errors when no violations (escaped)", () => {
    const summary = buildSummary(makeResult([], [
      'policy "p1": unknown field',
      "[click here](http://evil.com)",
    ]));
    expect(summary).toContain("No policy violations found");
    expect(summary).toContain("Evaluation Errors");
    // Plain text passes through
    expect(summary).toContain('policy "p1"');
    // Markdown link syntax is escaped
    expect(summary).not.toContain("[click here](http://evil.com)");
    expect(summary).toContain("\\[click here\\]\\(http://evil.com\\)");
  });

  it("shows evaluation errors alongside violations", () => {
    const summary = buildSummary(makeResult([blockViolation], ["engine timeout"]));
    expect(summary).toContain("Policy Scan Results");
    expect(summary).toContain("Evaluation Errors");
    // "engine timeout" has no markdown special chars, so it passes through unchanged
    expect(summary).toContain("engine timeout");
  });
});

describe("escapeMarkdown", () => {
  it("escapes markdown special characters", () => {
    expect(escapeMarkdown("[link](http://evil.com)")).toBe(
      "\\[link\\]\\(http://evil.com\\)",
    );
  });

  it("passes through plain text unchanged", () => {
    expect(escapeMarkdown("engine timeout")).toBe("engine timeout");
  });
});

describe("buildAnnotations", () => {
  it("maps block violations to failure annotations", () => {
    const annotations = buildAnnotations([blockViolation]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].annotation_level).toBe("failure");
    expect(annotations[0].path).toBe("package.json");
  });

  it("maps warn violations to warning annotations", () => {
    const annotations = buildAnnotations([warnViolation]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].annotation_level).toBe("warning");
  });

  it("excludes log violations from annotations", () => {
    const annotations = buildAnnotations([logViolation]);
    expect(annotations).toHaveLength(0);
  });

  it("handles mixed violations", () => {
    const annotations = buildAnnotations([
      blockViolation,
      warnViolation,
      logViolation,
    ]);
    expect(annotations).toHaveLength(2);
  });
});

describe("buildTelemetry", () => {
  it("builds telemetry payload with scan results", () => {
    const result = makeResult([blockViolation]);
    const telemetry = buildTelemetry(result, 0);

    expect(telemetry.repository).toBe("CloudNua/test-repo");
    expect(telemetry.sha).toBe("abc123def456");
    expect(telemetry.agentExitCode).toBe(0);
    expect(telemetry.scan.totalViolations).toBe(1);
    expect(telemetry.violations).toHaveLength(1);
    expect(telemetry.violations[0].dependency).toBe("lodash");
    expect(telemetry.firewallRoutingActive).toBe(false);
    expect(telemetry.firewallOrigin).toBeUndefined();
  });

  it("includes non-zero agent exit code", () => {
    const telemetry = buildTelemetry(makeResult([]), 1);
    expect(telemetry.agentExitCode).toBe(1);
  });

  it("includes firewall origin (redacted) when firewall-url is set", () => {
    const telemetry = buildTelemetry(
      makeResult([]),
      0,
      "https://firewall.example.com/v1/proxy?token=secret",
    );
    expect(telemetry.firewallRoutingActive).toBe(true);
    // Only origin is stored — path and query stripped
    expect(telemetry.firewallOrigin).toBe("https://firewall.example.com");
  });

  it("omits firewallOrigin when not provided", () => {
    const telemetry = buildTelemetry(makeResult([]), 0);
    expect(telemetry.firewallRoutingActive).toBe(false);
    expect("firewallOrigin" in telemetry).toBe(false);
  });
});

describe("writeTelemetryFile", () => {
  it("writes JSON file to .cloudnua directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
    const telemetry = buildTelemetry(makeResult([blockViolation]), 0);

    const outputPath = writeTelemetryFile(telemetry, tmpDir);

    expect(existsSync(outputPath)).toBe(true);
    expect(outputPath).toContain(".cloudnua/scan-result.json");

    const written = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(written.repository).toBe("CloudNua/test-repo");
    expect(written.violations).toHaveLength(1);
  });

  it("creates .cloudnua directory if missing", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
    const cloudnuaDir = join(tmpDir, ".cloudnua");

    expect(existsSync(cloudnuaDir)).toBe(false);

    writeTelemetryFile(buildTelemetry(makeResult([]), 0), tmpDir);

    expect(existsSync(cloudnuaDir)).toBe(true);
  });

  it("persists firewall metadata to disk", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "telemetry-fw-"));
    const telemetry = buildTelemetry(
      makeResult([]),
      0,
      "https://firewall.example.com/v1/proxy",
    );
    const outputPath = writeTelemetryFile(telemetry, tmpDir);
    const written = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(written.firewallRoutingActive).toBe(true);
    expect(written.firewallOrigin).toBe("https://firewall.example.com");
  });
});
