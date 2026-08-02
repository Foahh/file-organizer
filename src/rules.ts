import path from "node:path";
import { FileOrganizerError } from "./errors.ts";
import { lookupCategory } from "./utils.ts";

export interface NamedRule {
  name: string;
  match: string[];
  /** Compiled once at config load — use for matching, not `match` strings. */
  matchGlobs: Bun.Glob[];
  folder: string;
}

/** Wildcard extension mapping entry compiled at config load. */
export interface MappingGlob {
  pattern: string;
  glob: Bun.Glob;
  folder: string;
}

export interface Destination {
  /** Destination folder relative to target (may be nested, using OS separators). */
  folder: string;
  /** Set when a named rule matched. */
  ruleName?: string;
}

/** Normalize a config folder path to OS-specific separators (no leading/trailing sep). */
export function normalizeFolder(folder: string): string {
  return folder
    .split(/[/\\]+/)
    .filter((s) => s.length > 0)
    .join(path.sep);
}

/**
 * Normalize and validate a config destination folder.
 * Rejects absolute paths and `.` / `..` segments so destinations cannot escape the target tree.
 */
export function assertSafeRelativeFolder(
  folder: string,
  label = "folder",
): string {
  const trimmed = folder.trim();
  if (path.isAbsolute(trimmed)) {
    throw FileOrganizerError.configParse(
      `${label} must be a relative path, not absolute`,
    );
  }

  const normalized = normalizeFolder(folder);
  if (!normalized) {
    throw FileOrganizerError.configParse(`${label} must be a non-empty path`);
  }

  for (const segment of normalized.split(path.sep)) {
    if (segment === "." || segment === "..") {
      throw FileOrganizerError.configParse(
        `${label} must not contain '.' or '..' path segments`,
      );
    }
  }

  return normalized;
}

export function topLevelFolder(folder: string): string {
  const normalized = normalizeFolder(folder);
  return normalized.split(path.sep)[0] ?? normalized;
}

/**
 * Whether to enter a subdirectory while scanning.
 * Only descend along paths that lead to (or are) a configured destination —
 * arbitrary folders (extracted games, projects) stay opaque.
 */
export function shouldDescend(
  relativePath: string,
  destinations: Iterable<string>,
): boolean {
  const rel = normalizeFolder(relativePath);
  if (!rel) {
    return false;
  }
  const prefix = rel + path.sep;
  for (const dest of destinations) {
    const d = normalizeFolder(dest);
    if (d === rel || d.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** True if basename matches any compiled glob. */
export function matchBasename(basename: string, globs: Bun.Glob[]): boolean {
  for (const glob of globs) {
    if (glob.match(basename)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve destination folder: first matching named rule (order), then extension mapping, else Others.
 */
export function resolveDestination(
  basename: string,
  extension: string,
  rules: NamedRule[],
  mapping: Map<string, string>,
  mappingGlobs: MappingGlob[] = [],
): Destination {
  for (const rule of rules) {
    if (matchBasename(basename, rule.matchGlobs)) {
      return {
        folder: normalizeFolder(rule.folder),
        ruleName: rule.name,
      };
    }
  }

  const category = lookupCategory(extension, mapping, mappingGlobs) ?? "Others";
  return { folder: normalizeFolder(category) };
}

/**
 * True if the file's relative path under target already lives under the destination folder
 * (as the immediate parent or any nested descendant).
 */
export function isUnderDestination(
  relativeFilePath: string,
  folder: string,
): boolean {
  if (relativeFilePath.startsWith("..") || path.isAbsolute(relativeFilePath)) {
    return false;
  }

  const dest = normalizeFolder(folder);
  const dir = path.dirname(relativeFilePath);

  if (dir === dest) {
    return true;
  }

  const prefix = dest + path.sep;
  return dir.startsWith(prefix);
}
