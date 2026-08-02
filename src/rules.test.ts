import { expect, test } from "bun:test";
import path from "node:path";
import { FileOrganizerError } from "./errors.ts";
import { assertSafeRelativeFolder, resolveDestination } from "./rules.ts";
import { lookupCategory } from "./utils.ts";

test("assertSafeRelativeFolder accepts nested destination", () => {
  expect(assertSafeRelativeFolder("Pictures/Screenshots")).toBe(
    path.join("Pictures", "Screenshots"),
  );
});

test("assertSafeRelativeFolder accepts simple folder", () => {
  expect(assertSafeRelativeFolder("Documents")).toBe("Documents");
});

test("assertSafeRelativeFolder rejects parent escape chain", () => {
  expect(() => assertSafeRelativeFolder("Foo/../../../Outside")).toThrow(
    FileOrganizerError,
  );
  try {
    assertSafeRelativeFolder("Foo/../../../Outside");
  } catch (e) {
    expect(e).toBeInstanceOf(FileOrganizerError);
    expect((e as FileOrganizerError).code).toBe("CONFIG_PARSE");
  }
});

test("assertSafeRelativeFolder rejects leading .. segment", () => {
  expect(() => assertSafeRelativeFolder("../Outside")).toThrow(
    FileOrganizerError,
  );
});

test("assertSafeRelativeFolder rejects absolute path", () => {
  const absolute = process.platform === "win32" ? "C:\\Outside" : "/etc/passwd";
  expect(() => assertSafeRelativeFolder(absolute)).toThrow(FileOrganizerError);
});

test("resolveDestination uses compiled rule and mapping globs", () => {
  const mapping = new Map<string, string>([
    ["pdf", "Documents"],
    ["r0*", "Compressed"],
  ]);
  const mappingGlobs = [
    {
      pattern: "r0*",
      glob: new Bun.Glob("r0*"),
      folder: "Compressed",
    },
  ];
  const rules = [
    {
      name: "screenshots",
      match: ["Screenshot*"],
      matchGlobs: [new Bun.Glob("Screenshot*")],
      folder: "Pictures",
    },
  ];

  expect(
    resolveDestination("Screenshot_1.png", "png", rules, mapping, mappingGlobs),
  ).toEqual({ folder: "Pictures", ruleName: "screenshots" });

  expect(
    resolveDestination("archive.r01", "r01", rules, mapping, mappingGlobs),
  ).toEqual({ folder: "Compressed" });

  expect(lookupCategory("r01", mapping, mappingGlobs)).toBe("Compressed");
  expect(lookupCategory("pdf", mapping, mappingGlobs)).toBe("Documents");
});
