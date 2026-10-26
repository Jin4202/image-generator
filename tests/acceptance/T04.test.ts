// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { updateScene, duplicateScene } from "../../src/application/services/scenes";
import { ids, sceneInput } from "../support/fixtures";
import { world } from "../support/world";
it("T04 scene update uses CAS; duplicate preserves independent snapshot",async()=>{const w=world();try{
 const changed=await updateScene(w.deps,ids.scene,{expectedRevision:0,content:{...sceneInput.content,prompt:"new pose"}});expect(changed.revision).toBe(1);
 await expect(updateScene(w.deps,ids.scene,{expectedRevision:0,content:sceneInput.content})).rejects.toMatchObject({code:"CONFLICT"});
 const copy=await duplicateScene(w.deps,ids.scene);expect(copy.id).not.toBe(ids.scene);expect(copy.content).toEqual(changed.content);
 }finally{w.dispose();}});
