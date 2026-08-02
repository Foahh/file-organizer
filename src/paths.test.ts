import { expect, test } from "bun:test";
import { quoteUnixShellArg, quoteWindowsCmdArg } from "./paths.ts";

const windowsCases: { input: string; expected: string }[] = [
  { input: "C:\\Users\\a\\Downloads", expected: '"C:\\Users\\a\\Downloads"' },
  {
    input: "C:\\Users\\a\\My Downloads",
    expected: '"C:\\Users\\a\\My Downloads"',
  },
  { input: "C:\\Users\\a\\foo&bar", expected: '"C:\\Users\\a\\foo&bar"' },
  { input: "C:\\Users\\a\\foo|bar", expected: '"C:\\Users\\a\\foo|bar"' },
  {
    input: 'C:\\Users\\a\\say"hello',
    expected: '"C:\\Users\\a\\say""hello"',
  },
  {
    input: "C:\\Users\\a\\%TEMP%\\file",
    expected: '"C:\\Users\\a\\%%TEMP%%\\file"',
  },
];

for (const { input, expected } of windowsCases) {
  test(`quoteWindowsCmdArg: ${input}`, () => {
    expect(quoteWindowsCmdArg(input)).toBe(expected);
  });
}

const unixCases: { input: string; expected: string }[] = [
  {
    input: "/home/user/.config/fortify/run.sh",
    expected: "'/home/user/.config/fortify/run.sh'",
  },
  {
    input: "/home/user/My Config/fortify/run.sh",
    expected: "'/home/user/My Config/fortify/run.sh'",
  },
  {
    input: "/home/user/it's/run.sh",
    expected: `'/home/user/it'\\''s/run.sh'`,
  },
  {
    input: "/tmp/evil;rm -rf /",
    expected: "'/tmp/evil;rm -rf /'",
  },
  {
    input: "/tmp/$HOME/run.sh",
    expected: "'/tmp/$HOME/run.sh'",
  },
];

for (const { input, expected } of unixCases) {
  test(`quoteUnixShellArg: ${input}`, () => {
    expect(quoteUnixShellArg(input)).toBe(expected);
  });
}
