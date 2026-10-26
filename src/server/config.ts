import { resolve } from "node:path";
import { z } from "zod";
const Env = z.object({ APP_DATA_DIR: z.string().min(1).default("./data"), GENERATION_PROVIDER: z.enum(["mock", "fal"]).optional(), FAL_KEY: z.string().min(1).optional() });
/** T16: what the local settings file may hold (APP_DATA_DIR/settings/settings.json). */
export type StoredSettings = { mode: "mock" | "fal"; falKey?: string };

/**
 * Pure: explicit env > stored settings file > mock default (env FAL_KEY wins over a stored key).
 * Callers that honour the settings file read it first (src/server/settings.ts); plain `loadConfig(env)` is env-only.
 */
export function loadConfig(env: Record<string, string | undefined>, stored: StoredSettings | null = null) {
  const config = Env.parse({ ...env, GENERATION_PROVIDER: env.GENERATION_PROVIDER || undefined, FAL_KEY: env.FAL_KEY || undefined });
  const provider = config.GENERATION_PROVIDER ?? stored?.mode ?? "mock";
  const falKey = config.FAL_KEY ?? stored?.falKey;
  if (provider === "fal" && !falKey) throw new Error("FAL_KEY is required for fal mode");
  const dataDir = resolve(config.APP_DATA_DIR);
  return Object.freeze({
    dataDir, databasePath: resolve(dataDir, "studio.sqlite"), provider, falKey,
    keySource: config.FAL_KEY ? "env" as const : stored?.falKey ? "file" as const : "none" as const,
    modeSource: config.GENERATION_PROVIDER ? "env" as const : stored ? "file" as const : "default" as const,
  });
}
export type AppConfig = ReturnType<typeof loadConfig>;
/** Two configs run the same way (mode, and the key only when it is used). */
export const sameRuntime = (a: AppConfig, b: AppConfig) => a.provider === b.provider && (a.provider !== "fal" || a.falKey === b.falKey);
