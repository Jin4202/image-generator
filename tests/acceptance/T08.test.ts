// PENDING T08: functional acceptance; must fail before implementation.
import { expect, it } from "vitest";
import { saveReview, refineCandidate } from "../../src/application/services/review";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { ids } from "../support/fixtures";
import { seedCandidate } from "../support/seed-candidate";
import { world } from "../support/world";
it("T08 appends reviews and creates child preview without mutating parent",async()=>{
 const w=world();try{const deps={...w.deps,blobs:createLocalBlobStore(w.root)};const ratings={identity:4,style:4,composition:4,anatomy:3,preservation:null,approved:true,notes:""};
 await expect(saveReview(deps,ids.candidate,ratings)).rejects.toMatchObject({code:"NOT_FOUND"});
 await seedCandidate(deps);const before=deps.repo.get("candidates",ids.candidate);await saveReview(deps,ids.candidate,ratings);await saveReview(deps,ids.candidate,{...ratings,notes:"second"});expect(deps.repo.list("reviews",ids.project)).toHaveLength(2);
 const preview=await refineCandidate(deps,ids.candidate,{sceneId:ids.scene,adapterId:"mock-reference",outputCount:1,seed:1,edit:{instruction:"fix blade",preservation:"preserve face",maskMediaId:null}});expect(preview.snapshot.parentCandidateId).toBe(ids.candidate);expect(deps.repo.get("candidates",ids.candidate)).toEqual(before);expect(deps.repo.list("runs",ids.project)).toHaveLength(1);
 }finally{w.dispose();}
});
