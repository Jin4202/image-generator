// PENDING IMPLEMENTATION: excluded from default verify. This suite MUST fail until its task is implemented.
import { expect, it } from "vitest";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { uploadMedia } from "../../src/application/services/media";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { ids } from "../support/fixtures";
import { world } from "../support/world";
it("T02 decodes and stores images; rejects spoofed MIME and path traversal", async()=>{
 const w=world();try{const blobs=createLocalBlobStore(w.root);const deps={...w.deps,blobs};const bytes=new Uint8Array(Buffer.from(MOCK_PNG_BASE64,"base64"));
 const media=await uploadMedia(deps,{projectId:ids.project,bytes,declaredMime:"image/png",licenseNotes:"test"});expect(media.width).toBe(1);expect(await blobs.read(media.relativePath)).toEqual(bytes);
 await expect(uploadMedia(deps,{projectId:ids.project,bytes,declaredMime:"image/jpeg",licenseNotes:""})).rejects.toMatchObject({code:"INVALID_MEDIA"});await expect(blobs.read("../outside")).rejects.toThrow();
 }finally{w.dispose();}
});
