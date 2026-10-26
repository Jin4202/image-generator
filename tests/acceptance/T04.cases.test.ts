// T04 normal/error/boundary cases: scene service, canvas normalization helpers and scene HTTP routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../src/application/ports";
import { approveAsset, approveStyle, createAsset, createStyle } from "../../src/application/services/library";
import { createScene, duplicateScene, getScene, updateScene } from "../../src/application/services/scenes";
import { boxFromDrag, normalizePoint, replaceSketchReference } from "../../src/components/canvas/scene-canvas";
import { SceneContent } from "../../src/contracts";
import type { Media } from "../../src/contracts";
import { ids, now, project, sceneInput } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests inject the real T01–T04 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const scenesRoute = await import("../../src/app/api/scenes/route");
const sceneRoute = await import("../../src/app/api/scenes/[id]/route");
const duplicateRoute = await import("../../src/app/api/scenes/[id]/duplicate/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const other = id(500);
const later = "2026-10-26T00:05:00.000Z";
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const media = (n: number, projectId = ids.project): Media => ({ id: id(n), projectId, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: 1, relativePath: `blobs/${"b".repeat(64)}.png`, source: "upload", licenseNotes: "" });
const specification = { linework: "", shading: "", palette: "", anatomy: "", rendering: "", lighting: "", effectsLanguage: "", positive: "anime", negative: "" };
const base: SceneContent = structuredClone(sceneInput.content);
const content = (patch: Partial<SceneContent> = {}): SceneContent => ({ ...structuredClone(base), ...patch });

let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string;
let approvedStyle: string; let draftStyle: string; let approvedAsset: string; let draftAsset: string; let foreignStyle: string;
beforeEach(async () => {
  w = world(); clock = now; deps = { ...w.deps, now: () => clock }; container.deps = deps;
  deps.repo.insert("projects", { ...project, id: other, projectId: other, title: "Other" });
  for (const m of [media(10), media(11), media(12, other)]) deps.repo.insert("media", m);
  approvedStyle = (await approveStyle(deps, (await createStyle(deps, { projectId: ids.project, logicalId: id(700), specification, referenceIds: [] })).id)).id;
  draftStyle = (await createStyle(deps, { projectId: ids.project, logicalId: id(700), specification, referenceIds: [] })).id;
  const asset = { projectId: ids.project, logicalId: id(800), name: "Kaze", kind: "character" as const, invariants: "", variants: "", slots: [{ slot: "front" as const, mediaId: id(10) }] };
  approvedAsset = (await approveAsset(deps, (await createAsset(deps, asset)).id)).id;
  draftAsset = (await createAsset(deps, asset)).id;
  foreignStyle = (await approveStyle(deps, (await createStyle(deps, { projectId: other, logicalId: id(701), specification, referenceIds: [] })).id)).id;
});
afterEach(() => { container.deps = null; w.dispose(); });

describe("createScene / getScene", () => {
  it("stores trimmed prompt, approved versions, references and boxes in order", async () => {
    const value = content({
      prompt: "  duel on a cliff  ", styleVersionId: approvedStyle, assetVersionIds: [approvedAsset],
      references: [{ mediaId: id(10), role: "character", note: "front" }, { mediaId: id(10), role: "style", note: "" }, { mediaId: id(11), role: "sketch", note: "" }],
      boxes: [{ label: "hero", box: { x: 0, y: 0, w: 1, h: 1 }, zIndex: 1, facing: "left" }, { label: "rival", box: { x: 0.5, y: 0.25, w: 0.5, h: 0.75 }, zIndex: 1, facing: "right" }],
    });
    const scene = await createScene(deps, { projectId: ids.project, content: value });
    expect(scene).toMatchObject({ projectId: ids.project, revision: 0, createdAt: now });
    expect(scene.content).toEqual({ ...value, prompt: "duel on a cliff" });
    expect(await getScene(deps, scene.id)).toEqual(scene);
  });
  it("accepts size bounds 512 and 2048 and rejects outside them, blank prompts and overflowing boxes", async () => {
    expect((await createScene(deps, { projectId: ids.project, content: content({ size: { width: 512, height: 2048 } }) })).content.size).toEqual({ width: 512, height: 2048 });
    for (const bad of [content({ size: { width: 511, height: 1024 } }), content({ size: { width: 1024, height: 2049 } }), content({ prompt: "   " }), content({ boxes: [{ label: "x", box: { x: 0.6, y: 0, w: 0.5, h: 0.5 }, zIndex: 0, facing: "" }] }), content({ boxes: [{ label: "x", box: { x: 0, y: 0, w: 0, h: 0.5 }, zIndex: 0, facing: "" }] })]) {
      expect(await rejection(createScene(deps, { projectId: ids.project, content: bad }))).toBe("VALIDATION");
    }
  });
  it("rejects parent/mask roles and duplicate (media, role) or asset selections", async () => {
    for (const role of ["parent", "mask"] as const) expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ references: [{ mediaId: id(10), role, note: "" }] }) }))).toBe("VALIDATION");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ references: [{ mediaId: id(10), role: "character", note: "a" }, { mediaId: id(10), role: "character", note: "b" }] }) }))).toBe("VALIDATION");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ assetVersionIds: [approvedAsset, approvedAsset] }) }))).toBe("VALIDATION");
  });
  it("blocks unapproved versions with CONFLICT and foreign or missing records with NOT_FOUND", async () => {
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ styleVersionId: draftStyle }) }))).toBe("CONFLICT");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ assetVersionIds: [draftAsset] }) }))).toBe("CONFLICT");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ styleVersionId: foreignStyle }) }))).toBe("NOT_FOUND");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ styleVersionId: approvedAsset }) }))).toBe("NOT_FOUND");
    expect(await rejection(createScene(deps, { projectId: ids.project, content: content({ references: [{ mediaId: id(12), role: "sketch", note: "" }] }) }))).toBe("NOT_FOUND");
    expect(await rejection(createScene(deps, { projectId: id(999), content: content() }))).toBe("NOT_FOUND");
    expect(deps.repo.list("scenes", ids.project).map(s => s.id)).toEqual([ids.scene]);
  });
  it("reports unknown and malformed scene ids", async () => {
    expect(await rejection(getScene(deps, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(getScene(deps, "nope"))).toBe("VALIDATION");
  });
});

describe("updateScene", () => {
  it("applies CAS updates sequentially and rejects stale revisions with CONFLICT", async () => {
    const first = await updateScene(deps, ids.scene, { expectedRevision: 0, content: content({ prompt: "pose A" }) });
    const second = await updateScene(deps, ids.scene, { expectedRevision: 1, content: content({ prompt: "pose B" }) });
    expect(second).toMatchObject({ revision: 2, createdAt: first.createdAt, content: { prompt: "pose B" } });
    expect(await rejection(updateScene(deps, ids.scene, { expectedRevision: 1, content: content({ prompt: "late" }) }))).toBe("CONFLICT");
    expect(await rejection(updateScene(deps, ids.scene, { expectedRevision: 5, content: content() }))).toBe("CONFLICT");
    expect((await getScene(deps, ids.scene)).content.prompt).toBe("pose B");
  });
  it("re-validates references on update and leaves the scene untouched on failure", async () => {
    expect(await rejection(updateScene(deps, ids.scene, { expectedRevision: 0, content: content({ styleVersionId: draftStyle }) }))).toBe("CONFLICT");
    expect(await rejection(updateScene(deps, ids.scene, { expectedRevision: 0, content: content({ references: [{ mediaId: id(12), role: "style", note: "" }] }) }))).toBe("NOT_FOUND");
    expect(await rejection(updateScene(deps, ids.scene, { expectedRevision: -1, content: content() }))).toBe("VALIDATION");
    expect(await rejection(updateScene(deps, id(999), { expectedRevision: 0, content: content() }))).toBe("NOT_FOUND");
    expect(await getScene(deps, ids.scene)).toMatchObject({ revision: 0, content: base });
  });
});

describe("duplicateScene", () => {
  it("creates a new revision-0 scene with an independent deep copy and no runs", async () => {
    const source = await updateScene(deps, ids.scene, { expectedRevision: 0, content: content({ styleVersionId: approvedStyle, boxes: [{ label: "hero", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, zIndex: 0, facing: "" }] }) });
    clock = later; const copy = await duplicateScene(deps, ids.scene);
    expect(copy).toMatchObject({ projectId: ids.project, revision: 0, createdAt: later });
    expect(copy.id).not.toBe(source.id); expect(copy.content).toEqual(source.content);
    await updateScene(deps, copy.id, { expectedRevision: 0, content: { ...copy.content, prompt: "new pose", boxes: [] } });
    expect(await getScene(deps, ids.scene)).toEqual(source);
    expect(deps.repo.list("runs", ids.project)).toEqual([]);
    expect(await rejection(duplicateScene(deps, id(999)))).toBe("NOT_FOUND");
  });
});

describe("SceneCanvas helpers", () => {
  it("normalizes pointer pixels to 0..1 and clamps outside points", () => {
    expect(normalizePoint(360, 135, 720, 540)).toEqual([0.5, 0.25]);
    expect(normalizePoint(-5, 900, 720, 540)).toEqual([0, 1]);
  });
  it("turns drags in any direction into boxes that fit the canvas and drops tiny ones", () => {
    expect(boxFromDrag([0.8, 0.9], [0.2, 0.1])).toEqual({ x: 0.2, y: 0.1, w: 0.6, h: 0.8 });
    const edge = boxFromDrag([1 / 3, 1 / 3], [1, 1])!;
    expect(edge.x + edge.w).toBeLessThanOrEqual(1); expect(edge.y + edge.h).toBeLessThanOrEqual(1);
    expect(boxFromDrag([0.5, 0.5], [0.505, 0.9])).toBeNull();
    for (const box of [edge, boxFromDrag([0, 0], [1, 1])!]) expect(SceneContent.parse(content({ boxes: [{ label: "b", box, zIndex: 0, facing: "" }] })).boxes[0].box).toEqual(box);
  });
  it("replaces sketch references in place and refuses to exceed 20 references", () => {
    const refs: SceneContent["references"] = [{ mediaId: id(1), role: "character", note: "" }, { mediaId: id(2), role: "sketch", note: "old" }, { mediaId: id(3), role: "style", note: "" }, { mediaId: id(4), role: "sketch", note: "" }];
    expect(replaceSketchReference(refs, id(9))).toEqual([refs[0], { mediaId: id(9), role: "sketch", note: "" }, refs[2]]);
    expect(replaceSketchReference([refs[0]], id(9))).toEqual([refs[0], { mediaId: id(9), role: "sketch", note: "" }]);
    const full = Array.from({ length: 20 }, (_, i) => ({ mediaId: id(100 + i), role: "style" as const, note: "" }));
    expect(replaceSketchReference(full, id(9))).toBeNull();
    expect(replaceSketchReference([...full.slice(0, 19), { mediaId: id(2), role: "sketch", note: "" }], id(9))).toHaveLength(20);
  });
});

describe("HTTP routes", () => {
  const url = "http://127.0.0.1:3000/api/scenes";
  const send = (method: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) });
  const read = async (response: Response) => ({ status: response.status, body: await response.json() });

  it("creates, reads, CAS-updates and duplicates scenes", async () => {
    const created = await read(await scenesRoute.POST(send("POST", { projectId: ids.project, content: content({ prompt: " http " }) })));
    expect(created).toMatchObject({ status: 200, body: { data: { revision: 0, content: { prompt: "http" } } } });
    const sceneId = created.body.data.id;
    expect((await read(await sceneRoute.GET(new Request(url), ctx(sceneId)))).body.data).toEqual(created.body.data);
    expect((await read(await sceneRoute.PATCH(send("PATCH", { expectedRevision: 0, content: content({ prompt: "v1" }) }), ctx(sceneId)))).body.data.revision).toBe(1);
    expect(await read(await sceneRoute.PATCH(send("PATCH", { expectedRevision: 0, content: content() }), ctx(sceneId)))).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } });
    const copy = await read(await duplicateRoute.POST(send("POST", {}), ctx(sceneId)));
    expect(copy.status).toBe(200); expect(copy.body.data.id).not.toBe(sceneId); expect(copy.body.data.content.prompt).toBe("v1");
  });
  it("maps validation, approval, origin and id errors", async () => {
    expect((await scenesRoute.POST(send("POST", { projectId: ids.project, content: content({ references: [{ mediaId: id(10), role: "mask", note: "" }] }) }))).status).toBe(400);
    expect((await scenesRoute.POST(send("POST", { projectId: ids.project, content: content({ styleVersionId: draftStyle }) }))).status).toBe(409);
    expect((await scenesRoute.POST(send("POST", { projectId: ids.project, content: content(), extra: 1 }))).status).toBe(400);
    expect((await scenesRoute.POST(send("POST", { projectId: ids.project, content: content() }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await sceneRoute.GET(new Request(url), ctx("bad"))).status).toBe(400);
    expect((await duplicateRoute.POST(send("POST", {}), ctx(id(999)))).status).toBe(404);
  });
});
