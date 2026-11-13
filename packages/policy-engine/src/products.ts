import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  bankingProductSchema, institutionCatalogProblems, institutionCatalogSchema, type InstitutionCatalog,
  legacyProductMappingSchema, productAttributesSourceSchema, productDomainSourceSchema, productTaxonomySchema, stableDigest,
  type ProductNode, type ProductTaxonomy,
} from "@ehf/contracts";

export class ProductTaxonomyError extends Error {}

/**
 * Compile the canonical product taxonomy from its domain, attribute and legacy-mapping sources
 * (Product Policy Studio plan, phase A). Deterministic: domains by code, nodes in authored order.
 * Every reference must resolve and every legacy `productType` must map, or compilation refuses.
 */
export function compileProductTaxonomy(input: {
  version: string; domains: unknown[]; attributes: unknown; legacy: unknown; legacyProductTypes: readonly string[];
}): ProductTaxonomy {
  const domains = input.domains.map((raw) => productDomainSourceSchema.parse(raw)).sort((a, b) => a.metadata.code.localeCompare(b.metadata.code));
  const attributes = productAttributesSourceSchema.parse(input.attributes);
  const legacy = legacyProductMappingSchema.parse(input.legacy);
  const fail = (code: string) => { throw new ProductTaxonomyError(code); };

  const nodes: ProductNode[] = [];
  const seen = new Set<string>();
  const add = (node: ProductNode) => { if (seen.has(node.id)) fail(`product.id_duplicate:${node.id}`); seen.add(node.id); nodes.push(node); };
  for (const domain of domains) {
    const { sectors, classes, ...fields } = domain.spec;
    const domainId = domain.metadata.code;
    add({ id: domainId, level: "domain", parent: null, ancestors: [], sectors, ...fields, children: classes.map((entry) => `${domainId}.${entry.code}`) });
    for (const entry of classes) {
      const { code, types, ...classFields } = entry;
      const classId = `${domainId}.${code}`;
      add({ id: classId, level: "class", parent: domainId, ancestors: [domainId], sectors, ...classFields, children: types.map((type) => `${classId}.${type.code}`) });
      for (const type of types) {
        const { code: typeCode, ...typeFields } = type;
        add({ id: `${classId}.${typeCode}`, level: "type", parent: classId, ancestors: [domainId, classId], sectors, ...typeFields, children: [] });
      }
    }
  }
  for (const node of nodes) for (const reference of [...node.alsoClassifiedAs, ...node.bundle]) {
    if (!seen.has(reference)) fail(`product.reference_unknown:${node.id}:${reference}`);
    if (reference === node.id) fail(`product.reference_self:${node.id}`);
  }
  const attributeIds = attributes.spec.attributes.map((attribute) => attribute.id);
  if (new Set(attributeIds).size !== attributeIds.length) fail("product.attribute_duplicate");

  const mapping: Record<string, string> = {};
  for (const entry of legacy.spec.mappings) {
    if (Object.hasOwn(mapping, entry.productType)) fail(`product.legacy_duplicate:${entry.productType}`);
    if (!input.legacyProductTypes.includes(entry.productType)) fail(`product.legacy_type_unknown:${entry.productType}`);
    if (!seen.has(entry.productId)) fail(`product.legacy_target_unknown:${entry.productType}:${entry.productId}`);
    mapping[entry.productType] = entry.productId;
  }
  for (const productType of input.legacyProductTypes) if (!Object.hasOwn(mapping, productType)) fail(`product.legacy_unmapped:${productType}`);

  const content = {
    apiVersion: "harness.factory/product-taxonomy-v1" as const, kind: "ProductTaxonomy" as const, version: input.version,
    status: [...domains.map((domain) => domain.metadata.status), attributes.metadata.status, legacy.metadata.status].every((status) => status === "APPROVED") ? "APPROVED" as const : "CANDIDATE" as const,
    domains: domains.map((domain) => ({ code: domain.metadata.code, version: domain.metadata.version, status: domain.metadata.status, digest: stableDigest(domain) })),
    nodes, attributes: attributes.spec.attributes,
    legacy: Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))),
  };
  return productTaxonomySchema.parse({ ...content, digest: stableDigest(content) });
}

/** The canonical product a case's legacy `productType` names, or null when it is unmapped. */
export function canonicalProductFor(taxonomy: Pick<ProductTaxonomy, "legacy">, productType: string): string | null {
  return Object.hasOwn(taxonomy.legacy, productType) ? taxonomy.legacy[productType]! : null;
}

const yamlFiles = (directory: string) => readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort();
const readYaml = (path: string) => parse(readFileSync(path, "utf8")) as unknown;

/** Compile the taxonomy from its source directory (`domains/products`). */
export function loadProductTaxonomy(source: string, version = "1.0.0"): ProductTaxonomy {
  return compileProductTaxonomy({
    version,
    domains: yamlFiles(join(source, "taxonomy")).map((name) => readYaml(join(source, "taxonomy", name))),
    attributes: readYaml(join(source, "attributes.yaml")),
    legacy: readYaml(join(source, "legacy-mapping.yaml")),
    legacyProductTypes: bankingProductSchema.options,
  });
}

/**
 * The institution catalog seeds (`domains/products/institutions`), stamped with the taxonomy they
 * were checked against. A seed with any problem an approver would have to resolve is refused.
 */
export function loadInstitutionSeeds(source: string, taxonomy: ProductTaxonomy): InstitutionCatalog[] {
  return yamlFiles(join(source, "institutions")).map((name) => {
    const catalog = institutionCatalogSchema.parse({ ...(readYaml(join(source, "institutions", name)) as object), taxonomy: { version: taxonomy.version, digest: taxonomy.digest } });
    const problems = institutionCatalogProblems(catalog, taxonomy);
    if (problems.length) throw new ProductTaxonomyError(`institution seed ${name}: ${problems.join(", ")}`);
    return catalog;
  });
}

/** `domains/products` from the image (/app/domains), the repository root, or this package's checkout. */
export function productSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.PRODUCT_SOURCE_ROOT, resolve(process.cwd(), "domains/products"), resolve(process.cwd(), "../../domains/products"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../domains/products")].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(resolve(path, "attributes.yaml")));
  if (!found) throw new Error("products.source_missing");
  return found;
}
