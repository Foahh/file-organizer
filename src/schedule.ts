import { chmod, unlink } from "node:fs/promises";
import { FileOrganizerError } from "./errors.ts";
import {
  ensureConfigDir,
  getLogPath,
  getRunnerPath,
  getSelfInvocation,
  type InstallState,
  quoteUnixShellArg,
  TASK_NAME,
} from "./paths.ts";

export interface Interval {
  unit: "minute" | "hour" | "day";
  every: number;
  raw: string;
}

export function parseEvery(input: string): Interval {
  const normalized = input.trim().toLowerCase();
  if (normalized === "hourly") {
    return { unit: "hour", every: 1, raw: input };
  }
  if (normalized === "daily") {
    return { unit: "day", every: 1, raw: input };
  }

  const match = normalized.match(
    /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/,
  );
  if (!match?.[1] || !match[2]) {
    throw FileOrganizerError.configParse(
      `invalid --every value "${input}". Use e.g. 30m, 1h, 6h, 1d, hourly, daily`,
    );
  }

  const every = Number(match[1]);
  if (!Number.isFinite(every) || every < 1) {
    throw FileOrganizerError.configParse(
      `--every must be a positive integer interval`,
    );
  }

  const unitToken = match[2];
  let unit: Interval["unit"];
  if (unitToken.startsWith("m")) {
    unit = "minute";
  } else if (unitToken.startsWith("h")) {
    unit = "hour";
  } else {
    unit = "day";
  }

  if (unit === "minute" && every > 59) {
    throw FileOrganizerError.configParse(
      `--every minutes must be 1-59 (got ${every})`,
    );
  }
  if (unit === "hour" && every > 23) {
    throw FileOrganizerError.configParse(
      `--every hours must be 1-23 (got ${every})`,
    );
  }

  return { unit, every, raw: input };
}

export function formatInterval(interval: Interval): string {
  if (interval.unit === "minute") {
    return `every ${interval.every} minute(s)`;
  }
  if (interval.unit === "hour") {
    return `every ${interval.every} hour(s)`;
  }
  return interval.every === 1 ? "daily" : `every ${interval.every} day(s)`;
}

export async function writeRunnerScript(
  directory: string,
  config: string,
): Promise<string> {
  await ensureConfigDir();
  const runner = getRunnerPath();
  const log = getLogPath();
  const invoke = getSelfInvocation(["apply", "-d", directory, "-c", config]);

  if (process.platform === "win32") {
    const content = `@echo off\r\n${invoke} >> "${log}" 2>&1\r\n`;
    await Bun.write(runner, content);
  } else {
    const content = `#!/bin/sh\n${invoke} >> "${log}" 2>&1\n`;
    await Bun.write(runner, content);
    await chmod(runner, 0o755);
  }
  return runner;
}

async function scheduleWindows(
  interval: Interval,
  runner: string,
): Promise<void> {
  const sc =
    interval.unit === "minute"
      ? "MINUTE"
      : interval.unit === "hour"
        ? "HOURLY"
        : "DAILY";
  const mo = String(interval.every);
  const tr = runner.includes(" ") ? `"${runner}"` : runner;

  const result =
    interval.unit === "day"
      ? await Bun.$`schtasks /Create /F /TN ${TASK_NAME} /TR ${tr} /SC ${sc} /MO ${mo} /ST 09:00`
          .nothrow()
          .quiet()
      : await Bun.$`schtasks /Create /F /TN ${TASK_NAME} /TR ${tr} /SC ${sc} /MO ${mo}`
          .nothrow()
          .quiet();

  if (result.exitCode !== 0) {
    throw FileOrganizerError.io(
      `schtasks failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  }
}

async function unscheduleWindows(): Promise<boolean> {
  const result = await Bun.$`schtasks /Delete /F /TN ${TASK_NAME}`
    .nothrow()
    .quiet();
  return result.exitCode === 0;
}

async function isScheduledWindows(): Promise<boolean> {
  const result = await Bun.$`schtasks /Query /TN ${TASK_NAME}`
    .nothrow()
    .quiet();
  return result.exitCode === 0;
}

const CRON_BEGIN = "# BEGIN FORTIFY";
const CRON_END = "# END FORTIFY";

function cronExpression(interval: Interval): string {
  if (interval.unit === "minute") {
    return `*/${interval.every} * * * *`;
  }
  if (interval.unit === "hour") {
    return interval.every === 1 ? `0 * * * *` : `0 */${interval.every} * * *`;
  }
  return interval.every === 1 ? `0 9 * * *` : `0 9 */${interval.every} * *`;
}

async function readCrontab(): Promise<string> {
  const result = await Bun.$`crontab -l`.nothrow().quiet();
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout.toString();
}

async function writeCrontab(content: string): Promise<void> {
  const trimmed = content.replace(/\n+$/, "");
  const payload = trimmed ? `${trimmed}\n` : "\n";
  const tmp = `${getRunnerPath()}.crontab.tmp`;
  await Bun.write(tmp, payload);
  try {
    const result = await Bun.$`crontab ${tmp}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      throw FileOrganizerError.io(
        `crontab update failed: ${result.stderr.toString().trim()}`,
      );
    }
  } finally {
    try {
      await unlink(tmp);
    } catch {
      // ignore
    }
  }
}

function stripFortifyCron(crontab: string): string {
  const lines = crontab.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === CRON_BEGIN) {
      skipping = true;
      continue;
    }
    if (line.trim() === CRON_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n");
}

export function formatCronJobLine(interval: Interval, runner: string): string {
  return `${cronExpression(interval)} ${quoteUnixShellArg(runner)}`;
}

async function scheduleCron(interval: Interval, runner: string): Promise<void> {
  const existing = await readCrontab();
  const base = stripFortifyCron(existing);
  const block = [
    CRON_BEGIN,
    formatCronJobLine(interval, runner),
    CRON_END,
  ].join("\n");
  const next = base ? `${base}\n${block}\n` : `${block}\n`;
  await writeCrontab(next);
}

async function unscheduleCron(): Promise<boolean> {
  const existing = await readCrontab();
  if (!existing.includes(CRON_BEGIN)) {
    return false;
  }
  await writeCrontab(stripFortifyCron(existing));
  return true;
}

async function isScheduledCron(): Promise<boolean> {
  const existing = await readCrontab();
  return existing.includes(CRON_BEGIN);
}

export async function enableSchedule(
  state: Pick<InstallState, "directory" | "config">,
  every: string,
): Promise<{ interval: Interval; runner: string }> {
  const interval = parseEvery(every);
  const runner = await writeRunnerScript(state.directory, state.config);

  if (process.platform === "win32") {
    await scheduleWindows(interval, runner);
  } else {
    await scheduleCron(interval, runner);
  }

  return { interval, runner };
}

export async function disableSchedule(): Promise<boolean> {
  let removed: boolean;
  if (process.platform === "win32") {
    removed = await unscheduleWindows();
  } else {
    removed = await unscheduleCron();
  }

  try {
    await unlink(getRunnerPath());
  } catch {
    // ignore
  }

  return removed;
}

export async function isScheduleActive(): Promise<boolean> {
  if (process.platform === "win32") {
    return isScheduledWindows();
  }
  return isScheduledCron();
}
