import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { FileOrganizerError } from "./errors.ts";
import {
  installFortify,
  printStatus,
  scheduleFortify,
  uninstallFortify,
  unscheduleFortify,
} from "./install.ts";
import { JOURNAL_DIR_NAME, undoJournal } from "./journal.ts";
import { Organizer } from "./organizer.ts";
import {
  getDefaultDirectory,
  readInstallState,
  resolveDefaultConfigPath,
} from "./paths.ts";
import { printPlan } from "./plan.ts";

const HELP = `fortify - organize files by extension into category folders

Usage:
  fortify [options]                 Preview changes (dry-run, default)
  fortify apply [options]           Apply changes and write a journal
  fortify undo [options]            Reverse the last successful apply
  fortify install [options]         Install user config (and optional schedule)
  fortify uninstall                 Remove schedule + install state
  fortify schedule --every <int>    Register a periodic apply job
  fortify unschedule                Remove the periodic job
  fortify status                    Show install / schedule status

Options:
  -d, --directory <path>   Target directory (default: ~/Downloads)
  -c, --config <path>      Rules file (default: installed or ./rules.toml)
  --every <interval>       Schedule interval: 30m, 1h, 6h, 1d, hourly, daily
  --no-sort-files          Skip sorting into category folders
  --no-move-duplicates     Skip content-hash duplicate moves
  --no-remove-empty-folders  Skip removing empty category folders
  -h, --help               Show this help

Notes:
  Nested files already under the correct category are left alone.
  Apply writes <target>/.fortify/last-run.json for undo.
  After \`fortify install --every 1h\`, applies run in the background.
`;

export type Command =
  | "dry-run"
  | "apply"
  | "undo"
  | "install"
  | "uninstall"
  | "schedule"
  | "unschedule"
  | "status";

export interface CliOptions {
  command: Command;
  directory?: string;
  config: string;
  configExplicit: boolean;
  every?: string;
  sortFiles: boolean;
  moveDuplicates: boolean;
  removeEmptyFolders: boolean;
}

const META_COMMANDS = new Set<Command>([
  "install",
  "uninstall",
  "schedule",
  "unschedule",
  "status",
]);

export async function parseCli(
  argv: string[] = process.argv.slice(2),
): Promise<CliOptions> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      directory: { type: "string", short: "d" },
      config: { type: "string", short: "c" },
      every: { type: "string" },
      "sort-files": { type: "boolean", default: true },
      "move-duplicates": { type: "boolean", default: true },
      "remove-empty-folders": { type: "boolean", default: true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const positional = positionals[0];
  let command: Command = "dry-run";
  const known: Command[] = [
    "apply",
    "undo",
    "install",
    "uninstall",
    "schedule",
    "unschedule",
    "status",
  ];
  if (positional !== undefined) {
    if ((known as string[]).includes(positional)) {
      command = positional as Command;
    } else {
      console.error(
        `Error: unknown command "${positional}". See --help for usage.`,
      );
      process.exit(1);
    }
  }

  if (command === "schedule" && !values.every) {
    console.error("Error: `schedule` requires --every <interval> (e.g. 1h).");
    process.exit(1);
  }

  const state = await readInstallState();
  const configExplicit = values.config !== undefined;
  const config = resolveDefaultConfigPath(values.config, state);

  const directory =
    values.directory ?? state?.directory ?? getDefaultDirectory();
  if (!META_COMMANDS.has(command) && !directory) {
    console.error(
      "Error: no directory specified. Use -d <path> to set the target directory.",
    );
    process.exit(1);
  }

  return {
    command,
    directory,
    config,
    configExplicit,
    every: values.every,
    sortFiles: values["sort-files"] !== false,
    moveDuplicates: values["move-duplicates"] !== false,
    removeEmptyFolders: values["remove-empty-folders"] !== false,
  };
}

export function formatPartialApplyMessage(
  directory: string,
  completedCount: number,
): string {
  const journalPath = path.join(directory, JOURNAL_DIR_NAME, "last-run.json");
  return [
    `Applied ${completedCount} action(s) before errors. Journal: ${journalPath}`,
    `You can run \`fortify undo -d ${directory}\` to reverse the applied actions.`,
  ].join("\n");
}

export async function runCli(options: CliOptions): Promise<void> {
  switch (options.command) {
    case "install":
      await installFortify({
        directory: options.directory,
        configSource: options.configExplicit ? options.config : undefined,
        every: options.every,
      });
      return;
    case "uninstall":
      await uninstallFortify();
      return;
    case "schedule": {
      if (!options.every) {
        throw FileOrganizerError.configParse(
          "`schedule` requires --every <interval>",
        );
      }
      await scheduleFortify(options.every, {
        directory: options.directory,
        config: options.config,
      });
      return;
    }
    case "unschedule":
      await unscheduleFortify();
      return;
    case "status":
      await printStatus();
      return;
    default:
      break;
  }

  if (!options.directory) {
    throw FileOrganizerError.directoryNotFound(
      "no directory specified. Use -d <path>",
    );
  }

  if (options.command === "undo") {
    const count = await undoJournal(options.directory);
    console.log(`Undo complete: ${count} action(s) reversed.`);
    return;
  }

  const config = await loadConfig(options.directory, options.config);
  const organizer = await Organizer.create(config);
  const plan = await organizer.buildPlan({
    sortFiles: options.sortFiles,
    moveDuplicates: options.moveDuplicates,
    removeEmptyFolders: options.removeEmptyFolders,
  });

  const dryRun = options.command === "dry-run";
  printPlan(plan, dryRun);

  if (dryRun) {
    if (plan.actions.length > 0) {
      console.log("\nRe-run with `apply` to execute these changes.");
    }
    return;
  }

  if (plan.actions.length === 0) {
    return;
  }

  console.log("\nApplying...");
  try {
    await organizer.applyPlan(plan);
    console.log(
      `Done. Journal written to ${path.join(options.directory, JOURNAL_DIR_NAME, "last-run.json")}`,
    );
  } catch (e) {
    if (e instanceof FileOrganizerError) {
      const completedCount = e.completed?.length ?? 0;
      if (completedCount > 0) {
        console.log(
          formatPartialApplyMessage(options.directory, completedCount),
        );
      }
    }
    handleCliError(e);
  }
}

export function handleCliError(e: unknown): never {
  if (e instanceof FileOrganizerError) {
    console.error(`Error: ${e.message}`);
  } else {
    console.error(`Error: ${e}`);
  }
  process.exit(1);
}
