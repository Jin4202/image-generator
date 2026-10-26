import { expect, it } from "vitest";
import { MockAdapter } from "../../src/infrastructure/models/mock";
import { compiled } from "../support/fixtures";
it("mock supports deterministic success and explicit failure", async () => { for (const outcome of ["success","failure"] as const) { const a=new MockAdapter(outcome);const {requestId}=await a.submit(compiled,[],{signal:new AbortController().signal,mayPost:()=>true});await a.poll(requestId);await a.poll(requestId);expect((await a.poll(requestId)).status).toBe(outcome==="success"?"completed":"failed"); } });
it("rejects unknown request and mismatched refs", async () => { const a=new MockAdapter();await expect(a.poll("missing")).rejects.toThrow();await expect(a.submit(compiled,[new Uint8Array()],{signal:new AbortController().signal,mayPost:()=>true})).rejects.toThrow(); });

it("mock result is valid PNG and can be downloaded after adapter restart",async()=>{const {default:sharp}=await import("sharp");const a=new MockAdapter();const {requestId}=await a.submit(compiled,[],{signal:new AbortController().signal,mayPost:()=>true});const outputs=await new MockAdapter().download(requestId);const decoded=await sharp(outputs[0].bytes).raw().toBuffer({resolveWithObject:true});expect(decoded.info.width).toBe(1);expect(decoded.info.height).toBe(1);});
