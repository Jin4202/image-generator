import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { POST } from "../../src/app/api/demo/route";
import { GET as listProjects, POST as createProject } from "../../src/app/api/projects/route";
import { Limits } from "../../src/contracts";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { resetDependencies } from "../../src/server/container";
function req(body: unknown) { return new Request("http://localhost/api/demo", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); }
it("runs full mock transport without claiming persistence", async () => { const response=await POST(req({prompt:"Wind Duel"})); const {data}=await response.json(); expect(response.status).toBe(200); expect(data.trace).toEqual(["queued","running","completed"]); expect(data.persisted).toBe(false); expect(data.imageDataUrl).toMatch(/^data:image\/png;base64,/); });
it("rejects malformed input and cross-origin mutation", async () => { expect((await POST(req({prompt:""}))).status).toBe(400); const r=req({prompt:"x"});r.headers.set("Origin","https://foreign.example");expect((await POST(r)).status).toBe(403); });
it("enforces streamed JSON limit", async () => { expect((await POST(req({prompt:"x".repeat(Limits.jsonBytes)}))).status).toBe(413); });
// T12 replaced the temporary "production API returns 501" assertion with real persistence through the wired container.
it("production API persists to the configured, migrated database and reports an unmigrated one explicitly", async () => {
  const root=mkdtempSync(join(tmpdir(),"wired-"));const previous=process.env.APP_DATA_DIR;process.env.APP_DATA_DIR=root;
  try {
    const unmigrated=await createProject(req({title:"Before migrate"}));expect(unmigrated.status).toBe(500);
    const failure=(await unmigrated.json()).error;expect(failure.code).toBe("STORAGE");expect(failure.message).toContain("db:migrate");expect(JSON.stringify(failure)).not.toContain(root);
    migrateDatabase(join(root,"studio.sqlite"));
    const created=await createProject(req({title:" Wind Duel "}));expect(created.status).toBe(200);const project=(await created.json()).data;expect(project.title).toBe("Wind Duel");
    resetDependencies(); // simulate a server restart: reopen from disk
    expect((await (await listProjects()).json()).data.map((p: { id: string }) => p.id)).toEqual([project.id]);
  } finally { resetDependencies(); if(previous===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=previous; rmSync(root,{recursive:true,force:true}); }
});

it("unexpected errors do not leak provider details",async()=>{const {respond}=await import("../../src/server/http");const r=await respond(async()=>{throw new Error("FAL_KEY=secret");});expect(r.status).toBe(500);expect(await r.text()).not.toContain("secret");});

it("allows browser loopback Host when Next normalizes request URL",async()=>{const r=req({prompt:"x"});r.headers.set("Host","127.0.0.1");r.headers.set("Origin","http://127.0.0.1");expect((await POST(r)).status).toBe(200);});
it("rejects non-local Host even without Origin",async()=>{const r=req({prompt:"x"});r.headers.set("Host","attacker.example");expect((await POST(r)).status).toBe(403);});
