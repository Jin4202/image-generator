import * as C from "@/contracts";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { createStyle } from "@/application/services/library";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, C.CreateStyle);
  return createStyle(getDependencies(), input);
}); }
