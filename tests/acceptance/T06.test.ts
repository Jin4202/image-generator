// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { submitRun, tickWorker, getRun } from "../../src/application/services/runs";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { ids } from "../support/fixtures";
import { world } from "../support/world";
it("T06 replay is idempotent and worker persists output without duplicate submission",async()=>{const w=world();try{
 const deps={...w.deps,blobs:createLocalBlobStore(w.root)};w.seedPreview();const input={previewId:ids.preview,previewHash:"a".repeat(64),idempotencyKey:ids.run,acceptUnknownCost:false,maxEstimatedCostMicros:0};
 const run=await submitRun(deps,input);expect((await submitRun(deps,input)).id).toBe(run.id);
 for(let i=0;i<8;i++)await tickWorker(deps,"test-worker");const result=await getRun(deps,run.id);expect(result.run.status).toBe("succeeded");expect(result.candidates).toHaveLength(1);expect(deps.repo.list("runs",ids.project)).toHaveLength(1);
 }finally{w.dispose();}});

it("T06 ambiguous submit stays unknown; repeated ticks never resubmit",async()=>{const w=world();try{
 const { MockAdapter }=await import("../../src/infrastructure/models/mock");const adapter=new MockAdapter();let submitted=0;adapter.submit=async()=>{submitted++;throw new Error("network response lost");};const deps={...w.deps,blobs:createLocalBlobStore(w.root),adapters:new Map([[adapter.id,adapter]])};w.seedPreview();const run=await submitRun(deps,{previewId:ids.preview,previewHash:"a".repeat(64),idempotencyKey:ids.run,acceptUnknownCost:false,maxEstimatedCostMicros:0});
 for(let i=0;i<5;i++)await tickWorker(deps,"test-worker");expect((await getRun(deps,run.id)).run.status).toBe("submission_unknown");expect(submitted).toBe(1);
 }finally{w.dispose();}});
