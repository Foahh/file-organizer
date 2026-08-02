import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { FileOrganizerError } from "./errors.ts";
import {
  JOURNAL_DIR_NAME,
  journalPath,
  readJournal,
  undoJournal,
} from "./journal.ts";
import { Organizer } from "./organizer.ts";
import { addMove, createEmptyPlan } from "./plan.ts";

const RULES_PATH = path.join(import.meta.dir, "..", "rules.toml");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fortify-"));
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

test("apply sorts a PDF into Documents and undo restores it", async () => {
  const sourcePath = path.join(tempDir, "report.pdf");
  await writeFile(sourcePath, "smoke-pdf-content");

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  const plan = await organizer.buildPlan({
    sortFiles: true,
    moveDuplicates: false,
    removeEmptyFolders: false,
  });

  expect(plan.sortCount).toBeGreaterThanOrEqual(1);

  const sortMove = plan.actions.find(
    (a) =>
      a.kind === "move" &&
      a.reason === "sort" &&
      path.resolve(a.from) === path.resolve(sourcePath),
  );
  expect(sortMove).toBeDefined();
  if (sortMove?.kind !== "move") {
    throw new Error("expected a sort move for report.pdf");
  }

  const expectedDest = path.join(tempDir, "Documents", "report.pdf");
  expect(path.resolve(sortMove.to)).toBe(path.resolve(expectedDest));

  await organizer.applyPlan(plan);

  expect(await Bun.file(sourcePath).exists()).toBe(false);
  expect(await Bun.file(expectedDest).exists()).toBe(true);
  expect(await Bun.file(journalPath(tempDir)).exists()).toBe(true);

  const undone = await undoJournal(tempDir);

  expect(undone).toBeGreaterThanOrEqual(1);
  expect(await Bun.file(sourcePath).exists()).toBe(true);
  expect(await Bun.file(expectedDest).exists()).toBe(false);
  expect(await Bun.file(journalPath(tempDir)).exists()).toBe(false);
  expect(await Bun.file(path.join(tempDir, JOURNAL_DIR_NAME)).exists()).toBe(
    false,
  );
});

test("journal lists first move after second apply action fails", async () => {
  const file1From = path.join(tempDir, "first.txt");
  const file1To = path.join(tempDir, "Documents", "first.txt");
  const file2From = path.join(tempDir, "missing-second.txt");
  const file2To = path.join(tempDir, "Documents", "missing-second.txt");

  await writeFile(file1From, "first content");

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  const plan = createEmptyPlan();
  addMove(plan, file1From, file1To, "sort");
  addMove(plan, file2From, file2To, "sort");

  try {
    await organizer.applyPlan(plan);
    throw new Error("expected applyPlan to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("MULTIPLE");
    expect((e as FileOrganizerError).completed?.length).toBe(1);
  }

  expect(await Bun.file(file1From).exists()).toBe(false);
  expect(await Bun.file(file1To).exists()).toBe(true);

  const entry = await readJournal(tempDir);
  expect(entry.actions.length).toBe(1);
  expect(entry.actions[0]).toEqual({
    kind: "move",
    from: file1From,
    to: file1To,
    reason: "sort",
  });
});

test("different sizes produce no duplicate moves", async () => {
  const small = path.join(tempDir, "small.txt");
  const large = path.join(tempDir, "large.txt");
  await writeFile(small, "short");
  await writeFile(large, "a much longer payload that cannot share size");

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  const plan = await organizer.buildPlan({
    sortFiles: false,
    moveDuplicates: true,
    removeEmptyFolders: false,
  });

  expect(plan.duplicateCount).toBe(0);
  expect(
    plan.actions.filter((a) => a.kind === "move" && a.reason === "duplicate"),
  ).toHaveLength(0);
});

test("same size same content moves older duplicate; newer stays", async () => {
  const content = "identical-payload-bytes";
  const older = path.join(tempDir, "older.txt");
  const newer = path.join(tempDir, "newer.txt");
  await writeFile(older, content);
  await writeFile(newer, content);

  const olderTime = new Date("2020-01-01T00:00:00Z");
  const newerTime = new Date("2024-06-01T00:00:00Z");
  await utimes(older, olderTime, olderTime);
  await utimes(newer, newerTime, newerTime);

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  expect(organizer.files[0]?.path).toBe(newer);

  const plan = await organizer.buildPlan({
    sortFiles: false,
    moveDuplicates: true,
    removeEmptyFolders: false,
  });

  const dupMoves = plan.actions.filter(
    (a) => a.kind === "move" && a.reason === "duplicate",
  );
  expect(plan.duplicateCount).toBe(1);
  expect(dupMoves).toHaveLength(1);
  if (dupMoves[0]?.kind !== "move") {
    throw new Error("expected a duplicate move");
  }
  expect(path.resolve(dupMoves[0].from)).toBe(path.resolve(older));
  expect(path.resolve(dupMoves[0].to)).toBe(
    path.resolve(path.join(tempDir, "Duplicates", "older_1.txt")),
  );
});

test("same size different content produces no duplicate move", async () => {
  const a = path.join(tempDir, "alpha.txt");
  const b = path.join(tempDir, "bravo.txt");
  // Same byte length, different content
  await writeFile(a, "aaaa");
  await writeFile(b, "bbbb");

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  const plan = await organizer.buildPlan({
    sortFiles: false,
    moveDuplicates: true,
    removeEmptyFolders: false,
  });

  expect(plan.duplicateCount).toBe(0);
  expect(
    plan.actions.filter((a) => a.kind === "move" && a.reason === "duplicate"),
  ).toHaveLength(0);
});
