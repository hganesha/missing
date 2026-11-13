import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CompilerError, refuse } from "./errors.js";
import { compareKeys } from "./json.js";

/**
 * The files of one domain package: `package.yaml`, its workflow, and every other file the
 * package carries (all of them are digested into the plan's dependency manifest).
 */

export interface PackageSource {
  /** Regular files, keyed by package-relative path with `/` separators. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Order paths component by component, each component by its bytes: the order of Rust's
 * `PathBuf`, which the dependency manifest has always used (`a/b` sorts before `a-b`).
 */
export function comparePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareKeys(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Read a package directory. Symbolic links are not followed and are not part of the
 * package, exactly as the dependency manifest has always treated them.
 */
export function directorySource(root: string): PackageSource {
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    throw new CompilerError("read package.yaml", `read package.yaml: ${(error as Error).message}`);
  }
  if (!rootStat.isDirectory()) throw new CompilerError("read package.yaml", `read package.yaml: ${root} is not a directory`);
  const files = new Map<string, Uint8Array>();
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, readRegularFile(absolute));
    }
  };
  walk(root, "");
  return { files };
}

/** An in-memory package: package-relative path to UTF-8 text or bytes. */
export function memorySource(entries: Readonly<Record<string, string | Uint8Array>>): PackageSource {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(entries)) {
    if (!safeRelativePath(path)) refuse(`package.dependency_path_unsafe:${path}`);
    files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }
  return { files };
}

/** Sorted manifest order. */
export function sortedFiles(source: PackageSource): [string, Uint8Array][] {
  return [...source.files.entries()].sort(([left], [right]) => comparePaths(left, right));
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function readText(source: PackageSource, path: string, label: string): string {
  const bytes = source.files.get(path);
  if (!bytes) throw new CompilerError(label, `${label}: ${path} not found in the package`);
  try {
    return utf8.decode(bytes);
  } catch {
    throw new CompilerError(label, `${label}: stream did not contain valid UTF-8`);
  }
}

/**
 * A package-relative dependency (policy binding source, workflow): never absolute, never
 * through `..`, and a regular file inside the package.
 */
export function packageRelativeFile(source: PackageSource, path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..")) refuse(`package.dependency_path_unsafe:${path}`);
  const normalized = path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
  if (!normalized || !source.files.has(normalized)) refuse(`package.dependency_missing:${path}`);
  return normalized;
}

/** Reads a regular file, refusing a symlink swapped in after the directory listing. */
function readRegularFile(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new CompilerError("read package.yaml", `read package.yaml: ${path} is not a regular file`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
