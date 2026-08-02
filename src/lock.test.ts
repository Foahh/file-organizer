import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { FileOrganizerError } from "./errors.ts";
import { acquireTargetLock, lockPath, withTargetLock } from "./lock.ts";
import { Organizer } from "./organizer.ts";
import { addMove, createEmptyPlan } from "./plan.ts";

const RULES_PATH = path.join(import.meta.dir, "..", "rules.toml");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fortify-lock-"));
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

test("second acquire throws while lock is held", async () => {
  const release = await acquireTargetLock(tempDir);
  try {
    expect(await Bun.file(lockPath(tempDir)).exists()).toBe(true);
    try {
      await withTargetLock(tempDir, async () => "should-not-run");
      throw new Error("expected withTargetLock to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FileOrganizerError);
      expect((e as FileOrganizerError).code).toBe("IO");
      expect((e as FileOrganizerError).message).toContain(
        "another fortify apply/undo is in progress",
      );
    }
  } finally {
    await release();
  }
});

test("after release, second acquire succeeds", async () => {
  const release = await acquireTargetLock(tempDir);
  await release();

  let ran = false;
  const result = await withTargetLock(tempDir, async () => {
    ran = true;
    return 42;
  });
  expect(ran).toBe(true);
  expect(result).toBe(42);
  expect(await Bun.file(lockPath(tempDir)).exists()).toBe(false);
});

test("applyPlan fails with lock error when lock held", async () => {
  const sourcePath = path.join(tempDir, "report.pdf");
  await writeFile(sourcePath, "lock-test-content");

  const config = await loadConfig(tempDir, RULES_PATH);
  const organizer = await Organizer.create(config);
  const plan = createEmptyPlan();
  addMove(
    plan,
    sourcePath,
    path.join(tempDir, "Documents", "report.pdf"),
    "sort",
  );

  const release = await acquireTargetLock(tempDir);
  try {
    try {
      await organizer.applyPlan(plan);
      throw new Error("expected applyPlan to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FileOrganizerError);
      expect((e as FileOrganizerError).code).toBe("IO");
      expect((e as FileOrganizerError).message).toContain(
        "another fortify apply/undo is in progress",
      );
    }
    // Source must remain untouched (fail before mutate)
    expect(await Bun.file(sourcePath).exists()).toBe(true);
  } finally {
    await release();
  }
});
