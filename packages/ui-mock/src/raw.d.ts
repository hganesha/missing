/** Vite (and Vitest) serve `?raw` imports as the file's text. */
declare module "*?raw" {
  const source: string;
  export default source;
}

/** Vite (and Vitest) expand `import.meta.glob` at build time. */
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, unknown>;
}
