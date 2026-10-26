// T16: fal key/mode settings. Real route handlers + wired container on an isolated migrated APP_DATA_DIR, plus a real
// worker child process for the two-process rules. No run is ever submitted in fal mode here: zero fal requests.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as C from "../../src/contracts";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { getDependencies, resetDependencies } from "../../src/server/container";
import { createDependencies } from "../../src/server/create-dependencies";
import { loadEffectiveConfig, readSettingsFile } from "../../src/server/settings";
import { compiled, ids, now, project, sceneInput, snapshot } from "../support/fixtures";

const ENV_KEY = "t16-env-sentinel-key";
const FILE_KEY = "t16-file-sentinel-key:abc123";
const base = "http://127.0.0.1:3000";
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
let root: string; const saved: Record<string, string | undefined> = {}; const workers: ChildProcess[] = [];
const setEnv = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const settingsPath = () => join(root, "settings", "settings.json");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t16-"));
  setEnv({ APP_DATA_DIR: root, GENERATION_PROVIDER: undefined, FAL_KEY: undefined });
  migrateDatabase(join(root, "studio.sqlite"));
});
afterEach(async () => {
  for (const w of workers.splice(0)) if (w.exitCode === null) { w.kill("SIGKILL"); await new Promise(r => w.once("exit", r)); }
  resetDependencies();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const routes = async () => ({
  settings: await import("../../src/app/api/settings/fal/route"),
  health: await import("../../src/app/api/health/route"),
  models: await import("../../src/app/api/models/route"),
  generations: await import("../../src/app/api/generations/route"),
  workspace: await import("../../src/app/api/projects/[id]/workspace/route"),
});
const put = (body: unknown, headers: Record<string, string> = {}) => new Request(`${base}/api/settings/fal`, { method: "PUT", headers: { "content-type": "application/json", host: "127.0.0.1:3000", ...headers }, body: JSON.stringify(body) });
const del = () => new Request(`${base}/api/settings/fal`, { method: "DELETE", headers: { host: "127.0.0.1:3000" } });
async function call(response: Response | Promise<Response>) { const r = await response; const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) }; }
const restart = () => resetDependencies(); // a server restart reopens everything from env + settings file

function seedPreview(n = 1) {
  const repo = getDependencies().repo;
  if (!repo.get("projects", ids.project)) {
    repo.insert("projects", structuredClone(project));
    repo.insert("scenes", { id: ids.scene, projectId: ids.project, revision: 0, createdAt: now, content: structuredClone(sceneInput.content) });
  }
  const id = `00000000-0000-4000-8000-${String(700 + n).padStart(12, "0")}`;
  repo.insert("previews", { id, projectId: ids.project, revision: 0, createdAt: now, snapshot: structuredClone(snapshot), compiled: structuredClone(compiled), hash: String(n).repeat(64), expiresAt: "2999-01-01T00:00:00.000Z" });
  return { previewId: id, previewHash: String(n).repeat(64), idempotencyKey: `00000000-0000-4000-8000-${String(800 + n).padStart(12, "0")}`, acceptUnknownCost: false, maxEstimatedCostMicros: 0 };
}
const submit = async (input: unknown) => call((await routes()).generations.POST(new Request(`${base}/api/generations`, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body: JSON.stringify(input) })));

describe("storage, precedence and restart", () => {
  it("stores the key privately, never returns it, and applies only after a restart", async () => {
    const { settings, health, models } = await routes();
    expect((await call(settings.GET())).body.data).toEqual({ configured: false, source: "none", savedMode: "mock", modeSource: "default", serverMode: "mock", restartRequired: false });
    const saved = await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    expect(saved.status).toBe(200); expect(saved.text).not.toContain(FILE_KEY);
    expect(saved.body.data).toEqual({ configured: true, source: "file", savedMode: "fal", modeSource: "file", serverMode: "mock", restartRequired: true });
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "settings")).mode & 0o777).toBe(0o700);
    expect(readSettingsFile(root)).toEqual({ mode: "fal", falKey: FILE_KEY });
    // Saving does not switch the running server: fal is not offered and nothing new may start until restart.
    expect((await call(models.GET())).body.data.map((m: C.ModelInfo) => [m.available, m.reason])).toEqual([[false, "RESTART_REQUIRED"], [false, "RESTART_REQUIRED"], [false, "RESTART_REQUIRED"]]);
    expect((await call(health.GET())).body.data).toMatchObject({ provider: "mock", liveGeneration: false, restartRequired: true });

    restart();
    const after = await call(health.GET());
    expect(after.body.data).toMatchObject({ provider: "fal", liveGeneration: true, restartRequired: false }); expect(after.text).not.toContain(FILE_KEY);
    expect((await call(models.GET())).body.data.map((m: C.ModelInfo) => m.available)).toEqual([true, true, true]);
    expect((await call(settings.GET())).body.data).toMatchObject({ serverMode: "fal", restartRequired: false });
    // The worker reads the same file the same way at start.
    const workerSide = createDependencies(loadEffectiveConfig({ APP_DATA_DIR: root }));
    expect([...workerSide.adapters.keys()]).toEqual(["mock-reference", "fal-flux2-edit", "fal-flux2-text"]); workerSide.repo.close();
  });
  it("environment variables win over the file and are reported as such", async () => {
    const { settings } = await routes();
    await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    setEnv({ FAL_KEY: ENV_KEY, GENERATION_PROVIDER: "mock" }); restart();
    const view = await call(settings.GET());
    expect(view.body.data).toEqual({ configured: true, source: "env", savedMode: "fal", modeSource: "env", serverMode: "mock", restartRequired: false });
    expect(view.text).not.toContain(ENV_KEY);
    expect(loadEffectiveConfig(process.env)).toMatchObject({ provider: "mock", falKey: ENV_KEY });
    setEnv({ GENERATION_PROVIDER: undefined }); restart();
    expect(loadEffectiveConfig(process.env)).toMatchObject({ provider: "fal", falKey: ENV_KEY }); // file mode, env key
  });
  it("delete removes the stored key and stores mock; after restart the server is mock", async () => {
    const { settings, health } = await routes();
    await call(settings.PUT(put({ mode: "fal", key: FILE_KEY }))); restart();
    const removed = await call(settings.DELETE(del()));
    expect(removed.body.data).toMatchObject({ configured: false, source: "none", savedMode: "mock", serverMode: "fal", restartRequired: true });
    expect(readFileSync(settingsPath(), "utf8")).not.toContain(FILE_KEY);
    restart();
    expect((await call(health.GET())).body.data).toMatchObject({ provider: "mock", liveGeneration: false });
  });
  it("omitting the key keeps the stored one; a change that runs the same needs no restart", async () => {
    const { settings, models } = await routes();
    await call(settings.PUT(put({ mode: "mock", key: FILE_KEY })));
    const same = await call(settings.PUT(put({ mode: "mock" })));
    expect(same.body.data).toMatchObject({ configured: true, source: "file", restartRequired: false });
    expect(readSettingsFile(root)).toEqual({ mode: "mock", falKey: FILE_KEY });
    expect((await call(models.GET())).body.data[0]).toMatchObject({ available: true, reason: null });
  });
});

describe("invalid input, write failures and origin", () => {
  it("rejects bad input and write failures without touching the existing file", async () => {
    const { settings } = await routes();
    await call(settings.PUT(put({ mode: "mock", key: FILE_KEY })));
    const before = readFileSync(settingsPath());
    for (const body of [{ mode: "fal", key: "" }, { mode: "fal", key: "has space" }, { mode: "other" }, { mode: "mock", extra: 1 }]) {
      const r = await call(settings.PUT(put(body))); expect(r.status, JSON.stringify(body)).toBe(400); expect(r.body.error.code).toBe("VALIDATION");
    }
    rmSync(settingsPath());
    expect((await call(settings.PUT(put({ mode: "fal" })))).body.error.code).toBe("VALIDATION"); // fal needs a key from somewhere
    writeFileSync(settingsPath(), before, { mode: 0o600 });
    // Write failure 1: a symlinked settings directory is refused; the file it points at stays as it was.
    renameSync(join(root, "settings"), join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(root, "settings"));
    const refused = await call(settings.PUT(put({ mode: "fal", key: "another-key" })));
    expect(refused.status).toBe(500); expect(refused.body.error.code).toBe("STORAGE");
    expect(refused.text).not.toContain(root); expect(refused.text).not.toContain("another-key");
    expect(readFileSync(join(root, "elsewhere", "settings.json")).equals(before)).toBe(true);
    rmSync(join(root, "settings")); renameSync(join(root, "elsewhere"), join(root, "settings"));
    // Write failure 2: the final rename fails (target is a directory); no temp file is left behind.
    rmSync(settingsPath()); mkdirSync(join(settingsPath(), "blocker"), { recursive: true });
    expect((await call(settings.PUT(put({ mode: "mock" })))).body.error.code).toBe("STORAGE");
    expect(readdirSync(join(root, "settings"))).toEqual(["settings.json"]);
    rmSync(settingsPath(), { recursive: true }); writeFileSync(settingsPath(), before, { mode: 0o600 });
    expect((await call(settings.PUT(put({ mode: "mock" }, { origin: "https://evil.example" })))).body.error.code).toBe("FORBIDDEN");
    expect(readFileSync(settingsPath()).equals(before)).toBe(true);
  });
  it("a malformed settings file is reported without content or path", async () => {
    const { settings } = await routes();
    await call(settings.PUT(put({ mode: "mock", key: FILE_KEY })));
    writeFileSync(settingsPath(), `{"version":1,"mode":"fal","falKey":"${FILE_KEY}","x":1}`);
    const r = await call(settings.GET());
    expect(r.body.error.code).toBe("STORAGE"); expect(r.text).not.toContain(FILE_KEY); expect(r.text).not.toContain(root);
  });
});

describe("active runs and the generation gate", () => {
  it.each(["draft", "submission_unknown", "download_failed", "running"] as const)("a %s run blocks change and delete; nothing is written and generation stays open", async status => {
    const { settings, models } = await routes();
    await call(settings.PUT(put({ mode: "mock", key: FILE_KEY })));
    const before = readFileSync(settingsPath());
    const run = await submit(seedPreview()); expect(run.status).toBe(200);
    const repo = getDependencies().repo; const current = repo.get("runs", run.body.data.id)!;
    if (status !== "draft") repo.replace("runs", { ...current, status, revision: current.revision + 1 }, current.revision);
    for (const r of [await call(settings.PUT(put({ mode: "fal", key: "other-key" }))), await call(settings.DELETE(del()))]) { expect(r.status).toBe(409); expect(r.body.error.code).toBe("CONFLICT"); }
    expect(readFileSync(settingsPath()).equals(before)).toBe(true);
    expect((await call(models.GET())).body.data[0]).toMatchObject({ available: true });
  });
  it("after a change that needs a restart, new generations are refused until restart (mock included)", async () => {
    const { settings } = await routes();
    await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    const refused = await submit(seedPreview(1));
    expect(refused.status).toBe(422); expect(refused.body.error.code).toBe("UNSUPPORTED");
    setEnv({ GENERATION_PROVIDER: "mock" }); restart(); // restart (pinned to mock so no fal adapter exists in this test)
    expect((await submit(seedPreview(2))).status).toBe(200);
  });
  it("a submit already in flight when the settings change lands is refused; a run created first blocks the change", async () => {
    const { settings, generations } = await routes();
    // Order 1: the submit request is in flight (body not yet read) when the change is saved.
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const input = seedPreview(1);
    const body = new ReadableStream<Uint8Array>({ async start(controller) { await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(input))); controller.close(); } });
    const inFlight = call(generations.POST(new Request(`${base}/api/generations`, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body, duplex: "half" } as RequestInit)));
    const change = await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    release();
    const run = await inFlight;
    expect(change.status).toBe(200);
    expect(run.status).toBe(422); expect(run.body.error.code).toBe("UNSUPPORTED");
    expect(getDependencies().repo.list("runs")).toEqual([]);

    // Order 2: the run exists first; the change is refused and the file is untouched.
    rmSync(settingsPath()); restart();
    expect((await submit(seedPreview(2))).status).toBe(200);
    const refused = await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(readSettingsFile(root)).toBeNull();
  });
});

describe("two processes and secrecy", () => {
  function startWorker(env: Record<string, string> = {}) {
    const child = spawn(tsx, ["src/worker/main.ts"], { env: { ...process.env, APP_DATA_DIR: root, GENERATION_PROVIDER: "", FAL_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", d => { output += d; }); child.stderr!.on("data", d => { output += d; });
    workers.push(child);
    return { output: () => output, exited: () => new Promise<number | null>(resolve => child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", code => resolve(code))) };
  }
  async function waitFor(probe: () => boolean, timeoutMs = 30_000) { const deadline = Date.now() + timeoutMs; while (!probe()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise(r => setTimeout(r, 200)); } }

  it("the worker starts with the saved settings, never logs the key, and stops when the settings change", async () => {
    const { settings } = await routes();
    await call(settings.PUT(put({ mode: "fal", key: FILE_KEY })));
    const worker = startWorker();
    await waitFor(() => worker.output().includes("Worker started"));
    expect(worker.output()).toContain("provider: fal; live fal: configured");
    restart(); // server restarted with the same file: no active run, so the change below is allowed
    await call(settings.DELETE(del()));
    expect(await worker.exited()).toBe(0);
    expect(worker.output()).toContain("Provider settings changed");
    expect(worker.output()).not.toContain(FILE_KEY); expect(worker.output()).not.toContain(root);
    const mockWorker = startWorker();
    await waitFor(() => mockWorker.output().includes("Worker started"));
    expect(mockWorker.output()).toContain("provider: mock; live fal: off");
  }, 60_000);
  it("the key appears in no API response", async () => {
    const { settings, health, models, workspace } = await routes();
    await call(settings.PUT(put({ mode: "fal", key: FILE_KEY }))); restart();
    seedPreview();
    const bodies = [await call(settings.GET()), await call(health.GET()), await call(models.GET()), await call(workspace.GET(new Request(base), { params: Promise.resolve({ id: ids.project }) }))];
    for (const r of bodies) { expect(r.status).toBe(200); expect(r.text).not.toContain(FILE_KEY); }
  });
});
