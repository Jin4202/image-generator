// PENDING T09: functional acceptance; must fail before implementation.
import { expect, it } from "vitest";
import sharp from "sharp";
import { Manifest } from "../../src/contracts";
import { exportCandidate, saveEffects } from "../../src/application/services/effects";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { ids } from "../support/fixtures";
import { seedCandidate } from "../support/seed-candidate";
import { world } from "../support/world";
it("T09 identity export preserves pixels and source while emitting validated manifest",async()=>{
 const w=world();try{const deps={...w.deps,blobs:createLocalBlobStore(w.root)};
 await expect(exportCandidate(deps,{candidateId:ids.candidate})).rejects.toMatchObject({code:"NOT_FOUND"});await seedCandidate(deps);const base=deps.repo.get("media",ids.media)!;
 await saveEffects(deps,ids.candidate,{expectedRevision:0,layers:[],brightness:1,contrast:1,saturation:1,blur:0});const result=await exportCandidate(deps,{candidateId:ids.candidate});const png=deps.repo.get("media",result.pngMediaId)!;
 const original=await sharp(await deps.blobs.read(base.relativePath)).ensureAlpha().raw().toBuffer();const exported=await sharp(await deps.blobs.read(png.relativePath)).ensureAlpha().raw().toBuffer();expect(exported).toEqual(original);expect(deps.repo.get("media",ids.media)).toEqual(base);
 const text=Buffer.from(await deps.blobs.read(result.manifestPath)).toString("utf8");const manifest=Manifest.parse(JSON.parse(text));expect(manifest.candidateId).toBe(ids.candidate);expect(text).not.toContain("FAL_KEY");expect(text).not.toContain(w.root);
 }finally{w.dispose();}
});
