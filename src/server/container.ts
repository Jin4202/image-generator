import "server-only";
import type { Dependencies } from "../application/ports";
import { loadConfig } from "./config";
import { createDependencies } from "./create-dependencies";

let cached: { signature: string; deps: Dependencies } | null = null;

/**
 * T12: lazy singleton per process; no DB writes at import/build; explicit migrations.
 * Env is read on first use (never at import). A changed APP_DATA_DIR/provider/key rebuilds the wiring; a failed open
 * (e.g. unmigrated DB) is not cached, so the next request retries after `npm run db:migrate`.
 */
export function getDependencies(): Dependencies {
  const config = loadConfig(process.env);
  const signature = JSON.stringify([config.databasePath, config.dataDir, config.provider, config.falKey ?? null]);
  if (cached?.signature === signature) return cached.deps;
  if (cached) { try { cached.deps.repo.close(); } catch { /* already closed */ } cached = null; }
  const deps = createDependencies(config);
  cached = { signature, deps };
  return deps;
}

/** Closes and forgets the singleton (process shutdown, tests simulating a server restart). */
export function resetDependencies(): void {
  if (cached) { try { cached.deps.repo.close(); } catch { /* already closed */ } }
  cached = null;
}
