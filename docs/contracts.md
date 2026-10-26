# Behavioral contracts v1

코드 기준: `src/contracts/*.ts`, `src/application/ports.ts`. 아래 모든 계약은 기능 구현 전에 읽는다. Unknown keys는 입력 schema에서 거부한다. service도 직접 호출될 수 있으므로 같은 schema로 재검증한다. UUID v4/ISO UTC millisecond timestamps, integer micro-USD 사용. DI `now/newId` 외에 clock/random을 업무 로직에서 직접 호출하지 않는다.

## 공통

HTTP JSON 성공 `{data:T}`, 실패 `{error:{code,message}}`; 성공 200 (생성/접수 포함, 이 prototype에서는 201/202를 혼용하지 않는다). media/manifest 다운로드만 raw binary/JSON file. 에러코드/HTTP mapping은 `domain/errors.ts`. Zod 오류→VALIDATION 400, missing→404, CAS/중복 intent→409, unsupported→422, byte limit→413, decode/MIME→422, provider→502, storage→500, stub→501. 예상 밖 exception은 INTERNAL로 숨기고 raw provider 응답/키/stack을 client에 주지 않는다.

반복되는 공통 precondition: ID가 존재하고 모든 참조가 동일 projectId. 다른 프로젝트의 ID도 NOT_FOUND로 처리한다. mutation은 transaction에서 검증 후 기록한다. 중간 실패는 DB 전체 rollback. input object를 수정하지 않는다. 기본 list는 createdAt 오름차순, 같은 시간은 id 오름차순. projects list만 프로젝트 필터 없이 허용; 다른 collection의 projectId 없는 list는 worker/admin 내부에서만 사용한다.

## repository

- 책임/타입: `Repository`, `UnitOfWork`, `Entities`. 동기 CRUD와 CAS/lease. network/file blobs/business policy는 소유하지 않는다.
- get missing→null, list empty→[], 둘 다 detached object. insert 중복→CONFLICT. 잘못된 schema/body↔column 불일치→VALIDATION. open 미설치 DB/손상→STORAGE.
- insert는 revision 0, 모든 ID/scope/schema 검증. projectId 존재 검사; Project는 projectId=id.
- replace는 existing revision=expectedRevision AND new revision=expected+1, id/project/createdAt 고정. 허용 mutation은 architecture 저장 절. 불변 필드 변경은 CONFLICT. missing→NOT_FOUND.
- transaction은 BEGIN IMMEDIATE, throw rollback, 성공 commit. Promise 반환하면 rollback+VALIDATION(비동기 callback 금지). nested transaction 금지 VALIDATION. closed handle 사용→STORAGE.
- lease singleton id=1. `acquireLease(owner,now,until)`은 until>now, 기존 없거나 expired 또는 같은 owner만 허용; false는 다른 active owner. release는 해당 owner만 삭제, 없는 lease는 no-op.
- 예: insert project(rev0) → reopen get 동일; replace title rev1 expected0 성공, 다시 expected0은 CONFLICT.
- 부수효과/의존성: SQLite만, Drizzle/better-sqlite3. SQL은 parameter binding. T01은 포트 구현체만 작성.

## media

- `uploadMedia(deps,{projectId,bytes,declaredMime,licenseNotes})→Media`, `readMedia(deps,id)→{media,bytes}`; `BlobStore.write/read`; `ImageInspector.inspect(bytes)→{mime,width,height,pages}` (`Dependencies.imageInspector`).
- 이미지 decode는 application이 아니라 ImageInspector 포트가 담당한다(application의 sharp import 금지 유지). infrastructure sharp 구현은 metadata 조회 후 Limits.uploadPixels 이내면 첫 프레임 전체를 실제 decode하고, 초과면 header 값만 반환해 호출자가 거부하게 한다. decode 실패는 INVALID_MEDIA. media service는 결과로 MIME 일치, 픽셀 수, 다중 프레임을 판정한다. BlobStore는 decode 책임을 갖지 않는다.
- bytes 1..10MiB inclusive, decoded width×height≤16,000,000. sharp 실제 decode 성공, PNG/JPEG/WebP만. metadata만 읽고 통과시키지 않는다. animated/multipage는 UNSUPPORTED. MIME 일치해야 하며 원본 bytes는 변경하지 않는다. source=upload, licenseNotes≤2000. 사용자 파일명은 경로에 사용하지 않는다.
- SHA-256 content-addressed write는 같은 bytes/ext면 같은 경로. root 바깥, absolute, `..`, symlink escape 거부. read는 해당 root 내부 실제 파일만. atomic temp+rename, 기존 파일 hash가 다르면 STORAGE; 참조 이미지의 자동 overwrite 없음.
- project 검증→decode→blob→DB insert. 같은 파일 재업로드는 새 Media ID를 허용하되 같은 blob을 공유한다. media metadata/bytes는 불변.
- POST /api/media/upload: multipart `file` 1개, `projectId`, `licenseNotes`(기본 빈 문자열). 전체 body 상한 10MiB+64KiB를 stream counting 후 parse; file은 별도 10MiB 검사. 잘못된/중복 field 거부. 업로드 정보 외 body field 금지.
- GET /api/media/:id: DB로 경로 resolve; Content-Type, nosniff, immutable cache, 파일 ID만 받는다. missing file→STORAGE, 없는 ID→NOT_FOUND.
- 예: PNG magic+완전 decode+declared PNG→Media, PNG bytes+declared JPEG→INVALID_MEDIA.

## projects

- createProject(CreateProject)→Project: title trim 1..120, budgetMicros nullable 정수. id=projectId, rev0, clock 사용. 빈 문자열 VALIDATION. 영구 저장 후 반환.
- listProjects/getProject/getWorkspace: project 존재 확인. Workspace는 해당 프로젝트의 media/styles/assets/scenes/runs/candidates/reviews/effects/exports/experiments만. preview는 별도 submit 참조용이며 workspace에는 포함하지 않는다. 절대 path/환경변수 포함 금지.
- 예: `{title:" Wind Duel "}`→title `Wind Duel`, budgetMicros null. budget null은 한도 미설정이지 무제한 과금 동의가 아니다.
- UI /projects: 생성/목록/선택. 선택 projectId는 URL query로 전달한다. title/budget 수정·삭제는 MVP API 밖.

## library

- createStyle/CreateAsset DTO→Style/Asset. logicalId는 클라이언트가 UUID로 생성(새 논리 자산) 또는 기존 logicalId 재사용(새 버전). 서버가 같은 project/logicalId의 max version+1을 transaction 안에서 결정한다. 첫 version=1, approvedAt=null.
- slots/referenceIds 실제 media가 same project에 존재해야 한다. 중복 referenceIds, 중복 slot 종류, asset 이름 공백, 존재하지 않는 slot image는 거부. 없는 각도 이미지를 생성했다고 표시하지 않는다.
- approveStyle/approveAsset: 최초 승인 시 approvedAt=now, rev+1. 이미 승인되어 있으면 같은 record 반환(no new version, no rev bump). 승인 후 변경은 create로 새 버전을 만든다. asset 승인에는 적어도 1개 slot 필요, style 승인에는 specification.positive가 trim 후 비어 있으면 VALIDATION. style refs는 0개 가능.
- Style와 Asset는 상호 종속되지 않는다. Scene에서 조합한다. 형상/스타일의 자동 분석/생성은 범위 밖(수동 입력과 업로드).
- 예: logical A v1 blue 승인→create logical A red→v2 draft; 기존 run은 v1 유지.

## scenes

- createScene/getScene/updateScene/duplicateScene. 모든 media/style/asset는 같은 프로젝트. style/asset 선택은 승인 버전만, 미승인→CONFLICT. references가 선택 버전의 slot/ref와 연결되면 실제 사용할 이미지들은 명시적으로 Scene.references에 선택한다; compiler가 숨겨진 이미지를 자동 추가하지 않는다.
- (mediaId,role) 중복 금지. 서로 다른 역할로 같은 media 재사용은 허용, 각각 provider 참조 한도에 계산. Scene에는 parent/mask role 금지(수정 preview가 소유).
- 저장은 prompt trim, box가 0..1 안에 완전히 들어감, boxes zIndex tie는 배열 순서. target size 512..2048 양 축. update expectedRevision CAS, duplicate는 새 id/rev0/createdAt이며 content deep copy, 기존 run 복사하지 않는다.
- SceneCanvas: pen/eraser와 labeled boxes; pointer 좌표를 canvas 크기로 정규화. 스케치 PNG를 upload한 뒤 role=sketch 참조를 갱신. upload 실패 시 scene에 없는 ID를 쓰지 않는다. 마스크는 T08 UI에서 별도 PNG(흰색 수정, 검정 보존)로 만들되 live 지원 없음을 안내.
- 예: duplicate pose 변경→styleVersionId 그대로, 원본 scene/run 불변.

## previews

- createPreview(PreviewInput)→Preview. scene 존재/현재 revision, 승인된 선택 버전, references media를 검증. parent가 있으면 같은 프로젝트의 candidate, parent run.sceneId와 input.sceneId 동일해야 한다. 마스크가 있으면 media scope 검증 후 adapter capability 검사.
- snapshot에는 scene deep copy, 선택된 Style/Assets full version objects(assets는 scene.assetVersionIds 순서), parentCandidateId/edit. parent media는 역할 parent로 references 앞에 추가한다. Snapshot.scene 자체는 원본 저장 장면의 copy를 유지; compiler가 parent 입력을 알 수 있도록 createPreview는 snapshot.scene.references의 선두에 parent role을 추가한다(이 변화가 원본 scene을 변경하면 안 됨).
- 편집은 parent 존재와 edit 둘 다 필요. 현재 live 경로 mask 미지원: maskMediaId!=null이면 UNSUPPORTED. 사용자 명시적으로 mask 제거 후 whole-image edit preview 재요청. 자동 mask 폐기 금지.
- compile(snapshot,options) 순수 함수: parent→character→style→sketch→mask 순으로 stable sort. 같은 role은 scene 배열 순서 유지. fal edit refs 1..4, 초과/0→UNSUPPORTED; mock refs 0..4. 입력을 몰래 자르지 않는다.
- text baseline은 refs=[] + REFERENCES_OMITTED(참조가 있을 때), 편집/parent는 UNSUPPORTED. baseline도 동일 style/asset 텍스트 지시와 장면을 사용한다.
- prompt 정확한 조립: 줄바꿈으로 `[SCENE]`+prompt, `[CAMERA]`+camera, `[STYLE]`+style.specification의 키 정렬 JSON 또는 `{}`, `[ASSETS]`+assets의 `{name,kind,invariants,variants}` 배열 JSON, `[LAYOUT]`+boxes JSON, `[REFERENCES]`+전송 순서 `{index:1-based,role,note}` JSON, `[EDIT]`+edit JSON 또는 `null`. 각 label과 값은 서로 다른 줄. JSON object key는 모든 깊이에서 사전순, 배열 순서 유지. text baseline의 REFERENCES는 []. 스타일 negative는 본문으로만 전달하므로 비어 있지 않으면 NEGATIVE_AS_TEXT.
- SOFT_LAYOUT은 boxes나 sketch 참조가 있으면 항상 표시(text baseline에도 적용). FULL_IMAGE_EDIT은 edit가 있으면 표시. warnings 순서 고정: SOFT_LAYOUT, FULL_IMAGE_EDIT, REFERENCES_OMITTED, NEGATIVE_AS_TEXT 중 해당 항목.
- endpoint mapping: mock-reference→mock://fixture; fal-flux2-edit→fal-ai/flux-2/edit; fal-flux2-text→fal-ai/flux-2. Native params는 Compiled schema의 literal defaults. seed null은 실제 provider payload에서 생략한다.
- 초기 가격: mock known 0 (source mock, verifiedAt 고정 2026-10-26T00:00:00.000Z). fal unknown(reason `pricing-not-configured`), 가격 수치를 임의 고정하지 않는다. 요금 계산기 추가는 후속 계약 변경.
- hash=SHA256(UTF8 canonical JSON `{snapshot,compiled}`), expiry=now+900000ms. preview append-only. 예: 같은 snapshot/options→같은 hash, createdAt/ID/expiry는 hash에 미포함.
- 부수효과: createPreview만 DB insert, compile은 무부수효과. 파일 읽기/유료 호출 없음.

## runs

- submitRun(SubmitInput)→Run, getRun→run+index순 candidates. preview를 새로 compile하지 않는다. previewHash와 persisted hash 일치, now < expiresAt, scene revision 동일을 요구한다. 만료/scene변경→STALE_PREVIEW.
- replay를 transaction에서 먼저 조회한다. (project,idempotencyKey)가 있으면 previewId/hash 일치 시 기존 run 반환(만료 후에도 replay 가능). key 재사용으로 다른 preview를 가리키면 CONFLICT. 같은 preview를 다른 key로 제출해도 기존 run 반환. 새 생성은 새 preview가 필요하다.
- 전역 active cap=1: draft/submitting/queued/running/downloading/download_failed/submission_unknown 포함. active가 있으면 새 run CONFLICT. terminal만 슬롯 해제. DB BEGIN IMMEDIATE로 submit race 직렬화.
- known cost: maxEstimatedCostMicros 필수, estimate 초과면 BUDGET_EXCEEDED. unknown: acceptUnknownCost=true AND maxEstimatedCostMicros=null 필요, 아니면 COST_UNKNOWN. 프로젝트 budget이 있으면 unknown은 항상 차단. 누적 reservation=모든 run의 actual known 우선, 없으면 estimate known; 실패도 자동 환급하지 않는다. unknown이 하나라도 있으면 finite budget 신규 생성 차단. 합계+새 estimate>budget 차단. mock 0도 known 정책 적용.
- run은 draft/rev0/providerRequestId=null/actualCost unknown(reason `not-reported`)/errorCode=null. snapshot/compiled deep copy. 생성 endpoint HTTP는 provider submit을 호출하지 않는다. 선택 adapter가 deps.adapters에 없으면 UNSUPPORTED로 거부한다.
- tickWorker(owner): lease 60초, tick마다 획득/갱신. 다른 owner면 processedRunId=null. 하나의 active run만 처리, 없으면 null. worker loop는 2초 간격, SIGINT/SIGTERM에 다음 tick 중단/lease 해제/DB close.
- draft: submitting commit 후 upload+submit 최대 30초. 외부 작업 동안 10초마다 lease 갱신; lease 상실하면 새 부수효과 금지. provider 응답 ID를 얻으면 즉시 DB 기록. adapter가 SubmissionError(certainty="rejected")를 던진 경우만 failed. SubmissionError("unknown")와 분류되지 않은 모든 exception은 submissionFailureState에 따라 submission_unknown. timeout/network/응답 파싱 불명확은 항상 unknown. 클라이언트 submit 자동 retry 설정을 명시적으로 0으로 설정하거나 retry 없는 transport 사용.
- expired 이전 worker의 submitting을 인수하면 request ID 없을 경우 submission_unknown; 절대로 다시 submit하지 않는다. 늦게 도착한 응답도 원래 worker의 lease 소유권과 CAS를 확인한다. 보장은 exactly-once가 아니라 **불명확 제출 시 중단**이다.
- queued/running: poll만. 일시 network/429/5xx는 상태 유지+errorCode=PROVIDER_POLL, 다음 tick에 재조회. provider FAILED만 failed. running에서 provider queued로 돌아오는 응답은 무시. completed면 downloading commit.
- downloading: adapter.download (최대 30초) → output count=compiled num_images, decoded MIME/size/픽셀 제한, live 결과 크기는 요청과 일치해야 함. mock만 명시적 1×1 fixture 예외. blob 저장 후 전체 Media/Candidate insert + run succeeded atomic. unique(run,index)는 replay 중복 방지. 파일 실패/결과 shape 불일치는 download_failed, 생성 재요청 금지.
- retryDownload는 download_failed→downloading만. resolveRun의 attach(requestId)는 submission_unknown→queued만, abandon(reason)은 submission_unknown 또는 download_failed→failed, errorCode=`ABANDONED:<reason>`(최대1000자, 비밀 입력 금지). abandon은 provider 취소/환급이 아니며 UI에 안내한다.
- 실제 비용은 provider가 제공하지 않으면 계속 unknown. 완료 기록에는 updatedAt 최종 시각. UI latency 정의=완료 updatedAt-createdAt(대기 포함).

## fal

- createFalAdapter(id,key,transport?)→ModelAdapter, buildFalInput(compiled,referenceUrls)→FalInput. transport 주입 테스트는 network 없이 실행. default transport(2026-10-26 승인된 구성): **submit은 SDK를 우회해 공식 Queue REST(`POST https://queue.fal.run/<endpoint>`, `Authorization: Key`)를 서버 fetch로 호출당 POST 1회, `redirect:"error"`, 30초 timeout으로 직접 호출**한다(@fal-ai/client 1.10.1의 queue.submit은 요청별 retry 설정이 client retry 설정을 덮어써 재시도 0을 보장할 수 없음). 429·5xx·timeout·연결 단절·응답 파싱 실패·request_id 누락은 SubmissionError("unknown"). upload/status/result는 instance-scoped SDK client(`createFalClient`, retry 0 설정)를 사용하고 전역 fal.config는 공유하지 않는다. 오류 본문과 인증 header는 로그에 남기지 않는다. queue submit 전 upload/입력 실패는 명확하게 미제출이므로 SubmissionError("rejected"); queue 응답의 400/401/403/404/422처럼 명백한 거부만 rejected로 분류한다. 그 외 timeout/5xx/파싱 오류는 unknown. SDK 자체 자동 retry는 금지한다.
- submit: adapter/endpoint 일치, refs 길이/bytes mapping 검사→각 ref 업로드→반환 URL을 native input에 순서대로 바인딩→queue.submit 딱 1회. public Compiled에는 stable media IDs, 임시 upload URL은 메모리에서만. 실제 native field mapping은 buildFalInput 테스트가 보호한다.
- edit image_urls 1..4, text image_urls 없음. mask/negative_prompt/LoRA/controlnet 필드 없음. seed null 생략, 안전 검사 true. published endpoint schema 변경은 blocker.
- poll은 IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED를 queued/running/completed/failed로 정규화. transport.result는 queue.result의 data만 반환한다. download는 queue.result→FalOutput schema validate→이미지 fetch→bytes, MIME png, returned seed 기록. has_nsfw_concepts에 true가 있으면 PROVIDER 오류로 후보 승인을 만들지 않는다.
- URL fetch: HTTPS만, localhost/private/link-local/reserved IP 금지, DNS 모든 주소와 redirect 매번 검증(최대3), 30초 timeout, streamed 10MiB limit. 임의 URL 다운로드 API를 제공하지 않는다. SDK 저장소 업로드 반환 주소와 결과 주소의 원문을 logs/export에 남기지 않는다.
- official schema 참조 및 검증일은 `docs/model-support-matrix.md`. live smoke는 기본 검증 밖이며 사용자 요청 때만.

## review

- saveReview(candidateId,ReviewInput)→Review: 후보 존재 확인, edit이면 preservation 필수, 원본이면 preservation=null. 평가는 append-only, 최신 createdAt/id 평가가 현재 판정. `approved`는 사람 선택; threshold 미달이어도 기록 가능하나 passesReview=false로 표시.
- getCandidate→candidate+reviews(시간순). 원본 이미지/metadata 변경 없음.
- refineCandidate(candidateId,PreviewInput minus parentCandidateId)→Preview: parent를 URL에서 설정하고 createPreview를 사용한다. 생성/과금하지 않는다. 반환 preview를 일반 submit으로 실행한다. 부모→자식 관계는 resulting candidate.parentCandidateId와 run.snapshot.edit로 표현하며 별도 Revision 테이블을 만들지 않는다.
- UI /review?candidateId=...: 원본/자식 비교, ratings, 보존 지시, 전체 편집 경고. 마스크 미지원 시 생성 버튼을 차단하고 명시적 제거를 요구한다.

## effects

- saveEffects(candidateId,EffectsInput)→Effects: same-project overlay media, source image 불변. 첫 저장 expectedRevision=0, 새 record revision=0. 이후 expected=current, 새 revision+1. client는 저장된 content.expectedRevision이 아니라 Effects.revision을 다음 요청 expectedRevision에 넣는다. layer zIndex tie는 배열 순서. getEffects missing candidate→404, 후보 있으나 효과 없음→null.
- 기준 좌표는 후보 이미지 실제 pixel. x/y는 scale/rotate 후 overlay bounding box의 왼쪽 위, rotation clockwise degrees about own center. transform 후 canvas 경계 clip. source-over만. sRGB RGBA로 합성.
- base에 brightness multiplier→contrast 선형(c,128*(1-c))→saturation multiplier→blur 순서, 이후 overlay 낮은 z부터. blur=0 skip, 0<blur<0.3은 sigma0.3. alpha 보존. crop/resize base 없음.
- 합성은 application이 아니라 `ImageCompositor` 포트(`Dependencies.imageCompositor`, `composite({base, adjustments, overlays:[{bytes, layer}]})→{PNG bytes,width,height}`)가 담당한다(application의 sharp import 금지 유지, 2026-10-26 승인). 포트 주석에 위 순서·좌표·clip 규칙과 "identity+overlay 없음은 base 픽셀 그대로"를 고정한다. overlay 정렬(zIndex, tie는 배열 순서)은 service가 한다. sharp 구현은 `src/infrastructure/images/compositor.ts`.
- exportCandidate→ExportRecord: 효과 미저장 시 identity defaults, sharp PNG 생성/새 media(source export), Manifest 검증/JSON blob, ExportRecord commit. base SHA 변하면 실패. PNG는 /api/media/:pngMediaId, JSON은 /api/exports/:id/manifest로 다운로드.
- Manifest v1은 full project workspace snapshot(이번 export record 및 PNG media를 삽입하기 **직전**, 기존 exports는 포함), 모든 workspace media의 stable path/hash와 파일 목록. JSON+PNG 두 다운로드이며 zip/import는 범위 밖. manifest의 나머지 참조 파일은 로컬 data/blobs에 유지되며 **두 파일만으로 다른 컴퓨터에서 프로젝트 복원 가능하다고 표시하지 않는다**. 이동 가능한 전체 bundle은 후속 기능.
- workspace/manifest는 schema allowlist로 serialize; FAL_KEY, 환경변수, request headers, provider URLs, 절대 path 금지. snapshot에 입력 텍스트는 그대로 포함하므로 사용자가 직접 prompt에 쓴 텍스트를 자동 비밀 탐지한다고 주장하지 않는다.
- side effects: blob write + DB, 원본은 읽기만. 누락 파일/깨진 이미지→STORAGE, 부분 export DB commit 금지.

## experiments

- createExperiment(projectId,3 unique sceneIds,repeats=3)→Experiment. same-project 실제 scenes, sceneRevisions에 생성 시 각 scene.revision을 고정하고 runIds=[] 생성만. 자동 API 호출/18개 즉시 예약 금지. 현재 active cap에 맞춰 UI가 preview/동의/submit을 각 결과마다 반복한다.
- T11에서는 experiment의 계획 슬롯 순서(scene 입력 순서 × [fal-flux2-edit,fal-flux2-text] × repeat0..2)를 UI에서 표시한다. seed=repeat, outputCount=1 고정; 각 슬롯은 해당 scene/adapter/seed 조합으로 식별한다. run 연결을 위해 `attachExperimentRun(deps,experimentId,runId)`가 필요하며 이 함수는 아래 공개 계약 코드에 포함한다. 중복 attach는 no-op, 다른 scene/adapter/seed, outputCount!=1, edit run 또는 이미 채워진 슬롯은 CONFLICT. mock은 연습으로 연결할 수 없고 별도 데모만.
- reportExperiment: 연결된 run의 candidates를 전체 표본으로 사용. 각 후보 최신 review와 passesReview가 accepted 판정, total=후보 수. acceptanceRate accepted/total, total0→null. costPerAccepted accepted0→unknown(reason `no-accepted-results`); 하나라도 run actual unknown→unknown(reason `incomplete-billing`), 그렇지 않으면 actual sum/accepted를 microUSD로 반올림. estimated 결과를 actual로 바꾸지 않는다. medianLatency는 succeeded run의 updatedAt-createdAt, 없으면 null.
- input task intent는 각 scene마다 첫 preview snapshot과 동일해야 함, reference/text params 차이는 기록한다. scene 수정 후 기존 experiment에 attach 금지(experiment.sceneRevisions와 snapshot.sceneRevision 비교). 실제 품질 결론은 사람에게 맡긴다.

## HTTP 경로와 ownership

아래 route.ts는 각각 `src/app/api/<경로>/route.ts`. dynamic id는 params Promise를 await 후 UUID 검증. 입력/출력은 같은 이름의 service 계약을 따른다. 모든 API Node runtime, cache no-store(immutable media 제외).

| method/path | service / task |
|---|---|
| GET/POST projects | listProjects/createProject / T03 |
| GET projects/:id | getProject / T03 |
| GET projects/:id/workspace | getWorkspace / T03 |
| POST media/upload, GET media/:id | uploadMedia/readMedia / T02 |
| POST styles, POST styles/:id/approve | createStyle/approveStyle / T03 |
| POST assets, POST assets/:id/approve | createAsset/approveAsset / T03 |
| POST scenes, GET/PATCH scenes/:id, POST scenes/:id/duplicate | scene service / T04 |
| GET models | registry DTO / T07 then wiring T12 |
| POST generations/preview | createPreview / T05 |
| POST generations, GET generations/:id | submitRun/getRun / T06 |
| POST generations/:id/resolve, POST generations/:id/retry-download | run recovery / T06 |
| GET candidates/:id, POST candidates/:id/review, POST candidates/:id/refine | review service / T08 |
| GET/PUT candidates/:id/effects | effects service / T09 |
| POST exports, GET exports/:id/manifest | export / T09 |
| POST experiments, GET experiments/:id, POST experiments/:id/runs | experiment / T11 |
| POST demo, GET health | implemented skeleton; T12 health updates readiness |

## UI 공통 (T10 통합)

projectId/sceneId/candidateId는 URL query로 선택하고 reload 후 복원한다. 본문 데이터는 DB에서 읽는다. loading/error/empty/ready를 구분한다. 미선택 mutation은 disabled, 501은 미구현으로 표시한다. preview/비용 동의/지원 제약/버전 표시와 polling 종료(terminal 또는 화면 이동)는 필수다. UI 스타일은 위임하되 상태 의미는 바꾸지 않는다.

## Config / worker / HTTP infrastructure

configは明示的env引数をparse。APP_DATA_DIR default ./data、GENERATION_PROVIDER mock|fal、FAL_KEYはfalで必須。import時env読取/DB open禁止。containerはlazy singletonを返し、worker用factoryはNext server-only markerをimportしない。workerはprovider modeとDB pathを表示してよいがkey/URLは表示しない。shutdownでleaseとDBを閉じる。

공통HTTP実装済み: streamed JSON cap, same-origin, safe errors.ライブラリ例外は各infrastructure boundaryでAppErrorへ変換する。DTOをルートから返す前に契約schemaでserialize/validateする。ダウンロード以外のHTTP応答にfs pathを公開しない。

HTTP origin 비교는 Next의 정규화된 URL hostname 대신 직접 Host header를 사용한다. 먼저 localhost/127.0.0.1/[::1]만 허용하고 origin의 scheme/host/port를 비교한다. proxy forwarded header는 신뢰하지 않는다. origin 없는 CLI도 non-local Host는 거부한다.

GET /api/models 반환은 `ModelInfo[]` schema로 고정한다. id/provider/endpoint/available/mode/scope/maxReferences/masks/reason을 모두 반환한다. T07 구현 후 fal adapter는 GENERATION_PROVIDER=fal 및 유효한 FAL_KEY 설정일 때만 available=true, 나머지는 reason=NOT_CONFIGURED. T12가 조립할 mock adapter는 product mode에서도 사용 가능하므로 T07에서 mock scope를 product로 갱신한다. scope는 데이터 생성 지원 범위이며 서버 업무 서비스의 준비 여부는 health.stage와 별개다.
