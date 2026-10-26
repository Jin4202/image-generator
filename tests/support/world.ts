import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { openRepository } from "../../src/infrastructure/persistence/repository";
import { testDependencies } from "./dependencies";
import { project, ids, sceneInput, now, snapshot, compiled } from "./fixtures";
export function world() {
 const root=mkdtempSync(join(tmpdir(),"studio-acceptance-")); const path=join(root,"studio.sqlite");
 try { migrateDatabase(path); const repo=openRepository(path); repo.insert("projects",structuredClone(project));
 repo.insert("scenes",{id:ids.scene,projectId:ids.project,revision:0,createdAt:now,content:structuredClone(sceneInput.content)});
 const deps=testDependencies({repo});
 return {root,path,deps,seedPreview:()=>repo.insert("previews",{id:ids.preview,projectId:ids.project,revision:0,createdAt:now,snapshot:structuredClone(snapshot),compiled:structuredClone(compiled),hash:"a".repeat(64),expiresAt:"2026-10-26T00:15:00.000Z"}),dispose:()=>{repo.close();rmSync(root,{recursive:true,force:true});}};
 } catch(error) {rmSync(root,{recursive:true,force:true});throw error;}
}
