import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "fortify";
export const JOURNAL_DIR_NAME = ".fortify";
export const TASK_NAME = "FortifyOrganize";

export interface InstallState {
  directory: string;
  config: string;
  every?: string;
  scheduled: boolean;
  installedAt: string;
  updatedAt: string;
}

export function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, APP_NAME);
}

export function getRulesPath(): string {
  return path.join(getConfigDir(), "rules.toml");
}

export function getStatePath(): string {
  return path.join(getConfigDir(), "install.json");
}

export function getLogPath(): string {
  return path.join(getConfigDir(), "fortify.log");
}

export function getRunnerPath(): string {
  return path.join(
    getConfigDir(),
    process.platform === "win32" ? "run.cmd" : "run.sh",
  );
}

export async function ensureConfigDir(): Promise<string> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readInstallState(): Promise<InstallState | undefined> {
  const file = Bun.file(getStatePath());
  if (!(await file.exists())) {
    return undefined;
  }
  return (await file.json()) as InstallState;
}

export async function writeInstallState(state: InstallState): Promise<void> {
  await ensureConfigDir();
  await Bun.write(getStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function getDefaultDirectory(): string | undefined {
  const downloads = path.join(os.homedir(), "Downloads");
  if (existsSync(downloads)) {
    return downloads;
  }
  return undefined;
}

/** Quote a single argument for safe embedding in a `.cmd` line run by cmd.exe. */
export function quoteWindowsCmdArg(s: string): string {
  return `"${s.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

/** Quote a single argument for safe embedding in a POSIX sh / crontab command. */
export function quoteUnixShellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve the command used to invoke fortify (compiled binary or bun + script). */
export function getSelfInvocation(args: string[]): string {
  const quote = (s: string): string => {
    if (process.platform === "win32") {
      return quoteWindowsCmdArg(s);
    }
    return quoteUnixShellArg(s);
  };

  const exec = process.execPath.toLowerCase();
  const isCompiled =
    Bun.main === process.execPath ||
    exec.endsWith(`${path.sep}fortify`) ||
    exec.endsWith(`${path.sep}fortify.exe`) ||
    /[/\\]fortify(\.exe)?$/i.test(process.execPath);

  const parts = isCompiled
    ? [process.execPath, ...args]
    : [process.execPath, path.join(import.meta.dir, "index.ts"), ...args];

  return parts.map(quote).join(" ");
}

export async function findBundledRules(): Promise<string | undefined> {
  const candidates: string[] = [
    path.join(import.meta.dir, "..", "rules.toml"),
    path.join(path.dirname(process.execPath), "rules.toml"),
  ];
  if (Bun.main) {
    candidates.unshift(path.join(path.dirname(Bun.main), "..", "rules.toml"));
    candidates.unshift(path.join(path.dirname(Bun.main), "rules.toml"));
  }
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve rules path: explicit -c, then install state, then user config, then cwd.
 */
export function resolveDefaultConfigPath(
  explicit: string | undefined,
  state: InstallState | undefined,
): string {
  if (explicit !== undefined && explicit !== "rules.toml") {
    return explicit;
  }
  if (explicit === "rules.toml" && existsSync("rules.toml")) {
    return path.resolve("rules.toml");
  }
  if (state?.config && existsSync(state.config)) {
    return state.config;
  }
  const installed = getRulesPath();
  if (existsSync(installed)) {
    return installed;
  }
  return explicit ?? "rules.toml";
}
