import { AppError } from "@/domain/errors";
import { getDependencies, getLoadedConfig, isRestartPending } from "@/server/container";
export const runtime = "nodejs";
/**
 * Readiness: 200 only when the migrated database opens; 503 otherwise (e.g. before `npm run db:migrate`).
 * Never reports paths or keys. `liveGeneration` is true only when this server started in fal mode with a key;
 * `restartRequired` (T16) means saved settings wait for a server and worker restart.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const deps = getDependencies();
    const config = getLoadedConfig();
    return Response.json({ data: { status: "ok", stage: "product", persistence: "ready", provider: config.provider, liveGeneration: deps.adapters.has("fal-flux2-edit"), restartRequired: isRestartPending() } }, { headers });
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Configuration or storage is not ready";
    return Response.json({ error: { code: error instanceof AppError ? error.code : "STORAGE", message } }, { status: 503, headers });
  }
}
