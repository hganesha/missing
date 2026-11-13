import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite 6: Storybook 8.6's Vite builder supports Vite ≤ 6. apps/web builds with Vite 7.
export default defineConfig({
  plugins: [react()],
  css: { modules: { localsConvention: "camelCaseOnly" } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: "non-scoped" } },
    setupFiles: ["./src/test-setup.ts"],
  },
} as Parameters<typeof defineConfig>[0]);
