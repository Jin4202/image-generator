// T18: user-facing wording says "에셋", never "자산"; identifiers, routes and stored input are unchanged. Real stack.
import { expect, test, type Page } from "@playwright/test";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";

/** Visible text plus accessible names (aria-label, placeholder, alt, title, option text). */
const userText = (page: Page) => page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("[aria-label],[placeholder],[alt],[title]")].flatMap(e => ["aria-label", "placeholder", "alt", "title"].map(a => e.getAttribute(a) ?? "")), ...[...document.querySelectorAll("option")].map(o => o.textContent ?? "")].join("\n"));

test("menus, pages and help text use 에셋; asset approval and scene selection still work; API/data unchanged", async ({ page, request }) => {
  await page.goto("/");
  expect(await userText(page)).not.toContain("자산");
  await expect(page.getByText("02 에셋·스타일")).toBeVisible();

  const savedName = "자산 이름 그대로"; // user input is stored and shown as typed, not rewritten
  const project = (await (await request.post("/api/projects", { data: { title: "T18 wording", budgetMicros: null } })).json()).data;
  await page.goto(`/projects?projectId=${project.id}`);
  await expect(page.getByRole("link", { name: "에셋 준비" })).toBeVisible();
  expect(await userText(page)).not.toContain("자산");

  await page.getByRole("navigation", { name: "작업 단계" }).getByRole("link", { name: "에셋", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/assets\\?projectId=${project.id}`));
  await expect(page.getByRole("heading", { name: "에셋", exact: true })).toBeVisible();
  await expect(page.getByText("아직 에셋이 없습니다.")).toBeVisible();
  expect(await userText(page)).not.toContain("자산");

  await page.getByLabel("업로드할 이미지").setInputFiles({ name: "hero.png", mimeType: "image/png", buffer: Buffer.from(MOCK_PNG_BASE64, "base64") });
  await page.getByRole("button", { name: "업로드", exact: true }).click();
  await page.getByLabel("에셋 이름").fill(savedName);
  await page.getByRole("button", { name: "슬롯 추가" }).click();
  await page.getByLabel("슬롯 1 이미지").selectOption({ index: 1 });
  await page.getByRole("button", { name: "에셋 저장 (초안)" }).click();
  await page.getByRole("button", { name: "이 버전 승인" }).click();
  await expect(page.getByText("승인됨 (변경 불가)")).toBeVisible();

  const assets = (await (await request.get(`/api/projects/${project.id}/workspace`)).json()).data.assets;
  expect(assets).toHaveLength(1); expect(assets[0].name).toBe(savedName); expect(assets[0].approvedAt).not.toBeNull();

  await page.goto(`/scenes?projectId=${project.id}`);
  const group = page.getByRole("group", { name: "에셋 (승인 버전만)" });
  await group.getByLabel(`${savedName} v1`).check();
  await page.getByLabel("장면 설명").fill("Wording scene");
  await page.getByRole("button", { name: "장면 만들기" }).click();
  await expect(page).toHaveURL(/sceneId=/);
  const sceneId = new URL(page.url()).searchParams.get("sceneId");
  expect((await (await request.get(`/api/scenes/${sceneId}`)).json()).data.content.assetVersionIds).toEqual([assets[0].id]);
  expect((await userText(page)).replaceAll(savedName, "")).not.toContain("자산");

  await page.goto(`/generate?projectId=${project.id}&sceneId=${sceneId}`);
  await expect(page.getByRole("heading", { name: "생성", exact: true })).toBeVisible();
  expect((await userText(page)).replaceAll(savedName, "")).not.toContain("자산");
});
