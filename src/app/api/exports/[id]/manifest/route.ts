import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { respond } from "@/server/http";
import { readExportManifest } from "@/application/services/effects";
export const runtime = "nodejs";
/** T09: JSON manifest file download. Resolve export record ID; never accept a path. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
    const { record, bytes } = await readExportManifest(getDependencies(), parsed.data);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="manifest-${record.id}.json"`, "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch (error) {
    // Errors use the standard JSON envelope (no-store) rather than the file.
    return respond(async () => { throw error; });
  }
}
