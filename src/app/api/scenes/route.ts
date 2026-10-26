import * as C from "@/contracts";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { createScene } from "@/application/services/scenes";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, C.CreateScene);
  return createScene(getDependencies(), input);
}); }
