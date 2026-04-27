import * as core from "@actions/core";
import { readFileSync } from "fs";
import { snapshotWorkspace, diffSnapshots } from "./utils/workspace";
import { scanChanges } from "./scanner";
import { parseWorkspaceManifests } from "./scanner/manifests";
import {
  matchPackageIntelligence,
  deduplicateViolations,
} from "./scanner/package-intelligence";
import { createCheckRun } from "./reporting/check-run";
import { buildTelemetry, writeTelemetryFile } from "./reporting/telemetry";
import { logger } from "./utils/logger";
import { runStep } from "./utils/run";
import { CloudNuaClient } from "./api/client";
import { STATE_FIREWALL_URL, STATE_AGENT_EXIT_CODE } from "./utils/constants";
import type { FileSnapshot } from "./utils/workspace";

runStep("Post-execution", async () => {
  logger.info("Post-execution step starting");

  // 1. Load saved state from pre step
  const snapshotPath = core.getState("workspace-snapshot-path");

  if (!snapshotPath) {
    logger.warning("No saved state from pre step — skipping post-execution scan");
    return;
  }

  const beforeSnapshot: FileSnapshot = JSON.parse(
    readFileSync(snapshotPath, "utf-8"),
  );

  // 2. Take post-execution snapshot and diff
  const afterSnapshot = await snapshotWorkspace();
  const changes = diffSnapshots(beforeSnapshot, afterSnapshot);

  if (changes.length === 0) {
    logger.info("No file changes detected — nothing to scan");
    return;
  }

  logger.info(`${changes.length} files changed by agent`);
  for (const change of changes) {
    core.debug(`  ${change.status}: ${change.path}`);
  }

  // 3. Warn if deprecated policy-types input is set
  const policyTypes = core.getInput("policy-types");
  if (policyTypes && policyTypes !== "all") {
    logger.warning(
      "policy-types input is deprecated and currently ignored — policy filtering is handled server-side",
    );
  }

  // 4. Scan changes — CloudNua control plane resolves policies server-side
  const apiToken = core.getInput("api-token", { required: true });
  core.setSecret(apiToken);
  const apiUrl = core.getInput("api-url") || "https://app.cloudnua.com";
  const allowHttp = core.getInput("allow-http") === "true";
  const client = new CloudNuaClient(apiToken, apiUrl, { allowHttp });

  const workspaceDir = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const result = await scanChanges(changes, workspaceDir, client);

  // 4b. Package intelligence matching (client-side, Pro tier only)
  try {
    const packageIntelligence = await client.fetchPackageIntelligence();
    const manifests = parseWorkspaceManifests(workspaceDir);
    const allDeps = manifests.flatMap((m) => m.dependencies);
    const pkgIntelMatches = matchPackageIntelligence(
      allDeps,
      packageIntelligence ?? undefined,
    );

    if (pkgIntelMatches.length > 0) {
      result.violations = deduplicateViolations(
        result.violations,
        pkgIntelMatches,
      );
      result.summary.packageIntelligenceMatches = pkgIntelMatches.length;

      // Recount after deduplication
      let blockCount = 0;
      let requireApprovalCount = 0;
      let warnCount = 0;
      let logCount = 0;
      for (const v of result.violations) {
        switch (v.policyAction) {
          case "block": blockCount++; break;
          case "require_approval": requireApprovalCount++; break;
          case "warn": warnCount++; break;
          case "log": logCount++; break;
        }
      }
      result.summary.totalViolations = result.violations.length;
      result.summary.blockCount = blockCount;
      result.summary.requireApprovalCount = requireApprovalCount;
      result.summary.warnCount = warnCount;
      result.summary.logCount = logCount;
    }
  } catch (error) {
    logger.warning(
      `Package intelligence fetch failed (non-fatal): ${error instanceof Error ? error.message : error}`,
    );
  }

  logger.info(
    `Scan complete: ${result.summary.totalViolations} violations ` +
      `(${result.summary.blockCount} block, ${result.summary.requireApprovalCount} require_approval, ` +
      `${result.summary.warnCount} warn, ${result.summary.logCount} log)`,
  );

  // 5. Post Check Run
  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
  if (token) {
    core.setSecret(token);
    try {
      const headSha = process.env.GITHUB_SHA ?? "";
      await createCheckRun(result, headSha, token);
    } catch (error) {
      logger.warning(
        `Failed to create Check Run: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else {
    logger.warning("GITHUB_TOKEN not available — skipping Check Run");
  }

  // 6. Write telemetry artifact
  const agentExitCode = parseInt(core.getState(STATE_AGENT_EXIT_CODE) || "0", 10);
  const firewallUrl = core.getState(STATE_FIREWALL_URL);
  const telemetry = buildTelemetry(result, agentExitCode, firewallUrl || undefined);
  writeTelemetryFile(telemetry, workspaceDir);

  // 7. Fail the action if blocking violations found
  const failOnViolation = core.getInput("fail-on-violation") === "true";
  const failCount = result.summary.blockCount + result.summary.requireApprovalCount;
  if (failOnViolation && failCount > 0) {
    core.setFailed(
      `${failCount} blocking/require-approval policy violation(s) found`,
    );
  }

  logger.info("Post-execution step complete");
});
