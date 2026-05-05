import * as core from "@actions/core";
import { logger } from "./utils/logger";
import { runStep } from "./utils/run";

// Contributor note: if logic here grows beyond ~20 lines or branches on inputs,
// refactor to `export async function runPreStep()` + `require.main === module`
// guard, matching main.ts / post.ts so it can be unit-tested. The current body
// is small enough that an inline IIFE-style call is acceptable.
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
