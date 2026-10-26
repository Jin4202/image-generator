import type { Dependencies } from "../../src/application/ports";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { compiled, ids, now, snapshot } from "./fixtures";
/** Seed stored immutable aggregates; does not call provider or depend on run orchestration. */
export async function seedCandidate(deps: Dependencies) {
 const blob=await deps.blobs.write(new Uint8Array(Buffer.from(MOCK_PNG_BASE64,"base64")),"png");
 deps.repo.insert("media",{id:ids.media,projectId:ids.project,revision:0,createdAt:now,...blob,mime:"image/png",width:1,height:1,source:"generated",licenseNotes:"test"});
 deps.repo.insert("previews",{id:ids.preview,projectId:ids.project,revision:0,createdAt:now,snapshot,compiled,hash:"a".repeat(64),expiresAt:"2026-10-26T00:15:00.000Z"});
 deps.repo.insert("runs",{id:ids.run,projectId:ids.project,revision:0,createdAt:now,previewId:ids.preview,idempotencyKey:ids.run,status:"succeeded",snapshot,compiled,providerRequestId:"seed",actualCost:{kind:"unknown",reason:"test"},errorCode:null,updatedAt:now});
 deps.repo.insert("candidates",{id:ids.candidate,projectId:ids.project,revision:0,createdAt:now,runId:ids.run,index:0,mediaId:ids.media,parentCandidateId:null,seed:1});
}
