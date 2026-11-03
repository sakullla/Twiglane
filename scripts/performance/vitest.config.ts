import { defineConfig } from "vite";
import base from "../../vite.config.ts";

export default defineConfig({
  ...base,
  test: { environment: "happy-dom", include: ["scripts/performance/ui.spec.ts"] },
});
