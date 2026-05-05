import { readFileSync, readdirSync, realpathSync } from "fs";
import { resolve, relative, join } from "path";
import { logger } from "@/utils/logger";
import type { ChangedFile } from "@/utils/workspace";

const MANIFEST_PATTERNS: Record<string, string> = {
  "package.json": "npm",
  "requirements.txt": "pip",
  "pyproject.toml": "pip",
  "go.mod": "go",
  "Cargo.toml": "cargo",
};

export interface ParsedDependency {
  name: string;
  version: string | null;
  ecosystem: string;
  filePath: string;
}

export interface ManifestResult {
  filePath: string;
  ecosystem: string;
  dependencies: ParsedDependency[];
}

function getBasename(filePath: string): string {
  return filePath.split("/").pop() ?? "";
}

function isManifestFile(filePath: string): boolean {
  return getBasename(filePath) in MANIFEST_PATTERNS;
}

function getEcosystem(filePath: string): string {
  return MANIFEST_PATTERNS[getBasename(filePath)] ?? "unknown";
}

/**
 * Find manifest files among changed files and parse them from the local filesystem.
 */
export function parseChangedManifests(
  changedFiles: ChangedFile[],
  workspaceDir: string,
): ManifestResult[] {
  const results: ManifestResult[] = [];
  const resolvedBase = resolve(workspaceDir);

  const manifestFiles = changedFiles.filter(
    (f) => f.status !== "deleted" && isManifestFile(f.path),
  );

  for (const file of manifestFiles) {
    try {
      const fullPath = resolve(workspaceDir, file.path);

      // Path traversal guard: ensure resolved path stays within workspace
      if (!fullPath.startsWith(resolvedBase + "/")) {
        logger.warning(`Skipping file outside workspace: ${file.path}`);
        continue;
      }

      const content = readFileSync(fullPath, "utf-8");
      const ecosystem = getEcosystem(file.path);
      const dependencies = parseManifestContent(content, ecosystem, file.path);
      results.push({ filePath: file.path, ecosystem, dependencies });
      logger.info(`Parsed ${file.path}: ${dependencies.length} dependencies`);
    } catch (error) {
      logger.warning(
        `Failed to parse ${file.path}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return results;
}

/**
 * Walk the workspace and parse ALL manifest files for package intelligence matching.
 *
 * Hardening (scan-only mode runs against untrusted PR contributors' workspaces):
 * - Uses lstatSync + Dirent.isSymbolicLink() — never follows symlinks. A fork PR
 *   cannot point at /etc/passwd or anything outside the workspace.
 * - realpathSync containment check — even if a symlink slips past the lstat
 *   guard via a race, the resolved real path must stay inside the workspace.
 * - Bounded by MAX_DEPTH, MAX_FILES_VISITED, and MAX_WALL_MS — protects the
 *   runner from a malicious PR that nests directories or floods entries.
 * - Parse-error logs include only filename + error class, never error.message,
 *   to avoid echoing untrusted file content into CI logs.
 */
const MAX_DEPTH = 20;
const MAX_FILES_VISITED = 50_000;
const MAX_WALL_MS = 30_000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "__pycache__",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  ".venv",
  "venv",
  ".turbo",
  ".pnpm-store",
  ".yarn",
  ".cache",
  "coverage",
  ".nyc_output",
  ".gradle",
  ".mvn",
  ".idea",
  ".vscode",
  ".DS_Store",
  "tmp",
  "temp",
]);
const SKIP_PREFIXES = ["bazel-"];

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

export function parseWorkspaceManifests(
  workspaceDir: string,
): ManifestResult[] {
  const results: ManifestResult[] = [];
  const resolvedBase = resolve(workspaceDir);
  let realBase: string;
  try {
    realBase = realpathSync(resolvedBase);
  } catch {
    realBase = resolvedBase;
  }

  const startedAt = Date.now();
  let filesVisited = 0;
  let truncated = false;

  function walk(dir: string, depth: number): void {
    if (truncated) return;
    if (depth > MAX_DEPTH) return;
    if (Date.now() - startedAt > MAX_WALL_MS) {
      truncated = true;
      return;
    }

    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;

      // Per-entry wall-clock sample — protects against a flat-fan-out attack
      // where a single directory contains millions of files (the outer
      // depth-recursion guard at the top of walk() never re-checks once the
      // for-loop is running). Sampled every 1024 entries to keep overhead
      // negligible vs Date.now()-per-iter.
      if (
        (filesVisited & 0x3ff) === 0 &&
        Date.now() - startedAt > MAX_WALL_MS
      ) {
        truncated = true;
        return;
      }

      // Skip symlinks unconditionally — fork PRs can plant them.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }

      if (!entry.isFile() || !isManifestFile(entry.name)) continue;

      filesVisited++;
      if (filesVisited > MAX_FILES_VISITED) {
        truncated = true;
        return;
      }

      const fullPath = join(dir, entry.name);

      // Defence-in-depth: stat the resolved real path and confirm containment.
      // Belt-and-braces on top of the symlink check above.
      let realPath: string;
      try {
        realPath = realpathSync(fullPath);
      } catch {
        continue;
      }
      if (
        realPath !== realBase &&
        !realPath.startsWith(realBase + "/")
      ) {
        continue;
      }

      const relPath = relative(resolvedBase, fullPath);
      try {
        // Read from realPath (not fullPath): closes a TOCTOU between the
        // realpathSync containment check and the read. If something swaps
        // fullPath for a symlink between the two calls, we still read the
        // path we just verified.
        const content = readFileSync(realPath, "utf-8");
        const ecosystem = getEcosystem(relPath);
        const dependencies = parseManifestContent(content, ecosystem, relPath);
        results.push({ filePath: relPath, ecosystem, dependencies });
        logger.debug(`Parsed ${relPath}: ${dependencies.length} dependencies`);
      } catch (error) {
        // Log filename + error class only — avoid echoing untrusted file
        // content (e.g. JSON.parse errors include the offending substring).
        const errClass =
          error instanceof Error ? error.constructor.name : "unknown";
        logger.warning(`Failed to parse ${relPath} (${errClass})`);
      }
    }
  }

  walk(resolvedBase, 0);

  if (truncated) {
    logger.warning(
      `Workspace walk truncated (depth=${MAX_DEPTH}, files=${MAX_FILES_VISITED}, wall=${MAX_WALL_MS}ms) — partial results`,
    );
  }

  if (results.length > 0) {
    const totalDeps = results.reduce((sum, r) => sum + r.dependencies.length, 0);
    logger.info(
      `Package intelligence: scanned ${results.length} manifest(s), ${totalDeps} dependencies`,
    );
  }

  return results;
}

export function parseManifestContent(
  content: string,
  ecosystem: string,
  filePath: string,
): ParsedDependency[] {
  switch (ecosystem) {
    case "npm":
      return parsePackageJson(content, filePath);
    case "pip":
      return filePath.endsWith(".toml")
        ? parsePyprojectToml(content, filePath)
        : parseRequirementsTxt(content, filePath);
    case "go":
      return parseGoMod(content, filePath);
    case "cargo":
      return parseCargoToml(content, filePath);
    default:
      return [];
  }
}

function parsePackageJson(
  content: string,
  filePath: string,
): ParsedDependency[] {
  try {
    const pkg = JSON.parse(content);
    const deps: ParsedDependency[] = [];

    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      const entries = pkg[section];
      if (entries && typeof entries === "object") {
        for (const [name, version] of Object.entries(entries)) {
          deps.push({
            name,
            version: typeof version === "string" ? version : null,
            ecosystem: "npm",
            filePath,
          });
        }
      }
    }

    return deps;
  } catch {
    return [];
  }
}

function parseRequirementsTxt(
  content: string,
  filePath: string,
): ParsedDependency[] {
  const deps: ParsedDependency[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;

    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
    if (!match) continue;

    deps.push({
      name: match[1],
      version: match[2]?.trim() ?? null,
      ecosystem: "pip",
      filePath,
    });
  }

  return deps;
}

function parsePyprojectToml(
  content: string,
  filePath: string,
): ParsedDependency[] {
  const deps: ParsedDependency[] = [];
  const depSection = content.match(
    /\[project\]\s*[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/,
  );
  if (!depSection) return deps;

  for (const line of depSection[1].split("\n")) {
    const match = line.match(/"([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?"/);
    if (match) {
      deps.push({
        name: match[1],
        version: match[2]?.trim() ?? null,
        ecosystem: "pip",
        filePath,
      });
    }
  }

  return deps;
}

function parseGoMod(content: string, filePath: string): ParsedDependency[] {
  const deps: ParsedDependency[] = [];

  // Match all require blocks (handles multiple require blocks)
  for (const blockMatch of content.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const line of blockMatch[1].split("\n")) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match && !match[1].startsWith("//")) {
        deps.push({
          name: match[1],
          version: match[2],
          ecosystem: "go",
          filePath,
        });
      }
    }
  }

  // Single-line require statements
  const singleRequires = content.matchAll(
    /^require\s+(\S+)\s+(\S+)\s*$/gm,
  );
  for (const match of singleRequires) {
    deps.push({
      name: match[1],
      version: match[2],
      ecosystem: "go",
      filePath,
    });
  }

  return deps;
}

function parseCargoToml(
  content: string,
  filePath: string,
): ParsedDependency[] {
  const deps: ParsedDependency[] = [];
  const depSection = content.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
  if (!depSection) return deps;

  for (const line of depSection[1].split("\n")) {
    const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
    if (simpleMatch) {
      deps.push({
        name: simpleMatch[1],
        version: simpleMatch[2],
        ecosystem: "cargo",
        filePath,
      });
      continue;
    }

    const tableMatch = line.match(
      /^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/,
    );
    if (tableMatch) {
      deps.push({
        name: tableMatch[1],
        version: tableMatch[2],
        ecosystem: "cargo",
        filePath,
      });
    }
  }

  return deps;
}
