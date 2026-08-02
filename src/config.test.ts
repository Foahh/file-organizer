import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { FileOrganizerError } from "./errors.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fortify-config-"));
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

test("loadConfig rejects named-rule folder with .. escape", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
Documents = ["pdf"]

[[rules]]
name = "escape"
match = ["*.evil"]
folder = "../../Outside"
`,
  );

  try {
    await loadConfig(tempDir, configPath);
    expect.unreachable("expected loadConfig to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("CONFIG_PARSE");
    expect((e as FileOrganizerError).message).toContain("rules[0].folder");
  }
});

test("loadConfig rejects mapping folder with .. escape", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
"../Outside" = ["pdf"]
`,
  );

  try {
    await loadConfig(tempDir, configPath);
    expect.unreachable("expected loadConfig to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("CONFIG_PARSE");
    expect((e as FileOrganizerError).message).toContain("mapping folder");
  }
});

test("loadConfig rejects mapping value that is a string", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
Documents = "pdf"
`,
  );

  try {
    await loadConfig(tempDir, configPath);
    expect.unreachable("expected loadConfig to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("CONFIG_PARSE");
    expect((e as FileOrganizerError).message).toContain('mapping["Documents"]');
  }
});

test("loadConfig rejects ignore that is a string", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
ignore = "desktop.ini"

[mapping]
Documents = ["pdf"]
`,
  );

  try {
    await loadConfig(tempDir, configPath);
    expect.unreachable("expected loadConfig to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("CONFIG_PARSE");
    expect((e as FileOrganizerError).message).toContain("ignore must be");
  }
});

test("loadConfig accepts valid ignore array", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
ignore = ["desktop.ini"]

[mapping]
Documents = ["pdf"]
`,
  );

  const config = await loadConfig(tempDir, configPath);
  expect(config.ignored).toEqual(["desktop.ini"]);
  expect(config.ignoredGlobs).toHaveLength(1);
  expect(config.ignoredGlobs[0]?.match("desktop.ini")).toBe(true);
});

test("loadConfig compiles globs for ignore, named rules, and wildcard mapping", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
ignore = ["*.tmp"]

[mapping]
Documents = ["pdf"]
Compressed = ["zip", "r0*"]

[[rules]]
name = "screenshots"
match = ["Screenshot*"]
folder = "Pictures"
`,
  );

  const config = await loadConfig(tempDir, configPath);

  expect(config.ignoredGlobs).toHaveLength(1);
  expect(config.ignoredGlobs[0]?.match("notes.tmp")).toBe(true);
  expect(config.ignoredGlobs[0]?.match("notes.pdf")).toBe(false);

  expect(config.rules[0]?.matchGlobs).toHaveLength(1);
  expect(config.rules[0]?.matchGlobs[0]?.match("Screenshot_1.png")).toBe(true);
  expect(config.rules[0]?.matchGlobs[0]?.match("photo.png")).toBe(false);

  expect(config.mapping.get("pdf")).toBe("Documents");
  expect(config.mapping.get("zip")).toBe("Compressed");
  expect(config.mappingGlobs).toHaveLength(1);
  expect(config.mappingGlobs[0]?.pattern).toBe("r0*");
  expect(config.mappingGlobs[0]?.glob.match("r01")).toBe(true);
  expect(config.mappingGlobs[0]?.glob.match("zip")).toBe(false);
});

test("loadConfig accepts nested destination folders", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
"Pictures/Screenshots" = ["png"]

[[rules]]
name = "screenshots"
match = ["Screenshot*"]
folder = "Pictures/Screenshots"
`,
  );

  const config = await loadConfig(tempDir, configPath);
  const expected = path.join("Pictures", "Screenshots");
  expect(config.mapping.get("png")).toBe(expected);
  expect(config.rules[0]?.folder).toBe(expected);
  expect(config.destinations.has(expected)).toBe(true);
});

test("loadConfig registers top-level folder for nested mapping", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
"Pictures/Screenshots" = ["png"]
`,
  );

  const config = await loadConfig(tempDir, configPath);
  const nested = path.join("Pictures", "Screenshots");
  expect(config.knownFolders.has("Pictures")).toBe(true);
  expect(config.knownFolders.has(nested)).toBe(false);
  expect(config.destinations.has(nested)).toBe(true);
  expect(config.destinations.has("Pictures")).toBe(true);
});

test("loadConfig registers flat mapping folder in knownFolders", async () => {
  const configPath = path.join(tempDir, "rules.toml");
  await writeFile(
    configPath,
    `
[mapping]
Documents = ["pdf"]
`,
  );

  const config = await loadConfig(tempDir, configPath);
  expect(config.knownFolders.has("Documents")).toBe(true);
  expect(config.destinations.has("Documents")).toBe(true);
});
