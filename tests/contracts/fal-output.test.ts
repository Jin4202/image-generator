import { expect, it } from "vitest";
import { FalOutput } from "../../src/infrastructure/models/fal-contract";
it("provider output allowlists metadata and requires safety coverage",()=>{
 const value={images:[{url:"https://example.com/result.png",content_type:"image/png",file_name:"ignore"}],seed:1,has_nsfw_concepts:[false],unexpected_secret:"omit"};
 expect(FalOutput.parse(value)).not.toHaveProperty("unexpected_secret");expect(FalOutput.safeParse({...value,has_nsfw_concepts:[]}).success).toBe(false);expect(FalOutput.safeParse({...value,images:[]}).success).toBe(false);
});
