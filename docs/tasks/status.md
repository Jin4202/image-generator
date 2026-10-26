# Task completion ledger

Hollow architecture: verification 결과는 `docs/VERIFICATION.md`. 아래 task들은 모두 미구현.

| Task | 상태 | 증거 |
|---|---|---|
| T01 | done (2026-10-26) | 아래 T01 기록 |
| T02 | done (2026-10-26) | 아래 T02 기록 |
| T03 | done (2026-10-26) | 아래 T03 기록 |
| T04 | done (2026-10-26) | 아래 T04 기록 |
| T05 | done (2026-10-26) | 아래 T05 기록 |
| T06 | done (2026-10-26) | 아래 T06 기록 |
| T07 | done (2026-10-26) | 아래 T07 기록 |
| T08 | done (2026-10-26) | 아래 T08 기록 |
| T09 | done (2026-10-26) | 아래 T09 기록 |
| T10 | done (2026-10-26) | 아래 T10 기록 |
| T11 | done (2026-10-26) | 아래 T11 기록 |
| T12 | done (2026-10-26) | 아래 T12 기록 |

완료 시 task별 실제 명령/결과와 날짜를 덧붙인다. index.json의 status도 함께 갱신한다.

## T01 — SQLite repository와 CAS/lease (2026-10-26)

변경 파일
- `src/infrastructure/persistence/repository.ts`: `openRepository` 구현 (Drizzle + better-sqlite3).
- `tests/acceptance/T01.cases.test.ts`: 신규 정상/오류/경계 16 case. 기존 `T01.test.ts`는 변경 없음.
- `docs/tasks/index.json`: T01 status → done.

구현 요약
- open: 파일이 없으면 생성하지 않고 STORAGE, migration 미설치(필수 테이블 누락)/비 SQLite 파일 → STORAGE. FK ON, WAL, busy_timeout=5000 설정 후 확인. 오류 메시지에 절대 경로 미포함.
- get/list: missing→null/[]; body를 contract schema로 재검증한 detached object 반환, 저장 body↔컬럼 불일치는 STORAGE. list는 createdAt→id 오름차순(Date 비교로 정밀도 차이 무관), projects는 projectId=id 필터.
- insert: schema 검증(VALIDATION), revision 0, project projectId=id, project 존재 및 FK 컬럼(run.previewId, candidate.runId, effects.candidateId)이 같은 프로젝트에 존재(NOT_FOUND), PK/unique 중복 CONFLICT. indexed 컬럼은 body에서 파생해 함께 기록.
- replace: expectedRevision CAS(stale→CONFLICT, missing→NOT_FOUND), new revision≠expected+1→VALIDATION, id/projectId/createdAt 고정. media/previews/candidates/reviews/exports append-only. style/asset는 approvedAt null→값 1회만. run은 previewId/idempotencyKey/snapshot/compiled 고정. effects는 candidateId 고정. 조건부 UPDATE의 changes도 확인.
- transaction: BEGIN IMMEDIATE, throw 시 rollback 후 원래 오류 재throw, Promise 반환 시 rollback+VALIDATION, nested/종료된 tx 사용 VALIDATION, close 이후 STORAGE. 단건 mutation도 transaction 밖이면 자체 IMMEDIATE transaction.
- lease: id=1 upsert의 조건부 갱신(같은 owner 또는 expires_at≤now). 시각은 ISO ms로 정규화 저장/비교. until≤now/빈 owner/잘못된 시각 VALIDATION. release는 해당 owner만, 없으면 no-op.

해석이 필요했던 점 (계약 변경 없음, 검토 요청)
- replace의 new revision≠expected+1은 DB 상태와 무관한 잘못된 입력이므로 VALIDATION, 기존 revision 불일치만 CONFLICT로 구분했다.
- experiments는 architecture 저장 절에 명시가 없어 contracts의 "sceneRevisions를 생성 시 고정"에 따라 sceneIds/sceneRevisions를 불변으로, runIds만 변경 가능하게 두었다(T11 attach와 충돌 없음).
- FK 컬럼 대상이 다른 프로젝트에 있으면 contracts 공통 규칙대로 NOT_FOUND. JSON 내부 참조(mediaId 등)는 service 책임으로 남겼다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T01.test.ts`: 구현 전 NotImplementedError(T01)로 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T01`: 2 files / 17 tests passed.
- `npm run verify`: exit 0 — handoff 12 tasks, boundaries, lint, typecheck, unit 7 files/30 tests, production build 통과.
- `npm run test:e2e`: Chromium 2 passed.
- 참고 `npm run test:acceptance`(전체): 12 failed / 17 passed. 남은 실패는 T02/T03/T04/T05/T07 NotImplementedError와 T12의 501≠200으로, T01 원인 실패 없음(예상된 pending 상태).

남은 문제
- 동시 writer가 busy_timeout(5초)을 넘기면 STORAGE로 실패한다. 자동 재시도는 하지 않는다.
- WAL 미지원 파일시스템에서는 open이 STORAGE로 실패한다.

## T02 — 이미지 파일 저장과 업로드 경계 (2026-10-26)

변경 파일
- `src/infrastructure/storage/local.ts`: `createLocalBlobStore`
- `src/infrastructure/images/sharp.ts` (신규, 설계 결정으로 T02 소유에 추가): `createSharpImageInspector`
- `src/application/ports.ts`: `ImageInfo`, `ImageInspector`, `Dependencies.imageInspector` 추가 (사용자 승인한 계약 수정, docs/blockers.md)
- `src/application/services/media.ts`: `uploadMedia`, `readMedia`
- `src/app/api/media/upload/route.ts`, `src/app/api/media/[id]/route.ts`
- `tests/support/dependencies.ts`: 기본 `imageInspector`에 실제 sharp 구현 사용(순수 CPU)
- `tests/acceptance/T02.cases.test.ts`: 신규 19 case. 기존 `T02.test.ts`는 변경 없음.
- `playwright.config.ts` (T12 소유, 사용자 승인한 임시 변경): `workers: 1`
- 문서: `docs/contracts.md#media`(ImageInspector 계약), `docs/architecture.md`(ports 설명), `docs/tasks/T02.md`(소유 파일), `docs/tasks/T12.md`(wiring 대상), `docs/tasks/index.json`(T02 files), `docs/blockers.md`

구현 요약
- blob store: 경로는 `blobs/<sha256>.<ext>` 정규식만 허용(absolute, `..`, 하위 디렉터리, 대문자, 다른 확장자는 VALIDATION). realpath로 blobs 디렉터리가 root 안에 있는지 확인하고, symlink 파일은 거부(STORAGE)한다. temp 파일(`wx`)을 hard link로 연결해 원자적으로 쓰고 기존 파일은 덮어쓰지 않는다. 기존 파일의 hash가 다르면 STORAGE, read할 때도 hash를 재검증한다. 오류 메시지에 경로를 넣지 않는다.
- ImageInspector: signature sniff(PNG/JPEG/WebP/GIF 외 형식은 decoder에 전달하지 않음) → sharp metadata → 16MP 이내면 `failOn: "warning"`으로 첫 프레임 전체를 raw decode한다. APNG는 libvips가 단일 페이지로 보고하므로 `acTL` chunk로 프레임 수를 직접 읽는다. decode 실패는 INVALID_MEDIA, 입력 bytes는 복사해서 사용한다.
- uploadMedia: 입력 검증 → project 존재 확인(blob 생성 전, NOT_FOUND) → 0 byte INVALID_MEDIA / 10MiB 초과 TOO_LARGE → 선언 MIME이 PNG/JPEG/WebP가 아니면 UNSUPPORTED → inspect → 실제 형식과 선언 불일치 INVALID_MEDIA → 16MP 초과 TOO_LARGE → 다중 프레임 UNSUPPORTED → blob write → Media insert(source=upload). 원본 bytes는 그대로 저장한다.
- readMedia: missing ID는 NOT_FOUND, 파일 누락·불일치는 STORAGE.
- POST /api/media/upload: same-origin, multipart만 허용. Content-Length 사전 검사와 stream counting으로 10MiB+64KiB를 초과하면 413. 허용 field는 file/projectId/licenseNotes뿐이고 중복·미지정 field는 400, file은 별도로 10MiB 검사.
- GET /api/media/:id: UUID 검증, raw bytes와 Content-Type, nosniff, `public, max-age=31536000, immutable`. 오류는 표준 JSON envelope로 반환한다.

해석이 필요했던 점 (계약 변경 없음, 검토 요청)
- 16MP 초과는 크기 제한이므로 TOO_LARGE(413)로 처리했다(계약은 byte limit만 413으로 명시).
- 0 byte 파일은 디코딩할 수 없는 미디어로 보고 INVALID_MEDIA로 처리했다.
- 선언 MIME이 허용 목록 밖(gif, svg 등)이면 UNSUPPORTED, 허용 MIME인데 실제 내용이 다르면 INVALID_MEDIA로 처리했다.
- route 테스트는 T12 composition root 대신 `vi.mock`으로 container를 test double로 바꾸고, 실제 T01/T02 구현을 주입해 검증했다. 실제 container wiring은 T12에서 한다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T02.test.ts`: 구현 전 NotImplementedError(T02) 1 failed 확인 → 구현 후 통과.
- `npm run test:acceptance -- tests/acceptance/T01 tests/acceptance/T02`: 4 files / 37 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint 0 problem, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 처음에는 실패했다. setup.spec은 통과, demo.spec은 next dev full reload race로 실패(기본 2 worker, 0/8). 사용자 승인으로 `playwright.config.ts`에 임시 `workers: 1`을 적용한 뒤 3회 연속 2 passed, verify 직후 실행도 2 passed. 상세는 docs/blockers.md.
- 참고 `npm run test:acceptance`(전체): 11 failed / 37 passed. 남은 실패는 T03–T07 NotImplementedError와 T12의 501이고, T01/T02 원인 실패는 없다.

남은 문제
- e2e의 `workers: 1`은 임시 조치다. production e2e stack 전환으로 근본 해결하는 일은 T12에 남겼다(T12.md 4단계).
- T12는 `createDependencies`에 `imageInspector: createSharpImageInspector()`를 조립해야 한다(T12.md에 반영).
- DB insert가 실패하면 blob 파일이 orphan으로 남는다(architecture에서 허용, 자동 GC 없음).

## T03 — 프로젝트와 승인 라이브러리 service (2026-10-26)

변경 파일
- `src/application/services/projects.ts`: `createProject`, `listProjects`, `getProject`, `getWorkspace`
- `src/application/services/library.ts`: `createStyle`, `approveStyle`, `createAsset`, `approveAsset`
- `tests/acceptance/T03.cases.test.ts`: 신규 15 case(service + HTTP route). 기존 `T03.test.ts`는 변경 없음.
- T03 소유 route 7개는 이미 계약대로 service를 호출하는 얇은 wrapper였기 때문에 수정하지 않았다. 실제 동작은 route 테스트로 검증했다.

구현 요약
- createProject: `CreateProject` 재검증(trim, 1..120, budget 정수≥0/null, unknown key 거부 → VALIDATION). id=projectId, revision 0, `deps.now()` 사용, 저장 후 반환.
- listProjects/getProject: createdAt→id 순 목록. 잘못된 ID는 VALIDATION, 없는 ID는 NOT_FOUND.
- getWorkspace: 하나의 transaction 안에서 project와 10개 collection을 projectId로 조회(previews 제외) → `Workspace` allowlist schema로 serialize. 정렬은 repository의 createdAt→id 순서를 따른다.
- createStyle/createAsset: schema 재검증 → 중복 referenceId 또는 중복 slot 종류는 VALIDATION → transaction 안에서 project와 media scope를 확인(없거나 다른 프로젝트면 NOT_FOUND) → 같은 project/logicalId의 max version+1을 할당한 뒤 insert. version=1에서 시작, approvedAt=null. asset 이름 공백은 schema trim으로 거부.
- approveStyle/approveAsset: transaction 안에서 미승인이면 approvedAt=now, revision+1(T01 approval 규칙으로 1회만 허용). 이미 승인됐으면 같은 record를 그대로 반환. style positive가 공백이면, asset slot이 0개이면 VALIDATION.

해석이 필요했던 점 (계약 변경 없음, 검토 요청)
- slot 종류가 다르면 같은 media를 여러 slot에 써도 허용했다(계약은 slot 종류 중복만 금지).
- slot이 0개인 asset draft 생성은 허용하고 승인만 막았다(계약상 "승인에는 적어도 1개 slot 필요").
- logicalId 재사용 시 이전 버전과 kind/name이 같은지는 검사하지 않았다(계약에 규칙 없음).

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T03.test.ts`: 구현 전 NotImplementedError(T03) 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T01 tests/acceptance/T02 tests/acceptance/T03`: 6 files / 53 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed (workers: 1 임시 설정 유지).
- 참고 `npm run test:acceptance`(전체): 10 failed / 53 passed. 남은 실패는 T04–T07 NotImplementedError, T08/T09/T11(자기 service stub이 NOT_FOUND 대신 NOT_IMPLEMENTED를 던짐), T12의 501이고, T01–T03 원인 실패는 없다.

남은 문제
- route의 실제 container wiring은 T12에 남아 있다(현재 production route는 501).

## T04 — 장면 저장과 canvas 계약 (2026-10-26)

변경 파일
- `src/application/services/scenes.ts`: `createScene`, `getScene`, `updateScene`, `duplicateScene`
- `src/components/canvas/scene-canvas.tsx`: `SceneCanvas`, 테스트용 export helper `normalizePoint`/`boxFromDrag`/`replaceSketchReference`
- `tests/acceptance/T04.cases.test.ts`: 신규 13 case(service, canvas helper, HTTP route). 기존 `T04.test.ts`는 변경 없음.
- T04 소유 route 3개는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증).

구현 요약
- 공통 검증: schema 재검증(prompt trim, size 512..2048, box가 0..1 안에 완전히 포함, unknown key 거부 → VALIDATION). parent/mask role, (mediaId,role) 중복, assetVersionId 중복은 VALIDATION. transaction 안에서 project/media/style/asset이 같은 프로젝트인지 확인(아니면 NOT_FOUND), style/asset 미승인 버전은 CONFLICT.
- createScene: revision 0, `deps.now()`. 순서는 references/boxes 배열 순서 그대로(zIndex tie는 배열 순서).
- updateScene: transaction 안에서 expectedRevision 비교(불일치 CONFLICT) 후 참조를 재검증하고 revision+1로 replace. 실패해도 기존 scene은 그대로.
- duplicateScene: 새 id, revision 0, 현재 시각, `structuredClone`한 content. run/preview는 복사하지 않는다.
- SceneCanvas: `next/dynamic(ssr:false)`로 react-konva를 client에서만 로드한다. 펜/지우개(`destination-out`)와 드래그 박스를 지원하고 pointer 좌표는 0..1로 정규화한다. 박스는 x+w≤1, y+h≤1로 clamp하고 1% 미만이면 버린다. 박스 라벨/z/방향 편집과 삭제(최대 30개) 지원. "스케치 PNG 업로드"는 박스를 제외한 스케치를 흰 배경 PNG로 장면 target size에 맞춰 렌더한 뒤 `POST /api/media/upload`로 보낸다. 응답을 `Media` schema로 확인한 뒤에만 sketch 참조를 교체(첫 sketch 위치 유지, 20개 한도)한다. 실패 시 value를 바꾸지 않고 오류만 표시한다. provider 호출은 없다.

해석이 필요했던 점 (계약 변경 없음, 검토 요청)
- SceneCanvas props(`value`, `onChange`)는 고정 signature라 projectId를 받을 수 없다. contracts UI 공통 규칙("projectId는 URL query로 전달")에 따라 업로드 시 `window.location.search`의 `projectId`를 사용한다. 없으면 업로드하지 않고 안내만 한다.
- sketch 참조 갱신은 기존 sketch role 참조를 모두 새 media 하나로 교체하는 것으로 해석했다.
- 스케치 stroke 자체는 SceneContent에 없으므로 컴포넌트 로컬 상태다. 업로드한 PNG만 장면에 남고, 새로고침 후 stroke 편집 상태는 복원되지 않는다.
- 미승인 버전 선택은 계약대로 CONFLICT, 없거나 다른 프로젝트의 버전은 공통 규칙대로 NOT_FOUND.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T04.test.ts`: 구현 전 NotImplementedError(T04) 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T01 … T04`: 8 files / 67 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 브라우저 수동 확인(임시 harness page로 확인 후 삭제, 커밋 대상 아님): dev server에서 펜 stroke, 박스 드래그 → 정규화 box 저장(예: x 0.649, w 0.2667). 업로드 요청은 file/projectId/licenseNotes 3개 field, PNG 1280×720·흰 배경·박스 픽셀 0. 지우개 적용 후 stroke 픽셀 0. production upload route가 501(T12 미연결)을 반환하면 오류를 표시하고 references는 변경되지 않음. 375px 폭에서 가로 overflow 없음(stage 343×193). 확인 중 dark theme에서 활성 도구 버튼 글자가 보이지 않던 문제를 수정했다.
- 참고 `npm run test:acceptance`(전체): 9 failed / 67 passed. 남은 실패는 T05–T09, T11 stub과 T12 501이고, T01–T04 원인 실패는 없다.

남은 문제
- 실제 업로드 성공 경로(브라우저 → container → 저장)는 T12 container 연결 후 T10 화면에서 확인해야 한다. 이번에는 route 레벨 테스트와 실패 경로만 브라우저로 확인했다.
- `/scenes` 페이지 통합은 T10 범위.

## T05 — 순수 compiler와 immutable preview (2026-10-26)

변경 파일
- `src/application/compiler.ts`: `compile`, 그리고 prompt와 hash가 같이 쓰는 helper `canonicalJson` export(소유 모듈 내 helper)
- `src/application/services/previews.ts`: `createPreview`
- `tests/acceptance/T05.cases.test.ts`: 신규 16 case(compiler 9, createPreview 6, HTTP route 1). 기존 `T05.test.ts`는 변경 없음.
- `src/app/api/generations/preview/route.ts`는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증).

구현 요약
- compile(순수): Snapshot/옵션 schema 재검증(실패 VALIDATION), Zod가 만든 사본만 사용해 입력을 변경하지 않는다. 참조는 parent→character→style→sketch 순 stable sort. 한도는 fal edit 1..4, mock 0..4이고 벗어나면 UNSUPPORTED(자르지 않음). text baseline은 refs=[] + REFERENCES_OMITTED(참조가 있을 때), parent/edit는 UNSUPPORTED. mask(edit.maskMediaId 또는 mask role)는 모든 adapter에서 UNSUPPORTED. parent/edit/parent 참조가 서로 맞지 않으면 VALIDATION. prompt는 `[SCENE]`…`[EDIT]` label과 값을 각각 다른 줄에 두고, JSON은 모든 깊이에서 key를 정렬한다. warnings는 고정 순서로 넣는다(negative는 trim 후 비어 있지 않을 때). endpoint mapping과 native literal parameters를 적용하고, seed null은 그대로 둔다(생략은 T07 payload 단계). 가격은 mock known 0(source mock, verifiedAt 2026-10-26T00:00:00.000Z), fal은 unknown `pricing-not-configured`.
- createPreview: PreviewInput 재검증 → transaction 안에서 scene, 같은 프로젝트의 승인된 style/asset(scene 순서), 참조 media를 확인. parent는 같은 프로젝트 candidate이고 parent run의 sceneId가 요청 sceneId와 같아야 한다(아니면 VALIDATION). mask는 media scope 확인 후 UNSUPPORTED. snapshot은 deep copy이고 parent 참조만 사본의 선두에 추가한다(저장된 scene은 그대로). → compile → `SHA-256(canonical {snapshot, compiled})` → expiresAt=createdAt+900000ms → 두 번째 transaction에서 snapshot을 다시 만들어 동일한지 확인한 뒤 insert(달라졌으면 CONFLICT).

해석/설계 선택 (계약 변경 없음, 검토 요청)
- application은 `node:crypto` import가 boundary상 금지라서 hash는 Web Crypto 전역(`globalThis.crypto.subtle`, import 불필요)으로 계산했다. 비동기라 transaction 안에서 할 수 없으므로, 읽기 transaction → 외부에서 hash → 쓰기 transaction(동일성 재확인 후 insert)으로 나눴다. 사이에 scene이나 library가 바뀌면 CONFLICT로 다시 요청하게 한다.
- parent candidate의 run이 다른 scene이면 입력 오류로 보고 VALIDATION(400)으로 처리했다.
- compiler는 parentCandidateId·edit·parent 참조 1개가 함께 있어야만 허용한다(contracts의 "편집은 parent와 edit 둘 다 필요"를 snapshot 일관성 검사로 적용).
- NEGATIVE_AS_TEXT는 negative를 trim한 결과가 비어 있지 않을 때만 표시한다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T05.test.ts`: 구현 전 NotImplementedError(T05) 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T01 … T05`: 10 files / 84 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 참고 `npm run test:acceptance`(전체): 8 failed / 84 passed. 남은 실패는 T06/T07 NotImplementedError, T08/T09/T11 자기 stub, T12 501이고, T01–T05 원인 실패는 없다.

남은 문제
- 실제 fal schema 대조와 seed null 생략은 T07 범위.

## T06 — 영속 생성 orchestration과 worker loop (2026-10-26)

변경 파일
- `src/application/services/runs.ts`: `submitRun`, `getRun`, `resolveRun`, `retryDownload`, `tickWorker`
- `src/worker/runner.ts`: `runWorker`
- `tests/acceptance/T06.cases.test.ts`: 신규 25 case(submit 정책 9, worker 단계 11, 복구 2, loop 2, HTTP 1). 기존 `T06.test.ts`는 변경 없음.
- `docs/tasks/T12.md`: worker main의 signal/DB close 책임 명시.
- generation route 4개는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증).

구현 요약
- submitRun(BEGIN IMMEDIATE 단일 transaction): preview 조회 → replay 검사(같은 project+key, 또는 같은 preview. previewId/hash 일치 시 만료 후에도 기존 run 반환, 다른 preview면 CONFLICT) → hash 일치 → now<expiresAt, scene revision 동일(아니면 STALE_PREVIEW) → adapter 존재(아니면 UNSUPPORTED) → 전역 active cap 1(CONFLICT) → 비용 정책 → draft run insert. provider 호출 없음.
- 비용: known은 max 필수, 초과 시 BUDGET_EXCEEDED. unknown은 acceptUnknownCost=true와 max=null 필수이고, finite budget이면 항상 COST_UNKNOWN. finite budget 누적은 run별 actual known 우선, 없으면 estimate known(실패 run도 포함, 환급 없음). 둘 다 unknown인 run이 있으면 COST_UNKNOWN, 합계+새 estimate>budget이면 BUDGET_EXCEEDED(같으면 허용).
- tickWorker: owner 검증 → lease 60초 획득/갱신(실패 시 null) → active run 1개에 대해 한 단계만 실행. 모든 worker 쓰기는 같은 transaction에서 lease 재확인 + revision CAS + `transition()` 검증을 거친다.
  - draft: adapter가 없으면 failed. 아니면 `submitting` intent를 먼저 commit → 참조 bytes 읽기(실패는 미제출이 확실하므로 failed `REFERENCE_UNAVAILABLE`) → submit 1회(30초 timeout, 10초마다 lease heartbeat). 성공 시 request ID와 함께 queued. rejected만 failed, 그 외 오류는 submission_unknown, timeout은 submission_unknown `SUBMISSION_TIMEOUT`. lease를 잃었으면 늦게 온 응답을 기록하지 않는다.
  - tick 시작 시 submitting이면 중단된 제출로 보고 submission_unknown `SUBMISSION_INTERRUPTED`(재제출 없음).
  - queued/running: poll만. 오류·timeout은 상태 유지 + `PROVIDER_POLL`, 다음 성공 시 errorCode 해제. running→provider queued는 무시. completed는 downloading, provider failed는 failed `PROVIDER_FAILED:<code>`.
  - downloading: download(30초) → 개수=num_images, PNG, decode, 16MP, 10MiB, live adapter는 요청 크기 일치(mock 1×1만 예외) → blob 저장 → 한 transaction에 Media(source generated)·Candidate(index, parentCandidateId, seed) insert + succeeded. 실패는 download_failed(`OUTPUT_COUNT`/`OUTPUT_FORMAT`/`OUTPUT_SIZE`/`DOWNLOAD_FAILED`/`DOWNLOAD_TIMEOUT`/`STORE_FAILED`)이고 생성 재요청은 하지 않는다.
  - submission_unknown/download_failed는 사용자 조치를 기다린다(processedRunId=null).
- resolveRun: attach는 submission_unknown→queued(request ID 기록), abandon은 submission_unknown/download_failed→failed `ABANDONED:<trim된 reason>`. retryDownload는 download_failed→downloading. 그 외 상태는 CONFLICT.
- runWorker: tick → 2초 대기(abort 시 즉시 깨어남) 반복. tick 오류는 오류 이름만 로그(메시지/키 미출력)하고 계속. abort되면 진행 중 tick을 마친 뒤 lease를 해제한다.

해석이 필요했던 점 (계약 변경 없음, 검토 요청)
- previewHash가 저장된 hash와 다르면 CONFLICT(409)로 처리했다(계약은 "일치 요구"만 명시). STALE_PREVIEW는 만료와 scene 변경에만 사용한다.
- known estimate에서 maxEstimatedCostMicros=null이면 VALIDATION(400).
- finite budget 계산 중 unknown run 때문에 막히는 경우는 COST_UNKNOWN.
- 제출 전 참조 media/blob을 읽지 못하면 provider에 아무것도 보내지 않았으므로 failed로 끝낸다(submitting→failed 전이는 run-state에서 허용).
- adapter가 사라진 queued/running run은 상태를 유지하고 `ADAPTER_UNAVAILABLE`만 기록한다(설정 복구 후 재개 가능). downloading이면 download_failed.
- 생성 media의 licenseNotes는 `Generated via <endpoint>`(provider URL 아님).
- SIGINT/SIGTERM 처리와 DB close는 `src/worker/main.ts`(T12 소유)에서 한다. runWorker는 abort 후 lease 해제까지만 담당한다(T12.md에 명시).

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T06.test.ts`: 구현 전 NotImplementedError(T06) 2 failed 확인 → 구현 후 2 passed.
- `npm run test:acceptance -- tests/acceptance/T06`: 27 passed, 3회 반복 모두 통과(fake timer 테스트 안정성 확인).
- `npm run test:acceptance -- tests/acceptance/T01 … T06`: 12 files / 111 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 참고 `npm run test:acceptance`(전체): 6 failed / 111 passed. 남은 실패는 T07 NotImplementedError, T08/T09/T11 자기 stub, T12 501이고, T01–T06 원인 실패는 없다.
- 실제 fal 호출 없음. mock과 test double(FakeAdapter, 루프 테스트용 in-memory blob/inspector)만 사용했고 모델 품질과는 무관하다.

남은 문제
- 별도 프로세스 재시작(worker+Next) 검증은 T12의 e2e-stack 범위다. 이번에는 같은 DB에서 새 adapter 인스턴스와 다른 owner로 lease 만료 후 재개되는 것을 확인했다.
- timeout 뒤에도 provider 호출 자체는 취소할 수 없다(늦은 응답은 기록하지 않음). attach로만 연결할 수 있다.

## T07 — fal boundary와 native payload adapter (2026-10-26)

**live fal 호출 0회.** fal에는 공개 문서 페이지 열람(HTTP GET)만 했고 API 호출·과금은 없다. 모든 테스트는 transport/HTTP/SDK/DNS test double을 사용하고, 전역 fetch guard로 실제 network 호출이 0회임을 확인한다. mock 테스트를 모델 품질 평가로 해석하지 않는다.

변경 파일
- `src/infrastructure/models/fal.ts`: `createFalAdapter`, `buildFalInput`, default transport `createDefaultFalTransport`(신규 export, 테스트 주입용 option), `isPublicAddress`/`validatingLookup` helper export
- `src/app/api/models/route.ts`: 설정 기반 `ModelInfo[]`(fal은 provider=fal+key일 때만 available, 그 외 `NOT_CONFIGURED`; mock은 scope product), `respond` envelope와 nodejs runtime
- `docs/model-support-matrix.md`: 2026-10-26 schema 재확인 결과와 차이 기록, 상태 갱신
- 사용자 승인 계약 수정: `docs/contracts.md#fal`, `docs/architecture.md`(기술 스택 표), `docs/decisions/004-provider-and-cost.md`(Amendment), `src/infrastructure/models/fal-contract.ts`(주석만), `docs/blockers.md`(결정 기록)
- `tests/acceptance/T07.cases.test.ts`: 신규 21 case. 기존 `T07.test.ts`는 변경 없음.

구현 요약
- buildFalInput: Compiled 재검증 → edit은 refs 수와 URL 수가 같고 1..4개(HTTPS만), text는 URL·refs 0개 → 공개 필드만 정확히 mapping, seed null 생략, `FalInput` strict schema로 최종 검증(mask/negative/LoRA/controlnet/key 필드 없음).
- adapter.submit: adapter/endpoint 일치와 ref bytes mapping 확인 → ref를 순서대로 upload → URL을 순서대로 binding → transport.submit 정확히 1회. 업로드·입력 단계 실패는 `SubmissionError("rejected")`(미제출 확실). submit 오류는 400/401/403/404/422만 rejected, 그 외는 unknown. request_id가 없거나 비어 있으면 unknown. 임시 URL은 메모리에만 있다.
- poll: IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED → queued/running/completed/failed. 알 수 없는 값이나 오류는 PROVIDER(T06에서 PROVIDER_POLL로 기록).
- download: result → `FalOutput` allowlist parse(실패 `OUTPUT_FORMAT`) → `has_nsfw_concepts`에 true가 있으면 이미지를 받지 않고 `OUTPUT_NSFW` → 각 이미지 fetch → PNG signature 확인 → `{bytes, mime: image/png, seed}`.
- default transport(승인된 구성): submit은 `POST https://queue.fal.run/<endpoint>`를 호출당 1회, `redirect: "error"`, 30초 timeout, `Authorization: Key`로 보낸다. 429·5xx·timeout·연결 단절·파싱 실패·request_id 누락은 unknown이고, 오류 메시지에 본문과 key를 넣지 않는다. upload/status/result는 instance-scoped `createFalClient({credentials, retry:{maxRetries:0}})`를 쓰고 전역 `fal` singleton은 사용하지 않는다. queue의 "COMPLETED + error"는 FAILED로 mapping한다.
- fetchImage: HTTPS만, URL credential/localhost/비공개 IP literal 차단. DNS는 접속 시점에 모든 answer를 검증해(lookup hook) 검사 후 주소가 바뀌는 rebinding을 막는다. redirect는 매 hop 재검증하고 최대 3회. 전체 30초 timeout, 10MiB streamed cap. 오류 코드에 URL을 넣지 않는다.

schema 재확인(문서만): 사용하는 입력·출력 필드명과 범위는 matrix와 일치하고 계약 변경이 필요한 차이는 없다. 차이 메모: image_urls 4개 초과 시 provider는 조용히 버리지만 앱은 차단한다. queue status에는 FAILED가 없고 COMPLETED+error로 온다. 가격 미게시.

해석이 필요했던 점 (검토 요청)
- `isPublicAddress`는 IPv4-mapped/compatible IPv6, NAT64(64:ff9b::/96), 6to4(2002::/16), 2001::/23, 문서용 대역도 차단한다(보수적).
- 제출 응답 request_id는 500자 이하 문자열만 허용한다(ResolveInput attach 한도와 같음).
- 업로드 Blob의 content-type은 bytes signature로 정한다(png/jpeg/webp, 그 외 octet-stream).
- models route는 `loadConfig(process.env)`를 요청 시점에 읽는다(import 시 env 읽기 금지 준수). key 형식은 network 없이 검증할 수 없으므로 비어 있지 않은지만 확인한다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T07.test.ts`: 구현 전 NotImplementedError(T07) 2 failed 확인 → 구현 후 2 passed.
- `npm run test:acceptance -- tests/acceptance/T07`: 23 passed(real network 0).
- `npm run test:acceptance -- tests/acceptance/T01 … T07`: 14 files / 134 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 참고 `npm run test:acceptance`(전체): 4 failed / 134 passed. 남은 실패는 T08/T09/T11 자기 stub과 T12 501이고, T01–T07 원인 실패는 없다.
- 검증 중 발견·수정: Node `BlockList`에 IPv4-mapped IPv6 subnet(::ffff:0:0/96)을 넣으면 모든 IPv4가 차단돼 IPv4/IPv6 목록을 분리했다. 테스트에서 module-level `vi.spyOn(globalThis, "fetch")`가 suite 오류를 일으켜 `vi.stubGlobal` guard로 바꿨다.

남은 문제
- live 동작(실제 upload/submit/결과 URL·형식, 실제 비용)은 미검증이다. 사용자가 요청할 때만 비용과 입력을 먼저 보여 주고 진행한다.
- adapter 등록(`createDependencies`에서 fal mode일 때 `createFalAdapter` 조립)은 T12 범위다.

## T08 — 사람 평가와 child revision (2026-10-26)

변경 파일
- `src/application/services/review.ts`: `saveReview`, `getCandidate`, `refineCandidate`, 그리고 refine 입력 schema `RefineInput` export(소유 모듈 helper)
- `src/app/api/candidates/[id]/refine/route.ts`: URL의 candidate id를 parent로 사용하고 `RefineInput`으로 body를 검증한 뒤 preview를 반환
- `tests/acceptance/T08.cases.test.ts`: 신규 10 case(service 8, HTTP route 2). 기존 `T08.test.ts`는 변경 없음.
- candidate GET과 review POST route는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증). `/review` 페이지는 T10 소유라 손대지 않았다.

구현 요약
- saveReview: ReviewInput 재검증 → transaction 안에서 candidate와 run 조회(NOT_FOUND) → run.snapshot.edit가 있으면 edit으로 보고 preservation 필수, 원본이면 preservation은 null이어야 함(어기면 VALIDATION) → append-only insert. 기준 미달이어도 기록하며, 판정은 `domain/approval.passesReview`가 계산한다(반환 DTO는 계약 그대로 `Review`).
- getCandidate: candidate와 그 candidate의 reviews만 createdAt→id 순으로 반환. 최신 판정은 마지막 항목.
- refineCandidate: URL id를 parent로 고정(body의 다른 parentCandidateId는 VALIDATION) → edit 필수 → candidate 존재 확인 → `createPreview`에 위임. parent scene/scope, mask UNSUPPORTED, text baseline UNSUPPORTED는 T05 검사를 그대로 쓴다. preview만 만들고 run·provider 호출·비용은 없다. lineage는 결과 candidate.parentCandidateId와 run.snapshot.edit로만 표현한다(별도 Revision 테이블 없음).

해석/설계 선택 (계약 변경 없음, 검토 요청)
- "edit candidate"는 그 candidate를 만든 run의 `snapshot.edit !== null`로 판정했다.
- 원본 candidate 평가에 preservation 점수를 보내면 무시하지 않고 VALIDATION으로 거부한다(계약: 원본이면 preservation=null).
- `PreviewInput`은 refine이 걸린 schema라 Zod 4에서 `.omit()`을 쓸 수 없다. 그래서 같은 필드 정의(shape)를 재사용한 strict `RefineInput`(edit 필수)을 service에 두고 route가 import한다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T08.test.ts`: 구현 전 NOT_IMPLEMENTED로 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T08`: 11 passed. 원본 → refine preview → submit → mock worker → child candidate 흐름에서 parent candidate/run/media/blob bytes 불변을 확인했다.
- `npm run test:acceptance -- tests/acceptance/T01 … T08`: 16 files / 145 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 참고 `npm run test:acceptance`(전체): 3 failed / 145 passed. 남은 실패는 T09/T11 자기 stub과 T12 501이고, T01–T08 원인 실패는 없다.

남은 문제
- 원본/자식 비교 UI, 보존 지시 입력, 전체 편집 경고, mask 차단 안내는 T10(`/review`) 범위다.

## T09 — 효과와 PNG/manifest export (2026-10-26)

변경 파일
- `src/application/services/effects.ts`: `saveEffects`, `getEffects`, `exportCandidate`, 그리고 manifest 다운로드용 `readExportManifest`(신규 export)
- `src/infrastructure/images/compositor.ts` (신규, 승인된 포트 구현): `createSharpImageCompositor`
- `src/application/ports.ts`: `CompositeLayer`, `CompositeInput`, `ImageCompositor`, `Dependencies.imageCompositor` 추가(사용자 승인 계약 수정). 같은 파일에서 T02 편집 때 빠진 공백(`ProviderOutput ={`)도 정리했다.
- `src/components/canvas/effects-canvas.tsx`: `EffectsCanvas`와 테스트용 helper `rotatedBox`/`topLeftFromCenter`/`cssFilter`
- `src/app/api/exports/[id]/manifest/route.ts`: export ID로만 manifest JSON을 다운로드(attachment, nosniff). 경로 입력은 받지 않는다.
- `tests/support/dependencies.ts`: 기본 `imageCompositor`로 실제 sharp 구현 사용
- `tests/acceptance/T09.cases.test.ts`: 신규 15 case(compositor 6, service 6, canvas helper 1, HTTP 2). 기존 `T09.test.ts`는 변경 없음.
- 문서: `docs/contracts.md#effects`, `docs/architecture.md`, `docs/tasks/T09.md`(소유 파일), `docs/tasks/T12.md`(wiring), `docs/tasks/index.json`, `docs/blockers.md`(결정 기록)
- effects GET/PUT route와 exports POST route는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증).

구현 요약
- saveEffects: EffectsInput 재검증 → transaction 안에서 candidate(NOT_FOUND)와 overlay media가 같은 프로젝트인지(NOT_FOUND) 확인 → 저장된 효과가 없으면 expectedRevision 0으로 revision 0 생성, 있으면 expectedRevision이 저장된 revision과 같을 때만 revision+1(아니면 CONFLICT). getEffects는 효과가 없으면 null.
- exportCandidate: 읽기 transaction(candidate, base media, 효과 또는 identity 기본값, overlay를 zIndex·배열 순으로 정렬) → 이 export 직전의 workspace snapshot → base/overlay blob 읽기(파일 누락·hash 불일치·크기 불일치 STORAGE) → compositor로 PNG 생성 → PNG blob, Manifest(schema 검증, 모든 workspace media의 path/hash 목록) JSON blob 쓰기 → 쓰기 transaction에서 base sha와 효과 revision이 그대로인지 재확인(변했으면 CONFLICT) 후 export media(source export)와 ExportRecord insert. 파일 단계에서 실패하면 DB 변경은 0이다(orphan blob은 architecture상 허용).
- ImageCompositor(sharp): base를 sRGB RGBA로 decode → RGB와 alpha를 분리해 brightness→contrast(c·v+128(1−c))→saturation→blur(0 skip, 0<σ<0.3이면 0.3)를 단계마다 별도 pipeline으로 적용(sharp는 한 pipeline 안에서 연산 순서를 바꾸므로) → alpha 재결합. identity면 원본 픽셀 그대로. overlay는 scale→시계방향 rotate(투명 배경)→alpha에 opacity 곱 → 회전 bounding box 왼쪽 위를 반올림한 (x,y)에 두고 canvas 경계로 clip → source-over.
- EffectsCanvas: base는 CSS filter(brightness→contrast→saturate→blur, 앞의 두 단계는 계약과 같은 선형식)로 미리보기, overlay는 client 전용 Konva로 drag(중심 → 저장 좌표 변환). 밝기/대비/채도/흐림 slider, overlay 추가(media ID)·수치 편집·삭제(최대 20개). 근사 미리보기이며 내보낸 PNG가 기준이라고 표시한다.

인수 기준 확인
- identity decoded pixels 동일(base acceptance + 2×2 투명 픽셀 포함 case), 원본 media record와 blob bytes 불변, 효과 reload 동일, 누락·변조 파일 시 media/export 수 변화 0, manifest schemaVersion 1·Manifest schema 통과·절대 경로/FAL_KEY/provider host 미포함.
- 순서 증명: gray 100에 brightness 2·contrast 0.5를 적용하면 164(반대 순서면 228). alpha 128/77 보존을 확인했다.

해석이 필요했던 점 (검토 요청)
- overlay x/y는 정수 pixel로 반올림해 배치한다.
- scale 후 overlay가 한 변 16384px 또는 64MP(=4×업로드 한도)를 넘으면 UNSUPPORTED로 거부한다(메모리 보호용 안전 한도, 새 제품 규칙은 아님).
- manifest JSON은 2칸 들여쓰기로 저장한다. 다운로드 파일명은 `manifest-<exportId>.json`이고 cache는 private immutable.
- 같은 후보를 여러 번 export하면 각 manifest는 이전 export들과 그 PNG media를 포함하고 자기 자신은 포함하지 않는다.

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T09.test.ts`: 구현 전 NOT_IMPLEMENTED로 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T09`: 16 passed.
- `npm run test:acceptance -- tests/acceptance/T01 … T09`: 18 files / 161 tests passed.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- 브라우저 수동 확인(임시 harness page로 확인 후 삭제, 커밋 대상 아님): slider가 CSS filter 순서대로 반영되고, overlay가 올바른 배율로 표시되며, 실제 마우스 drag로 저장 좌표가 바뀐다(예상 약 355.6/177.8, 결과 353.78/177.78, 차이는 screenshot 좌표 반올림). 375px 폭에서 가로 overflow 없음(이미지와 stage 모두 343×193). overlay media는 `/api/media`가 T12 전이라 501이므로 브라우저 안에서 data URL로 대체했다.
- 브라우저 확인 중 발견·수정: (1) SSR된 `<img>`가 hydration 전에 load를 끝내 onLoad가 불리지 않아 stage가 생기지 않던 문제 → mount 후 `complete` 확인 추가. (2) 1px border 때문에 base 718px와 stage 720px가 어긋남 → outline으로 변경. (3) 모바일에서 미리보기가 720px로 고정돼 이미지가 찌그러짐 → ResizeObserver로 사용 가능한 폭에 맞춤.
- 참고 `npm run test:acceptance`(전체): 2 failed / 161 passed. 남은 실패는 T11 자기 stub과 T12 501이고, T01–T09 원인 실패는 없다.

남은 문제
- CSS saturate/blur와 sharp modulate/blur는 계산 방식이 조금 달라 미리보기는 근사치다(export PNG가 기준).
- 실제 `/api/media` 연결 상태의 효과 화면 통합은 T10/T12 범위.

## T10 — 제품 UI와 API client 통합 (2026-10-26)

변경 파일
- 페이지(소유): `src/app/{projects,assets,styles,scenes,generate,review,effects,history}/page.tsx`
- 신규 공용 client helper(라우트되지 않는 private folder, T10 소유로 index.json·T10.md에 등록): `src/app/_studio/api.ts`(envelope fetch, `ApiError`, 501 문구, `useApi`), `ui.tsx`(PageShell/Nav, URL query 선택, loading/error/empty/ready 표시), `generation.tsx`(PreviewDetails, SubmitPanel, RunMonitor), `media.tsx`(업로드, 이미지 선택)
- 테스트: `tests/e2e-acceptance/T10.flows.spec.ts`(신규 9 case), `tests/e2e-acceptance/T10.mock-api.ts`(MOCK API helper). 기존 `T10.spec.ts`는 변경 없음.
- API/DTO, server module, 새 dependency 변경 없음. `/experiments`(T11)와 `/`(T12)는 손대지 않았다.

구현 요약
- 공통: projectId/sceneId/candidateId/runId는 URL query로 선택하고 `router.replace`로 갱신해 reload 후 복원된다. 모든 응답은 contract schema로 검증한다. 501은 "미구현 (501 NOT_IMPLEMENTED)… 저장·생성되지 않았습니다"로만 표시하고 성공·빈 목록처럼 보이지 않는다. 미선택 상태의 mutation 버튼은 disabled. `useSearchParams` 사용 부분은 Suspense 안에 둬서 production build의 정적 prerender를 유지했다.
- /projects: 생성(제목, 선택적 USD 예산 → micro-USD), 목록, 선택, 다음 단계 링크. 예산 미설정은 무제한 동의가 아님을 안내.
- /assets: 이미지 업로드(multipart), 자산 생성(새 자산 또는 기존 logicalId의 새 버전, slot 중복 차단), 버전별 승인(slot 0개면 disabled).
- /styles: Style DNA 9개 필드, 참조 이미지 선택, 새 버전, 승인(positive 비면 disabled).
- /scenes: 장면 목록·새 장면, 승인 버전만 선택 가능한 style/asset, 역할별 참조(자동 추가 없음 안내), SceneCanvas(스케치·박스), CAS 저장(충돌 안내), 복제, 생성으로 이동.
- /generate: 장면·모델(사용 불가 사유 표시)·개수·seed → 요청 미리보기(전송 순서 참조, 경고 설명, 예상 비용, 만료, 프롬프트) → 비용 동의(known: 예상액을 상한으로, unknown: "가격을 알 수 없음" 명시 동의 후 상한 없이, 예산 설정 시 unknown 차단) → "생성 실행"(장면·미리보기·동의·미만료가 모두 있어야 enabled, preview별 idempotency key) → runId를 URL에 기록 → RunMonitor가 2초마다 polling하고 terminal/사용자 조치 상태/화면 이탈 시 중단. submission_unknown은 request ID 연결 또는 추적 중단, download_failed는 다운로드 재시도 또는 중단(중단은 취소·환불이 아님을 안내).
- /review: 원본/수정본 비교, 평가(edit이면 보존 점수 필수, 통과/미달 즉시 표시), append-only 기록(현재 판정 표시), 수정본 만들기(FULL_IMAGE_EDIT 경고, mask 선택 시 차단하고 명시적 "마스크 제거" 요구) → 같은 미리보기·동의·제출·진행 흐름.
- /effects: EffectsCanvas, 효과 저장(Effects.revision을 expectedRevision으로), 저장 안 된 변경이 있으면 내보내기 disabled, PNG와 manifest 다운로드 링크, 두 파일만으로 복원 불가 안내.
- /history: run 목록(상태, 오류 코드, adapter, 소요 시간=완료 updatedAt−createdAt, 실제/예상 비용, snapshot의 장면·스타일·자산 버전), 수정본 lineage, 후보 썸네일, 최신 평가 판정, 평가/효과/진행 보기 링크.

인수 기준 확인
- 장면 미선택이면 "생성 실행" disabled(기존 acceptance + flows).
- unknown 비용은 명시 동의 전 submit 0회, 동의 후 1회(`acceptUnknownCost: true, maxEstimatedCostMicros: null`). 예산이 있으면 동의 체크박스와 제출 모두 차단.
- reload 시 선택 복원: 장면 선택과 진행 중 run(runId) 복원, polling은 terminal 이후 4.5초 동안 추가 요청 0.
- 501: 목록 501은 미구현 alert만 표시하고 "없음" 문구를 보이지 않음, 제출 501은 진행 화면을 열지 않음.

검증 중 발견·수정
- `useApi`가 reload 때 loading으로 바뀌어 하위 화면이 remount되면서 작성 중이던 수정 폼이 초기화됨 → 같은 path의 재조회는 기존 데이터를 유지하도록 수정.
- 모바일 /scenes 가로 overflow(단일 열 grid의 auto track이 canvas 초기 폭 720px로 늘어남) → 모든 페이지 grid를 `grid-cols-1`/`minmax(0,…)`로 바꾸고 Panel에 `min-w-0` 추가.
- label 안에 넣은 select는 option 텍스트가 접근성 이름에 섞여 → 주요 select에 명시적 aria-label 추가.
- React lint(effect 안 동기 setState) → 요청 key 기반 결과 저장과 preview별 동의 상태로 재구성.

해석이 필요했던 점 (검토 요청)
- 공용 client helper를 8개 페이지에 복제하지 않고 `src/app/_studio/` private folder 하나로 묶었다(다른 task 파일·계약 변경 없음, T10 소유로 등록).
- 수정본 여부는 UI에서 `candidate.parentCandidateId !== null`로 판단한다(서버는 run.snapshot.edit 기준이며, 두 조건은 refine 계약상 함께 성립).
- 예산 입력은 USD 소수 입력을 micro-USD 정수로 반올림한다.
- 사용자 조치를 기다리는 상태(submission_unknown, download_failed)에서도 polling을 멈추고, 조치 후 다시 조회한다(worker가 이 상태를 바꾸지 않으므로).

실행 명령/결과
- `npm run test:e2e:acceptance -- T10.spec.ts`: 구현 전 heading 없음으로 1 failed 확인 → 구현 후 passed.
- `npm run test:e2e:acceptance`(T10 전체): 10 passed. 모든 /api/**는 page.route MOCK API이고, 실제 저장·생성·모델 품질 검증이 아니다.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, production build. 모든 페이지 정적 prerender).
- `npm run test:e2e`: 2 passed.
- `npm run test:acceptance`(전체): 2 failed / 161 passed. 남은 실패는 T11 stub과 T12 501이고, T10은 vitest suite가 없으며 원인 실패도 없다.
- 시각 확인: MOCK API로 generate/review/scenes/history 화면 screenshot을 확인(임시 spec은 삭제).

남은 문제
- 실제 API(container wiring) 상태의 전체 흐름 E2E는 T12 범위다(production 501 해제 후 page.route 없이 검증).
- `/experiments` 화면은 T11, 루트 화면의 제품 진입 전환은 T12 소유다.

## T11 — 실험 계획과 비교 보고 (2026-10-26)

변경 파일
- `src/application/services/experiments.ts`: `createExperiment`, `reportExperiment`, `attachExperimentRun`
- `src/app/experiments/page.tsx`: 실험 계획, 18슬롯 진행, 경로별 요청 차이, 비교 보고(T10 `_studio` 공용 컴포넌트를 import만 하고 수정하지 않음)
- `tests/acceptance/T11.cases.test.ts`: 신규 11 case(service 10, HTTP 1). 기존 `T11.test.ts`는 변경 없음.
- `tests/e2e-acceptance/T11.experiments.spec.ts`: 신규 2 browser case(MOCK API).
- experiments route 3개는 이미 계약대로 service를 호출하므로 수정하지 않았다(route 테스트로 검증).

구현 요약
- createExperiment: 입력 재검증(서로 다른 scene 3개, repeats=3) → 같은 프로젝트의 실제 scene 확인(NOT_FOUND) → 각 scene의 현재 revision을 `sceneRevisions`에 고정하고 sceneIds는 입력 순서로 저장, runIds=[]. preview·run·provider 호출 없음.
- attachExperimentRun: 같은 run 재연결은 no-op. 다음은 CONFLICT: fal-flux2-edit/text가 아닌 run(mock 포함), 계획에 없는 scene, 고정 revision과 다른 snapshot.sceneRevision(계획 후 scene 수정), edit run, outputCount≠1, seed가 0·1·2(repeat)가 아님, 이미 채워진 (scene, adapter, seed) 슬롯, 같은 scene의 첫 연결 run과 snapshot(과제 의도)이 다른 run. 다른 프로젝트의 run이나 없는 record는 NOT_FOUND. 상태와 무관하게 연결할 수 있다(진행 중 run 포함). 슬롯이 유일하므로 최대 18개.
- reportExperiment: 연결된 run의 모든 candidate가 표본이고, 각 candidate의 최신 review(createdAt→id)에 `passesReview`를 적용해 accepted를 판정한다. acceptanceRate는 total 0이면 null. costPerAccepted는 accepted 0이면 unknown `no-accepted-results`, 실제 비용 unknown인 run이 하나라도 있으면 unknown `incomplete-billing`, 그 외에는 실제 비용 합/accepted를 반올림(estimate는 쓰지 않음). medianLatencyMs는 succeeded run의 updatedAt−createdAt 중앙값(짝수면 가운데 두 값의 평균), 없으면 null.
- /experiments: 장면 3개를 골라 계획 저장 → 목록·선택(URL `experimentId`) → 장면별 경로×seed 표에 각 슬롯 상태 표시. 빈 슬롯은 "생성"(그 슬롯의 scene·adapter·seed·outputCount 1로 미리보기 → 비용 동의 → 제출 → 자동 attach → 진행 표시) 또는 조건이 맞는 기존 run "연결". 장면이 고정 revision 이후 수정됐거나 fal 모델이 설정되지 않았으면 해당 슬롯 버튼을 disabled하고 이유를 표시. 연결된 run별 전송 참조 수, 경고(REFERENCES_OMITTED 등), 실제 비용을 표로 보여 준다. 보고는 unknown 사유와 "결과 없음"을 그대로 표시하고 통계적 결론을 주장하지 않는다.

해석이 필요했던 점 (검토 요청)
- "첫 preview snapshot과 동일한 과제 의도"는 같은 scene에서 먼저 연결된 run의 snapshot 전체(scene copy, style/asset 버전, edit 없음)와 같아야 하는 것으로 구현했다. 경로별로 다른 것은 compiled 요청(참조 vs 텍스트)뿐이다.
- known costPerAccepted의 Money `source`는 `experiment-actual-cost`, `verifiedAt`은 보고 계산 시각(`deps.now()`)이다.
- 진행 중(queued 등) run도 슬롯에 연결할 수 있고, 보고에는 생성된 candidate만 표본으로 들어간다.
- UI에서는 한 번에 한 슬롯만 실행한다(전역 active cap 1과 같은 조건).

실행 명령/결과
- `npm run test:acceptance -- tests/acceptance/T11.test.ts`: 구현 전 NOT_IMPLEMENTED로 1 failed 확인 → 구현 후 1 passed.
- `npm run test:acceptance -- tests/acceptance/T11`: 12 passed(18슬롯을 모두 채운 뒤 추가 연결이 CONFLICT인 경계 포함).
- `npm run test:e2e:acceptance`(T10+T11): 12 passed. 모두 page.route MOCK API이며 실제 저장·과금·품질 검증이 아니다.
- `npm run verify`: exit 0 (handoff, boundaries, lint, typecheck, unit 30 tests, build).
- `npm run test:e2e`: 2 passed.
- `npm run test:acceptance`(전체): 1 failed / 173 passed. 남은 실패는 T12의 501→200 assertion뿐이다.

남은 문제
- 실제 fal로 18슬롯을 실행하는 것은 유료 live 작업이라 사용자 요청과 비용 확인이 필요하다. 이번에는 실행하지 않았다.
- 실제 API(container wiring) 상태의 실험 E2E는 T12 범위다.

## T12 — composition root 연결과 전체 handoff 검증 (2026-10-26)

변경 파일
- `src/server/create-dependencies.ts`: config → repo(`openRepository`, migration 누락 시 STORAGE와 `npm run db:migrate` 안내), blob store, `createSharpImageInspector`, `createSharpImageCompositor`, adapters(mock 항상, fal edit/text는 fal 모드+key일 때만), `now`, `newId`. Next `server-only`를 import하지 않아 worker와 공유한다.
- `src/server/container.ts`: lazy singleton. env는 첫 사용 시 읽고(import 시 아님), config(DB 경로, provider, key)가 바뀌면 다시 조립한다. open 실패는 캐시하지 않는다. `resetDependencies()` 추가(종료, 테스트의 서버 재시작 시뮬레이션용).
- `src/worker/main.ts`: 의존성 조립(실패 시 코드와 안내만 출력, 경로·key 없음) → 고유 owner → SIGINT/SIGTERM → AbortController → `runWorker` resolve 후 `repo.close()`.
- `src/app/api/health/route.ts`: 준비되면 200 `{status, stage: product, persistence: ready, provider, liveGeneration}`, DB 미준비 시 503과 안내. 경로·key는 노출하지 않는다.
- `src/app/page.tsx`: 제품 진입(준비 상태, 프로젝트 시작, 작업 흐름 링크). mock 데모 패널은 "저장 안 됨/유료 호출 없음" 표시를 유지했다.
- `scripts/e2e-stack.ts`: 임시 APP_DATA_DIR → migration → production build → worker와 `next start` child 실행. 종료 신호나 child 사망 시 두 child를 정리하고 임시 디렉터리를 삭제한다. mock provider, 비밀이 아닌 FAL_KEY sentinel 사용.
- `playwright.config.ts`: webServer를 e2e-stack으로 교체(health 200 대기, graceful SIGTERM). `workers: 1` 유지 이유를 주석에 기록.
- `tests/integration/demo.test.ts`, `tests/e2e/demo.spec.ts`, `tests/e2e/setup.spec.ts`: AGENTS가 허용한 T12 baseline 교체. production 501 assertion은 실제 저장·조회(재시작 후 재조회 포함)로, 초기 M0/미구현 assertion은 실제 준비 상태와 제품 진입 assertion으로 바꿨다. mock demo의 truthful assertion(저장 안 됨, trace)과 새로고침·모바일·pageerror 검증은 유지했다. demo 상태 locator는 준비 상태 status가 추가되어 데모 region 안으로 범위를 좁혔다.
- 신규 테스트: `tests/acceptance/T12.cases.test.ts`(5 case, 실제 worker child process 포함), `tests/e2e-acceptance/T12.flow.spec.ts`(실제 stack UI 전체 흐름). 기존 `T12.test.ts`는 변경 없음.
- 문서: `README.md`(실행·worker·fal·검증 안내), `docs/blockers.md`(e2e blocker resolved).

인수 기준 확인
- prod routes 구현: 모든 제품 route가 wired container로 동작한다(T12 base + 통합·e2e).
- source 수정 없이 전체 mock 흐름: (a) vitest에서 실제 route handler와 별도 worker 프로세스로 업로드 → style/asset 승인 → 장면 → 미리보기 → 제출 → worker 생성 → 평가 → refine → child → 효과 → export → manifest. (b) Playwright로 production stack에서 page.route 없이 화면만으로 프로젝트 → 업로드 → 장면(참조) → 미리보기·동의·제출 → worker 완료 → 평가 → export·manifest 다운로드 → 이력.
- 서버/worker 재시작 후 lineage 복원: worker SIGTERM 종료(exit 0, lease 해제 로그) → container reset(서버 재시작 시뮬레이션) → workspace에서 child.parentCandidateId, run.snapshot.edit, style 버전, review, export, media 파일 복원 확인. 별도 프로세스 unknown resume: submitting에서 중단된 run을 첫 worker가 `submission_unknown`(재제출 없음)으로 바꾸고, attach 후 새 worker 프로세스가 완료.
- key 미노출: production stack의 FAL_KEY sentinel이 방문한 모든 client JS chunk, /api/models·health·workspace, manifest에 없다(vitest에서도 workspace·manifest·health·models 확인). client chunk에 `queue.fal.run` 없음.
- 모든 task suite pass(아래).

실행 명령/결과 (최종 전체 실행)
- `npm run verify`: exit 0 (handoff 12 tasks, boundaries, lint, typecheck, unit/contract/integration 30 tests, production build).
- `npm run test:acceptance`(전체): exit 0, **22 files / 179 tests passed**.
- `npm run test:e2e`: exit 0, 2 passed(production stack).
- `npm run test:e2e:acceptance`(전체): exit 0, **13 passed**(T10·T11 page.route mock UI 12건 + T12 실제 stack 전체 흐름 1건).
- 정리 확인: e2e·acceptance 실행 후 이번 실행의 임시 디렉터리 잔여 0, 기본 `./data` 미생성. 실제 fal 호출 0.

해석/설계 선택 (검토 요청)
- health는 준비되지 않으면 503을 반환한다(Playwright webServer 준비 판정에 사용). 성공 시 envelope `{data}`를 유지했다.
- container singleton은 config signature 기준으로 다시 조립한다. 테스트가 APP_DATA_DIR를 바꿔도 이전 DB 연결을 재사용하지 않는다.
- worker owner는 `worker-<hostname>-<pid>-<random>`이다. 비정상 종료(SIGKILL) 후에는 lease 만료(60초) 뒤 다른 worker가 이어받는다(정상 종료는 즉시 해제). SIGKILL 시나리오는 T06 단위 테스트(lease 만료 인수)로 검증했고 프로세스 수준에서는 SIGTERM 재시작만 실행했다(60초 대기 회피).
- e2e-stack은 실행마다 production build를 한다(`E2E_SKIP_BUILD=1`로 생략 가능).

남은 문제
- 실제 fal live 검증(업로드·제출·결과·비용)은 사용자 요청과 비용 확인이 필요해 실행하지 않았다.
- 이전 세션 시점(08:51)의 acceptance 임시 디렉터리 1개(`studio-acceptance-*`, mock PNG blob 1개 포함)가 남아 있어 삭제했다. 어떤 테스트가 dispose 후 blob을 썼을 가능성이 있으나 최종 전체 실행에서는 재현되지 않았다.
- `docs/VERIFICATION.md`와 `docs/tasks/README.md`의 "hollow/pending" 서술은 설계 시점 snapshot이라 소유 범위 밖이어서 수정하지 않았다. 현재 상태는 이 status.md와 README가 기준이다.
