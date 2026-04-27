import type { ParsedDependency } from "./manifests";
import type { PackageEntry, PackageIntelligence } from "@/types/policy";
import type { Violation } from "./index";
import { logger } from "@/utils/logger";

/**
 * Map risk_level/risk_score to a four-tier action.
 *
 * critical (score 8–10)   → block
 * high     (score 6–7.9)  → require_approval
 * medium   (score 3–5.9)  → warn
 * low      (score 0–2.9)  → log
 */
export function severityAction(entry: PackageEntry): string {
  const score = entry.risk_score;
  if (score >= 8) return "block";
  if (score >= 6) return "require_approval";
  if (score >= 3) return "warn";
  return "log";
}

/**
 * Build a human-readable message for a package intelligence violation.
 */
function buildMessage(entry: PackageEntry, dep: ParsedDependency): string {
  const signals = entry.signals.map((s) => `${s.type} (${s.score})`).join(", ");
  const parts: string[] = [
    `Package intelligence: ${entry.package_name} flagged as ${entry.risk_level} risk (score ${entry.risk_score})`,
  ];
  if (signals) {
    parts.push(`Signals: ${signals}`);
  }
  if (entry.remediation) {
    parts.push(`Remediation: ${entry.remediation}`);
  }
  if (dep.version && entry.affected_versions.length > 0) {
    parts.push(`Affected versions: ${entry.affected_versions.join(", ")}`);
  }
  return parts.join(". ");
}

/**
 * Check whether a dependency's version is affected.
 *
 * Rules:
 * - If affected_versions is empty → match on name only (conservative)
 * - If dependency has no version (unpinned) → always match
 * - Otherwise → match if the exact version string is in affected_versions
 */
function isVersionAffected(
  dep: ParsedDependency,
  entry: PackageEntry,
): boolean {
  // Empty affected_versions = match all versions (conservative)
  if (entry.affected_versions.length === 0) return true;
  // Unpinned dependency = always match
  if (!dep.version) return true;
  // Strip leading semver operators for comparison (e.g. "^1.2.3" → "1.2.3")
  const cleanVersion = dep.version.replace(/^[~^>=<!]+/, "");
  return entry.affected_versions.includes(cleanVersion);
}

export interface PackageIntelligenceMatch {
  violation: Violation;
  entry: PackageEntry;
}

/**
 * Cross-reference parsed manifest dependencies against flagged packages
 * from package intelligence.
 *
 * Match by ecosystem + package_name, then check version against
 * affected_versions array.
 */
export function matchPackageIntelligence(
  dependencies: ParsedDependency[],
  packageIntelligence: PackageIntelligence | undefined,
): PackageIntelligenceMatch[] {
  if (!packageIntelligence || packageIntelligence.packages.length === 0) {
    return [];
  }

  // Build lookup: "ecosystem:package_name" → PackageEntry
  const lookup = new Map<string, PackageEntry>();
  for (const pkg of packageIntelligence.packages) {
    lookup.set(`${pkg.ecosystem}:${pkg.package_name}`, pkg);
  }

  const matches: PackageIntelligenceMatch[] = [];

  for (const dep of dependencies) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const entry = lookup.get(key);
    if (!entry) continue;

    if (!isVersionAffected(dep, entry)) {
      logger.debug(
        `Skipping ${dep.name}@${dep.version} — not in affected versions`,
      );
      continue;
    }

    const action = severityAction(entry);
    const message = buildMessage(entry, dep);

    matches.push({
      violation: {
        policyId: `pkg-intel:${entry.ecosystem}:${entry.package_name}`,
        policyType: "package_intelligence",
        policyAction: action,
        filePath: dep.filePath,
        dependency: dep.name,
        message,
      },
      entry,
    });
  }

  if (matches.length > 0) {
    logger.info(
      `Package intelligence: ${matches.length} match(es) found`,
    );
  }

  return matches;
}

/**
 * Deduplicate violations: when a dependency is flagged by both seed policy
 * (server-side evaluation) and package intelligence, emit one violation.
 *
 * Prefer package intelligence (richer signal data: risk_score, signals,
 * remediation). Keep the higher severity of the two.
 */
export function deduplicateViolations(
  seedViolations: Violation[],
  pkgIntelMatches: PackageIntelligenceMatch[],
): Violation[] {
  if (pkgIntelMatches.length === 0) return seedViolations;

  const ACTION_RANK: Record<string, number> = {
    block: 4,
    require_approval: 3,
    warn: 2,
    log: 1,
  };

  // Build set of pkg-intel matches keyed by "dependency:filePath"
  const pkgIntelByDep = new Map<string, PackageIntelligenceMatch>();
  for (const m of pkgIntelMatches) {
    const key = `${m.violation.dependency}:${m.violation.filePath}`;
    pkgIntelByDep.set(key, m);
  }

  const result: Violation[] = [];
  const consumedPkgIntelKeys = new Set<string>();

  for (const seed of seedViolations) {
    const key = `${seed.dependency}:${seed.filePath}`;
    const pkgMatch = pkgIntelByDep.get(key);

    if (pkgMatch) {
      // Duplicate — prefer pkg-intel violation but keep higher severity
      consumedPkgIntelKeys.add(key);
      const seedRank = ACTION_RANK[seed.policyAction] ?? 0;
      const pkgRank = ACTION_RANK[pkgMatch.violation.policyAction] ?? 0;
      const mergedAction =
        seedRank > pkgRank ? seed.policyAction : pkgMatch.violation.policyAction;

      result.push({
        ...pkgMatch.violation,
        policyAction: mergedAction,
      });
    } else {
      result.push(seed);
    }
  }

  // Add any pkg-intel matches that didn't overlap with seed violations
  for (const m of pkgIntelMatches) {
    const key = `${m.violation.dependency}:${m.violation.filePath}`;
    if (!consumedPkgIntelKeys.has(key)) {
      result.push(m.violation);
    }
  }

  return result;
}
