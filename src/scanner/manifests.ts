import { readFileSync, readdirSync, statSync } from "fs";
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
 * Skips node_modules, .git, and other common non-project directories.
 */
export function parseWorkspaceManifests(
  workspaceDir: string,
): ManifestResult[] {
  const results: ManifestResult[] = [];
  const resolvedBase = resolve(workspaceDir);
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "__pycache__",
    "dist",
    "build",
    "vendor",
    "target",
    ".venv",
    "venv",
  ]);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (isManifestFile(entry)) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          const relPath = relative(resolvedBase, fullPath);
          const ecosystem = getEcosystem(relPath);
          const dependencies = parseManifestContent(content, ecosystem, relPath);
          results.push({ filePath: relPath, ecosystem, dependencies });
          logger.debug(`Parsed ${relPath}: ${dependencies.length} dependencies`);
        } catch (error) {
          const relPath = relative(resolvedBase, fullPath);
          logger.warning(
            `Failed to parse ${relPath}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }

  walk(resolvedBase);

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
