#!/usr/bin/env bun
import { handleCliError, parseCli, runCli } from "./cli.ts";

try {
  const options = await parseCli();
  await runCli(options);
} catch (e) {
  handleCliError(e);
}
