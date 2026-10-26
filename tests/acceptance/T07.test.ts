// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { buildFalInput, createFalAdapter } from "../../src/infrastructure/models/fal";
import { compiled } from "../support/fixtures";
it("T07 maps exactly documented native inputs without leaking keys",()=>{
 const reference={...compiled,adapterId:"fal-flux2-edit" as const,endpoint:"fal-ai/flux-2/edit",references:[{mediaId:"00000000-0000-4000-8000-000000000003",role:"character" as const,note:""}]};
 const native=buildFalInput(reference,["https://example.com/reference.png"]);expect(native.image_urls).toEqual(["https://example.com/reference.png"]);expect(native.enable_safety_checker).toBe(true);expect(native).not.toHaveProperty("apiKey");
 const text=buildFalInput({...compiled,adapterId:"fal-flux2-text",endpoint:"fal-ai/flux-2"},[]);expect(text).not.toHaveProperty("image_urls");
});
it("T07 uses injected transport; no live network needed",async()=>{
 const calls:unknown[]=[];const transport={submit:async(endpoint:string,input:unknown)=>{calls.push({endpoint,input});return {request_id:"provider-1"};},status:async()=>"IN_QUEUE" as const,result:async()=>({}),upload:async()=>"https://example.com/file.png",fetchImage:async()=>new Uint8Array()};
 const adapter=createFalAdapter("fal-flux2-text","test-secret",transport);await adapter.submit({...compiled,adapterId:"fal-flux2-text",endpoint:"fal-ai/flux-2"},[],{signal:new AbortController().signal,mayPost:()=>true});expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).not.toContain("test-secret");
});
