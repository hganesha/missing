import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, it, expect } from "vitest";
import {
  prepareDocumentIndex,
  indexDocument,
  searchDocuments,
  resolveDocumentCitation,
  withdrawDocumentIndex,
  documentAuthorizationDigest,
  type IndexDocument,
  type DocumentRetrievalAuthority,
} from "./document-search.js";
import type { ContextStore } from "./index.js";
const document: IndexDocument = {
  documentId: "doc1",
  documentVersion: "a".repeat(64),
  artifactHash: "a".repeat(64),
  artifactRef: "evidence1",
  subjects: ["subject1"],
  purposes: ["kyc.review"],
  accessRoles: ["Case.Analyst"],
  residency: "US",
  parserVersion: "parser.v1",
  textCoverage: "cited_quotes",
  pages: [
    {
      page: 1,
      text: "Certificate 🧭 of incorporation. Acme Holdings is registered in Delaware.",
      objectId: "page1",
      versionId: "p1",
    },
  ],
};
const request = {
  query: "Acme",
  mode: "lexical" as const,
  maxResults: 5,
  snippetChars: 500,
  contextBudget: 1000,
  purpose: "kyc.review",
};
describe("exact document chunking", () => {
  it("preserves Unicode code point offsets, attribution, coverage and historical citation identity", () => {
    const prepared = prepareDocumentIndex("t", "c", document);
    const chunk = prepared.chunks[0]!;
    expect(
      Array.from(document.pages[0]!.text)
        .slice(chunk.citation.start, chunk.citation.end)
        .join(""),
    ).toBe(chunk.text);
    expect(chunk.citation).toMatchObject({
      offsetUnit: "codepoint",
      textCoverage: "cited_quotes",
      pageRecord: { objectId: "page1", versionId: "p1" },
    });
    const rebuilt = prepareDocumentIndex("t", "c", document, "rebuild");
    expect(rebuilt.authorizationDigest).toBe(prepared.authorizationDigest);
    expect(rebuilt.chunks[0]!.citation.citationId).not.toBe(
      chunk.citation.citationId,
    );
    expect(() =>
      prepareDocumentIndex("t", "c", {
        ...document,
        pages: [...document.pages, ...document.pages],
      }),
    ).toThrow("index_pages_invalid");
  });
});
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "permission-filtered document index",
  () => {
    it("filters before snippets, rechecks citations, reports lag and withdraws old text under tenant RLS", async () => {
      const admin = new pg.Pool({
          connectionString: process.env.EHF_TEST_DATABASE_URL,
        }),
        tenant = `documents-${randomUUID()}`,
        role = `document_test_${randomUUID().replaceAll("-", "")}`;
      let pool: pg.Pool | undefined;
      try {
        await admin.query("create schema if not exists context");
        const exists = await admin.query(
          "select to_regclass('context.document_chunks') as name",
        );
        if (!exists.rows[0].name)
          await admin.query(
            readFileSync(
              new URL("../migrations/004_document_search.sql", import.meta.url),
              "utf8",
            ),
          );
        await admin.query(
          `create role ${role} nologin nosuperuser nobypassrls`,
        );
        await admin.query(`grant usage on schema context to ${role}`);
        await admin.query(
          `grant select,insert,update on context.document_generations,context.document_chunks to ${role}`,
        );
        pool = new pg.Pool({
          connectionString: process.env.EHF_TEST_DATABASE_URL,
          options: `-c role=${role}`,
        });
        const store = { db: pool } as ContextStore;
        const authority: DocumentRetrievalAuthority = {
          caseId: "case1",
          subjects: ["subject1"],
          purpose: "kyc.review",
          roles: ["Case.Analyst"],
          residencies: ["US"],
          documents: [
            {
              documentId: "doc1",
              authorizationDigest: documentAuthorizationDigest(document),
            },
          ],
        };
        expect(
          (await searchDocuments(store, tenant, authority, request))
            .indexComplete,
        ).toBe(false);
        await indexDocument(store, tenant, "case1", document);
        const found = await searchDocuments(store, tenant, authority, request);
        expect(found.indexComplete).toBe(true);
        expect(found.matches).toHaveLength(1);
        const citation = found.matches[0]!.citation;
        expect(
          (
            await resolveDocumentCitation(
              store,
              tenant,
              authority,
              citation.citationId,
            )
          ).text,
        ).toContain("Acme");
        for (const denied of [
          { ...authority, roles: ["Harness.Reader"] },
          { ...authority, subjects: ["other"] },
          { ...authority, purpose: "marketing" },
          { ...authority, residencies: ["EU"] },
          { ...authority, caseId: "other" },
          { ...authority, documents: [] },
        ]) {
          expect(
            (await searchDocuments(store, tenant, denied, request)).matches,
          ).toEqual([]);
          await expect(
            resolveDocumentCitation(store, tenant, denied, citation.citationId),
          ).rejects.toThrow("citation_unavailable");
        }
        expect(
          (await searchDocuments(store, "other-tenant", authority, request))
            .matches,
        ).toEqual([]);
        const changed = {
          ...document,
          pages: [
            {
              ...document.pages[0]!,
              text: "Acme has changed text.",
              versionId: "p2",
            },
          ],
        };
        const current = {
          ...authority,
          documents: [
            {
              documentId: "doc1",
              authorizationDigest: documentAuthorizationDigest(changed),
            },
          ],
        };
        expect(
          (await searchDocuments(store, tenant, current, request))
            .indexComplete,
        ).toBe(false);
        await expect(
          resolveDocumentCitation(store, tenant, current, citation.citationId),
        ).rejects.toThrow("citation_unavailable");
        await indexDocument(store, tenant, "case1", changed);
        await expect(
          resolveDocumentCitation(
            store,
            tenant,
            authority,
            citation.citationId,
          ),
        ).rejects.toThrow("citation_unavailable");
        expect(
          (await searchDocuments(store, tenant, current, request)).matches[0]
            ?.text,
        ).toBe("Acme has changed text.");
        await withdrawDocumentIndex(store, tenant, "case1", "doc1");
        expect(
          (await searchDocuments(store, tenant, current, request)).matches,
        ).toEqual([]);
        const text = await admin.query(
          "select content from context.document_chunks where tenant_id=$1",
          [tenant],
        );
        expect(text.rows.every((row) => row.content === null)).toBe(true);
        await indexDocument(
          store,
          tenant,
          "case1",
          changed,
          "explicit-rebuild",
        );
        expect(
          (await searchDocuments(store, tenant, current, request)).matches,
        ).toHaveLength(1);
        // Even a raw table read without a bound tenant sees no content under this role.
        expect(
          (await pool.query("select content from context.document_chunks"))
            .rows,
        ).toEqual([]);
      } finally {
        await pool?.end();
        await admin
          .query("delete from context.document_chunks where tenant_id=$1", [
            tenant,
          ])
          .catch(() => undefined);
        await admin
          .query(
            "delete from context.document_generations where tenant_id=$1",
            [tenant],
          )
          .catch(() => undefined);
        await admin.query(`drop owned by ${role}`).catch(() => undefined);
        await admin.query(`drop role if exists ${role}`).catch(() => undefined);
        await admin.end();
      }
    });
  },
);
