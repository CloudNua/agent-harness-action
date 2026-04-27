import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";

const ROOT = resolve(__dirname, "../..");

describe("action.yml", () => {
  it("exists and is valid YAML", () => {
    const content = readFileSync(resolve(ROOT, "action.yml"), "utf-8");
    const action = load(content) as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(action.name).toBe("CloudNua Agent Harness");
  });

  it("defines required inputs", () => {
    const content = readFileSync(resolve(ROOT, "action.yml"), "utf-8");
    const action = load(content) as Record<string, Record<string, Record<string, unknown>>>;
    const inputs = action.inputs;

    expect(inputs["api-token"]).toBeDefined();
    expect(inputs["api-token"].required).toBe(true);

    expect(inputs["agent-command"]).toBeDefined();
    expect(inputs["agent-command"].required).toBe(true);

    expect(inputs["api-url"]).toBeDefined();
    expect(inputs["api-url"].default).toBe("https://app.cloudnua.com");

    expect(inputs["policy-types"]).toBeDefined();
    expect(inputs["policy-types"].default).toBe("all");

    expect(inputs["firewall-url"]).toBeDefined();
    expect(inputs["firewall-url"].required).toBe(false);

    expect(inputs["allow-http"]).toBeDefined();
    expect(inputs["allow-http"].required).toBe(false);
    expect(inputs["allow-http"].default).toBe("false");

    expect(inputs["fail-on-violation"]).toBeDefined();
    expect(inputs["fail-on-violation"].default).toBe("true");

    expect(inputs["github-token"]).toBeDefined();
    expect(inputs["github-token"].required).toBe(false);
  });

  it("specifies node20 runtime with pre/main/post entry points", () => {
    const content = readFileSync(resolve(ROOT, "action.yml"), "utf-8");
    const action = load(content) as Record<string, Record<string, string>>;

    expect(action.runs.using).toBe("node20");
    expect(action.runs.pre).toBe("dist/pre/index.js");
    expect(action.runs.main).toBe("dist/main/index.js");
    expect(action.runs.post).toBe("dist/post/index.js");
  });
});

describe("build output", () => {
  it("dist/pre/index.js exists", () => {
    expect(existsSync(resolve(ROOT, "dist/pre/index.js"))).toBe(true);
  });

  it("dist/main/index.js exists", () => {
    expect(existsSync(resolve(ROOT, "dist/main/index.js"))).toBe(true);
  });

  it("dist/post/index.js exists", () => {
    expect(existsSync(resolve(ROOT, "dist/post/index.js"))).toBe(true);
  });
});

describe("logger", () => {
  it("exports expected methods", async () => {
    const { logger } = await import("@/utils/logger");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warning).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.group).toBe("function");
  });
});
