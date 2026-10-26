// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { compile } from "../../src/application/compiler";
import { snapshot, ids } from "../support/fixtures";
it("T05 compiler preserves order, reports baseline omission and blocks overflow",()=>{
 const input=structuredClone(snapshot);input.scene.references=[{mediaId:ids.media,role:"sketch",note:""},{mediaId:ids.candidate,role:"character",note:""}];
 const a=compile(input,{adapterId:"fal-flux2-edit",outputCount:1,seed:1});expect(a.references.map(r=>r.role)).toEqual(["character","sketch"]);expect(compile(input,{adapterId:"fal-flux2-edit",outputCount:1,seed:1})).toEqual(a);
 const b=compile(input,{adapterId:"fal-flux2-text",outputCount:1,seed:1});expect(b.references).toHaveLength(0);expect(b.warnings).toContain("REFERENCES_OMITTED");
 input.scene.references=Array.from({length:5},()=>({mediaId:ids.media,role:"style" as const,note:""}));expect(()=>compile(input,{adapterId:"fal-flux2-edit",outputCount:1,seed:1})).toThrow();
});
