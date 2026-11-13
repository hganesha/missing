#!/usr/bin/env -S npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compilePackage, COMPILER_NAME, COMPILER_VERSION, validatePackage } from "./compiler.js";
import { CompilerError } from "./errors.js";

const USAGE = `Usage: ${COMPILER_NAME} <command>

Commands:
  compile <package-dir> --out <file> [--model-profiles <file>]
      Compile a domain package into a plan; prints the plan digest.
      --model-profiles defaults to config/model-profiles.json.
  validate <package-dir>
      Check the package rules and print the LGIR analysis of its workflow.
  --version
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

/** Parse `<positional> [--flag value | --flag=value | -o value]...`. */
function parseArguments(args: string[], flags: Record<string, string>): { positional: string[]; values: Map<string, string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const [flagText, inline] = argument.startsWith("-") ? argument.split(/=(.*)/s, 2) as [string, string | undefined] : [argument, undefined];
    const flag = flags[flagText];
    if (argument.startsWith("-") && argument !== "-") {
      if (!flag) fail(`unexpected argument '${argument}'\n\n${USAGE}`, 2);
      const value = inline ?? args[(index += 1)];
      if (value === undefined) fail(`a value is required for '${flagText}'\n\n${USAGE}`, 2);
      if (values.has(flag)) fail(`the argument '${flagText}' cannot be used multiple times`, 2);
      values.set(flag, value);
    } else {
      positional.push(argument);
    }
  }
  return { positional, values };
}

export function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${COMPILER_NAME} ${COMPILER_VERSION}\n`);
    return;
  }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  try {
    if (command === "compile") {
      const { positional, values } = parseArguments(rest, { "--out": "out", "-o": "out", "--model-profiles": "modelProfiles" });
      const [packageDir, ...extra] = positional;
      if (!packageDir || extra.length > 0) fail(`compile takes one package directory\n\n${USAGE}`, 2);
      const out = values.get("out");
      if (!out) fail(`--out is required\n\n${USAGE}`, 2);
      const compiled = compilePackage(packageDir, { modelProfiles: values.get("modelProfiles") ?? "config/model-profiles.json" });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, compiled.document);
      process.stdout.write(`${compiled.planDigest}\n`);
      return;
    }
    if (command === "validate") {
      const { positional } = parseArguments(rest, {});
      const [packageDir, ...extra] = positional;
      if (!packageDir || extra.length > 0) fail(`validate takes one package directory\n\n${USAGE}`, 2);
      const result = validatePackage(packageDir);
      process.stdout.write(`${result.report}\n`);
      if (!result.ok) fail("LGIR validation failed");
      return;
    }
    fail(`unrecognized command '${command}'\n\n${USAGE}`, 2);
  } catch (error) {
    if (error instanceof CompilerError) fail(error.message);
    throw error;
  }
}

main(process.argv.slice(2));
