import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { FileOrganizerError } from "./errors.ts";
import { FileEntry } from "./file-entry.ts";
import { JOURNAL_DIR_NAME, writeJournal } from "./journal.ts";
import { withTargetLock } from "./lock.ts";
import {
  addMove,
  addRemoveDir,
  createEmptyPlan,
  type Plan,
  type PlanAction,
} from "./plan.ts";
import { resolveDestination, shouldDescend } from "./rules.ts";
import { hashFile, isDirEmpty, resolveUniqueFilename } from "./utils.ts";

export interface BuildPlanOptions {
  sortFiles: boolean;
  moveDuplicates: boolean;
  removeEmptyFolders: boolean;
}

export class Organizer {
  config: Config;
  files: FileEntry[];

  private constructor(config: Config, files: FileEntry[]) {
    this.config = config;
    this.files = files;
  }

  static async create(config: Config): Promise<Organizer> {
    const files: FileEntry[] = [];
    await scanKnownDirs(
      config.target,
      config.knownFolders,
      config.destinations,
      files,
    );

    // Sort by mtime descending (newest first)
    const mtimes = new Map<string, number>();
    await Promise.all(
      files.map(async (f) => {
        try {
          const s = await stat(f.path);
          mtimes.set(f.path, s.mtimeMs);
        } catch {
          mtimes.set(f.path, 0);
        }
      }),
    );
    files.sort((a, b) => (mtimes.get(b.path) ?? 0) - (mtimes.get(a.path) ?? 0));

    return new Organizer(config, files);
  }

  async buildPlan(options: BuildPlanOptions): Promise<Plan> {
    const plan = createEmptyPlan();
    const reserved = new Set<string>();
    // Logical path after planned moves: original path -> effective path
    const effectivePath = new Map<string, string>();
    for (const file of this.files) {
      effectivePath.set(file.path, file.path);
    }

    if (options.sortFiles) {
      await this.planSort(plan, reserved, effectivePath);
    }

    if (options.moveDuplicates) {
      await this.planDuplicates(plan, reserved, effectivePath);
    }

    if (options.removeEmptyFolders) {
      await this.planRemoveEmptyFolders(plan, effectivePath);
    }

    return plan;
  }

  private async planSort(
    plan: Plan,
    reserved: Set<string>,
    effectivePath: Map<string, string>,
  ): Promise<void> {
    for (const file of this.files) {
      if (
        file.isSorted(
          this.config.target,
          this.config.ignoredGlobs,
          this.config.mapping,
          this.config.rules,
          this.config.mappingGlobs,
        )
      ) {
        continue;
      }

      const { folder, ruleName } = resolveDestination(
        file.fileName,
        file.extension,
        this.config.rules,
        this.config.mapping,
        this.config.mappingGlobs,
      );
      const targetDir = path.join(this.config.target, folder);
      const filename = await resolveUniqueFilename(
        file.fileStem,
        file.extension,
        targetDir,
        reserved,
        file.fileName,
      );
      const to = path.join(targetDir, filename);

      // Skip no-op (same path)
      if (path.resolve(file.path) === path.resolve(to)) {
        continue;
      }

      addMove(plan, file.path, to, "sort", ruleName);
      reserved.add(to);
      effectivePath.set(file.path, to);
    }
  }

  private async planDuplicates(
    plan: Plan,
    reserved: Set<string>,
    effectivePath: Map<string, string>,
  ): Promise<void> {
    const duplicateDir = path.join(this.config.target, "Duplicates");

    // Group candidates by size (this.files order = newest-first from create).
    // Different sizes cannot be content duplicates, so only hash buckets of size ≥ 2.
    const bySize = new Map<number, FileEntry[]>();
    for (const file of this.files) {
      if (file.matchGlobs(this.config.ignoredGlobs)) {
        continue;
      }

      let size: number;
      try {
        size = (await stat(file.path)).size;
      } catch {
        // Unreadable / vanished between scan and plan — skip
        continue;
      }

      const bucket = bySize.get(size);
      if (bucket) {
        bucket.push(file);
      } else {
        bySize.set(size, [file]);
      }
    }

    for (const bucket of bySize.values()) {
      if (bucket.length < 2) {
        continue;
      }

      const hashSet = new Set<string>();
      for (const file of bucket) {
        // Hash the file at its current on-disk path (not yet moved)
        const hash = await hashFile(file.path);

        if (hashSet.has(hash)) {
          const from = effectivePath.get(file.path) ?? file.path;
          const stem = path.basename(from, path.extname(from));
          const ext = path.extname(from).slice(1).toLowerCase();
          const filename = await resolveUniqueFilename(
            stem,
            ext,
            duplicateDir,
            reserved,
          );
          const to = path.join(duplicateDir, filename);

          if (path.resolve(from) === path.resolve(to)) {
            continue;
          }

          addMove(plan, from, to, "duplicate");
          reserved.add(to);
          effectivePath.set(file.path, to);
        } else {
          hashSet.add(hash);
        }
      }
    }
  }

  private async planRemoveEmptyFolders(
    plan: Plan,
    effectivePath: Map<string, string>,
  ): Promise<void> {
    const directories: string[] = [];
    await collectDirs(
      this.config.target,
      this.config.knownFolders,
      this.config.destinations,
      directories,
    );

    const remaining = new Set<string>();
    for (const file of this.files) {
      const dest = effectivePath.get(file.path) ?? file.path;
      remaining.add(path.resolve(dest));
    }

    const vacated = new Set<string>();
    for (const file of this.files) {
      const dest = effectivePath.get(file.path) ?? file.path;
      if (path.resolve(file.path) !== path.resolve(dest)) {
        vacated.add(path.resolve(file.path));
      }
    }

    directories.sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length,
    );

    const plannedRemoved = new Set<string>();

    for (const dir of directories) {
      const resolved = path.resolve(dir);
      // Inbound planned moves keep the directory non-empty
      if (hasRemainingUnder(resolved, remaining)) {
        continue;
      }
      if (await wouldBeEmpty(resolved, remaining, vacated, plannedRemoved)) {
        addRemoveDir(plan, dir);
        plannedRemoved.add(resolved);
      }
    }
  }

  async applyPlan(plan: Plan): Promise<PlanAction[]> {
    return withTargetLock(this.config.target, async () => {
      const completed: PlanAction[] = [];
      const errors: FileOrganizerError[] = [];

      for (const action of plan.actions) {
        try {
          if (action.kind === "move") {
            await mkdir(path.dirname(action.to), { recursive: true });
            await rename(action.from, action.to);
            completed.push(action);
          } else {
            if (await isDirEmpty(action.path)) {
              await rmdir(action.path);
              completed.push(action);
            }
          }
        } catch (e) {
          if (e instanceof FileOrganizerError) {
            errors.push(e);
          } else {
            errors.push(
              FileOrganizerError.io(e instanceof Error ? e.message : String(e)),
            );
          }
          continue;
        }

        try {
          await writeJournal(this.config.target, completed);
        } catch (e) {
          if (e instanceof FileOrganizerError) {
            errors.push(e);
          } else {
            errors.push(
              FileOrganizerError.io(e instanceof Error ? e.message : String(e)),
            );
          }
          break;
        }
      }

      if (errors.length > 0) {
        throw FileOrganizerError.multiple(
          errors,
          completed.length > 0 ? completed : undefined,
        );
      }

      return completed;
    });
  }
}

function hasRemainingUnder(dir: string, remainingFiles: Set<string>): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const filePath of remainingFiles) {
    if (filePath === dir || filePath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

async function wouldBeEmpty(
  dir: string,
  remainingFiles: Set<string>,
  vacatedFiles: Set<string>,
  plannedRemovedDirs: Set<string>,
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const fullPath = path.resolve(path.join(dir, entry.name));

    if (entry.isFile()) {
      if (remainingFiles.has(fullPath)) {
        return false;
      }
      if (!vacatedFiles.has(fullPath)) {
        return false;
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (plannedRemovedDirs.has(fullPath)) {
        continue;
      }
      return false;
    }

    return false;
  }

  return true;
}

async function scanKnownDirs(
  dir: string,
  knownFolders: Set<string>,
  destinations: Set<string>,
  files: FileEntry[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === JOURNAL_DIR_NAME) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(new FileEntry(fullPath));
    } else if (entry.isDirectory() && knownFolders.has(entry.name)) {
      await scanCategoryDir(fullPath, entry.name, destinations, files);
    }
    // Unknown root folders (extracted games, projects) stay opaque
  }
}

async function scanCategoryDir(
  dir: string,
  relativePath: string,
  destinations: Set<string>,
  files: FileEntry[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === JOURNAL_DIR_NAME) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(new FileEntry(fullPath));
    } else if (entry.isDirectory()) {
      const childRel = path.join(relativePath, entry.name);
      // Only descend toward configured destinations (e.g. Pictures/Screenshots)
      if (shouldDescend(childRel, destinations)) {
        await scanCategoryDir(fullPath, childRel, destinations, files);
      }
      // Else opaque: leave extracted trees intact
    }
  }
}

async function collectDirs(
  root: string,
  knownFolders: Set<string>,
  destinations: Set<string>,
  dirs: string[],
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === JOURNAL_DIR_NAME) {
      continue;
    }
    if (entry.isDirectory() && knownFolders.has(entry.name)) {
      const fullPath = path.join(root, entry.name);
      dirs.push(fullPath);
      await collectCategoryDirs(fullPath, entry.name, destinations, dirs);
    }
  }
}

async function collectCategoryDirs(
  dir: string,
  relativePath: string,
  destinations: Set<string>,
  dirs: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === JOURNAL_DIR_NAME) {
      continue;
    }
    if (entry.isDirectory()) {
      const childRel = path.join(relativePath, entry.name);
      if (shouldDescend(childRel, destinations)) {
        const fullPath = path.join(dir, entry.name);
        dirs.push(fullPath);
        await collectCategoryDirs(fullPath, childRel, destinations, dirs);
      }
    }
  }
}
