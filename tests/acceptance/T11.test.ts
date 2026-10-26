// PENDING T11: functional acceptance; must fail before implementation.
import { expect, it } from "vitest";
import { createExperiment, reportExperiment } from "../../src/application/services/experiments";
import { ids, now, sceneInput } from "../support/fixtures";
import { world } from "../support/world";
it("T11 stores a plan without submitting and reports empty results honestly",async()=>{const w=world();try{
 const input={projectId:ids.project,sceneIds:[ids.scene,ids.media,ids.candidate],repeats:3 as const};await expect(createExperiment(w.deps,input)).rejects.toMatchObject({code:"NOT_FOUND"});
 for(const id of [ids.media,ids.candidate])w.deps.repo.insert("scenes",{id,projectId:ids.project,revision:0,createdAt:now,content:sceneInput.content});
 const experiment=await createExperiment(w.deps,input);expect(experiment.runIds).toEqual([]);expect(experiment.sceneRevisions[ids.scene]).toBe(0);expect(w.deps.repo.list("runs",ids.project)).toHaveLength(0);
 const report=await reportExperiment(w.deps,experiment.id);expect(report).toMatchObject({total:0,accepted:0,acceptanceRate:null,medianLatencyMs:null,costPerAccepted:{kind:"unknown"}});
 }finally{w.dispose();}});
