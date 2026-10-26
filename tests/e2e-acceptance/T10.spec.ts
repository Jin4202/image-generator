// PENDING T10: no selected scene must never permit generation.
import { expect, test } from "@playwright/test";
test("generation screen requires scene selection",async({page})=>{
 await page.goto("/generate");await expect(page.getByRole("heading",{name:"생성",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"생성 실행",exact:true})).toBeDisabled();
});
