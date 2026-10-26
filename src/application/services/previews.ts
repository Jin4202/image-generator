import * as C from "../../contracts";
import type { Dependencies, UnitOfWork } from "../ports";
import { AppError } from "../../domain/errors";
import { canonicalJson, compile } from "../compiler";

const notFound = (what: string): never => { throw new AppError("NOT_FOUND", `${what} not found`); };

/** SHA-256 hex via the platform Web Crypto global (application code may not import node:crypto). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Resolves and deep-copies everything the request depends on; throws on scope, approval or parent problems. */
function buildSnapshot(tx: UnitOfWork, input: C.PreviewInput): { projectId: string; snapshot: C.Snapshot } {
  const scene = tx.get("scenes", input.sceneId) ?? notFound("Scene");
  const projectId = scene.projectId; const content = scene.content;
  const inProject = <T extends { projectId: string }>(record: T | null, what: string): T => record && record.projectId === projectId ? record : notFound(what);
  const approved = <T extends { approvedAt: string | null }>(record: T, what: string): T => {
    if (record.approvedAt === null) throw new AppError("CONFLICT", `${what} version is no longer approved`);
    return record;
  };
  const style = content.styleVersionId ? approved(inProject(tx.get("styles", content.styleVersionId), "Style version"), "Style") : null;
  const assets = content.assetVersionIds.map(id => approved(inProject(tx.get("assets", id), "Asset version"), "Asset"));
  for (const ref of content.references) inProject(tx.get("media", ref.mediaId), "Referenced media");
  let parentRef: C.Snapshot["scene"]["references"] = [];
  if (input.parentCandidateId) {
    const candidate = inProject(tx.get("candidates", input.parentCandidateId), "Parent candidate");
    const run = inProject(tx.get("runs", candidate.runId), "Parent run");
    if (run.snapshot.sceneId !== input.sceneId) throw new AppError("VALIDATION", "Parent candidate belongs to a different scene");
    inProject(tx.get("media", candidate.mediaId), "Parent media");
    parentRef = [{ mediaId: candidate.mediaId, role: "parent", note: "" }];
  }
  if (input.edit?.maskMediaId) {
    inProject(tx.get("media", input.edit.maskMediaId), "Mask media");
    throw new AppError("UNSUPPORTED", "Masks are not supported; remove the mask explicitly to request a whole-image edit");
  }
  // The stored scene is untouched: the snapshot gets its own copy with the parent prepended.
  const sceneCopy = structuredClone(content);
  sceneCopy.references = [...parentRef, ...sceneCopy.references];
  return { projectId, snapshot: C.Snapshot.parse({ sceneId: scene.id, sceneRevision: scene.revision, scene: sceneCopy, style: structuredClone(style), assets: structuredClone(assets), parentCandidateId: input.parentCandidateId, edit: input.edit ? structuredClone(input.edit) : null }) };
}

/** T05: docs/contracts.md#previews. Preserve signature; implement all listed invariants. */
export async function createPreview(deps: Dependencies, input: C.PreviewInput): Promise<C.Preview> {
  const parsed = C.PreviewInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid preview request");
  const request = parsed.data;
  const { projectId, snapshot } = deps.repo.transaction(tx => buildSnapshot(tx, request));
  const compiled = compile(snapshot, request);
  const hash = await sha256Hex(canonicalJson({ snapshot, compiled }));
  const createdAt = deps.now();
  const preview = C.Preview.parse({ id: deps.newId(), projectId, revision: 0, createdAt, snapshot, compiled, hash, expiresAt: new Date(Date.parse(createdAt) + C.Limits.previewTtlMs).toISOString() });
  // Hashing is async, so re-check inside the write transaction that nothing the snapshot depends on moved.
  deps.repo.transaction(tx => {
    const current = buildSnapshot(tx, request).snapshot;
    if (canonicalJson(current) !== canonicalJson(snapshot)) throw new AppError("CONFLICT", "Scene or library changed while preparing the preview; request it again");
    tx.insert("previews", preview);
  });
  return preview;
}
