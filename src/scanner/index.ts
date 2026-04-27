import { parseChangedManifests } from "./manifests";
import { logger } from "@/utils/logger";
import { CloudNuaClient } from "@/api/client";
import type { EvaluateManifest } from "@/types/policy";
import type { ChangedFile } from "@/utils/workspace";
import type { EvaluationViolation } from "@/types/policy";

export type { ManifestResult, ParsedDependency } from "./manifests";

export interface Violation {
  policyId: string;
  policyType: string;
  policyAction: string;
  filePath: string;
  dependency: string | null;
  message: string;
}

export interface ScanResult {
  violations: Violation[];
  evaluationErrors: string[];
  summary: {
    totalDependencies: number;
    totalViolations: number;
    blockCount: number;
    requireApprovalCount: number;
    warnCount: number;
    logCount: number;
    packageIntelligenceMatches: number;
  };
}

export function emptyScanResult(): ScanResult {
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

/**
 * Scan changed files by parsing manifests locally and delegating
 * policy evaluation to the CloudNua policy API via the control-plane proxy.
 *
 * Policies are resolved server-side by the CloudNua control plane — the client
 * sends only the manifest.
 */
export async function scanChanges(
  changedFiles: ChangedFile[],
  workspaceDir: string,
  client: CloudNuaClient,
): Promise<ScanResult> {
  const manifests = parseChangedManifests(changedFiles, workspaceDir);

  if (manifests.length === 0) {
    logger.info("No manifest files among changed files — no policy violations");
    return emptyScanResult();
  }

  const allDeps = manifests.flatMap((m) => m.dependencies);

  logger.info(
    `Scanning ${manifests.length} manifest files (${allDeps.length} dependencies)`,
  );

  // Build manifest in CloudNua policy API format
  const manifest: EvaluateManifest = {
    dependencies: allDeps.map((d) => ({
      name: d.name,
      version: d.version ?? "",
      license: "",
      deprecated: false,
    })),
    mcp_tools: [],
    file_paths: changedFiles.map((f) => f.path),
  };

  const response = await client.evaluate(manifest);

  // Warn if MCP policies exist but no MCP tools were provided
  if (response.summary?.has_mcp_policies) {
    logger.warning(
      "MCP policies active but no MCP tools detected — MCP scanning is not yet implemented in the agent harness",
    );
  }

  const evaluationErrors: string[] = [];
  if (response.errors && response.errors.length > 0) {
    for (const err of response.errors) {
      logger.warning(`Evaluation error: ${err}`);
      evaluationErrors.push(err);
    }
  }

  // Map policy API violations to local format using granular fields
  const defaultFilePath = manifests[0]?.filePath ?? "project";
  const violations = response.violations.map(
    (v: EvaluationViolation): Violation => ({
      policyId: v.policy_id,
      policyType: v.policy_type,
      policyAction: v.action.toLowerCase(),
      filePath:
        v.file_path && isSafePath(v.file_path) ? v.file_path : defaultFilePath,
      dependency: v.dependency_name || null,
      message: v.message,
    }),
  );

  const summary = response.summary
    ? {
        totalDependencies: allDeps.length,
        totalViolations: response.summary.total_violations,
        blockCount: response.summary.block_count,
        requireApprovalCount: 0,
        warnCount: response.summary.warn_count,
        logCount: response.summary.log_count,
        packageIntelligenceMatches: 0,
      }
    : {
        totalDependencies: allDeps.length,
        totalViolations: violations.length,
        ...countViolations(violations),
        packageIntelligenceMatches: 0,
      };

  return {
    violations,
    evaluationErrors,
    summary,
  };
}

function isSafePath(p: string): boolean {
  return !p.startsWith("/") && !p.includes("..") && !p.startsWith("\\");
}

function countViolations(violations: Violation[]) {
  let blockCount = 0;
  let requireApprovalCount = 0;
  let warnCount = 0;
  let logCount = 0;
  for (const v of violations) {
    switch (v.policyAction) {
      case "block":
        blockCount++;
        break;
      case "require_approval":
        requireApprovalCount++;
        break;
      case "warn":
        warnCount++;
        break;
      case "log":
        logCount++;
        break;
    }
  }
  return { blockCount, requireApprovalCount, warnCount, logCount };
}
