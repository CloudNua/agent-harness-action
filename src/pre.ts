import * as core from "@actions/core";
import { writeFileSync } from "fs";
import { join } from "path";
import { snapshotWorkspace } from "./utils/workspace";
import { logger } from "./utils/logger";
import { runStep } from "./utils/run";

runStep("Pre-execution", async () => {
  logger.info("Pre-execution step starting");

  // Mask the API token early so it never leaks in logs
  const apiToken = core.getInput("api-token", { required: true });
  core.setSecret(apiToken);

  // Snapshot workspace — write to temp file to avoid state size limits
  const snapshot = await snapshotWorkspace();
  const snapshotPath = join(
    process.env.RUNNER_TEMP ?? "/tmp",
    "cloudnua-snapshot.json",
  );
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  core.saveState("workspace-snapshot-path", snapshotPath);

  logger.info("Pre-execution step complete");
});
