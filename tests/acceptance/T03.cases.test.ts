// T03 normal/error/boundary cases: projects, workspace, style/asset versions and approval, plus their HTTP routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../src/application/ports";
import { approveAsset, approveStyle, createAsset, createStyle } from "../../src/application/services/library";
import { createProject, getProject, getWorkspace, listProjects } from "../../src/application/services/projects";
import type { Media, Project } from "../../src/contracts";
import { compiled, ids, now, project, snapshot } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests inject the real T01–T03 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const projectsRoute = await import("../../src/app/api/projects/route");
const projectRoute = await import("../../src/app/api/projects/[id]/route");
const workspaceRoute = await import("../../src/app/api/projects/[id]/workspace/route");
const stylesRoute = await import("../../src/app/api/styles/route");
const styleApproveRoute = await import("../../src/app/api/styles/[id]/approve/route");
const assetsRoute = await import("../../src/app/api/assets/route");
const assetApproveRoute = await import("../../src/app/api/assets/[id]/approve/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const other = id(500);
const later = "2026-10-26T00:05:00.000Z";
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const media = (n: number, projectId = ids.project): Media => ({ id: id(n), projectId, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: 1, relativePath: `blobs/${"b".repeat(64)}.png`, source: "upload", licenseNotes: "" });
const specification = { linework: "ink", shading: "cel", palette: "blue", anatomy: "stylized", rendering: "flat", lighting: "rim", effectsLanguage: "wind", positive: "anime", negative: "" };
const styleInput = (logicalId = id(700), referenceIds: string[] = [], projectId = ids.project) => ({ projectId, logicalId, specification, referenceIds });
const assetInput = (slots: { slot: "front" | "side" | "face"; mediaId: string }[] = [{ slot: "front", mediaId: id(10) }], logicalId = id(800)) => ({ projectId: ids.project, logicalId, name: " Kaze ", kind: "character" as const, invariants: "scar on left cheek", variants: "", slots });

let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string;
beforeEach(() => {
  w = world(); clock = now; deps = { ...w.deps, now: () => clock }; container.deps = deps;
  deps.repo.insert("projects", { ...project, id: other, projectId: other, title: "Other" });
  deps.repo.insert("media", media(10)); deps.repo.insert("media", media(11)); deps.repo.insert("media", media(12, other));
});
afterEach(() => { container.deps = null; w.dispose(); });

describe("projects", () => {
  it("creates a persisted project with trimmed title, id=projectId and null budget by default", async () => {
    const created = await createProject(deps, { title: " Wind Duel ", budgetMicros: null });
    expect(created).toMatchObject({ title: "Wind Duel", budgetMicros: null, revision: 0, createdAt: now });
    expect(created.projectId).toBe(created.id);
    expect(deps.repo.get("projects", created.id)).toEqual(created);
    expect((await createProject(deps, { title: "Budgeted", budgetMicros: 5_000_000 })).budgetMicros).toBe(5_000_000);
  });
  it("rejects blank, too long, negative-budget and unknown-field input with VALIDATION", async () => {
    const before = deps.repo.list("projects").length;
    for (const input of [{ title: "   ", budgetMicros: null }, { title: "x".repeat(121), budgetMicros: null }, { title: "ok", budgetMicros: -1 }, { title: "ok", budgetMicros: 1.5 }, { title: "ok", budgetMicros: null, path: "/etc" }]) {
      expect(await rejection(createProject(deps, input as never))).toBe("VALIDATION");
    }
    expect((await createProject(deps, { title: "x".repeat(120), budgetMicros: null })).title).toHaveLength(120);
    expect(deps.repo.list("projects")).toHaveLength(before + 1);
  });
  it("lists projects by createdAt then id and gets one by id", async () => {
    clock = later; const created = await createProject(deps, { title: "Later", budgetMicros: null });
    expect((await listProjects(deps)).map(p => p.id)).toEqual([ids.project, other, created.id]);
    expect(await getProject(deps, created.id)).toEqual(created);
    expect(await rejection(getProject(deps, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(getProject(deps, "not-an-id"))).toBe("VALIDATION");
  });
});

describe("workspace", () => {
  it("returns only this project's aggregates, sorted, without previews", async () => {
    deps.repo.insert("media", { ...media(9), createdAt: later });
    w.seedPreview();
    deps.repo.insert("runs", { id: ids.run, projectId: ids.project, revision: 0, createdAt: now, previewId: ids.preview, idempotencyKey: ids.run, status: "draft", snapshot, compiled, providerRequestId: null, actualCost: { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: now });
    const style = await createStyle(deps, styleInput()); await createStyle(deps, styleInput(id(701), [id(12)], other));
    const workspace = await getWorkspace(deps, ids.project);
    expect(Object.keys(workspace).sort()).toEqual(["assets", "candidates", "effects", "experiments", "exports", "media", "project", "reviews", "runs", "scenes", "styles"]);
    expect(workspace.project).toEqual(deps.repo.get("projects", ids.project));
    expect(workspace.media.map(m => m.id)).toEqual([id(10), id(11), id(9)]);
    expect(workspace.styles).toEqual([style]);
    expect(workspace.scenes.map(s => s.id)).toEqual([ids.scene]);
    expect(workspace.runs.map(r => r.id)).toEqual([ids.run]);
    expect(JSON.stringify(workspace)).not.toContain(w.root);
  });
  it("is NOT_FOUND for unknown projects and VALIDATION for malformed ids", async () => {
    expect(await rejection(getWorkspace(deps, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(getWorkspace(deps, "../x"))).toBe("VALIDATION");
  });
});

describe("styles", () => {
  it("allocates versions per project/logicalId and keeps approved versions immutable", async () => {
    const v1 = await createStyle(deps, styleInput(id(700), [id(10)]));
    expect(v1).toMatchObject({ version: 1, approvedAt: null, revision: 0, referenceIds: [id(10)] });
    clock = later; const approved = await approveStyle(deps, v1.id);
    expect(approved).toMatchObject({ approvedAt: later, revision: 1, version: 1 });
    const v2 = await createStyle(deps, { ...styleInput(), specification: { ...specification, palette: "red" } });
    expect(v2).toMatchObject({ version: 2, approvedAt: null });
    expect(deps.repo.get("styles", v1.id)).toEqual(approved);
    expect((await createStyle(deps, styleInput(id(701)))).version).toBe(1);
    expect((await createStyle(deps, styleInput(id(700), [], other))).version).toBe(1);
    expect((await createStyle(deps, styleInput())).version).toBe(3);
  });
  it("returns the same record when approved again", async () => {
    const style = await createStyle(deps, styleInput());
    const first = await approveStyle(deps, style.id); clock = later;
    expect(await approveStyle(deps, style.id)).toEqual(first);
    expect(deps.repo.get("styles", style.id)?.revision).toBe(1);
  });
  it("rejects duplicate, missing and foreign references and unknown projects without writing", async () => {
    expect(await rejection(createStyle(deps, styleInput(id(700), [id(10), id(10)])))).toBe("VALIDATION");
    expect(await rejection(createStyle(deps, styleInput(id(700), [id(999)])))).toBe("NOT_FOUND");
    expect(await rejection(createStyle(deps, styleInput(id(700), [id(12)])))).toBe("NOT_FOUND");
    expect(await rejection(createStyle(deps, styleInput(id(700), [], id(999))))).toBe("NOT_FOUND");
    expect(await rejection(createStyle(deps, { ...styleInput(), logicalId: "nope" }))).toBe("VALIDATION");
    expect(await rejection(createStyle(deps, { ...styleInput(), extra: true } as never))).toBe("VALIDATION");
    expect(deps.repo.list("styles", ids.project)).toEqual([]);
  });
  it("requires a non-blank positive specification to approve", async () => {
    const style = await createStyle(deps, { ...styleInput(), specification: { ...specification, positive: "  \n " } });
    expect(await rejection(approveStyle(deps, style.id))).toBe("VALIDATION");
    expect(deps.repo.get("styles", style.id)).toEqual(style);
    expect(await rejection(approveStyle(deps, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(approveStyle(deps, "bad"))).toBe("VALIDATION");
  });
});

describe("assets", () => {
  it("creates trimmed versioned assets and approves once", async () => {
    const v1 = await createAsset(deps, assetInput([{ slot: "front", mediaId: id(10) }, { slot: "face", mediaId: id(10) }]));
    expect(v1).toMatchObject({ name: "Kaze", version: 1, approvedAt: null });
    const approved = await approveAsset(deps, v1.id);
    expect(approved).toMatchObject({ approvedAt: now, revision: 1 });
    expect(await approveAsset(deps, v1.id)).toEqual(approved);
    const v2 = await createAsset(deps, { ...assetInput(), invariants: "no scar" });
    expect(v2.version).toBe(2); expect(deps.repo.get("assets", v1.id)).toEqual(approved);
  });
  it("rejects blank names, duplicate slot kinds and foreign/missing slot images", async () => {
    expect(await rejection(createAsset(deps, { ...assetInput(), name: "   " }))).toBe("VALIDATION");
    expect(await rejection(createAsset(deps, assetInput([{ slot: "front", mediaId: id(10) }, { slot: "front", mediaId: id(11) }])))).toBe("VALIDATION");
    expect(await rejection(createAsset(deps, assetInput([{ slot: "side", mediaId: id(12) }])))).toBe("NOT_FOUND");
    expect(await rejection(createAsset(deps, assetInput([{ slot: "side", mediaId: id(999) }])))).toBe("NOT_FOUND");
    expect(deps.repo.list("assets", ids.project)).toEqual([]);
  });
  it("allows a slotless draft but refuses to approve it", async () => {
    const draft = await createAsset(deps, assetInput([]));
    expect(await rejection(approveAsset(deps, draft.id))).toBe("VALIDATION");
    expect(deps.repo.get("assets", draft.id)?.approvedAt).toBeNull();
  });
});

describe("HTTP routes", () => {
  const base = "http://127.0.0.1:3000";
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) });
  const read = async (response: Response) => ({ status: response.status, body: await response.json() });

  it("creates, lists and reads projects and workspaces", async () => {
    const created = await read(await projectsRoute.POST(json("/api/projects", { title: " HTTP " })));
    expect(created).toMatchObject({ status: 200, body: { data: { title: "HTTP", budgetMicros: null } } });
    const list = await read(await projectsRoute.GET());
    expect(list.body.data.map((p: Project) => p.id)).toContain(created.body.data.id);
    expect((await read(await projectRoute.GET(new Request(base), ctx(created.body.data.id)))).body.data).toEqual(created.body.data);
    expect(await read(await projectRoute.GET(new Request(base), ctx(id(999))))).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect((await read(await workspaceRoute.GET(new Request(base), ctx(ids.project)))).body.data.media).toHaveLength(2);
    expect((await read(await workspaceRoute.GET(new Request(base), ctx("x")))).status).toBe(400);
  });
  it("rejects invalid and cross-origin mutations", async () => {
    expect((await projectsRoute.POST(json("/api/projects", { title: "" }))).status).toBe(400);
    expect((await projectsRoute.POST(json("/api/projects", { title: "ok", owner: "me" }))).status).toBe(400);
    expect((await projectsRoute.POST(json("/api/projects", { title: "ok" }, { origin: "https://evil.example" }))).status).toBe(403);
  });
  it("creates and idempotently approves styles and assets", async () => {
    const style = await read(await stylesRoute.POST(json("/api/styles", styleInput())));
    expect(style).toMatchObject({ status: 200, body: { data: { version: 1, approvedAt: null } } });
    const once = await read(await styleApproveRoute.POST(json("/api/styles/x/approve", {}), ctx(style.body.data.id)));
    const twice = await read(await styleApproveRoute.POST(json("/api/styles/x/approve", {}), ctx(style.body.data.id)));
    expect(once.body.data.approvedAt).toBe(now); expect(twice.body).toEqual(once.body);
    const asset = await read(await assetsRoute.POST(json("/api/assets", assetInput())));
    expect((await read(await assetApproveRoute.POST(json("/api/assets/x/approve", {}), ctx(asset.body.data.id)))).body.data.revision).toBe(1);
    expect(await read(await assetsRoute.POST(json("/api/assets", assetInput([{ slot: "front", mediaId: id(12) }]))))).toMatchObject({ status: 404 });
    expect((await styleApproveRoute.POST(json("/api/styles/x/approve", {}, { origin: "https://evil.example" }), ctx(style.body.data.id))).status).toBe(403);
  });
});
