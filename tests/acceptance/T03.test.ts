// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { createProject } from "../../src/application/services/projects";
import { createStyle, approveStyle } from "../../src/application/services/library";
import { ids } from "../support/fixtures";
import { world } from "../support/world";
it("T03 creates immutable approved versions and trims project titles",async()=>{
 const w=world();try{expect((await createProject(w.deps,{title:" Test ",budgetMicros:null})).title).toBe("Test");
 const specification={linework:"ink",shading:"cel",palette:"blue",anatomy:"stylized",rendering:"flat",lighting:"rim",effectsLanguage:"wind",positive:"anime",negative:""};
 const input={projectId:ids.project,logicalId:ids.media,specification,referenceIds:[]};const first=await createStyle(w.deps,input);await approveStyle(w.deps,first.id);const second=await createStyle(w.deps,{...input,specification:{...specification,palette:"red"}});expect(second.version).toBe(2);expect(w.deps.repo.get("styles",first.id)?.specification.palette).toBe("blue");
 }finally{w.dispose();}
});
