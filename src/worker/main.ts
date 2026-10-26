import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { AppError } from "../domain/errors";
import { sameRuntime } from "../server/config";
import { createDependencies } from "../server/create-dependencies";
import { loadEffectiveConfig } from "../server/settings";
import { runWorker } from "./runner";

/**
 * T06/T12: separate tsx process; dependency factory must not import Next's server-only marker.
 * SIGINT/SIGTERM stop new ticks; the in-flight tick finishes, the lease is released, then the DB closes.
 * T16: env + settings file are read at start. If the settings that would apply change (or become unreadable), the worker
 * stops the same way and asks for a restart instead of switching provider or key while running (no hot reload).
 */
const settingsCheckMs = 2_000;
async function main() {
  const config = loadEffectiveConfig(process.env);
  let deps;
  try { deps = createDependencies(config); }
  catch (error) {
    // Typically an unmigrated database; the message says how to fix it and contains no path or key.
    throw new Error(error instanceof AppError ? `${error.code}: ${error.message}` : "Worker could not open its dependencies");
  }
  const owner = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => { if (!controller.signal.aborted) { console.log(`Worker received ${signal}; finishing current step`); controller.abort(); } };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const watch = setInterval(() => {
    let changed: boolean;
    try { changed = !sameRuntime(config, loadEffectiveConfig(process.env)); } catch { changed = true; }
    if (changed && !controller.signal.aborted) { console.log("Provider settings changed; worker is stopping. Restart the worker (and the server) to apply them"); controller.abort(); }
  }, settingsCheckMs);
  console.log(`Worker started (provider: ${config.provider}; live fal: ${deps.adapters.has("fal-flux2-edit") ? "configured" : "off"})`);
  try { await runWorker(deps, owner, controller.signal); }
  finally { clearInterval(watch); deps.repo.close(); console.log("Worker stopped; lease released and database closed"); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Worker failed"); process.exitCode = 1; });
