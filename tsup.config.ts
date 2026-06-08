import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    api: "src/api/index.ts",
  },
  format: ["cjs"],
  target: "node18",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // EventHandlers.ts is loaded by Envio at runtime — not bundled here
  external: ["generated", "envio"],
});
