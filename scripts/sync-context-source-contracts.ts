import { canonicalTypeDescriptors } from "../packages/library-contracts/src/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { contextSourceJsonSchemas } from "../packages/contracts/src/context-sources.js";
const path = new URL(
  "../apps/fincrime-host/docs/ui/contracts/context-sources.schema.json",
  import.meta.url,
);
const content =
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft-07/schema#",
      $defs: contextSourceJsonSchemas(),
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== content)
    throw new Error("context_source.contract_drift");
} else writeFileSync(path, content);

const canonicalPath = new URL(
  "../apps/fincrime-host/docs/ui/contracts/fixtures/context-canonical-types.json",
  import.meta.url,
);
const metadata = JSON.stringify(canonicalTypeDescriptors(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(canonicalPath, "utf8") !== metadata)
    throw new Error("context_source.canonical_metadata_drift");
} else writeFileSync(canonicalPath, metadata);
