import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Bake the SDK version into the bundle from package.json so the User-Agent
// string can never drift from the published package metadata.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

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
  define: {
    __AETHER_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  // Optional peer deps — never bundle the frameworks into the SDK output.
  external: ["@langchain/core", "@llamaindex/core"],
  // Emit ESM as .mjs and CJS as .cjs to match the `exports`/`module` paths in
  // package.json (under "type": "module" tsup would otherwise emit ESM as .js).
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
