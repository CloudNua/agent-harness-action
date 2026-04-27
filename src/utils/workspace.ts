import * as exec from "@actions/exec";
import { logger } from "./logger";

export interface FileSnapshot {
  /** Map of relative file path -> git object hash (or "untracked") */
  files: Record<string, string>;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/**
 * Snapshot the current workspace state using git ls-files and status.
 * Uses @actions/exec which passes arguments as an array (no shell injection).
 */
export async function snapshotWorkspace(): Promise<FileSnapshot> {
  const files: Record<string, string> = {};

  // Get tracked files with their hashes
  let trackedOutput = "";
  await exec.exec("git", ["ls-files", "--stage"], {
    silent: true,
    listeners: {
      stdout: (data) => {
        trackedOutput += data.toString();
      },
    },
  });

  for (const line of trackedOutput.split("\n")) {
    if (!line.trim()) continue;
    // Format: <mode> <hash> <stage>\t<path>
    const match = line.match(/^\d+\s+([a-f0-9]+)\s+\d+\t(.+)$/);
    if (match) {
      files[match[2]] = match[1];
    }
  }

  // Get untracked files
  let untrackedOutput = "";
  await exec.exec("git", ["ls-files", "--others", "--exclude-standard"], {
    silent: true,
    listeners: {
      stdout: (data) => {
        untrackedOutput += data.toString();
      },
    },
  });

  for (const line of untrackedOutput.split("\n")) {
    if (line.trim()) {
      files[line.trim()] = "untracked";
    }
  }

  logger.info(`Snapshot captured: ${Object.keys(files).length} files`);
  return { files };
}

/**
 * Compare two workspace snapshots and return the list of changed files.
 */
export function diffSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
): ChangedFile[] {
  const changes: ChangedFile[] = [];

  // Check for added and modified files
  for (const [path, hash] of Object.entries(after.files)) {
    if (!(path in before.files)) {
      changes.push({ path, status: "added" });
    } else if (before.files[path] !== hash) {
      changes.push({ path, status: "modified" });
    }
  }

  // Check for deleted files
  for (const path of Object.keys(before.files)) {
    if (!(path in after.files)) {
      changes.push({ path, status: "deleted" });
    }
  }

  return changes;
}
