import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies } from "../ports";
import { AppError } from "../../domain/errors";
import { transitions } from "../../domain/run-state";

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

/** T17: title/budget edit with CAS (revision+1). id/createdAt and past run snapshots never change; lowering the budget
 * cancels or refunds nothing and only affects later submits. */
export async function updateProject(deps: Dependencies, id: string, input: z.infer<typeof C.UpdateProject>): Promise<C.Project> {
  const projectId = parseId(id);
  const parsed = C.UpdateProject.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid project fields");
  const { expectedRevision, title, budgetMicros } = parsed.data;
  return deps.repo.transaction(tx => {
    const current = tx.get("projects", projectId);
    if (!current) throw new AppError("NOT_FOUND", "Project not found");
    if (current.revision !== expectedRevision) throw new AppError("CONFLICT", "Project was changed elsewhere; reload and retry");
    const next = C.Project.parse({ ...current, revision: current.revision + 1, title, budgetMicros });
    tx.replace("projects", next, current.revision);
    return next;
  });
}

/**
 * T17: deletes the project's DB records in one BEGIN IMMEDIATE transaction (so it serializes with submitRun: no orphan
 * run). Refused with CONFLICT while any of its runs is active (unknown/download_failed included) or on a stale revision.
 * Content-addressed blobs may be shared with other projects and are kept: no disk reclamation or secure erase.
 */
export async function deleteProject(deps: Dependencies, id: string, input: z.infer<typeof C.DeleteProject>): Promise<z.infer<typeof C.ProjectDeleted>> {
  const projectId = parseId(id);
  const parsed = C.DeleteProject.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid delete request");
  return deps.repo.transaction(tx => {
    const current = tx.get("projects", projectId);
    if (!current) throw new AppError("NOT_FOUND", "Project not found");
    if (current.revision !== parsed.data.expectedRevision) throw new AppError("CONFLICT", "Project was changed elsewhere; reload and retry");
    if (tx.list("runs", projectId).some(run => transitions[run.status].length > 0)) throw new AppError("CONFLICT", "A generation of this project is still active (including unknown or failed downloads); resolve it first");
    tx.deleteProject(projectId);
    return C.ProjectDeleted.parse({ id: projectId, deleted: true });
  });
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
