import type { PlanAction } from "./plan.ts";

export type ErrorCode =
  | "IO"
  | "CONFIG_PARSE"
  | "DIRECTORY_NOT_FOUND"
  | "CONFIG_NOT_FOUND"
  | "JOURNAL_NOT_FOUND"
  | "MULTIPLE";

export class FileOrganizerError extends Error {
  code: ErrorCode;
  errors?: FileOrganizerError[];
  completed?: PlanAction[];

  constructor(code: ErrorCode, message: string, errors?: FileOrganizerError[]) {
    super(message);
    this.name = "FileOrganizerError";
    this.code = code;
    this.errors = errors;
  }

  static io(message: string): FileOrganizerError {
    return new FileOrganizerError("IO", `IO error: ${message}`);
  }

  static configParse(message: string): FileOrganizerError {
    return new FileOrganizerError(
      "CONFIG_PARSE",
      `Failed to parse config: ${message}`,
    );
  }

  static directoryNotFound(path: string): FileOrganizerError {
    return new FileOrganizerError(
      "DIRECTORY_NOT_FOUND",
      `Directory not found: ${path}`,
    );
  }

  static configNotFound(path: string): FileOrganizerError {
    return new FileOrganizerError(
      "CONFIG_NOT_FOUND",
      `Config file not found: ${path}`,
    );
  }

  static journalNotFound(path: string): FileOrganizerError {
    return new FileOrganizerError(
      "JOURNAL_NOT_FOUND",
      `No journal found to undo: ${path}`,
    );
  }

  static multiple(
    errors: FileOrganizerError[],
    completed?: PlanAction[],
  ): FileOrganizerError {
    const messages = errors.map((e) => `  - ${e.message}`).join("\n");
    const err = new FileOrganizerError(
      "MULTIPLE",
      `Multiple errors occurred:\n${messages}`,
      errors,
    );
    err.completed = completed;
    return err;
  }
}
