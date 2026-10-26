import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies, UnitOfWork } from "../ports";
import { AppError } from "../../domain/errors";

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label} fields`);
  return parsed.data;
}

/** Project and every referenced media must exist in the same project; foreign IDs look missing. */
function checkScope(tx: UnitOfWork, projectId: string, mediaIds: readonly string[]): void {
  if (!tx.get("projects", projectId)) throw new AppError("NOT_FOUND", "Project not found");
  for (const mediaId of mediaIds) {
    const media = tx.get("media", mediaId);
    if (!media || media.projectId !== projectId) throw new AppError("NOT_FOUND", "Referenced media not found");
  }
}

/** Next version for a logical item, decided inside the caller's transaction. */
function nextVersion(versions: readonly { logicalId: string; version: number }[], logicalId: string): number {
  return versions.reduce((max, item) => item.logicalId === logicalId ? Math.max(max, item.version) : max, 0) + 1;
}

/** T03: docs/contracts.md#library. Preserve signature; implement all listed invariants. */
export async function createStyle(deps: Dependencies, input: z.infer<typeof C.CreateStyle>): Promise<C.Style> {
  const data = parse(C.CreateStyle, input, "style");
  if (new Set(data.referenceIds).size !== data.referenceIds.length) throw new AppError("VALIDATION", "Duplicate style reference");
  return deps.repo.transaction(tx => {
    checkScope(tx, data.projectId, data.referenceIds);
    const style = C.Style.parse({ id: deps.newId(), revision: 0, createdAt: deps.now(), ...data, version: nextVersion(tx.list("styles", data.projectId), data.logicalId), approvedAt: null });
    tx.insert("styles", style);
    return style;
  });
}

/** T03: docs/contracts.md#library. Preserve signature; implement all listed invariants. */
export async function approveStyle(deps: Dependencies, id: string): Promise<C.Style> {
  const styleId = parse(C.Id, id, "style ID");
  return deps.repo.transaction(tx => {
    const style = tx.get("styles", styleId);
    if (!style) throw new AppError("NOT_FOUND", "Style not found");
    if (style.approvedAt !== null) return style;
    if (!style.specification.positive.trim()) throw new AppError("VALIDATION", "Style positive specification is required for approval");
    const approved = { ...style, revision: style.revision + 1, approvedAt: deps.now() };
    tx.replace("styles", approved, style.revision);
    return approved;
  });
}

/** T03: docs/contracts.md#library. Preserve signature; implement all listed invariants. */
export async function createAsset(deps: Dependencies, input: z.infer<typeof C.CreateAsset>): Promise<C.Asset> {
  const data = parse(C.CreateAsset, input, "asset");
  if (new Set(data.slots.map(s => s.slot)).size !== data.slots.length) throw new AppError("VALIDATION", "Duplicate asset slot");
  return deps.repo.transaction(tx => {
    checkScope(tx, data.projectId, data.slots.map(s => s.mediaId));
    const asset = C.Asset.parse({ id: deps.newId(), revision: 0, createdAt: deps.now(), ...data, version: nextVersion(tx.list("assets", data.projectId), data.logicalId), approvedAt: null });
    tx.insert("assets", asset);
    return asset;
  });
}

/** T03: docs/contracts.md#library. Preserve signature; implement all listed invariants. */
export async function approveAsset(deps: Dependencies, id: string): Promise<C.Asset> {
  const assetId = parse(C.Id, id, "asset ID");
  return deps.repo.transaction(tx => {
    const asset = tx.get("assets", assetId);
    if (!asset) throw new AppError("NOT_FOUND", "Asset not found");
    if (asset.approvedAt !== null) return asset;
    if (asset.slots.length === 0) throw new AppError("VALIDATION", "Asset approval requires at least one slot image");
    const approved = { ...asset, revision: asset.revision + 1, approvedAt: deps.now() };
    tx.replace("assets", approved, asset.revision);
    return approved;
  });
}
