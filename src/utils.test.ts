import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUniqueFilename } from "./utils.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fortify-utils-"));
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

test("directory blocks preferred name", async () => {
  await mkdir(path.join(tempDir, "report.pdf"));

  const result = await resolveUniqueFilename(
    "report",
    "pdf",
    tempDir,
    new Set(),
    "report.pdf",
  );

  expect(result).toBe("report_1.pdf");
});

test("file blocks preferred name", async () => {
  await writeFile(path.join(tempDir, "report.pdf"), "content");

  const result = await resolveUniqueFilename(
    "report",
    "pdf",
    tempDir,
    new Set(),
    "report.pdf",
  );

  expect(result).toBe("report_1.pdf");
});

test("free preferred name returned unchanged", async () => {
  const result = await resolveUniqueFilename(
    "report",
    "pdf",
    tempDir,
    new Set(),
    "report.pdf",
  );

  expect(result).toBe("report.pdf");
});
