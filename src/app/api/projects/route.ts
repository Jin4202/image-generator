import * as C from "@/contracts";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { listProjects } from "@/application/services/projects";
import { createProject } from "@/application/services/projects";
export const runtime = "nodejs";
export async function GET() { return respond(async () => {
  return listProjects(getDependencies());
}); }
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, C.CreateProject);
  return createProject(getDependencies(), input);
}); }
