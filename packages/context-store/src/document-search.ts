import { stableDigest } from "@ehf/contracts";
import type {
  DocumentCitation,
  DocumentSearchRequest,
} from "@ehf/contracts/document-search";
import {
  ContextStoreError,
  withContextTenant,
  type ContextStore,
} from "./index.js";

export type IndexDocument = {
  documentId: string;
  documentVersion: string;
  artifactHash: string;
  artifactRef: string;
  subjects: string[];
  purposes: string[];
  accessRoles: string[];
  residency: string;
  parserVersion: string;
  textCoverage: DocumentCitation["textCoverage"];
  pages: Array<{
    page: number;
    text: string;
    objectId: string;
    versionId: string;
  }>;
};
export const DOCUMENT_CHUNKER_VERSION = "page-codepoint.v1";
export function documentAuthorizationDigest(doc: IndexDocument) {
  return stableDigest({
    ...doc,
    subjects: [...doc.subjects].sort(),
    purposes: [...doc.purposes].sort(),
    accessRoles: [...doc.accessRoles].sort(),
    pages: [...doc.pages].sort((a, b) => a.page - b.page),
  });
}
export function prepareDocumentIndex(
  tenantId: string,
  caseId: string,
  doc: IndexDocument,
  generationKey = "default",
) {
  if (
    !/^[a-f0-9]{64}$/.test(doc.artifactHash) ||
    doc.documentVersion !== doc.artifactHash ||
    !doc.pages.length ||
    doc.pages.length > 500 ||
    !doc.subjects.length ||
    !doc.purposes.length ||
    !doc.accessRoles.length
  )
    throw new ContextStoreError("document.index_metadata_invalid");
  if (
    new Set(doc.pages.map((p) => p.page)).size !== doc.pages.length ||
    doc.pages.some(
      (p) =>
        !Number.isInteger(p.page) || p.page < 1 || !p.objectId || !p.versionId,
    )
  )
    throw new ContextStoreError("document.index_pages_invalid");
  if (
    Buffer.byteLength(doc.pages.map((p) => p.text).join(""), "utf8") > 1024000
  )
    throw new ContextStoreError("document.index_byte_limit", 413);
  const authorizationDigest = documentAuthorizationDigest(doc);
  const generation = stableDigest({
    authorizationDigest,
    chunker: DOCUMENT_CHUNKER_VERSION,
    generationKey,
  });
  const chunks: Array<{ citation: DocumentCitation; text: string }> = [];
  for (const page of [...doc.pages].sort((a, b) => a.page - b.page)) {
    const points = Array.from(page.text);
    for (let start = 0; start < points.length;) {
      const end = Math.min(points.length, start + 800);
      const text = points.slice(start, end).join(""),
        chunkDigest = stableDigest(text);
      const citationId = stableDigest({
        tenantId,
        caseId,
        documentId: doc.documentId,
        documentVersion: doc.documentVersion,
        generation,
        page: page.page,
        start,
        end,
        chunkDigest,
      });
      chunks.push({
        text,
        citation: {
          citationId,
          documentId: doc.documentId,
          documentVersion: doc.documentVersion,
          artifactHash: doc.artifactHash,
          artifactRef: doc.artifactRef,
          page: page.page,
          start,
          end,
          offsetUnit: "codepoint",
          chunkDigest,
          generation,
          parserVersion: doc.parserVersion,
          chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          textCoverage: doc.textCoverage,
          pageRecord: { objectId: page.objectId, versionId: page.versionId },
        },
      });
      if (chunks.length > 2000)
        throw new ContextStoreError("document.index_chunk_limit", 413);
      if (end === points.length) break;
      start = end - 80;
    }
  }
  return { authorizationDigest, generation, chunks };
}
export async function indexDocument(
  store: ContextStore,
  tenantId: string,
  caseId: string,
  doc: IndexDocument,
  generationKey = "default",
) {
  const prepared = prepareDocumentIndex(tenantId, caseId, doc, generationKey);
  return withContextTenant(store, tenantId, async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([tenantId, caseId, doc.documentId]),
    ]);
    const prior = await c.query<{ generation: string; active: boolean }>(
      "select generation,active from context.document_generations where tenant_id=$1 and case_id=$2 and document_id=$3 and generation=$4",
      [tenantId, caseId, doc.documentId, prepared.generation],
    );
    if (prior.rows[0]?.active)
      return {
        generation: prepared.generation,
        chunks: prepared.chunks.length,
        status: "indexed",
      };
    if (prior.rows.length)
      throw new ContextStoreError("document.index_generation_withdrawn", 409);
    await c.query(
      "update context.document_chunks set content=null where tenant_id=$1 and case_id=$2 and document_id=$3",
      [tenantId, caseId, doc.documentId],
    );
    await c.query(
      "update context.document_generations set active=false,withdrawn_at=now() where tenant_id=$1 and case_id=$2 and document_id=$3 and active",
      [tenantId, caseId, doc.documentId],
    );
    await c.query(
      `insert into context.document_generations(tenant_id,case_id,document_id,generation,document_version,artifact_hash,artifact_ref,authorization_digest,subject_ids,purposes,access_roles,residency,parser_version,chunker_version,text_coverage) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        tenantId,
        caseId,
        doc.documentId,
        prepared.generation,
        doc.documentVersion,
        doc.artifactHash,
        doc.artifactRef,
        prepared.authorizationDigest,
        doc.subjects,
        doc.purposes,
        doc.accessRoles,
        doc.residency,
        doc.parserVersion,
        DOCUMENT_CHUNKER_VERSION,
        doc.textCoverage,
      ],
    );
    await c.query(
      `insert into context.document_chunks(tenant_id,case_id,document_id,generation,citation_id,page,span_start,span_end,chunk_digest,content,page_record_id,page_record_version)
      select $1,$2,$3,$4,x.citation_id,x.page,x.span_start,x.span_end,x.chunk_digest,x.content,x.page_record_id,x.page_record_version
      from jsonb_to_recordset($5::jsonb) x(citation_id text,page integer,span_start integer,span_end integer,chunk_digest text,content text,page_record_id text,page_record_version text)`,
      [
        tenantId,
        caseId,
        doc.documentId,
        prepared.generation,
        JSON.stringify(
          prepared.chunks.map(({ citation: x, text }) => ({
            citation_id: x.citationId,
            page: x.page,
            span_start: x.start,
            span_end: x.end,
            chunk_digest: x.chunkDigest,
            content: text,
            page_record_id: x.pageRecord.objectId,
            page_record_version: x.pageRecord.versionId,
          })),
        ),
      ],
    );
    return {
      generation: prepared.generation,
      chunks: prepared.chunks.length,
      status: "indexed",
    };
  });
}
export async function withdrawDocumentIndex(
  store: ContextStore,
  tenantId: string,
  caseId: string,
  documentId: string,
) {
  return withContextTenant(store, tenantId, async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([tenantId, caseId, documentId]),
    ]);
    await c.query(
      "update context.document_chunks set content=null where tenant_id=$1 and case_id=$2 and document_id=$3",
      [tenantId, caseId, documentId],
    );
    await c.query(
      "update context.document_generations set active=false,withdrawn_at=now() where tenant_id=$1 and case_id=$2 and document_id=$3 and active",
      [tenantId, caseId, documentId],
    );
    return { status: "withdrawn" };
  });
}
export type DocumentRetrievalAuthority = {
  caseId: string;
  subjects: string[];
  purpose: string;
  roles: string[];
  residencies: string[];
  documents: Array<{ documentId: string; authorizationDigest: string }>;
};
/** ALL restrictions enter the database predicate before ranking or text leaves the index. */
const predicate = `g.tenant_id=$1 and g.case_id=$2 and g.active and g.subject_ids <@ $3::text[]
 and $4=any(g.purposes) and g.access_roles && $5::text[] and g.residency=any($6::text[])
 and exists(select 1 from jsonb_to_recordset($7::jsonb) a("documentId" text,"authorizationDigest" text)
 where a."documentId"=g.document_id and a."authorizationDigest"=g.authorization_digest)`;
function params(tenantId: string, a: DocumentRetrievalAuthority) {
  if (
    !tenantId ||
    !a.caseId ||
    !a.subjects.length ||
    !a.purpose ||
    !a.roles.length ||
    !a.residencies.length ||
    a.documents.length > 100
  )
    throw new ContextStoreError("document.search_scope_invalid", 403);
  return [
    tenantId,
    a.caseId,
    a.subjects,
    a.purpose,
    a.roles,
    a.residencies,
    JSON.stringify(a.documents),
  ];
}
type MatchRow = {
  citation_id: string;
  document_id: string;
  document_version: string;
  artifact_hash: string;
  artifact_ref: string;
  page: number;
  span_start: number;
  span_end: number;
  chunk_digest: string;
  generation: string;
  parser_version: string;
  chunker_version: string;
  text_coverage: DocumentCitation["textCoverage"];
  page_record_id: string;
  page_record_version: string;
  content: string;
  score: number;
};
const join =
  "from context.document_chunks c join context.document_generations g using(tenant_id,case_id,document_id,generation)";
function match(r: MatchRow) {
  if (stableDigest(r.content) !== r.chunk_digest)
    throw new ContextStoreError("document.chunk_integrity_invalid", 409);
  const citation: DocumentCitation = {
    citationId: r.citation_id,
    documentId: r.document_id,
    documentVersion: r.document_version,
    artifactHash: r.artifact_hash,
    artifactRef: r.artifact_ref,
    page: r.page,
    start: r.span_start,
    end: r.span_end,
    offsetUnit: "codepoint",
    chunkDigest: r.chunk_digest,
    generation: r.generation,
    parserVersion: r.parser_version,
    chunkerVersion: r.chunker_version,
    textCoverage: r.text_coverage,
    pageRecord: {
      objectId: r.page_record_id,
      versionId: r.page_record_version,
    },
  };
  return {
    citation,
    text: r.content,
    score: Number(r.score),
    trust: "UNTRUSTED_EXTERNAL" as const,
    verification: "EXTRACTED_TEXT" as const,
  };
}
export async function searchDocuments(
  store: ContextStore,
  tenantId: string,
  a: DocumentRetrievalAuthority,
  input: DocumentSearchRequest,
) {
  const values = params(tenantId, a);
  return withContextTenant(
    store,
    tenantId,
    async (c) => {
      await c.query("set local statement_timeout='3s'");
      const rows = await c.query<MatchRow>(
        `select c.*,g.document_version,g.artifact_hash,g.artifact_ref,g.parser_version,g.chunker_version,g.text_coverage,ts_rank_cd(to_tsvector('simple',c.content),websearch_to_tsquery('simple',$8)) as score ${join} where ${predicate} and c.content is not null and to_tsvector('simple',c.content) @@ websearch_to_tsquery('simple',$8) order by score desc,c.citation_id limit $9`,
        [...values, input.query, input.maxResults],
      );
      let remaining = input.contextBudget;
      const matches = [];
      for (const row of rows.rows) {
        const item = match(row),
          length = Math.min(
            Array.from(item.text).length,
            input.snippetChars,
            remaining,
          );
        if (length < 1) break;
        const text = Array.from(item.text).slice(0, length).join("");
        // Citation covers the complete chunk. Excerpt has its own exact, explicit end offset.
        matches.push({
          ...item,
          text,
          excerpt: {
            start: item.citation.start,
            end: item.citation.start + Array.from(text).length,
          },
        });
        remaining -= Array.from(text).length;
      }
      const indexed = await c.query<{ document_id: string }>(
        `select g.document_id from context.document_generations g where ${predicate}`,
        values,
      );
      return {
        matches,
        mode: "lexical",
        indexedDocumentCount: indexed.rows.length,
        authorizedDocumentCount: a.documents.length,
        indexComplete: indexed.rows.length === a.documents.length,
        limitations: [
          "Search covers indexed extracted text only. No result does not establish absence.",
          "Relevance scores do not represent extraction confidence or verification.",
        ],
      };
    },
    { readOnly: true },
  );
}
export async function resolveDocumentCitation(
  store: ContextStore,
  tenantId: string,
  a: DocumentRetrievalAuthority,
  citationId: string,
) {
  return withContextTenant(
    store,
    tenantId,
    async (c) => {
      const result = await c.query<MatchRow>(
        `select c.*,g.document_version,g.artifact_hash,g.artifact_ref,g.parser_version,g.chunker_version,g.text_coverage,0 as score ${join} where ${predicate} and c.citation_id=$8 and c.content is not null`,
        [...params(tenantId, a), citationId],
      );
      if (!result.rows[0])
        throw new ContextStoreError("document.citation_unavailable", 404);
      return match(result.rows[0]);
    },
    { readOnly: true },
  );
}
