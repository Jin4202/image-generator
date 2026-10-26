# Architectural blockers

현재 설계에 해결되지 않은 필수 선택지는 없음. 실제 provider schema/청구 정보는 T07에서 외부 사실을 재검증한다. 가격 미확인은 unknown 정책으로 명시적으로 처리한다.

추가 blocker 양식:
- Task ID:
- 충돌/누락 계약 및 파일:
- 재현/근거:
- 가능한 선택지와 영향:
- 추천:
- 사용자/설계 담당자 결정:
- 독립적으로 계속 가능한 작업:

배포, portable project archive/import, 모델 추가, 가격 계산기, 추가 effect blend mode는 현재 out-of-scope이며 자동으로 끼워 넣지 않는다.

## T02 — application media service에서 sharp decode 불가 (2026-10-26)

- Task ID: T02 (동일 문제가 T06 다운로드 검증, T09 compositing에도 예상됨)
- 충돌/누락 계약 및 파일: `docs/contracts.md#media`와 `docs/tasks/T02.md` 2단계는 `uploadMedia`(src/application/services/media.ts)가 sharp로 실제 decode하도록 요구한다. 그러나 AGENTS.md는 application에서 파일/외부 라이브러리 import를 금지하고 `scripts/check-boundaries.mjs`는 application의 bare import를 `zod`만 허용한다. `src/application/ports.ts`의 `Dependencies`에는 이미지 decode 포트가 없다.
- 재현/근거: application 아래에 `import sharp from "sharp"` 파일을 두고 `node scripts/check-boundaries.mjs` 실행 → `forbidden dependency sharp`.
- 가능한 선택지와 영향:
  - A. `ports.ts`에 이미지 decode 포트 추가(`Dependencies.images`), infrastructure에 sharp 구현, T12 wiring과 `tests/support/dependencies.ts`에 기본값 추가. 공개 port 변경이지만 계층 규칙 유지, T06/T09도 재사용 가능.
  - B. check-boundaries에서 application의 `sharp` import 허용. 변경 적지만 AGENTS 계층 원칙 위반, 테스트에서 decode 대체 불가.
  - C. uploadMedia가 header만 파싱. "metadata만 읽고 통과시키지 않는다" 계약 위반이라 부적합.
- 추천: A.
- 사용자/설계 담당자 결정 (2026-10-26): A 변형으로 해결. `ImageInspector` 포트(`inspect(bytes)→{mime,width,height,pages}`)를 `Dependencies.imageInspector`로 주입, sharp 구현은 infrastructure(`src/infrastructure/images/sharp.ts`)에서 전체 decode까지 수행. media service가 MIME/픽셀/다중 프레임 판정, decode 실패는 INVALID_MEDIA, 원본 bytes 불변. boundary 완화와 BlobStore decode 혼합은 채택하지 않음. 상태: resolved.
- 독립적으로 계속 가능한 작업: `src/infrastructure/storage/local.ts` blob store, multipart/raw media route, decode를 제외한 uploadMedia/readMedia 검증 흐름.

## T02 → T12 소유 — e2e demo 테스트가 next dev 병렬 실행 시 full reload로 실패 (2026-10-26)

- Task ID: T02에서 발견, 수정 대상 파일은 T12 소유(`playwright.config.ts`, `tests/e2e/demo.spec.ts`, `scripts/e2e-stack.ts`).
- 충돌/누락: `npm run test:e2e`가 `next dev`(webpack)를 2 worker로 병렬 실행한다. demo 테스트는 버튼 클릭 직후 첫 `POST /api/demo` on-demand compile이 일어나고, 이때 client webpack hot-update 후 Next가 페이지를 full reload해서 status 결과가 사라진다.
- 재현/근거: trace 순서는 `POST /api/demo` → `webpack.hot-update.json/js` → `GET /` 재요청, console에는 `[Fast Refresh] rebuilding`과 `[HMR] connected`가 2회 남는다. T02 구현 상태에서 기본 실행 0/8 통과, `--workers=1` 실행 3/3 통과. media route 2개를 stub으로 되돌리면 4/4 통과, 하나만 되돌리면 1/2 통과로, route 코드 양에 따라 확률이 달라지는 timing race다. 애플리케이션 동작 오류가 아니며 demo API 자체는 200을 반환한다(`tests/integration/demo.test.ts` 통과).
- 가능한 선택지와 영향:
  - A. `playwright.config.ts`에 `workers: 1` 지정. 변경이 가장 작고 assertion은 그대로다. e2e 시간이 약간 늘어난다.
  - B. T12 계획대로 e2e를 production build/start(`scripts/e2e-stack.ts`)로 전환. 근본 해결이지만 T12 범위다.
  - C. demo 테스트에서 클릭 전 API warm-up. T12 소유 테스트 수정이 필요하다.
- 추천: 지금 A를 적용하고 T12에서 B로 전환.
- 사용자/설계 담당자 결정 (2026-10-26): A를 임시 적용. `playwright.config.ts`에 `workers: 1`(주석으로 근거 표시)을 넣은 뒤 `npm run test:e2e` 3회 연속 2 passed. demo/setup assertion은 변경하지 않았다. 근본 해결(B: production build/start 기반 `scripts/e2e-stack.ts`)은 T12에 남긴다. T12가 B를 적용할 때 `workers: 1` 유지 여부를 재검토한다.
- 상태: mitigated (임시), T12에서 close.
- T12 close (2026-10-26): B 적용. Playwright webServer가 `scripts/e2e-stack.ts`(production build + `next start` + worker, 임시 DB)를 사용하므로 dev on-demand compile race 원인이 사라졌다. `workers: 1`은 유지: 모든 spec이 하나의 stack과 전역 active run cap 1을 공유하므로, 병렬 실행하면 제출 순서가 비결정적이 된다(이유를 config 주석에 기록). 상태: resolved.

## T07 — @fal-ai/client queue.submit 자동 재시도 (2026-10-26)

- Task ID: T07
- 충돌: contracts#fal과 runs의 "SDK 자동 retry 금지 / submit retry 0"과 architecture의 "@fal-ai/client queue API". 설치된 1.10.1 `src/queue.js`는 submit에 `QUEUE_RETRY_CONFIG`(maxRetries 3)를 요청별로 넘기고, `src/request.js`는 이 설정을 client `retry` 설정 위에 덮어쓴다. 그래서 client 설정만으로는 재시도 0을 보장할 수 없다.
- 재현/근거: node_modules/@fal-ai/client/src/queue.js의 submit `options.retry: QUEUE_RETRY_CONFIG`, request.js의 `Object.assign({}, config.retry, options.retry)`.
- 사용자/설계 담당자 결정 (2026-10-26): submit만 SDK를 우회해 공식 Queue REST를 서버 fetch로 직접 호출(POST 1회, redirect "error", 30초 timeout. 429·5xx·timeout·연결 단절·파싱 실패는 unknown, 명백한 거부만 rejected, request_id 검증, 오류 본문/인증 header 로그 금지). upload는 SDK storage, status/result는 SDK 조회 API, fetchImage는 기존 다운로드 보안 계약. FalTransport 공개 인터페이스는 유지. contracts/architecture/ADR 004/fal-contract 주석을 함께 수정했다. 상태: resolved.

## T09 — effects/export compositing에 필요한 이미지 렌더 포트 누락 (2026-10-26)

- Task ID: T09 (T02 blocker에서 예상했던 동일 유형)
- 충돌: `docs/contracts.md#effects`와 `docs/tasks/T09.md` 2단계는 application의 `exportCandidate`가 sharp로 brightness→contrast→saturation→blur→overlay 합성을 하도록 요구한다. 그러나 application의 sharp import는 금지(AGENTS, check-boundaries)이고, `Dependencies`에는 decode 전용 `ImageInspector`만 있으며 렌더/합성 포트가 없다.
- 선택지:
  - A. `ImageCompositor` 포트 추가: `composite({ base, overlays: [{ bytes, layer }], adjustments }) → { bytes(PNG), width, height }`. `Dependencies.imageCompositor`로 주입하고 sharp 구현은 `src/infrastructure/images/compositor.ts`(T09 소유로 추가)에 둔다. T12 wiring과 `tests/support/dependencies.ts` 기본값 추가. 합성 순서와 좌표 규칙은 포트 계약에 고정한다.
  - B. ImageInspector를 확장해 render까지 맡김: 책임이 섞인다.
  - C. boundary 완화: 이전 결정과 충돌.
- 추천: A.
- 사용자/설계 담당자 결정 (2026-10-26): A 채택. `ImageCompositor` 포트와 `Dependencies.imageCompositor`를 추가하고 sharp 구현은 `src/infrastructure/images/compositor.ts`(T09 소유)에 둔다. contracts#effects, architecture, T09/T12 문서, index.json, test 기본 의존성을 갱신. 상태: resolved.
- 독립 진행 가능: effects 저장/CAS/scope, manifest 생성·검증, manifest 다운로드 route, EffectsCanvas.
