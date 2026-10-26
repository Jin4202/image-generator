import { defineConfig } from "vitest/config";
import base from "./vitest.config.mjs";
export default defineConfig({ ...base, test: { ...base.test, include: ["tests/acceptance/**/*.test.ts"] } });
