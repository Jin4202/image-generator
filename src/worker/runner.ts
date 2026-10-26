import type { Dependencies } from "../application/ports";
import { tickWorker } from "../application/services/runs";
import { Limits } from "../contracts";

/** Resolves after `ms`, or immediately once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** T06: polling loop, abort/shutdown, delegates one step to tickWorker. An in-flight tick finishes; no new tick starts after abort. The caller closes the DB. */
export async function runWorker(deps: Dependencies, owner: string, signal: AbortSignal): Promise<void> {
  try {
    while (!signal.aborted) {
      try { await tickWorker(deps, owner); }
      // Keep polling; messages never include provider payloads, keys or paths.
      catch (error) { console.error(`Worker tick failed: ${error instanceof Error ? error.name : "unknown error"}`); }
      await pause(Limits.pollMs, signal);
    }
  } finally {
    try { deps.repo.releaseLease(owner); } catch { /* repository already closed */ }
  }
}
