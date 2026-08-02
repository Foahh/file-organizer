import { existsSync } from "node:fs";
import { FileOrganizerError } from "./errors.ts";
import {
  assertSafeRelativeFolder,
  type MappingGlob,
  type NamedRule,
  normalizeFolder,
  topLevelFolder,
} from "./rules.ts";

interface RawRule {
  name?: unknown;
  match?: unknown;
  folder?: unknown;
}

interface Rules {
  mapping?: Record<string, string[]>;
  ignore?: string[];
  rules?: RawRule[];
}

export interface Config {
  target: string;
  mapping: Map<string, string>;
  /** Wildcard mapping keys compiled once at load (exact keys stay on `mapping`). */
  mappingGlobs: MappingGlob[];
  ignored: string[];
  /** Ignore patterns compiled once at load. */
  ignoredGlobs: Bun.Glob[];
  knownFolders: Set<string>;
  /** All configured destination folders (mapping + rules + Others/Duplicates). */
  destinations: Set<string>;
  rules: NamedRule[];
}

function parseNamedRules(raw: RawRule[] | undefined): NamedRule[] {
  if (!raw || raw.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const rules: NamedRule[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      throw FileOrganizerError.configParse(
        `rules[${i}] must be a table with name, match, and folder`,
      );
    }

    const name = item.name;
    const match = item.match;
    const folder = item.folder;

    if (typeof name !== "string" || name.trim() === "") {
      throw FileOrganizerError.configParse(
        `rules[${i}].name must be a non-empty string`,
      );
    }
    if (seen.has(name)) {
      throw FileOrganizerError.configParse(`duplicate rule name: ${name}`);
    }
    seen.add(name);

    if (
      !Array.isArray(match) ||
      match.length === 0 ||
      !match.every((m) => typeof m === "string" && m.length > 0)
    ) {
      throw FileOrganizerError.configParse(
        `rules[${i}].match must be a non-empty array of strings`,
      );
    }

    if (typeof folder !== "string" || folder.trim() === "") {
      throw FileOrganizerError.configParse(
        `rules[${i}].folder must be a non-empty string`,
      );
    }

    const normalized = assertSafeRelativeFolder(folder, `rules[${i}].folder`);

    const matchPatterns = match as string[];
    rules.push({
      name,
      match: matchPatterns,
      matchGlobs: matchPatterns.map((p) => new Bun.Glob(p)),
      folder: normalized,
    });
  }

  return rules;
}

export async function loadConfig(
  target: string,
  configPath: string,
): Promise<Config> {
  if (!existsSync(target)) {
    throw FileOrganizerError.directoryNotFound(target);
  }

  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw FileOrganizerError.configNotFound(configPath);
  }

  let rulesFile: Rules;
  try {
    const content = await file.text();
    rulesFile = Bun.TOML.parse(content) as Rules;
  } catch (e) {
    if (e instanceof FileOrganizerError) {
      throw e;
    }
    throw FileOrganizerError.configParse(
      e instanceof Error ? e.message : String(e),
    );
  }

  const mapping = new Map<string, string>();
  const mappingGlobs: MappingGlob[] = [];
  for (const [folder, exts] of Object.entries(rulesFile.mapping ?? {})) {
    if (
      !Array.isArray(exts) ||
      exts.length === 0 ||
      !exts.every((ext) => typeof ext === "string" && ext.length > 0)
    ) {
      throw FileOrganizerError.configParse(
        `mapping["${folder}"] must be an array of extension strings`,
      );
    }

    const safeFolder = assertSafeRelativeFolder(
      folder,
      `mapping folder "${folder}"`,
    );
    for (const ext of exts) {
      const bareExt = ext.startsWith(".") ? ext.slice(1) : ext;
      const pattern = bareExt.toLowerCase();
      mapping.set(pattern, safeFolder);
      if (pattern.includes("*") || pattern.includes("?")) {
        mappingGlobs.push({
          pattern,
          glob: new Bun.Glob(pattern),
          folder: safeFolder,
        });
      }
    }
  }

  let namedRules: NamedRule[];
  try {
    namedRules = parseNamedRules(rulesFile.rules);
  } catch (e) {
    if (e instanceof FileOrganizerError) {
      throw e;
    }
    throw FileOrganizerError.configParse(
      e instanceof Error ? e.message : String(e),
    );
  }

  const knownFolders = new Set<string>(["Others", "Duplicates"]);
  const destinations = new Set<string>();

  const mappingFolders = new Set(mapping.values());
  for (const folder of mappingFolders) {
    knownFolders.add(topLevelFolder(folder));
    destinations.add(normalizeFolder(folder));
  }

  for (const rule of namedRules) {
    knownFolders.add(topLevelFolder(rule.folder));
    destinations.add(rule.folder);
  }

  for (const folder of knownFolders) {
    destinations.add(normalizeFolder(folder));
  }

  let ignored: string[] = [];
  if (rulesFile.ignore !== undefined) {
    if (
      !Array.isArray(rulesFile.ignore) ||
      !rulesFile.ignore.every((p) => typeof p === "string" && p.length > 0)
    ) {
      throw FileOrganizerError.configParse(
        "ignore must be an array of strings",
      );
    }
    ignored = rulesFile.ignore;
  }
  const ignoredGlobs = ignored.map((p) => new Bun.Glob(p));

  return {
    target,
    mapping,
    mappingGlobs,
    ignored,
    ignoredGlobs,
    knownFolders,
    destinations,
    rules: namedRules,
  };
}
