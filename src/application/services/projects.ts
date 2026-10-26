import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies } from "../ports";
import { AppError } from "../../domain/errors";

function parseId(id: string): string {
  const parsed = C.Id.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid project ID");
  return parsed.data;
}

/** T03: docs/contracts.md#projects. Preserve signature; implement all listed invariants. */
export async function createProject(deps: Dependencies, input: z.infer<typeof C.CreateProject>): Promise<C.Project> {
  const parsed = C.CreateProject.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid project fields");
  const id = deps.newId();
  const project = C.Project.parse({ id, projectId: id, revision: 0, createdAt: deps.now(), ...parsed.data });
  deps.repo.insert("projects", project);
  return project;
}

/** T03: docs/contracts.md#projects. Preserve signature; implement all listed invariants. */
export async function listProjects(deps: Dependencies): Promise<C.Project[]> {
  return deps.repo.list("projects");
}

/** T03: docs/contracts.md#projects. Preserve signature; implement all listed invariants. */
export async function getProject(deps: Dependencies, id: string): Promise<C.Project> {
  const project = deps.repo.get("projects", parseId(id));
  if (!project) throw new AppError("NOT_FOUND", "Project not found");
  return project;
}

/** T03: all project aggregates, stable createdAt/id sorting, public DTO only. */
export async function getWorkspace(deps: Dependencies, id: string): Promise<C.Workspace> {
  const projectId = parseId(id);
  // One read transaction gives a consistent snapshot; previews are submit-only and intentionally excluded.
  const workspace = deps.repo.transaction(tx => {
    const project = tx.get("projects", projectId);
    if (!project) throw new AppError("NOT_FOUND", "Project not found");
    return {
      project,
      media: tx.list("media", projectId), styles: tx.list("styles", projectId), assets: tx.list("assets", projectId),
      scenes: tx.list("scenes", projectId), runs: tx.list("runs", projectId), candidates: tx.list("candidates", projectId),
      reviews: tx.list("reviews", projectId), effects: tx.list("effects", projectId), exports: tx.list("exports", projectId),
      experiments: tx.list("experiments", projectId),
    };
  });
  // Serialize through the allowlist schema so only contract fields leave the service.
  return C.Workspace.parse(workspace);
}
