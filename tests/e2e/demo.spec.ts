import { expect, test } from "@playwright/test";
// Mock demo stays explicitly non-persistent; T12 replaced the temporary production-501 check with real persistence.
test("mock walking skeleton stays labeled while the production API persists", async ({page,request}) => {
 await page.goto("/");const demo=page.getByRole("region",{name:"계약 데모"});await demo.getByRole("button",{name:"Mock 계약 실행"}).click();
 await expect(demo.getByRole("status")).toContainText("queued → running → completed");
 await expect(demo.getByRole("status")).toContainText("저장 안 됨");
 const r=await request.post("/api/projects",{data:{title:"Wind Duel E2E"}});expect(r.status()).toBe(200);const created=(await r.json()).data;
 const list=await request.get("/api/projects");expect((await list.json()).data.map((p:{id:string})=>p.id)).toContain(created.id);
});
