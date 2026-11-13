import type { ContextBinding, ContextConnection } from "@ehf/contracts";

// Scan once instead of using whitespace-heavy regular expressions with overlapping
// repetitions. The parser must remain bounded even for adversarial draft queries.
function queryTokens(query: string): string[] {
  if (query.length > 16000)
    throw new Error("context_source.query_not_read_only");
  const tokens: string[] = [];
  for (let i = 0; i < query.length; ) {
    const char = query[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if ("*,=:".includes(char)) {
      tokens.push(char);
      i++;
      continue;
    }
    const start = i;
    while (i < query.length && /[A-Za-z0-9_.]/.test(query[i]!)) i++;
    if (i === start) throw new Error("context_source.query_not_read_only");
    tokens.push(query.slice(start, i));
  }
  return tokens;
}

/** A deliberately small SELECT grammar. No functions, expressions, comments, CTEs,
 * multiple statements or caller-controlled identifiers reach a database driver. */
export function contextReadQuery(
  connection: ContextConnection,
  binding: ContextBinding,
  values: Record<string, unknown>,
  options: {
    exactNumericColumns?: ReadonlySet<string>;
    knownColumns?: ReadonlySet<string>;
  } = {},
): {
  text: string;
  values: unknown[];
  named: Array<{ name: string; value: unknown }>;
} {
  const tokens = queryTokens(binding.query);
  let position = 0;
  const take = () => tokens[position++];
  const keyword = (word: string) => {
    if (take()?.toLowerCase() !== word)
      throw new Error("context_source.query_not_read_only");
  };
  const identifier = () => {
    const value = take();
    if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
      throw new Error("context_source.query_not_read_only");
    return value;
  };
  keyword("select");
  const selected: string[] = [];
  const wildcard = tokens[position] === "*";
  if (wildcard) take();
  else {
    selected.push(identifier());
    while (tokens[position] === ",") {
      take();
      selected.push(identifier());
    }
  }
  keyword("from");
  const relation = take();
  if (!relation || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(relation))
    throw new Error("context_source.query_not_read_only");
  const { resource, provider } = connection;
  const tds = provider === "fabric" || provider === "sqlserver";
  const scope = [
    provider === "databricks"
      ? resource.catalog
      : provider === "bigquery"
        ? resource.project
        : "",
    resource.schema,
    resource.object,
  ].filter(Boolean);
  if (relation !== resource.object && relation !== scope.join("."))
    throw new Error("context_source.query_scope_denied");
  if (scope.some((part) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part)))
    throw new Error("context_source.resource_invalid");
  const quote = (name: string) =>
    tds
      ? `[${name}]`
      : provider === "databricks" || provider === "bigquery"
        ? `\`${name}\``
        : `"${name}"`;
  const columnName = (name: string) => {
    // Require discovered spelling so case-insensitive SQL lookup cannot bypass
    // the exact-number projection, or silently select a different column.
    if (options.knownColumns && !options.knownColumns.has(name))
      throw new Error("context_source.column_unknown");
    return quote(name);
  };
  const from =
    provider === "bigquery"
      ? `\`${scope.join(".")}\``
      : scope.map(quote).join(".");
  const named: Array<{ name: string; value: unknown }> = [];
  const clauses: string[] = [];
  if (position < tokens.length) {
    keyword("where");
    for (;;) {
      const column = identifier();
      if (take() !== "=" || take() !== ":")
        throw new Error("context_source.query_predicate_invalid");
      const name = identifier();
      const parameter = binding.parameters.find((p) => p.name === name);
      if (
        !parameter ||
        !Object.hasOwn(values, name) ||
        typeof values[name] !== parameter.type
      )
        throw new Error("context_source.parameter_invalid");
      named.push({ name, value: values[name] });
      clauses.push(
        `${columnName(column)} = ${provider === "postgresql" ? `$${named.length}` : provider === "snowflake" ? "?" : tds || provider === "bigquery" ? `@${name}` : `:${name}`}`,
      );
      if (position === tokens.length) break;
      keyword("and");
    }
  }
  if (
    Object.keys(values).some(
      (name) => !binding.parameters.some((p) => p.name === name),
    ) ||
    binding.parameters.some((p) => p.required && !Object.hasOwn(values, p.name))
  )
    throw new Error("context_source.parameter_invalid");
  if (binding.parameters.some((p) => !named.some((n) => n.name === p.name)))
    throw new Error("context_source.parameter_unused");
  const project = (column: string) =>
    tds && options.exactNumericColumns?.has(column)
      ? `CONVERT(nvarchar(128), ${columnName(column)}, 2) AS ${quote(column)}`
      : columnName(column);
  const columns = wildcard
    ? [
        ...new Set([
          binding.keyField,
          binding.observedAtField,
          ...(binding.subjectField ? [binding.subjectField] : []),
          ...binding.mapping.map((mapping) => mapping.source),
        ]),
      ]
        .map(project)
        .join(", ")
    : selected.map(project).join(", ");
  const limit = binding.maximumRows + 1;
  return {
    text: `SELECT ${tds ? `TOP (${limit}) ` : ""}${columns} FROM ${from}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}${tds ? "" : ` LIMIT ${limit}`}`,
    values: named.map((p) => p.value),
    named,
  };
}
