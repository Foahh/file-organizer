import path from "node:path";
import type { MappingGlob, NamedRule } from "./rules.ts";
import { isUnderDestination, resolveDestination } from "./rules.ts";

export class FileEntry {
  path: string;

  constructor(filePath: string) {
    this.path = filePath;
  }

  /**
   * Sorted if ignored, or already under the resolved destination folder
   * (path prefix — preserves nesting inside that folder).
   */
  isSorted(
    target: string,
    ignoredGlobs: Bun.Glob[],
    mapping: Map<string, string>,
    rules: NamedRule[],
    mappingGlobs: MappingGlob[] = [],
  ): boolean {
    if (this.matchGlobs(ignoredGlobs)) {
      return true;
    }

    const { folder } = resolveDestination(
      this.fileName,
      this.extension,
      rules,
      mapping,
      mappingGlobs,
    );

    const relative = path.relative(target, this.path);
    return isUnderDestination(relative, folder);
  }

  matchGlobs(globs: Bun.Glob[]): boolean {
    const fullPath = this.path.replaceAll("\\", "/");
    const name = this.fileName;
    for (const glob of globs) {
      if (glob.match(fullPath) || glob.match(name)) {
        return true;
      }
    }
    return false;
  }

  get fileName(): string {
    return path.basename(this.path);
  }

  get fileStem(): string {
    const name = this.fileName;
    const ext = path.extname(name);
    return ext ? name.slice(0, -ext.length) : name;
  }

  get extension(): string {
    const ext = path.extname(this.path);
    return ext ? ext.slice(1).toLowerCase() : "";
  }
}
