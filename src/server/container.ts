import "server-only";
import type { Dependencies, ModelAdapter } from "../application/ports";
import type { Compiled } from "../contracts";
import type { AppConfig } from "./config";
import { createDependencies } from "./create-dependencies";
import { loadEffectiveConfig, type SettingsHost } from "./settings";

let cached: { signature: string; deps: Dependencies; config: AppConfig } | null = null;
// T16 generation gate: while closed, the shared adapter map is empty, so every submitRun transaction sees UNSUPPORTED.
let stash: [Compiled["adapterId"], ModelAdapter][] | null = null;
let holds = 0;
let restartPending = false;

const envSignature = () => JSON.stringify([process.env.APP_DATA_DIR ?? null, process.env.GENERATION_PROVIDER ?? null, process.env.FAL_KEY ?? null]);
const adapterMap = (deps: Dependencies) => deps.adapters as Map<Compiled["adapterId"], ModelAdapter>;
function applyGate() {
  if (!cached) return;
  const map = adapterMap(cached.deps);
  if ((holds > 0 || restartPending) && !stash) { stash = [...map]; map.clear(); }
  else if (holds === 0 && !restartPending && stash) { for (const [id, adapter] of stash) map.set(id, adapter); stash = null; }
}

/**
 * T12: lazy singleton per process; no DB writes at import/build; explicit migrations.
 * Env is read on first use (never at import). A changed APP_DATA_DIR/provider/key env rebuilds the wiring; a failed open
 * (e.g. unmigrated DB) is not cached, so the next request retries after `npm run db:migrate`.
 * T16: the settings file is read only when the wiring is built (server start), never per request: saving settings
 * needs a restart and does not switch providers in a running server.
 */
export function getDependencies(): Dependencies {
  const signature = envSignature();
  if (cached?.signature === signature) return cached.deps;
  if (cached) { try { cached.deps.repo.close(); } catch { /* already closed */ } cached = null; stash = null; }
  const config = loadEffectiveConfig(process.env);
  const deps = createDependencies(config);
  cached = { signature, deps, config };
  applyGate();
  return deps;
}

/** Config the running server was built with (settings file included). */
export function getLoadedConfig(): AppConfig {
  getDependencies();
  return cached!.config;
}

/** True after a settings change that only applies on restart; new generations are refused until then. */
export const isRestartPending = () => restartPending;

/** T16: what the settings routes need from this process. */
export function getSettingsHost(): SettingsHost {
  const deps = getDependencies();
  return {
    env: process.env, repo: deps.repo, loaded: cached!.config,
    closeGeneration() {
      holds++; applyGate();
      let released = false;
      return () => { if (!released) { released = true; holds--; applyGate(); } };
    },
    setRestartPending(pending) { restartPending = pending; applyGate(); },
  };
}

/** Closes and forgets the singleton (process shutdown, tests simulating a server restart). */
export function resetDependencies(): void {
  if (cached) { try { cached.deps.repo.close(); } catch { /* already closed */ } }
  cached = null; stash = null; holds = 0; restartPending = false;
}
