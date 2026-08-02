import { copyFile, unlink } from "node:fs/promises";
import { FileOrganizerError } from "./errors.ts";
import {
  ensureConfigDir,
  findBundledRules,
  getConfigDir,
  getDefaultDirectory,
  getLogPath,
  getRulesPath,
  getStatePath,
  type InstallState,
  readInstallState,
  writeInstallState,
} from "./paths.ts";
import {
  disableSchedule,
  enableSchedule,
  formatInterval,
  isScheduleActive,
  parseEvery,
} from "./schedule.ts";

export interface InstallOptions {
  directory?: string;
  configSource?: string;
  every?: string;
}

export async function installFortify(options: InstallOptions): Promise<void> {
  const directory = options.directory ?? getDefaultDirectory();
  if (!directory) {
    throw FileOrganizerError.directoryNotFound(
      "no directory specified. Use -d <path>",
    );
  }

  await ensureConfigDir();

  const rulesDest = getRulesPath();
  const rulesFile = Bun.file(rulesDest);
  if (!(await rulesFile.exists())) {
    const source = options.configSource ?? (await findBundledRules());
    if (!source) {
      throw FileOrganizerError.configNotFound(
        "bundled rules.toml (pass -c <path> to install)",
      );
    }
    await copyFile(source, rulesDest);
    console.log(`Installed rules → ${rulesDest}`);
  } else {
    console.log(`Rules already present → ${rulesDest}`);
  }

  const now = new Date().toISOString();
  const existing = await readInstallState();
  const state: InstallState = {
    directory,
    config: rulesDest,
    every: options.every ?? existing?.every,
    scheduled: false,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };

  if (options.every) {
    parseEvery(options.every);
    const { interval } = await enableSchedule(state, options.every);
    state.scheduled = true;
    state.every = options.every;
    console.log(`Scheduled ${formatInterval(interval)} (target: ${directory})`);
  }

  await writeInstallState(state);
  console.log(`Config dir: ${getConfigDir()}`);
  console.log(`State: ${getStatePath()}`);
  if (!options.every) {
    console.log(
      "Tip: run `fortify schedule --every 1h` to organize periodically.",
    );
  }
}

export async function uninstallFortify(): Promise<void> {
  const removed = await disableSchedule();
  if (removed) {
    console.log("Removed scheduled task.");
  } else {
    console.log("No scheduled task found.");
  }

  const state = await readInstallState();
  if (state) {
    try {
      await unlink(getStatePath());
    } catch {
      // ignore
    }
    console.log("Removed install state.");
  } else {
    console.log("No install state found.");
  }

  console.log(`Rules left at ${getRulesPath()} (delete manually if you want).`);
}

export async function scheduleFortify(
  every: string,
  overrides?: { directory?: string; config?: string },
): Promise<void> {
  const existing = await readInstallState();
  const directory =
    overrides?.directory ?? existing?.directory ?? getDefaultDirectory();
  if (!directory) {
    throw FileOrganizerError.directoryNotFound(
      "no directory specified. Use -d <path> or run `fortify install` first",
    );
  }

  let config = overrides?.config ?? existing?.config ?? getRulesPath();
  if (!(await Bun.file(config).exists())) {
    if (!existing) {
      await installFortify({ directory, every: undefined });
      config = getRulesPath();
    } else {
      throw FileOrganizerError.configNotFound(config);
    }
  }

  const { interval } = await enableSchedule({ directory, config }, every);
  const now = new Date().toISOString();
  await writeInstallState({
    directory,
    config,
    every,
    scheduled: true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  });

  console.log(`Scheduled ${formatInterval(interval)}`);
  console.log(`Target: ${directory}`);
  console.log(`Config: ${config}`);
  console.log(`Log: ${getLogPath()}`);
}

export async function unscheduleFortify(): Promise<void> {
  const removed = await disableSchedule();
  const existing = await readInstallState();
  if (existing) {
    await writeInstallState({
      ...existing,
      scheduled: false,
      every: undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  if (removed) {
    console.log("Unscheduled fortify.");
  } else {
    console.log("No schedule was registered.");
  }
}

export async function printStatus(): Promise<void> {
  const state = await readInstallState();
  const active = await isScheduleActive();

  console.log(`Config dir: ${getConfigDir()}`);
  console.log(
    `Rules: ${getRulesPath()} ${
      (await Bun.file(getRulesPath()).exists()) ? "(present)" : "(missing)"
    }`,
  );
  console.log(`Log: ${getLogPath()}`);

  if (!state) {
    console.log("Install: not installed (run `fortify install`)");
  } else {
    console.log(`Install: yes (since ${state.installedAt})`);
    console.log(`Target: ${state.directory}`);
    console.log(`Config: ${state.config}`);
    if (state.every) {
      console.log(`Interval: ${state.every}`);
    }
  }

  console.log(`Schedule: ${active ? "active" : "inactive"}`);
  if (state?.scheduled && !active) {
    console.log(
      "Warning: state says scheduled, but OS task/cron entry was not found.",
    );
  }
}
