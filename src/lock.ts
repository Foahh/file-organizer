import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { FileOrganizerError } from "./errors.ts";
import { JOURNAL_DIR_NAME } from "./paths.ts";

export function lockPath(target: string): string {
  return path.join(target, JOURNAL_DIR_NAME, "apply.lock");
}

/**
 * Acquire an exclusive apply/undo lock under `<target>/.fortify/apply.lock`.
 * Uses create-only open (`wx`) so it works on Windows and Unix without flock.
 * Returns a release function that closes and unlinks the lock file.
 * Fails closed on EEXIST (no stale recovery).
 */
export async function acquireTargetLock(
  target: string,
): Promise<() => Promise<void>> {
  const dir = path.join(target, JOURNAL_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const filePath = lockPath(target);

  let handle: FileHandle;
  try {
    handle = await open(filePath, "wx");
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e
        ? (e as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EEXIST") {
      throw FileOrganizerError.io(
        "another fortify apply/undo is in progress (lock file exists)",
      );
    }
    throw FileOrganizerError.io(e instanceof Error ? e.message : String(e));
  }

  const release = async (): Promise<void> => {
    try {
      await handle.close();
    } catch {
      // already closed
    }
    try {
      await unlink(filePath);
    } catch {
      // already gone
    }
  };

  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  } catch (e) {
    await release();
    throw FileOrganizerError.io(e instanceof Error ? e.message : String(e));
  }

  return release;
}

export async function withTargetLock<T>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireTargetLock(target);
  try {
    return await fn();
  } finally {
    await release();
  }
}
