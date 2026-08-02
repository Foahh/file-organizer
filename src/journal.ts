import { existsSync } from "node:fs";
import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileOrganizerError } from "./errors.ts";
import { withTargetLock } from "./lock.ts";
import { JOURNAL_DIR_NAME } from "./paths.ts";
import type { PlanAction } from "./plan.ts";

export { JOURNAL_DIR_NAME } from "./paths.ts";
export const JOURNAL_FILE_NAME = "last-run.json";

export interface JournalEntry {
  timestamp: string;
  actions: PlanAction[];
}

export function journalPath(target: string): string {
  return path.join(target, JOURNAL_DIR_NAME, JOURNAL_FILE_NAME);
}

export async function writeJournal(
  target: string,
  actions: PlanAction[],
): Promise<void> {
  const dir = path.join(target, JOURNAL_DIR_NAME);
  await mkdir(dir, { recursive: true });

  const entry: JournalEntry = {
    timestamp: new Date().toISOString(),
    actions,
  };

  await writeFile(journalPath(target), `${JSON.stringify(entry, null, 2)}\n`);
}

export async function readJournal(target: string): Promise<JournalEntry> {
  const filePath = journalPath(target);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw FileOrganizerError.journalNotFound(filePath);
  }

  try {
    const entry = (await file.json()) as JournalEntry;
    if (!entry || !Array.isArray(entry.actions)) {
      throw new Error("invalid journal format");
    }
    return entry;
  } catch (e) {
    if (e instanceof FileOrganizerError) {
      throw e;
    }
    throw FileOrganizerError.io(
      `Failed to read journal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function clearJournal(target: string): Promise<void> {
  try {
    await unlink(journalPath(target));
  } catch {
    // already missing
  }
}

export async function undoJournal(target: string): Promise<number> {
  let removeJournalDir = false;
  try {
    return await withTargetLock(target, async () => {
      const entry = await readJournal(target);
      const errors: FileOrganizerError[] = [];
      const remaining = [...entry.actions];
      let undone = 0;

      for (let i = entry.actions.length - 1; i >= 0; i--) {
        const action = entry.actions[i];
        if (!action) {
          continue;
        }
        try {
          if (action.kind === "move") {
            if (!(await Bun.file(action.to).exists())) {
              throw FileOrganizerError.io(
                `Cannot undo move; source missing: ${action.to}`,
              );
            }
            if (existsSync(action.from)) {
              throw FileOrganizerError.io(
                `Cannot undo move; destination already exists: ${action.from}`,
              );
            }
            await mkdir(path.dirname(action.from), { recursive: true });
            await rename(action.to, action.from);
            undone++;
            remaining.splice(i, 1);
          } else {
            await mkdir(action.path, { recursive: true });
            undone++;
            remaining.splice(i, 1);
          }
        } catch (e) {
          if (e instanceof FileOrganizerError) {
            errors.push(e);
          } else {
            errors.push(
              FileOrganizerError.io(e instanceof Error ? e.message : String(e)),
            );
          }
        }
      }

      if (remaining.length === 0) {
        await clearJournal(target);
        // Defer rmdir until after lock release — apply.lock still holds the dir.
        removeJournalDir = true;
      } else {
        await writeJournal(target, remaining);
      }

      if (errors.length > 0) {
        throw FileOrganizerError.multiple(errors);
      }

      return undone;
    });
  } finally {
    if (removeJournalDir) {
      try {
        await rmdir(path.join(target, JOURNAL_DIR_NAME));
      } catch {
        // ignore if not empty or missing
      }
    }
  }
}
