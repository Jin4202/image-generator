import * as C from "@/contracts";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { exportCandidate } from "@/application/services/effects";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, C.ExportInput);
  return exportCandidate(getDependencies(), input);
}); }
