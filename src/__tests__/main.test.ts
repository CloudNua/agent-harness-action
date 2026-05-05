import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const coreMocks = vi.hoisted(() => ({
  getInput: vi.fn<(name: string, options?: { required?: boolean }) => string>(),
  saveState: vi.fn<(name: string, value: string) => void>(),
  setSecret: vi.fn<(secret: string) => void>(),
  setFailed: vi.fn<(message: string) => void>(),
  info: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  warning: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  notice: vi.fn<(msg: string, props?: Record<string, string>) => void>(),
}));

const execMocks = vi.hoisted(() => ({
  exec: vi.fn<(...args: unknown[]) => Promise<number>>(),
}));

const workspaceMocks = vi.hoisted(() => ({
  snapshotWorkspace: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@actions/core", () => coreMocks);
vi.mock("@actions/exec", () => execMocks);
vi.mock("@/utils/workspace", () => ({
  snapshotWorkspace: workspaceMocks.snapshotWorkspace,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

describe("runMainStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible default returns for every getInput call
    coreMocks.getInput.mockImplementation((name: string) => {
      switch (name) {
        case "agent-command":
          return "";
        case "firewall-url":
          return "";
        case "allow-http":
          return "false";
        default:
          return "";
      }
    });
    execMocks.exec.mockResolvedValue(0);
    workspaceMocks.snapshotWorkspace.mockResolvedValue({});
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("scan-only mode", () => {
    it("logs scan-only message and returns when agent-command is empty", async () => {
      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(coreMocks.info).toHaveBeenCalledWith(
        expect.stringContaining("scan-only mode"),
      );
      expect(execMocks.exec).not.toHaveBeenCalled();
      expect(workspaceMocks.snapshotWorkspace).not.toHaveBeenCalled();
    });

    it("saves agent-exit-code=0 in scan-only mode so post-step does not flag a failure", async () => {
      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(coreMocks.saveState).toHaveBeenCalledWith("agent-exit-code", "0");
    });

    it("saves scan-only=true so post-step knows to walk the workspace instead of diffing snapshots", async () => {
      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(coreMocks.saveState).toHaveBeenCalledWith("scan-only", "true");
    });

    it("treats whitespace-only agent-command as scan-only mode", async () => {
      coreMocks.getInput.mockImplementation((name: string) =>
        name === "agent-command" ? "   \t\n  " : "",
      );

      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(execMocks.exec).not.toHaveBeenCalled();
      expect(coreMocks.info).toHaveBeenCalledWith(
        expect.stringContaining("scan-only mode"),
      );
    });

    it("does not snapshot the workspace in scan-only mode (avoids unnecessary I/O)", async () => {
      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(workspaceMocks.snapshotWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("agent-wrap mode", () => {
    it("snapshots workspace and executes agent command when agent-command is provided", async () => {
      coreMocks.getInput.mockImplementation((name: string) => {
        switch (name) {
          case "agent-command":
            return "echo hello";
          case "firewall-url":
            return "";
          case "allow-http":
            return "false";
          default:
            return "";
        }
      });

      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(workspaceMocks.snapshotWorkspace).toHaveBeenCalled();
      expect(execMocks.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", "echo hello"],
        expect.objectContaining({ ignoreReturnCode: true }),
      );
    });

    it("saves non-zero exit code from the agent command", async () => {
      coreMocks.getInput.mockImplementation((name: string) =>
        name === "agent-command" ? "false" : name === "allow-http" ? "false" : "",
      );
      execMocks.exec.mockResolvedValue(42);

      const { runMainStep } = await import("@/main");

      await runMainStep();

      expect(coreMocks.saveState).toHaveBeenCalledWith("agent-exit-code", "42");
    });
  });
});
