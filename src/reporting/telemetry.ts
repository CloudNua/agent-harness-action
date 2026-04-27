import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import * as github from "@actions/github";
import { logger } from "@/utils/logger";
import type { ScanResult } from "@/scanner/index";

export interface TelemetryPayload {
  timestamp: string;
  repository: string;
  ref: string;
  sha: string;
  workflow: string;
  runId: number;
  agentExitCode: number;
  firewallRoutingActive: boolean;
  firewallOrigin?: string;
  scan: {
    totalDependencies: number;
    totalViolations: number;
    blockCount: number;
    requireApprovalCount: number;
    warnCount: number;
    logCount: number;
    packageIntelligenceMatches: number;
  };
  violations: Array<{
    policyId: string;
    policyType: string;
    policyAction: string;
    filePath: string;
    dependency: string | null;
  }>;
}

export function buildTelemetry(
  result: ScanResult,
  agentExitCode: number,
  firewallUrl?: string,
): TelemetryPayload {
  const ctx = github.context;

  // Redact firewall URL to origin only (scheme + host) to avoid leaking
  // internal paths or query-string tokens in the telemetry artifact
  let firewallOrigin: string | undefined;
  if (firewallUrl) {
    try {
      firewallOrigin = new URL(firewallUrl).origin;
    } catch {
      // Should not happen — URL was already validated at input time
      firewallOrigin = undefined;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
    ref: ctx.ref,
    sha: ctx.sha,
    workflow: ctx.workflow,
    runId: ctx.runId,
    agentExitCode,
    firewallRoutingActive: !!firewallUrl,
    ...(firewallOrigin ? { firewallOrigin } : {}),
    scan: result.summary,
    violations: result.violations.map((v) => ({
      policyId: v.policyId,
      policyType: v.policyType,
      policyAction: v.policyAction,
      filePath: v.filePath,
      dependency: v.dependency,
    })),
  };
}

export function writeTelemetryFile(
  payload: TelemetryPayload,
  workspaceDir: string,
): string {
  const outputDir = join(workspaceDir, ".cloudnua");
  const outputPath = join(outputDir, "scan-result.json");

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  logger.info(`Telemetry written to ${outputPath}`);
  return outputPath;
}
