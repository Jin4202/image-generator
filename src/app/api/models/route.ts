import { ModelInfo } from "@/contracts";
import { isRestartPending } from "@/server/container";
import { respond } from "@/server/http";
import { loadEffectiveConfig } from "@/server/settings";
export const runtime = "nodejs";

/**
 * fal is offered only in fal mode with a key (env, else the T16 settings file); config is read per request (never at
 * import) and the key never leaves the server. While a saved settings change waits for a restart, nothing is offered:
 * the running server refuses new generations until the server and the worker restart.
 */
function falConfigured(): boolean {
  try { const config = loadEffectiveConfig(process.env); return config.provider === "fal" && Boolean(config.falKey); } catch { return false; }
}

export async function GET() { return respond(async () => {
  const pending = isRestartPending();
  const mock = !pending; const fal = !pending && falConfigured();
  const reason = (available: boolean) => available ? null : pending ? "RESTART_REQUIRED" : "NOT_CONFIGURED";
  return ModelInfo.array().parse([
    { id: "mock-reference", provider: "mock", endpoint: "mock://fixture", available: mock, mode: "mock", scope: "product", maxReferences: 4, masks: false, reason: reason(mock) },
    { id: "fal-flux2-edit", provider: "fal", endpoint: "fal-ai/flux-2/edit", available: fal, mode: "live", scope: "product", maxReferences: 4, masks: false, reason: reason(fal) },
    { id: "fal-flux2-text", provider: "fal", endpoint: "fal-ai/flux-2", available: fal, mode: "live", scope: "product", maxReferences: 0, masks: false, reason: reason(fal) },
  ]);
}); }
