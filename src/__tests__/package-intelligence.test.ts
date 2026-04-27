import { describe, it, expect, vi } from "vitest";
import {
  matchPackageIntelligence,
  deduplicateViolations,
  severityAction,
} from "@/scanner/package-intelligence";
import type { PackageEntry, PackageIntelligence } from "@/types/policy";
import type { ParsedDependency } from "@/scanner/manifests";
import type { Violation } from "@/scanner/index";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

function makeDep(
  name: string,
  version: string | null,
  ecosystem = "pip",
  filePath = "requirements.txt",
): ParsedDependency {
  return { name, version, ecosystem, filePath };
}

function makeEntry(
  overrides: Partial<PackageEntry> = {},
): PackageEntry {
  return {
    ecosystem: "pip",
    package_name: "litellm",
    risk_score: 10.0,
    risk_level: "critical",
    osv_malware_match: false,
    affected_versions: ["1.82.7", "1.82.8"],
    signals: [{ type: "osv_malware", score: 10.0, detail: "Malicious package" }],
    remediation: "Remove or downgrade litellm",
    ...overrides,
  };
}

function makePkgIntel(packages: PackageEntry[]): PackageIntelligence {
  return {
    packages,
    metadata: { total_packages: packages.length },
  };
}

// ─── severityAction ─────────────────────────────────────────────────────────

describe("severityAction", () => {
  it("maps critical (score >= 8) to block", () => {
    expect(severityAction(makeEntry({ risk_score: 10 }))).toBe("block");
    expect(severityAction(makeEntry({ risk_score: 8 }))).toBe("block");
  });

  it("maps high (score 6-7.9) to require_approval", () => {
    expect(severityAction(makeEntry({ risk_score: 7.5 }))).toBe("require_approval");
    expect(severityAction(makeEntry({ risk_score: 6 }))).toBe("require_approval");
  });

  it("maps medium (score 3-5.9) to warn", () => {
    expect(severityAction(makeEntry({ risk_score: 5.9 }))).toBe("warn");
    expect(severityAction(makeEntry({ risk_score: 3 }))).toBe("warn");
  });

  it("maps low (score 0-2.9) to log", () => {
    expect(severityAction(makeEntry({ risk_score: 2.9 }))).toBe("log");
    expect(severityAction(makeEntry({ risk_score: 0 }))).toBe("log");
  });
});

// ─── matchPackageIntelligence ────────────────────────────────────────────────

describe("matchPackageIntelligence", () => {
  it("matches dependency by ecosystem + name at affected version", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(1);
    expect(matches[0].violation.dependency).toBe("litellm");
    expect(matches[0].violation.policyAction).toBe("block");
    expect(matches[0].violation.policyType).toBe("package_intelligence");
  });

  it("does NOT match when version is safe (not in affected_versions)", () => {
    const deps = [makeDep("litellm", "1.82.6")]; // safe version
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(0);
  });

  it("matches unpinned dependency (no version) — always matches", () => {
    const deps = [makeDep("litellm", null)];
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(1);
  });

  it("matches when affected_versions is empty (conservative — name-only)", () => {
    const deps = [makeDep("litellm", "1.82.6")];
    const pkgIntel = makePkgIntel([makeEntry({ affected_versions: [] })]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(1);
  });

  it("strips semver operators when comparing versions", () => {
    const deps = [makeDep("litellm", "^1.82.7")]; // caret prefix
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(1);
  });

  it("does not match different ecosystem", () => {
    const deps = [makeDep("litellm", "1.82.7", "npm")]; // wrong ecosystem
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(0);
  });

  it("returns empty when package_intelligence is undefined", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const matches = matchPackageIntelligence(deps, undefined);
    expect(matches).toHaveLength(0);
  });

  it("returns empty when packages list is empty", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const matches = matchPackageIntelligence(deps, makePkgIntel([]));
    expect(matches).toHaveLength(0);
  });

  it("includes signal details and remediation in message", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches[0].violation.message).toContain("critical risk");
    expect(matches[0].violation.message).toContain("osv_malware");
    expect(matches[0].violation.message).toContain("Remove or downgrade");
  });

  it("generates correct policyId format", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches[0].violation.policyId).toBe("pkg-intel:pip:litellm");
  });

  it("matches multiple dependencies against multiple packages", () => {
    const deps = [
      makeDep("litellm", "1.82.7"),
      makeDep("flask", "2.0.0"),
      makeDep("safe-pkg", "1.0.0"),
    ];
    const pkgIntel = makePkgIntel([
      makeEntry(),
      makeEntry({
        package_name: "flask",
        risk_score: 5.0,
        risk_level: "medium",
        affected_versions: ["2.0.0"],
        signals: [],
        remediation: "Upgrade flask",
      }),
    ]);

    const matches = matchPackageIntelligence(deps, pkgIntel);
    expect(matches).toHaveLength(2);
    expect(matches[0].violation.policyAction).toBe("block"); // litellm critical
    expect(matches[1].violation.policyAction).toBe("warn"); // flask medium
  });
});

// ─── deduplicateViolations ──────────────────────────────────────────────────

describe("deduplicateViolations", () => {
  const seedViolation: Violation = {
    policyId: "pol_block_litellm",
    policyType: "dependency",
    policyAction: "block",
    filePath: "requirements.txt",
    dependency: "litellm",
    message: "Blocked dependency litellm",
  };

  it("returns seed violations unchanged when no pkg-intel matches", () => {
    const result = deduplicateViolations([seedViolation], []);
    expect(result).toEqual([seedViolation]);
  });

  it("deduplicates overlapping violations, preferring pkg-intel", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]);
    const matches = matchPackageIntelligence(deps, pkgIntel);

    const result = deduplicateViolations([seedViolation], matches);
    // Should emit ONE violation (not two)
    expect(result).toHaveLength(1);
    // Should use pkg-intel violation (richer data)
    expect(result[0].policyType).toBe("package_intelligence");
    expect(result[0].message).toContain("critical risk");
  });

  it("keeps higher severity when seed has higher action", () => {
    const deps = [makeDep("litellm", "1.82.7")];
    // pkg-intel says require_approval (score 7)
    const pkgIntel = makePkgIntel([
      makeEntry({ risk_score: 7, risk_level: "high" }),
    ]);
    const matches = matchPackageIntelligence(deps, pkgIntel);

    // seed says block — higher than require_approval
    const result = deduplicateViolations([seedViolation], matches);
    expect(result).toHaveLength(1);
    expect(result[0].policyAction).toBe("block"); // kept seed's higher severity
    expect(result[0].policyType).toBe("package_intelligence"); // but pkg-intel's data
  });

  it("keeps higher severity when pkg-intel has higher action", () => {
    const warnSeed: Violation = {
      ...seedViolation,
      policyAction: "warn",
    };
    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]); // block
    const matches = matchPackageIntelligence(deps, pkgIntel);

    const result = deduplicateViolations([warnSeed], matches);
    expect(result).toHaveLength(1);
    expect(result[0].policyAction).toBe("block"); // pkg-intel's higher severity
  });

  it("includes non-overlapping violations from both sources", () => {
    const npmSeed: Violation = {
      policyId: "pol_block_lodash",
      policyType: "dependency",
      policyAction: "block",
      filePath: "package.json",
      dependency: "lodash",
      message: "Blocked lodash",
    };

    const deps = [makeDep("litellm", "1.82.7")];
    const pkgIntel = makePkgIntel([makeEntry()]);
    const matches = matchPackageIntelligence(deps, pkgIntel);

    // npmSeed is for lodash@package.json, pkg-intel is for litellm@requirements.txt
    const result = deduplicateViolations([npmSeed], matches);
    expect(result).toHaveLength(2);
    expect(result[0].dependency).toBe("lodash");
    expect(result[1].dependency).toBe("litellm");
  });
});
