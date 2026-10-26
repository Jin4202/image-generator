// T14: a saved sketch reopens as the editing base on the real production stack (no API mocks except injected load
// failures/delays). Pixels are checked both on the live canvas and in the uploaded PNG, never via link text alone.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";

const size = 1024;
type Spot = [number, number];
/** White 1024² PNG with black 10% squares centred on each normalized spot. */
async function squares(...spots: Spot[]) {
  const side = Math.round(size / 10);
  const black = await sharp({ create: { width: side, height: side, channels: 3, background: "#000000" } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
    .composite(spots.map(([x, y]) => ({ input: black, left: Math.round(x * size - side / 2), top: Math.round(y * size - side / 2) }))).png().toBuffer();
}
async function api<T = unknown>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: T }).data;
}
async function setup(request: APIRequestContext, sketches: Buffer[]) {
  const project = await api<{ id: string }>(await request.post("/api/projects", { data: { title: "T14 sketch", budgetMicros: null } }));
  const media: string[] = [];
  for (const [i, png] of sketches.entries()) media.push((await api<{ id: string }>(await request.post("/api/media/upload", { multipart: { projectId: project.id, licenseNotes: "T14 seed", file: { name: `seed-${i}.png`, mimeType: "image/png", buffer: png } } }))).id);
  const content = (prompt: string, refs: string[]) => ({ prompt, camera: "", size: { width: size, height: size }, references: refs.map(mediaId => ({ mediaId, role: "sketch", note: "" })), styleVersionId: null, assetVersionIds: [], boxes: [] });
  const scene = await api<{ id: string; revision: number }>(await request.post("/api/scenes", { data: { projectId: project.id, content: content("Sketch scene", media) } }));
  return { projectId: project.id, media, scene, content };
}
const getScene = (request: APIRequestContext, id: string) => request.get(`/api/scenes/${id}`).then(r => api<{ revision: number; content: { prompt: string; references: { mediaId: string; role: string }[] } }>(r));
/** Luma of the uploaded PNG at a normalized spot (white 255, black 0). */
async function pngLuma(request: APIRequestContext, mediaId: string, [x, y]: Spot) {
  const bytes = Buffer.from(await (await request.get(`/api/media/${mediaId}`)).body());
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y * (info.height - 1)) * info.width + Math.round(x * (info.width - 1))) * info.channels;
  return (data[i] + data[i + 1] + data[i + 2]) / 3;
}
const sketchCanvas = (page: Page) => page.getByRole("region", { name: "장면 캔버스" }).locator("canvas").first();
/** Sketch-layer pixel on screen: "dark" (drawn), "white" (opaque light) or "empty" (transparent). */
async function canvasPixel(page: Page, [x, y]: Spot) {
  return sketchCanvas(page).evaluate((canvas: HTMLCanvasElement, [nx, ny]) => {
    const p = canvas.getContext("2d")!.getImageData(Math.round(nx * (canvas.width - 1)), Math.round(ny * (canvas.height - 1)), 1, 1).data;
    return p[3] < 128 ? "empty" : (p[0] + p[1] + p[2]) / 3 < 100 ? "dark" : "white";
  }, [x, y] as Spot);
}
async function stroke(page: Page, from: Spot, to: Spot) {
  await sketchCanvas(page).scrollIntoViewIfNeeded(); // page.mouse does not scroll
  const box = (await sketchCanvas(page).boundingBox())!;
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + (from[0] + (to[0] - from[0]) * i / 12) * box.width, box.y + (from[1] + (to[1] - from[1]) * i / 12) * box.height);
  await page.mouse.up();
}
async function uploadAndSave(page: Page, revision: number) {
  await page.getByRole("button", { name: "스케치 PNG 업로드" }).click();
  await expect(page.getByRole("region", { name: "장면 캔버스" }).getByRole("status").last()).toContainText("업로드");
  await page.getByRole("button", { name: "장면 저장" }).click();
  await expect(page.getByRole("heading", { name: `장면 편집 (rev ${revision})` })).toBeVisible();
}
const open = (page: Page, projectId: string, sceneId: string) => page.goto(`/scenes?projectId=${projectId}&sceneId=${sceneId}`);
const A: Spot = [0.25, 0.25]; const B: Spot = [0.75, 0.75]; const mid: Spot = [0.5, 0.5];

test("saved sketch reopens after reload; new strokes and erasing keep/remove the right pixels; the original blob is untouched", async ({ page, request }) => {
  const { projectId, media: [seed], scene } = await setup(request, [await squares(A)]);
  const seedBytes = Buffer.from(await (await request.get(`/api/media/${seed}`)).body());
  await open(page, projectId, scene.id);
  await expect.poll(() => canvasPixel(page, A)).toBe("dark");
  expect(await canvasPixel(page, mid)).toBe("white");
  await page.reload();
  await expect.poll(() => canvasPixel(page, A)).toBe("dark");

  await stroke(page, [0.6, 0.75], [0.9, 0.75]);
  await uploadAndSave(page, 1);
  const first = (await getScene(request, scene.id)).content.references;
  expect(first).toHaveLength(1); expect(first[0].mediaId).not.toBe(seed);
  expect(await pngLuma(request, first[0].mediaId, A)).toBeLessThan(60);
  expect(await pngLuma(request, first[0].mediaId, B)).toBeLessThan(120);
  expect(await pngLuma(request, first[0].mediaId, mid)).toBeGreaterThan(200);

  // The editor remounts on the new revision and loads the just-saved sketch as its base.
  await expect.poll(() => canvasPixel(page, B)).toBe("dark");
  await page.getByRole("button", { name: "지우개" }).click();
  for (const y of [0.22, 0.25, 0.28]) await stroke(page, [0.15, y], [0.35, y]);
  await uploadAndSave(page, 2);
  const second = (await getScene(request, scene.id)).content.references[0].mediaId;
  expect(await pngLuma(request, second, A)).toBeGreaterThan(200); // erased saved pixels become white
  expect(await pngLuma(request, second, B)).toBeLessThan(120);
  expect(Buffer.from(await (await request.get(`/api/media/${seed}`)).body()).equals(seedBytes)).toBe(true);
});

test("a failed load never lets a blank drawing overwrite the saved sketch; retry recovers", async ({ page, request }) => {
  const { projectId, media: [seed], scene } = await setup(request, [await squares(A)]);
  let fail = true;
  await page.route(`**/api/media/${seed}`, route => fail ? route.fulfill({ status: 500, body: "x" }) : route.continue());
  await open(page, projectId, scene.id);
  await expect(page.getByRole("region", { name: "장면 캔버스" }).getByRole("alert")).toContainText("불러오지 못해");
  await stroke(page, [0.6, 0.75], [0.9, 0.75]);
  await expect(page.getByRole("button", { name: "스케치 PNG 업로드" })).toBeDisabled();
  expect(await canvasPixel(page, B)).toBe("empty"); // drawing is disabled until the base is loaded
  expect((await getScene(request, scene.id))).toMatchObject({ revision: 0, content: { references: [{ mediaId: seed, role: "sketch" }] } });
  fail = false;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect.poll(() => canvasPixel(page, A)).toBe("dark");
});

test("a CAS conflict on save keeps the server scene and its sketch reference", async ({ page, request }) => {
  const { projectId, media: [seed], scene, content } = await setup(request, [await squares(A)]);
  await open(page, projectId, scene.id);
  await expect.poll(() => canvasPixel(page, A)).toBe("dark");
  await api(await request.patch(`/api/scenes/${scene.id}`, { data: { expectedRevision: 0, content: content("Changed elsewhere", [seed]) } }));
  await stroke(page, [0.6, 0.75], [0.9, 0.75]);
  await page.getByRole("button", { name: "스케치 PNG 업로드" }).click();
  await expect(page.getByText("선택한 sketch 참조만 갱신")).toBeVisible();
  await page.getByRole("button", { name: "장면 저장" }).click();
  await expect(page.getByText("다른 저장과 충돌했습니다")).toBeVisible();
  expect(await getScene(request, scene.id)).toMatchObject({ revision: 1, content: { prompt: "Changed elsewhere", references: [{ mediaId: seed, role: "sketch" }] } });
});

test("switching edit target or scene leaks no pixels, ignores a late load, and only the selected reference is replaced", async ({ page, request }) => {
  const { projectId, media: [left, right], scene } = await setup(request, [await squares(A), await squares(B)]);
  const other = await api<{ id: string }>(await request.post("/api/scenes", { data: { projectId, content: { prompt: "Empty scene", camera: "", size: { width: size, height: size }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] } } }));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/media/${left}`, async route => { await held; await route.continue(); });
  await open(page, projectId, scene.id);
  await expect(page.getByText("기존 스케치 불러오는 중")).toBeVisible(); // first sketch (left) is held
  await page.getByLabel("편집할 스케치").selectOption({ label: "참조 2 스케치" });
  await expect.poll(() => canvasPixel(page, B)).toBe("dark");
  release(); await page.waitForTimeout(500);
  expect(await canvasPixel(page, A)).toBe("white"); // the late left image was ignored

  await stroke(page, [0.4, 0.5], [0.6, 0.5]);
  await page.getByLabel("편집할 스케치").selectOption({ label: "참조 1 스케치" });
  await expect.poll(() => canvasPixel(page, A)).toBe("dark");
  expect(await canvasPixel(page, mid)).toBe("white"); // strokes stay with their target
  await page.getByLabel("편집할 스케치").selectOption({ label: "참조 2 스케치" });
  await expect.poll(() => canvasPixel(page, B)).toBe("dark");
  await stroke(page, [0.4, 0.5], [0.6, 0.5]);
  await uploadAndSave(page, 1);
  const refs = (await getScene(request, scene.id)).content.references;
  expect(refs[0].mediaId).toBe(left); expect(refs[1].mediaId).not.toBe(right);
  expect(await pngLuma(request, refs[1].mediaId, mid)).toBeLessThan(120);
  expect(await pngLuma(request, refs[1].mediaId, A)).toBeGreaterThan(200);

  // "새 스케치" is a separate, blank reference that leaves the existing ones alone.
  await page.getByLabel("편집할 스케치").selectOption({ label: "새 스케치 (참조 추가)" });
  expect(await canvasPixel(page, B)).toBe("empty");
  await stroke(page, [0.1, 0.9], [0.3, 0.9]);
  await uploadAndSave(page, 2);
  const added = (await getScene(request, scene.id)).content.references;
  expect(added.slice(0, 2)).toEqual(refs); expect(added).toHaveLength(3); expect(added[2].role).toBe("sketch");

  await page.getByRole("button", { name: /Empty scene/ }).click();
  await expect(page).toHaveURL(new RegExp(`sceneId=${other.id}`));
  await expect.poll(() => canvasPixel(page, B)).toBe("empty");
  expect(await canvasPixel(page, A)).toBe("empty");
  await expect(page.getByText("편집 중인 sketch 참조")).toHaveCount(0);
});
