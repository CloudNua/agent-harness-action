import * as core from "@actions/core";

export function runStep(name: string, fn: () => Promise<void>): void {
  fn().catch((error) => {
    core.setFailed(
      error instanceof Error ? error.message : `${name} failed`,
    );
  });
}
