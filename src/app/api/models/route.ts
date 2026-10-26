import { ModelInfo } from "@/contracts";
import { loadConfig } from "@/server/config";
import { respond } from "@/server/http";
export const runtime = "nodejs";

/** fal is offered only in fal mode with a key; env is read per request (never at import) and the key never leaves the server. */
function falConfigured(): boolean {
  try { const config = loadConfig(process.env); return config.provider === "fal" && Boolean(config.falKey); } catch { return false; }
}

export async function GET() { return respond(async () => {
  const fal = falConfigured();
  return ModelInfo.array().parse([
    { id: "mock-reference", provider: "mock", endpoint: "mock://fixture", available: true, mode: "mock", scope: "product", maxReferences: 4, masks: false, reason: null },
    { id: "fal-flux2-edit", provider: "fal", endpoint: "fal-ai/flux-2/edit", available: fal, mode: "live", scope: "product", maxReferences: 4, masks: false, reason: fal ? null : "NOT_CONFIGURED" },
    { id: "fal-flux2-text", provider: "fal", endpoint: "fal-ai/flux-2", available: fal, mode: "live", scope: "product", maxReferences: 0, masks: false, reason: fal ? null : "NOT_CONFIGURED" },
  ]);
}); }
