// T05 normal/error/boundary cases: pure compiler, immutable preview creation and the preview HTTP route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Dependencies } from "../../src/application/ports";
import { canonicalJson, compile } from "../../src/application/compiler";
import { approveAsset, approveStyle, createAsset, createStyle } from "../../src/application/services/library";
import { createPreview } from "../../src/application/services/previews";
import { updateScene } from "../../src/application/services/scenes";
import type { Asset, Media, PreviewInput, Snapshot, Style } from "../../src/contracts";
import { compiled as fixtureCompiled, ids, now, project, sceneInput, snapshot as baseSnapshot } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests inject the real T01–T05 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const previewRoute = await import("../../src/app/api/generations/preview/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const other = id(500);
const throwsCode = (work: () => unknown) => { try { work(); return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const media = (n: number, projectId = ids.project): Media => ({ id: id(n), projectId, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: 1, relativePath: `blobs/${"b".repeat(64)}.png`, source: "upload", licenseNotes: "" });
const spec = { linework: "ink", shading: "cel", palette: "blue", anatomy: "stylized", rendering: "flat", lighting: "rim", effectsLanguage: "wind", positive: "anime", negative: "" };
const styleRecord: Style = { id: id(600), projectId: ids.project, revision: 1, createdAt: now, logicalId: id(700), version: 1, approvedAt: now, referenceIds: [], specification: spec };
const assetRecord: Asset = { id: id(601), projectId: ids.project, revision: 1, createdAt: now, logicalId: id(800), version: 1, approvedAt: now, name: "Kaze", kind: "character", invariants: "scar", variants: "cloak", slots: [] };
const snap = (patch: Partial<Snapshot> = {}, scene: Partial<Snapshot["scene"]> = {}): Snapshot => ({ ...structuredClone(baseSnapshot), ...patch, scene: { ...structuredClone(baseSnapshot.scene), ...scene } });
const ref = (n: number, role: Snapshot["scene"]["references"][number]["role"], note = "") => ({ mediaId: id(n), role, note });
const opts = (adapterId: PreviewInput["adapterId"] = "mock-reference", seed: number | null = 1) => ({ adapterId, outputCount: 1, seed });
const edit = { instruction: "fix blade", preservation: "keep face", maskMediaId: null };

describe("compile", () => {
  it("assembles the exact prompt with sorted-key JSON sections on separate lines", () => {
    const s = snap({ style: styleRecord, assets: [assetRecord] }, { prompt: "Wind duel", camera: "low angle", references: [ref(1, "sketch", "pose"), ref(2, "character", "front")], boxes: [{ label: "hero", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, zIndex: 2, facing: "left" }] });
    expect(compile(s, opts()).prompt).toBe([
      "[SCENE]", "Wind duel",
      "[CAMERA]", "low angle",
      "[STYLE]", '{"anatomy":"stylized","effectsLanguage":"wind","lighting":"rim","linework":"ink","negative":"","palette":"blue","positive":"anime","rendering":"flat","shading":"cel"}',
      "[ASSETS]", '[{"invariants":"scar","kind":"character","name":"Kaze","variants":"cloak"}]',
      "[LAYOUT]", '[{"box":{"h":0.4,"w":0.3,"x":0.1,"y":0.2},"facing":"left","label":"hero","zIndex":2}]',
      "[REFERENCES]", '[{"index":1,"note":"front","role":"character"},{"index":2,"note":"pose","role":"sketch"}]',
      "[EDIT]", "null",
    ].join("\n"));
    expect(compile(snap(), opts()).prompt).toContain("[STYLE]\n{}\n[ASSETS]\n[]\n[LAYOUT]\n[]");
  });
  it("sorts parent → character → style → sketch with stable order inside a role", () => {
    const s = snap({ parentCandidateId: ids.candidate, edit }, { references: [ref(1, "sketch"), ref(2, "style"), ref(9, "parent"), ref(4, "style")] });
    expect(compile(s, opts()).references.map(r => r.mediaId)).toEqual([id(9), id(2), id(4), id(1)]);
    const roles = snap({}, { references: [ref(1, "sketch"), ref(2, "style"), ref(3, "character"), ref(4, "character")] });
    expect(compile(roles, opts()).references.map(r => r.mediaId)).toEqual([id(3), id(4), id(2), id(1)]);
  });
  it("maps endpoints, literal native parameters and pricing without inventing fal prices", () => {
    const one = snap({}, { references: [ref(1, "character")] });
    const mock = compile(one, opts("mock-reference", null));
    expect(mock).toMatchObject({ endpoint: "mock://fixture", estimate: { kind: "known", micros: 0, currency: "USD", source: "mock", verifiedAt: "2026-10-26T00:00:00.000Z" } });
    expect(mock.parameters).toEqual({ image_size: { width: 1280, height: 720 }, num_images: 1, seed: null, guidance_scale: 2.5, num_inference_steps: 28, acceleration: "regular", enable_prompt_expansion: false, enable_safety_checker: true, output_format: "png", sync_mode: false });
    expect(compile(one, opts("fal-flux2-edit"))).toMatchObject({ endpoint: "fal-ai/flux-2/edit", estimate: { kind: "unknown", reason: "pricing-not-configured" } });
    expect(compile(one, opts("fal-flux2-text"))).toMatchObject({ endpoint: "fal-ai/flux-2", estimate: { kind: "unknown", reason: "pricing-not-configured" } });
    expect(compile(one, { ...opts(), outputCount: 4 }).parameters.num_images).toBe(4);
  });
  it("enforces reference limits per adapter without truncating", () => {
    const refs = (n: number) => snap({}, { references: Array.from({ length: n }, (_, i) => ref(i + 1, "style")) });
    expect(throwsCode(() => compile(refs(0), opts("fal-flux2-edit")))).toBe("UNSUPPORTED");
    expect(compile(refs(4), opts("fal-flux2-edit")).references).toHaveLength(4);
    expect(throwsCode(() => compile(refs(5), opts("fal-flux2-edit")))).toBe("UNSUPPORTED");
    expect(compile(refs(0), opts("mock-reference")).references).toEqual([]);
    expect(throwsCode(() => compile(refs(5), opts("mock-reference")))).toBe("UNSUPPORTED");
    expect(compile(refs(5), opts("fal-flux2-text")).references).toEqual([]);
  });
  it("text baseline keeps style/asset text, omits refs visibly and refuses edits", () => {
    const s = snap({ style: styleRecord, assets: [assetRecord] }, { references: [ref(1, "character")] });
    const text = compile(s, opts("fal-flux2-text"));
    expect(text.warnings).toEqual(["REFERENCES_OMITTED"]);
    expect(text.prompt).toContain("[REFERENCES]\n[]");
    expect(text.prompt.split("[REFERENCES]")[0]).toBe(compile(s, opts("fal-flux2-edit")).prompt.split("[REFERENCES]")[0]);
    expect(compile(snap(), opts("fal-flux2-text")).warnings).toEqual([]);
    expect(throwsCode(() => compile(snap({ parentCandidateId: ids.candidate, edit }, { references: [ref(9, "parent")] }), opts("fal-flux2-text")))).toBe("UNSUPPORTED");
  });
  it("emits warnings in the fixed order", () => {
    const negative = { ...styleRecord, specification: { ...spec, negative: "extra fingers" } };
    const edited = snap({ style: negative, parentCandidateId: ids.candidate, edit }, { references: [ref(9, "parent")], boxes: [{ label: "x", box: { x: 0, y: 0, w: 1, h: 1 }, zIndex: 0, facing: "" }] });
    expect(compile(edited, opts()).warnings).toEqual(["SOFT_LAYOUT", "FULL_IMAGE_EDIT", "NEGATIVE_AS_TEXT"]);
    expect(compile(snap({ style: negative }, { references: [ref(1, "sketch")] }), opts("fal-flux2-text")).warnings).toEqual(["SOFT_LAYOUT", "REFERENCES_OMITTED", "NEGATIVE_AS_TEXT"]);
    expect(compile(snap({ style: { ...styleRecord, specification: { ...spec, negative: "   " } } }), opts()).warnings).toEqual([]);
    expect(compile(edited, opts()).prompt).toContain('[EDIT]\n{"instruction":"fix blade","maskMediaId":null,"preservation":"keep face"}');
  });
  it("blocks masks and inconsistent parent/edit snapshots", () => {
    expect(throwsCode(() => compile(snap({ parentCandidateId: ids.candidate, edit: { ...edit, maskMediaId: id(5) } }, { references: [ref(9, "parent")] }), opts()))).toBe("UNSUPPORTED");
    expect(throwsCode(() => compile(snap({}, { references: [ref(5, "mask")] }), opts()))).toBe("UNSUPPORTED");
    expect(throwsCode(() => compile(snap({ parentCandidateId: ids.candidate, edit }), opts()))).toBe("VALIDATION");
    expect(throwsCode(() => compile(snap({}, { references: [ref(9, "parent")] }), opts()))).toBe("VALIDATION");
    expect(throwsCode(() => compile(snap(), { ...opts(), outputCount: 5 }))).toBe("VALIDATION");
  });
  it("is deterministic and never mutates its input", () => {
    const s = snap({ style: styleRecord }, { references: [ref(2, "sketch"), ref(1, "character")] });
    const frozen = structuredClone(s);
    const a = compile(s, opts()); a.references.reverse();
    expect(s).toEqual(frozen);
    expect(compile(s, opts())).toEqual(compile(structuredClone(frozen), opts()));
  });
  it("canonical JSON sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }, 3], a: { d: null, c: "x" } })).toBe('{"a":{"c":"x","d":null},"b":[{"a":2,"z":1},3]}');
  });
});

describe("createPreview", () => {
  let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string; let styleId: string; let assetIds: string[];
  beforeEach(async () => {
    w = world(); clock = now; let n = 100; deps = { ...w.deps, now: () => clock, newId: () => id(n++) }; container.deps = deps;
    deps.repo.insert("projects", { ...project, id: other, projectId: other, title: "Other" });
    for (const m of [media(10), media(11), media(12), media(13, other)]) deps.repo.insert("media", m);
    styleId = (await approveStyle(deps, (await createStyle(deps, { projectId: ids.project, logicalId: id(700), specification: spec, referenceIds: [] })).id)).id;
    const asset = (name: string, logicalId: string) => ({ projectId: ids.project, logicalId, name, kind: "character" as const, invariants: "", variants: "", slots: [{ slot: "front" as const, mediaId: id(10) }] });
    assetIds = [(await approveAsset(deps, (await createAsset(deps, asset("B", id(801)))).id)).id, (await approveAsset(deps, (await createAsset(deps, asset("A", id(802)))).id)).id];
    await updateScene(deps, ids.scene, { expectedRevision: 0, content: { ...structuredClone(sceneInput.content), styleVersionId: styleId, assetVersionIds: [assetIds[1], assetIds[0]], references: [ref(11, "sketch"), ref(10, "character")] } });
  });
  afterEach(() => { container.deps = null; w.dispose(); });
  const input = (patch: Partial<PreviewInput> = {}): PreviewInput => ({ sceneId: ids.scene, adapterId: "mock-reference", outputCount: 1, seed: 7, parentCandidateId: null, edit: null, ...patch });
  const seedParent = () => {
    deps.repo.insert("media", { ...media(20), source: "generated" }); w.seedPreview();
    deps.repo.insert("runs", { id: ids.run, projectId: ids.project, revision: 0, createdAt: now, previewId: ids.preview, idempotencyKey: ids.run, status: "succeeded", snapshot: structuredClone(baseSnapshot), compiled: structuredClone(fixtureCompiled), providerRequestId: "seed", actualCost: { kind: "unknown", reason: "test" }, errorCode: null, updatedAt: now });
    deps.repo.insert("candidates", { id: ids.candidate, projectId: ids.project, revision: 0, createdAt: now, runId: ids.run, index: 0, mediaId: id(20), parentCandidateId: null, seed: 1 });
  };

  it("stores an immutable snapshot with full versions, scene revision, hash and 15 minute expiry", async () => {
    const scene = deps.repo.get("scenes", ids.scene)!; const before = structuredClone(input());
    const request = input(); const preview = await createPreview(deps, request);
    expect(request).toEqual(before);
    expect(preview).toMatchObject({ projectId: ids.project, revision: 0, createdAt: now, expiresAt: "2026-10-26T00:15:00.000Z" });
    expect(preview.snapshot).toEqual({ sceneId: ids.scene, sceneRevision: 1, scene: scene.content, style: deps.repo.get("styles", styleId), assets: [deps.repo.get("assets", assetIds[1]), deps.repo.get("assets", assetIds[0])], parentCandidateId: null, edit: null });
    expect(preview.compiled.references.map(r => r.role)).toEqual(["character", "sketch"]);
    expect(preview.hash).toBe(createHash("sha256").update(canonicalJson({ snapshot: preview.snapshot, compiled: preview.compiled }), "utf8").digest("hex"));
    expect(deps.repo.get("previews", preview.id)).toEqual(preview);
  });
  it("gives identical inputs the same hash, excluding id/createdAt/expiry, and different options a different hash", async () => {
    const a = await createPreview(deps, input()); clock = "2026-10-26T01:00:00.000Z";
    const b = await createPreview(deps, input());
    expect(b.id).not.toBe(a.id); expect(b.expiresAt).toBe("2026-10-26T01:15:00.000Z"); expect(b.hash).toBe(a.hash); expect(b.compiled).toEqual(a.compiled);
    expect((await createPreview(deps, input({ seed: 8 }))).hash).not.toBe(a.hash);
  });
  it("keeps the preview unchanged when the scene is edited afterwards", async () => {
    const preview = await createPreview(deps, input());
    await updateScene(deps, ids.scene, { expectedRevision: 1, content: { ...structuredClone(sceneInput.content), prompt: "changed" } });
    expect(deps.repo.get("previews", preview.id)).toEqual(preview);
  });
  it("prepends the parent reference for edits without touching the stored scene or parent", async () => {
    seedParent(); const scene = deps.repo.get("scenes", ids.scene)!; const candidate = deps.repo.get("candidates", ids.candidate);
    const preview = await createPreview(deps, input({ parentCandidateId: ids.candidate, edit }));
    expect(preview.snapshot.scene.references[0]).toEqual({ mediaId: id(20), role: "parent", note: "" });
    expect(preview.snapshot.scene.references.slice(1)).toEqual(scene.content.references);
    expect(preview.compiled.references.map(r => r.role)).toEqual(["parent", "character", "sketch"]);
    expect(preview.compiled.warnings).toContain("FULL_IMAGE_EDIT");
    expect(deps.repo.get("scenes", ids.scene)).toEqual(scene); expect(deps.repo.get("candidates", ids.candidate)).toEqual(candidate);
  });
  it("rejects parents from other scenes, masks and unsupported reference counts without storing anything", async () => {
    seedParent();
    const second = (await import("../../src/application/services/scenes")).createScene;
    const otherScene = await second(deps, { projectId: ids.project, content: structuredClone(sceneInput.content) });
    expect(await rejection(createPreview(deps, input({ sceneId: otherScene.id, parentCandidateId: ids.candidate, edit })))).toBe("VALIDATION");
    expect(await rejection(createPreview(deps, input({ parentCandidateId: ids.candidate, edit: { ...edit, maskMediaId: id(12) } })))).toBe("UNSUPPORTED");
    expect(await rejection(createPreview(deps, input({ parentCandidateId: ids.candidate, edit: { ...edit, maskMediaId: id(13) } })))).toBe("NOT_FOUND");
    expect(await rejection(createPreview(deps, input({ parentCandidateId: id(999), edit })))).toBe("NOT_FOUND");
    expect(await rejection(createPreview(deps, input({ adapterId: "fal-flux2-text", parentCandidateId: ids.candidate, edit })))).toBe("UNSUPPORTED");
    expect(await rejection(createPreview(deps, input({ sceneId: otherScene.id, adapterId: "fal-flux2-edit" })))).toBe("UNSUPPORTED");
    expect(await rejection(createPreview(deps, input({ sceneId: id(999) })))).toBe("NOT_FOUND");
    expect(await rejection(createPreview(deps, { ...input(), outputCount: 9 }))).toBe("VALIDATION");
    expect(deps.repo.list("previews", ids.project).map(p => p.id)).toEqual([ids.preview]);
  });
  it("records the text baseline omission on a stored preview", async () => {
    const preview = await createPreview(deps, input({ adapterId: "fal-flux2-text" }));
    expect(preview.compiled).toMatchObject({ references: [], warnings: ["SOFT_LAYOUT", "REFERENCES_OMITTED"], estimate: { kind: "unknown" } });
    expect(preview.snapshot.scene.references).toHaveLength(2);
  });
  it("serves the preview route with JSON envelopes and contract status codes", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) => previewRoute.POST(new Request("http://127.0.0.1:3000/api/generations/preview", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const ok = await post({ sceneId: ids.scene, adapterId: "mock-reference" });
    expect(ok.status).toBe(200); expect((await ok.json()).data).toMatchObject({ compiled: { parameters: { num_images: 1, seed: null } } });
    expect((await post({ sceneId: ids.scene, adapterId: "mock-reference", extra: 1 })).status).toBe(400);
    const tooMany = await updateScene(deps, ids.scene, { expectedRevision: 1, content: { ...structuredClone(sceneInput.content), references: [ref(10, "character"), ref(11, "character"), ref(12, "character"), ref(10, "style"), ref(11, "style")] } });
    expect(tooMany.revision).toBe(2);
    expect((await post({ sceneId: ids.scene, adapterId: "fal-flux2-edit" })).status).toBe(422);
    expect((await post({ sceneId: ids.scene, adapterId: "mock-reference" }, { origin: "https://evil.example" })).status).toBe(403);
  });
});
