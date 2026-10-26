import { describe, expect, it } from "vitest";
import { Box, CreateProject, Money, PreviewInput, ReviewInput, SceneContent, SubmitInput } from "../../src/contracts";
import { ids, sceneInput } from "../support/fixtures";
describe("public schemas", () => {
  it("trims titles and rejects empty or unknown fields", () => { expect(CreateProject.parse({ title: " Wind " }).title).toBe("Wind"); expect(CreateProject.safeParse({title: " "}).success).toBe(false); expect(CreateProject.safeParse({title:"x", FAL_KEY:"secret"}).success).toBe(false); });
  it("rejects boxes overflowing canvas, accepts edges", () => { expect(Box.safeParse({x:0,y:0,w:1,h:1}).success).toBe(true); expect(Box.safeParse({x:.9,y:0,w:.2,h:1}).success).toBe(false); });
  it.each([0,5,-1,1.5])("rejects output count %s", outputCount => { expect(PreviewInput.safeParse({sceneId:ids.scene,adapterId:"mock-reference",outputCount}).success).toBe(false); });
  it("requires edit and parent together", () => { expect(PreviewInput.safeParse({sceneId:ids.scene, adapterId:"mock-reference", parentCandidateId:ids.candidate}).success).toBe(false); });
  it("has strict money states; unknown is not zero", () => { expect(Money.safeParse({kind:"unknown",reason:"not priced"}).success).toBe(true); expect(Money.safeParse({kind:"unknown",reason:"not priced",micros:0}).success).toBe(false); });
  it("requires explicit submit cost consent", () => { expect(SubmitInput.safeParse({previewId:ids.preview, previewHash:"a".repeat(64),idempotencyKey:ids.run}).success).toBe(false); });
  it("rejects rating outside bounds and wrong dimensions", () => { expect(ReviewInput.safeParse({identity:6}).success).toBe(false); expect(SceneContent.safeParse({...sceneInput.content,size:{width:511,height:720}}).success).toBe(false); });
});
