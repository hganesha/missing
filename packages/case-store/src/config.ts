export type CaseStoreSchemas = {
  core: string;
  ledger: string;
  evidence: string;
};

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function schemaName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (!SQL_IDENTIFIER.test(normalized)) throw new Error(`case_store.schema_invalid:${normalized}`);
  return normalized;
}

export function caseStoreSchemas(env: NodeJS.ProcessEnv = process.env): CaseStoreSchemas {
  return {
    core: schemaName(env.CASE_CORE_SCHEMA, "case_core"),
    ledger: schemaName(env.CASE_LEDGER_SCHEMA, "case_ledger"),
    evidence: schemaName(env.EVIDENCE_SCHEMA, "evidence"),
  };
}

export function quoteIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`case_store.schema_invalid:${identifier}`);
  return `"${identifier}"`;
}

export function qualify(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function renderMigration(source: string, schemas: CaseStoreSchemas): string {
  return source
    .replaceAll("{{CASE_CORE_SCHEMA}}", quoteIdentifier(schemas.core))
    .replaceAll("{{CASE_LEDGER_SCHEMA}}", quoteIdentifier(schemas.ledger))
    .replaceAll("{{EVIDENCE_SCHEMA}}", quoteIdentifier(schemas.evidence));
}
