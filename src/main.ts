import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { writeFileSync } from "fs";
import { join } from "path";
import { snapshotWorkspace } from "./utils/workspace";
import { logger } from "./utils/logger";
import { runStep } from "./utils/run";
import { validateFirewallUrl } from "./utils/firewall";
import { STATE_FIREWALL_URL, STATE_AGENT_EXIT_CODE } from "./utils/constants";

runStep("Agent execution", async () => {
  logger.info("Agent execution step starting");

  const agentCommand = core.getInput("agent-command", { required: true });

  if (!agentCommand.trim()) {
    throw new Error("agent-command input must not be empty");
  }

  // Snapshot workspace before agent runs. Done in main (not pre) because
  // pre: hooks fire before the consumer's actions/checkout main: completes —
  // the workspace would have no .git directory yet.
  const snapshot = await snapshotWorkspace();
  const snapshotPath = join(
    process.env.RUNNER_TEMP ?? "/tmp",
    "cloudnua-snapshot.json",
  );
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  core.saveState("workspace-snapshot-path", snapshotPath);

  // Validate and resolve firewall-url if provided
  const firewallUrlInput = core.getInput("firewall-url");
  const allowHttp = core.getInput("allow-http") === "true";
  const firewallUrl = validateFirewallUrl(firewallUrlInput, allowHttp);

  if (firewallUrl) {
    const hostname = new URL(firewallUrl).hostname;
    logger.info(`Firewall routing active: ${hostname}`);
    core.saveState(STATE_FIREWALL_URL, firewallUrl);
  }

  logger.info(`Executing agent command: ${agentCommand}`);

  // Filter out all INPUT_* env vars to avoid leaking action inputs
  // (api-token, firewall-url, etc.) to the agent subprocess.
  // GITHUB_TOKEN is expected to be available via the standard env var.
  const filteredEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("INPUT_"),
    ),
  );

  const agentEnv: Record<string, string> = {
    ...filteredEnv,
    CLOUDNUA_HARNESS: "true",
  } as Record<string, string>;

  if (firewallUrl) {
    agentEnv.CLOUDNUA_FIREWALL_URL = firewallUrl;
  }

  // This intentionally uses shell execution because the agent-command input
  // may contain pipes, redirects, or other shell features (e.g., "copilot-cli suggest | tee output.log").
  // The command is authored by the workflow maintainer (trusted), not by external users.
  // @actions/exec passes arguments as an array to the shell binary (no injection from args).
  const exitCode = await exec.exec("bash", ["-c", agentCommand], {
    ignoreReturnCode: true,
    env: agentEnv,
  });

  if (exitCode !== 0) {
    logger.warning(`Agent command exited with code ${exitCode}`);
    core.saveState(STATE_AGENT_EXIT_CODE, String(exitCode));
  } else {
    core.saveState(STATE_AGENT_EXIT_CODE, "0");
  }

  logger.info("Agent execution step complete");
});
