import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOrganizerError } from "./errors.ts";
import {
  JOURNAL_DIR_NAME,
  journalPath,
  readJournal,
  undoJournal,
  writeJournal,
} from "./journal.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fortify-journal-"));
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

test("full undo restores all moves and clears journal", async () => {
  const file1From = path.join(tempDir, "a.txt");
  const file1To = path.join(tempDir, "dir1", "a.txt");
  const file2From = path.join(tempDir, "b.txt");
  const file2To = path.join(tempDir, "dir2", "b.txt");

  await mkdir(path.dirname(file1To), { recursive: true });
  await mkdir(path.dirname(file2To), { recursive: true });
  await writeFile(file1To, "content a");
  await writeFile(file2To, "content b");

  await writeJournal(tempDir, [
    { kind: "move", from: file1From, to: file1To, reason: "sort" },
    { kind: "move", from: file2From, to: file2To, reason: "sort" },
  ]);

  const undone = await undoJournal(tempDir);

  expect(undone).toBe(2);
  expect(await Bun.file(file1From).exists()).toBe(true);
  expect(await Bun.file(file1To).exists()).toBe(false);
  expect(await Bun.file(file2From).exists()).toBe(true);
  expect(await Bun.file(file2To).exists()).toBe(false);
  expect(await Bun.file(journalPath(tempDir)).exists()).toBe(false);
  expect(await Bun.file(path.join(tempDir, JOURNAL_DIR_NAME)).exists()).toBe(
    false,
  );
});

test("partial undo persists remaining actions and allows retry", async () => {
  const file1From = path.join(tempDir, "a.txt");
  const file1To = path.join(tempDir, "dir1", "a.txt");
  const file2From = path.join(tempDir, "b.txt");
  const file2To = path.join(tempDir, "dir2", "b.txt");

  await mkdir(path.dirname(file1To), { recursive: true });
  await writeFile(file1To, "content a");
  // file2To missing so the last journal action fails on first undo attempt

  await writeJournal(tempDir, [
    { kind: "move", from: file1From, to: file1To, reason: "sort" },
    { kind: "move", from: file2From, to: file2To, reason: "sort" },
  ]);

  try {
    await undoJournal(tempDir);
    throw new Error("expected undoJournal to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("MULTIPLE");
  }

  expect(await Bun.file(journalPath(tempDir)).exists()).toBe(true);
  const entry = await readJournal(tempDir);
  expect(entry.actions.length).toBe(1);
  expect(entry.actions[0]).toEqual({
    kind: "move",
    from: file2From,
    to: file2To,
    reason: "sort",
  });

  expect(await Bun.file(file1From).exists()).toBe(true);
  expect(await Bun.file(file1To).exists()).toBe(false);

  await mkdir(path.dirname(file2To), { recursive: true });
  await writeFile(file2To, "content b");

  const undone = await undoJournal(tempDir);

  expect(undone).toBe(1);
  expect(await Bun.file(file2From).exists()).toBe(true);
  expect(await Bun.file(file2To).exists()).toBe(false);
  expect(await Bun.file(journalPath(tempDir)).exists()).toBe(false);
});

test("undo refuses overwrite when original path already exists", async () => {
  const from = path.join(tempDir, "original.txt");
  const to = path.join(tempDir, "Documents", "original.txt");

  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, "moved content");
  await writeFile(from, "recreated content");

  await writeJournal(tempDir, [{ kind: "move", from, to, reason: "sort" }]);

  try {
    await undoJournal(tempDir);
    throw new Error("expected undoJournal to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("MULTIPLE");
    expect((e as FileOrganizerError).message).toContain(
      "destination already exists",
    );
  }

  expect(await Bun.file(to).text()).toBe("moved content");
  expect(await Bun.file(from).text()).toBe("recreated content");

  const entry = await readJournal(tempDir);
  expect(entry.actions).toEqual([{ kind: "move", from, to, reason: "sort" }]);
});
