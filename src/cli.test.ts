import { expect, test } from "bun:test";
import path from "node:path";
import { formatPartialApplyMessage } from "./cli.ts";
import { JOURNAL_DIR_NAME } from "./journal.ts";

test("formatPartialApplyMessage includes count, journal path, and undo hint", () => {
  const directory = "C:\\Users\\a\\Downloads";
  const message = formatPartialApplyMessage(directory, 2);
  const journalPath = path.join(directory, JOURNAL_DIR_NAME, "last-run.json");
  expect(message).toContain("Applied 2 action(s) before errors.");
  expect(message).toContain(`Journal: ${journalPath}`);
  expect(message).toContain(`fortify undo -d ${directory}`);
});
