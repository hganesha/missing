import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Replaces a generated file in one step: write a sibling temporary file, then rename it over
 * the target. Readers never see a partial file, and a symlink planted at the target between
 * a freshness check and the write is replaced rather than written through.
 */
export function writeFileAtomic(path, content, options = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', ...(options.mode ? { mode: options.mode } : {}) });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
