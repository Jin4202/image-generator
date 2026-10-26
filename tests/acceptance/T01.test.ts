// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { openRepository } from "../../src/infrastructure/persistence/repository";
import { project } from "../support/fixtures";
it("T01 persists across reopen, rolls back and rejects stale revisions", () => {
 const root=mkdtempSync(join(tmpdir(),"repo-"));let db:ReturnType<typeof openRepository>|undefined;
 try {const path=join(root,"db.sqlite");migrateDatabase(path);db=openRepository(path);db.insert("projects",project);db.close();db=openRepository(path);expect(db.get("projects",project.id)).toEqual(project);
 expect(()=>db!.transaction(tx=>{tx.replace("projects",{...project,title:"changed",revision:1},0);throw new Error("rollback");})).toThrow("rollback");expect(db.get("projects",project.id)?.title).toBe("Wind Duel");
 expect(()=>db!.replace("projects",{...project,revision:1},2)).toThrow();
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
