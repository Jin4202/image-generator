// PENDING T12: isolated actual API wiring acceptance; no live generation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { POST } from "../../src/app/api/projects/route";
import { getDependencies } from "../../src/server/container";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
it("T12 production API uses a migrated temporary database",async()=>{
 const root=mkdtempSync(join(tmpdir(),"wiring-"));const previous=process.env.APP_DATA_DIR;const previousProvider=process.env.GENERATION_PROVIDER;process.env.APP_DATA_DIR=root;process.env.GENERATION_PROVIDER="mock";migrateDatabase(join(root,"studio.sqlite"));
 try {const r=await POST(new Request("http://localhost/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"Handoff test"})}));expect(r.status).toBe(200);expect((await r.json()).data.title).toBe("Handoff test");}
 finally {try{getDependencies().repo.close();}catch{}if(previous===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=previous;if(previousProvider===undefined)delete process.env.GENERATION_PROVIDER;else process.env.GENERATION_PROVIDER=previousProvider;rmSync(root,{recursive:true,force:true});}
});
