# Model support matrix

Schema re-checked 2026-10-26 from the public API pages below (T07, docs only, no API calls). This is a capability boundary, not a live integration completion claim: no live fal request has been made.

| Adapter | Endpoint | References | Mask | Size | State |
|---|---|---|---|---|---|
| mock-reference | mock://fixture | 0–4, mapped bytes | no | output is explicit 1×1 fixture | implemented (mock, product scope) |
| fal-flux2-edit | fal-ai/flux-2/edit | 1–4; application rejects overflow | no native mask field in selected schema | width/height 512–2048 | adapter implemented, live unverified |
| fal-flux2-text | fal-ai/flux-2 | none | no | width/height 512–2048 | adapter implemented, live unverified |

Published fields used: prompt, image_size, num_images, seed, guidance_scale, num_inference_steps, acceleration, enable_prompt_expansion, enable_safety_checker, output_format, sync_mode; edit additionally image_urls. App limit num_images=1..4 is a product cap; do not infer endpoint universal limits from it.

Official sources:
- https://fal.ai/models/fal-ai/flux-2/edit/api
- https://fal.ai/models/fal-ai/flux-2/api
- https://docs.fal.ai/client-libraries/javascript

T07 must refresh these schemas and test fixtures before implementing live access. If changed, record blocker rather than silently dropping inputs. Pricing remains unknown in live Compiled until a separate verified pricing contract is approved; no value from a chat estimate is hardcoded. These API pages support data URIs or uploaded URLs; this architecture fixes provider storage upload through server transport.

## 2026-10-26 re-check (T07)

Input fields used by `buildFalInput` all exist with the same names on both pages: `prompt`, `image_size` (custom `{width,height}` 512–2048), `num_images` (default 1, range not published), `seed` (optional; omitted when null), `guidance_scale` (default 2.5), `num_inference_steps` (default 28), `acceleration` (`none|regular|high`, default `regular`), `enable_prompt_expansion` (no default published; sent explicitly `false`), `enable_safety_checker` (default `true`), `output_format` (`jpeg|png|webp`, default `png`), `sync_mode` (sent `false`); edit adds required `image_urls`. Text page has no `image_urls`.

Differences noted (no contract change needed):
- `image_urls`: page says "maximum 4; extra ones are ignored". The app blocks >4 before submit instead of letting the provider silently drop inputs; no published minimum, the app requires ≥1 for edit.
- Output: `images[]` (`url`, optional `content_type`, `file_name`, `file_size`, `width`, `height`), `seed`, `has_nsfw_concepts`, plus `timings` and `prompt`, which the allowlist parse ignores.
- Queue status values are `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`; failures come back as `COMPLETED` with `error`/`error_type`. The default transport maps that to `FAILED`.
- Status/result URLs use owner/app only (e.g. `fal-ai/flux-2/requests/{id}`); the SDK `queue.status/result` builds them that way.
- No price is published on the model pages; estimates stay `unknown` (`pricing-not-configured`).

Queue reference: https://fal.ai/docs/model-apis/model-endpoints/queue
