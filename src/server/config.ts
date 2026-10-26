import { resolve } from "node:path";
import { z } from "zod";
const Env = z.object({ APP_DATA_DIR: z.string().min(1).default("./data"), GENERATION_PROVIDER: z.enum(["mock", "fal"]).default("mock"), FAL_KEY: z.string().min(1).optional() });
export function loadConfig(env: Record<string, string | undefined>) {
  const config = Env.parse({ ...env, FAL_KEY: env.FAL_KEY || undefined });
  if (config.GENERATION_PROVIDER === "fal" && !config.FAL_KEY) throw new Error("FAL_KEY is required for fal mode");
  const dataDir = resolve(config.APP_DATA_DIR);
  return Object.freeze({ dataDir, databasePath: resolve(dataDir, "studio.sqlite"), provider: config.GENERATION_PROVIDER, falKey: config.FAL_KEY });
}
