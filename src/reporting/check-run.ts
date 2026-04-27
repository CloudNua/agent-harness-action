import * as github from "@actions/github";
import { logger } from "@/utils/logger";
import type { ScanResult, Violation } from "@/scanner/index";

const CHECK_RUN_NAME = "CloudNua Agent Harness";
const MAX_ANNOTATIONS_PER_BATCH = 50;

type Conclusion = "success" | "failure" | "neutral";

function escapeMarkdown(text: string): string {
  return text.replace(/[[\](){}*_~`#>+\-=|!\\]/g, "\\$&");
}

function determineConclusion(result: ScanResult): Conclusion {
  if (result.summary.blockCount > 0) return "failure";
  if (result.summary.requireApprovalCount > 0) return "failure";
  if (result.summary.warnCount > 0) return "neutral";
  return "success";
}

function buildSummary(result: ScanResult): string {
  const { summary } = result;
  const lines: string[] = [];

  if (summary.totalViolations === 0) {
    lines.push(
      `**No policy violations found.**\n\nScanned ${summary.totalDependencies} dependencies.`,
    );
    if (result.evaluationErrors.length > 0) {
      lines.push("\n### Evaluation Errors\n");
      for (const err of result.evaluationErrors) {
        lines.push(`- ⚠️ ${escapeMarkdown(err)}`);
      }
    }
    return lines.join("\n");
  }

  lines.push("## Policy Scan Results\n");
  lines.push(
    `| Severity | Count |`,
    `| --- | --- |`,
    `| Block | ${summary.blockCount} |`,
    `| Require Approval | ${summary.requireApprovalCount} |`,
    `| Warn | ${summary.warnCount} |`,
    `| Log | ${summary.logCount} |`,
    `| **Total** | **${summary.totalViolations}** |`,
  );
  lines.push(`\nScanned ${summary.totalDependencies} dependencies.`);
  if (summary.packageIntelligenceMatches > 0) {
    lines.push(
      `Package intelligence matched ${summary.packageIntelligenceMatches} dependencies.\n`,
    );
  } else {
    lines.push("");
  }

  // Group violations by file
  const byFile = new Map<string, Violation[]>();
  for (const v of result.violations) {
    const existing = byFile.get(v.filePath) ?? [];
    existing.push(v);
    byFile.set(v.filePath, existing);
  }

  lines.push("### Violations\n");
  for (const [file, violations] of byFile) {
    lines.push(`**${file}**`);
    for (const v of violations) {
      const icon =
        v.policyAction === "block"
          ? "🚫"
          : v.policyAction === "require_approval"
            ? "🔍"
            : v.policyAction === "warn"
              ? "⚠️"
              : "ℹ️";
      lines.push(`- ${icon} ${v.message}`);
    }
    lines.push("");
  }

  if (result.evaluationErrors.length > 0) {
    lines.push("### Evaluation Errors\n");
    for (const err of result.evaluationErrors) {
      lines.push(`- ⚠️ ${escapeMarkdown(err)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildAnnotations(
  violations: Violation[],
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
  title: string;
}> {
  return violations
    .filter((v) => v.policyAction !== "log")
    .map((v) => {
      const level =
        v.policyAction === "block" || v.policyAction === "require_approval"
          ? ("failure" as const)
          : ("warning" as const);

      const title =
        v.policyAction === "require_approval"
          ? `⚠ Review required: ${v.dependency ?? "project"} — suspicious signals detected`
          : `${v.policyType} policy: ${v.dependency ?? "project"}`;

      return {
        path: v.filePath,
        start_line: 1,
        end_line: 1,
        annotation_level: level,
        message: v.message,
        title,
      };
    });
}

export async function createCheckRun(
  result: ScanResult,
  headSha: string,
  token: string,
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const conclusion = determineConclusion(result);
  const summary = buildSummary(result);
  const annotations = buildAnnotations(result.violations);

  logger.info(
    `Creating Check Run: conclusion=${conclusion}, annotations=${annotations.length}`,
  );

  // Create the check run with the first batch of annotations
  const firstBatch = annotations.slice(0, MAX_ANNOTATIONS_PER_BATCH);
  const { data: checkRun } = await octokit.rest.checks.create({
    owner,
    repo,
    name: CHECK_RUN_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: {
      title:
        result.summary.totalViolations === 0
          ? "No policy violations"
          : `${result.summary.totalViolations} policy violation(s)`,
      summary,
      annotations: firstBatch,
    },
  });

  // Send remaining annotations in batches
  const remainingBatches: Array<typeof firstBatch> = [];
  for (let i = MAX_ANNOTATIONS_PER_BATCH; i < annotations.length; i += MAX_ANNOTATIONS_PER_BATCH) {
    remainingBatches.push(annotations.slice(i, i + MAX_ANNOTATIONS_PER_BATCH));
  }

  // Send remaining batches sequentially to avoid race conditions on the same check run
  for (const batch of remainingBatches) {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRun.id,
      output: {
        title:
          result.summary.totalViolations === 0
            ? "No policy violations"
            : `${result.summary.totalViolations} policy violation(s)`,
        summary,
        annotations: batch,
      },
    });
  }

  logger.info(`Check Run created: ${checkRun.html_url}`);
}

// Exported for testing
export { determineConclusion, buildSummary, buildAnnotations, escapeMarkdown };
