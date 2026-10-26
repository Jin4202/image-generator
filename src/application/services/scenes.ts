import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies, UnitOfWork } from "../ports";
import { AppError } from "../../domain/errors";

/** Edit roles belong to refine previews, never to a saved scene. */
const editRoles = new Set(["parent", "mask"]);

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label}`);
  return parsed.data;
}

/** Shape rules that need no storage: edit roles and duplicate selections. */
function checkContent(content: C.SceneContent): void {
  const pairs = new Set<string>();
  for (const ref of content.references) {
    if (editRoles.has(ref.role)) throw new AppError("VALIDATION", "Scenes cannot hold parent or mask references");
    const key = `${ref.mediaId}:${ref.role}`;
    if (pairs.has(key)) throw new AppError("VALIDATION", "Duplicate media/role reference");
    pairs.add(key);
  }
  if (new Set(content.assetVersionIds).size !== content.assetVersionIds.length) throw new AppError("VALIDATION", "Duplicate asset version");
}

/** Every referenced record must be in the same project (else NOT_FOUND); style/asset versions must be approved (else CONFLICT). */
function checkScope(tx: UnitOfWork, projectId: string, content: C.SceneContent): void {
  if (!tx.get("projects", projectId)) throw new AppError("NOT_FOUND", "Project not found");
  for (const ref of content.references) {
    const media = tx.get("media", ref.mediaId);
    if (!media || media.projectId !== projectId) throw new AppError("NOT_FOUND", "Referenced media not found");
  }
  const versions: { kind: "Style" | "Asset"; v: C.Style | C.Asset | null }[] = content.assetVersionIds.map(id => ({ kind: "Asset", v: tx.get("assets", id) }));
  if (content.styleVersionId) versions.unshift({ kind: "Style", v: tx.get("styles", content.styleVersionId) });
  for (const { kind, v } of versions) {
    if (!v || v.projectId !== projectId) throw new AppError("NOT_FOUND", `${kind} version not found`);
    if (v.approvedAt === null) throw new AppError("CONFLICT", `${kind} version is not approved`);
  }
}

/** T04: docs/contracts.md#scenes. Preserve signature; implement all listed invariants. */
export async function createScene(deps: Dependencies, input: z.infer<typeof C.CreateScene>): Promise<C.Scene> {
  const data = parse(C.CreateScene, input, "scene fields");
  checkContent(data.content);
  return deps.repo.transaction(tx => {
    checkScope(tx, data.projectId, data.content);
    const scene = C.Scene.parse({ id: deps.newId(), projectId: data.projectId, revision: 0, createdAt: deps.now(), content: data.content });
    tx.insert("scenes", scene);
    return scene;
  });
}

/** T04: docs/contracts.md#scenes. Preserve signature; implement all listed invariants. */
export async function getScene(deps: Dependencies, id: string): Promise<C.Scene> {
  const scene = deps.repo.get("scenes", parse(C.Id, id, "scene ID"));
  if (!scene) throw new AppError("NOT_FOUND", "Scene not found");
  return scene;
}

/** T04: docs/contracts.md#scenes. Preserve signature; implement all listed invariants. */
export async function updateScene(deps: Dependencies, id: string, input: z.infer<typeof C.UpdateScene>): Promise<C.Scene> {
  const sceneId = parse(C.Id, id, "scene ID");
  const data = parse(C.UpdateScene, input, "scene update");
  checkContent(data.content);
  return deps.repo.transaction(tx => {
    const current = tx.get("scenes", sceneId);
    if (!current) throw new AppError("NOT_FOUND", "Scene not found");
    if (current.revision !== data.expectedRevision) throw new AppError("CONFLICT", "Scene was changed by another save; reload and retry");
    checkScope(tx, current.projectId, data.content);
    const next = { ...current, revision: current.revision + 1, content: data.content };
    tx.replace("scenes", next, data.expectedRevision);
    return next;
  });
}

/** T04: docs/contracts.md#scenes. Preserve signature; implement all listed invariants. */
export async function duplicateScene(deps: Dependencies, id: string): Promise<C.Scene> {
  const sceneId = parse(C.Id, id, "scene ID");
  return deps.repo.transaction(tx => {
    const source = tx.get("scenes", sceneId);
    if (!source) throw new AppError("NOT_FOUND", "Scene not found");
    // Content only (no runs/previews); structuredClone keeps the copy independent of the source.
    const copy = C.Scene.parse({ id: deps.newId(), projectId: source.projectId, revision: 0, createdAt: deps.now(), content: structuredClone(source.content) });
    tx.insert("scenes", copy);
    return copy;
  });
}
