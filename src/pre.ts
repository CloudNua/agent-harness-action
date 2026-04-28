import * as core from "@actions/core";
import { logger } from "./utils/logger";
import { runStep } from "./utils/run";

runStep("Pre-execution", async () => {
  logger.info("Pre-execution step starting");

  // Mask secrets early so they never leak in logs from any subsequent step.
  // Workspace snapshotting must happen in main (after actions/checkout has run),
  // because pre: hooks fire before earlier steps' main: phases complete.
  const apiToken = core.getInput("api-token", { required: true });
  core.setSecret(apiToken);

  const cfAccessClientSecret = core.getInput("cf-access-client-secret");
  if (cfAccessClientSecret) {
    core.setSecret(cfAccessClientSecret);
  }

  logger.info("Pre-execution step complete");
});
