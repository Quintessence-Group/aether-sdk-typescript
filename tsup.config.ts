import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/integrations/langchain.ts",
    "src/integrations/llamaindex.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  // Optional peer deps — never bundle the frameworks into the SDK output.
  external: ["@langchain/core", "@llamaindex/core"],
  // Emit ESM as .mjs and CJS as .cjs to match the `exports`/`module` paths in
  // package.json (under "type": "module" tsup would otherwise emit ESM as .js).
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
