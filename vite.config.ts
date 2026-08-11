import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "modern",
    emptyOutDir: true,
    lib: {
      entry: "src/modern-tools.tsx",
      formats: ["es"],
      fileName: () => "modern-tools.js",
    },
    rollupOptions: {
      output: { assetFileNames: "[name][extname]" },
    },
  },
});
