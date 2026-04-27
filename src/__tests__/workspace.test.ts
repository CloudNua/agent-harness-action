import { describe, it, expect } from "vitest";
import { diffSnapshots } from "@/utils/workspace";
import type { FileSnapshot } from "@/utils/workspace";

describe("diffSnapshots", () => {
  it("detects added files", () => {
    const before: FileSnapshot = {
      files: { "package.json": "abc123" },
    };
    const after: FileSnapshot = {
      files: {
        "package.json": "abc123",
        "new-file.ts": "def456",
      },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([{ path: "new-file.ts", status: "added" }]);
  });

  it("detects modified files", () => {
    const before: FileSnapshot = {
      files: { "package.json": "abc123" },
    };
    const after: FileSnapshot = {
      files: { "package.json": "xyz789" },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([{ path: "package.json", status: "modified" }]);
  });

  it("detects deleted files", () => {
    const before: FileSnapshot = {
      files: { "package.json": "abc123", "removed.ts": "def456" },
    };
    const after: FileSnapshot = {
      files: { "package.json": "abc123" },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([{ path: "removed.ts", status: "deleted" }]);
  });

  it("detects no changes when snapshots are identical", () => {
    const snapshot: FileSnapshot = {
      files: { "package.json": "abc123", "index.ts": "def456" },
    };

    const changes = diffSnapshots(snapshot, snapshot);
    expect(changes).toEqual([]);
  });

  it("handles empty before snapshot (all files are new)", () => {
    const before: FileSnapshot = { files: {} };
    const after: FileSnapshot = {
      files: { "a.ts": "111", "b.ts": "222" },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.status === "added")).toBe(true);
  });

  it("handles empty after snapshot (all files deleted)", () => {
    const before: FileSnapshot = {
      files: { "a.ts": "111", "b.ts": "222" },
    };
    const after: FileSnapshot = { files: {} };

    const changes = diffSnapshots(before, after);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.status === "deleted")).toBe(true);
  });

  it("detects mixed changes", () => {
    const before: FileSnapshot = {
      files: {
        "keep.ts": "aaa",
        "modify.ts": "bbb",
        "delete.ts": "ccc",
      },
    };
    const after: FileSnapshot = {
      files: {
        "keep.ts": "aaa",
        "modify.ts": "bbb_changed",
        "add.ts": "ddd",
      },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toHaveLength(3);

    expect(changes.filter((c) => c.status === "modified")).toHaveLength(1);
    expect(changes.filter((c) => c.status === "added")).toHaveLength(1);
    expect(changes.filter((c) => c.status === "deleted")).toHaveLength(1);
  });

  it("treats untracked files correctly in diff", () => {
    const before: FileSnapshot = {
      files: { "tracked.ts": "aaa" },
    };
    const after: FileSnapshot = {
      files: { "tracked.ts": "aaa", "new-untracked.ts": "untracked" },
    };

    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([
      { path: "new-untracked.ts", status: "added" },
    ]);
  });
});
