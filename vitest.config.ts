import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Mirror the tsup `define` injection so tests see the same metadata-derived
// SDK version constant as the built bundle.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __AETHER_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
  },
});
