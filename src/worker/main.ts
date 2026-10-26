import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { AppError } from "../domain/errors";
import { loadConfig } from "../server/config";
import { createDependencies } from "../server/create-dependencies";
import { runWorker } from "./runner";

/**
 * T06/T12: separate tsx process; dependency factory must not import Next's server-only marker.
 * SIGINT/SIGTERM stop new ticks; the in-flight tick finishes, the lease is released, then the DB closes.
 */
async function main() {
  const config = loadConfig(process.env);
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
  console.log(`Worker started (provider: ${config.provider}; live fal: ${deps.adapters.has("fal-flux2-edit") ? "configured" : "off"})`);
  try { await runWorker(deps, owner, controller.signal); }
  finally { deps.repo.close(); console.log("Worker stopped; lease released and database closed"); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Worker failed"); process.exitCode = 1; });
