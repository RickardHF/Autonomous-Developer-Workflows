import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: "localhost",
  },
  build: {
    outDir: "dist",
  },
});
