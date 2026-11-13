import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** One boundary for every authored reference, including tables and the corpus. */
export function readPolicySource(root: string, reference: string): string {
  if (!reference || isAbsolute(reference) || reference.includes("\\") || reference.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("policy.reference_invalid");
  }
  let fd: number | undefined;
  try {
    const base = realpathSync(root);
    let target = base;
    for (const part of reference.split("/")) {
      target = join(target, part);
      if (lstatSync(target).isSymbolicLink()) throw new Error("policy.reference_invalid");
    }
    const rel = relative(base, realpathSync(target));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("policy.reference_invalid");
    fd = openSync(resolve(base, reference), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 10_485_760) throw new Error("policy.source_size_invalid");
    // A bounded buffer also protects against a file growing after stat.
    const buffer = Buffer.alloc(10_485_761);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > 10_485_760) throw new Error("policy.source_size_invalid");
    return buffer.subarray(0, size).toString("utf8");
  } catch (error) {
    if (error instanceof Error && /^policy\.[a-z_]+$/.test(error.message)) throw error;
    throw new Error("policy.source_unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
