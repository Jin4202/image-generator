import { expect, test } from "@playwright/test";
// T12 replaced the initial M0/not-implemented assertions with real readiness checks.
test("초기 화면이 실제 준비 상태와 제품 진입을 정직하게 안내한다", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle("AI Art Direction Studio");
  await expect(page.getByRole("heading", { name: "AI Art Direction Studio" })).toBeVisible();
  const readiness = page.getByRole("region", { name: "작업 준비 상태" });
  await expect(readiness.getByRole("status")).toContainText("준비됨 · 로컬 저장소 연결됨 · provider mock");
  await expect(readiness.getByRole("status")).toContainText("실제 유료 생성 꺼짐");
  await page.reload();
  await expect(readiness.getByRole("link", { name: "프로젝트 시작" })).toHaveAttribute("href", "/projects");
  await expect(page.getByRole("region", { name: "계약 데모" })).toContainText("유료 호출과 영구 저장은 없습니다");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
