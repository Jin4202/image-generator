import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { respond } from "@/server/http";
import { readMedia } from "@/application/services/media";
export const runtime = "nodejs";
/** T02: binary response with correct MIME, nosniff, immutable cache; never reveal disk paths. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
    const { media, bytes } = await readMedia(getDependencies(), parsed.data);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": media.mime, "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch (error) {
    // Errors use the standard JSON envelope (no-store) rather than raw bytes.
    return respond(async () => { throw error; });
  }
}
