import * as C from "@/contracts";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { createPreview } from "@/application/services/previews";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, C.PreviewInput);
  return createPreview(getDependencies(), input);
}); }
