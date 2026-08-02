import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * Returns a filename that does not collide with existing files on disk
 * or paths already reserved by the current plan.
 * If `preferred` is free, returns it; otherwise stem_1.ext, stem_2.ext, ...
 */
export async function resolveUniqueFilename(
  stem: string,
  ext: string,
  targetDir: string,
  reserved: Set<string>,
  preferred?: string,
): Promise<string> {
  if (preferred) {
    const preferredPath = path.join(targetDir, preferred);
    if (!reserved.has(preferredPath) && !existsSync(preferredPath)) {
      return preferred;
    }
  }

  for (let counter = 1; ; counter++) {
    const filename = ext ? `${stem}_${counter}.${ext}` : `${stem}_${counter}`;
    const fullPath = path.join(targetDir, filename);
    if (!reserved.has(fullPath) && !existsSync(fullPath)) {
      return filename;
    }
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  const stream = Bun.file(filePath).stream();

  for await (const chunk of stream) {
    hasher.update(chunk);
  }

  return hasher.digest("hex");
}

/** Look up category folder for an extension (exact then precompiled globs). */
export function lookupCategory(
  ext: string,
  mapping: Map<string, string>,
  mappingGlobs: { glob: Bun.Glob; folder: string }[] = [],
): string | undefined {
  const normalized = ext.toLowerCase();
  const exact = mapping.get(normalized);
  if (exact) {
    return exact;
  }

  for (const { glob, folder } of mappingGlobs) {
    if (glob.match(normalized)) {
      return folder;
    }
  }

  return undefined;
}
