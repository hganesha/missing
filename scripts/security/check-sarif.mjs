import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function countFindings(document) {
  if (document.version !== '2.1.0' || !Array.isArray(document.runs) || document.runs.length === 0) throw new Error('Invalid or empty SARIF');
  let count = 0;
  for (const run of document.runs) {
    if (!Array.isArray(run.results)) throw new Error('Missing SARIF results');
    if (run.invocations?.some((entry) => entry.executionSuccessful === false)) throw new Error('SAST execution failed');
    // No blanket severity or inline suppression escape hatch at promotion time.
    count += run.results.length;
  }
  return count;
}

/** One line per finding (rule, location, message) so the job log says what to fix. */
export function describeFindings(document) {
  return document.runs.flatMap((run) => run.results.map((result) => {
    const location = result.locations?.[0]?.physicalLocation;
    const where = location?.artifactLocation?.uri ? `${location.artifactLocation.uri}:${location.region?.startLine ?? '?'}` : '<no location>';
    const message = String(result.message?.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
    return `${result.ruleId ?? result.rule?.id ?? 'unknown-rule'}  ${where}  ${message}`;
  }));
}

if (process.argv[1]?.endsWith('/check-sarif.mjs')) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: check-sarif.mjs SARIF_DIRECTORY');
  const files = readdirSync(directory).filter((file) => file.endsWith('.sarif'));
  if (files.length === 0) throw new Error('SAST report missing');
  let count = 0;
  for (const file of files) {
    const document = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    count += countFindings(document);
    for (const line of describeFindings(document)) console.log(line);
  }
  console.log(`SAST findings: ${count}`);
  if (count !== 0) process.exitCode = 1;
}
