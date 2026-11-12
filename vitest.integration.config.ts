import { defineConfig } from "vite";
import base from "./vite.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/integration/**/*.spec.ts"],
  },
});
