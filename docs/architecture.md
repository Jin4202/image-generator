# Contract-first hollow architecture

설계 버전 1 · 2026-10-26. 이 문서는 기존 PLAN의 기술 설계 및 작업 순서를 구체화하여 대체한다. 원본의 제품 가설/사람 평가 목표는 유지한다.

## 범위와 현재 상태

대상은 로컬 단일 사용자, 단일 Next 서버와 단일 worker, SQLite 한 개다. 프로젝트 → 수동 Style DNA/캐릭터 승인 → 장면/스케치 → 요청 preview → 생성/평가 → child revision → 효과/PNG+manifest → 3구도 비교까지 계약을 정의한다.

**이미 구현:** 입력 schema/오류 envelope, 상태 전이, 품질 임계값 판정, config parsing, migration 실행기/초기 SQL, 모듈 의존성 검사, 명시적 mock adapter/데모, 초기 UI, 계약·인프라 smoke 테스트.
**hollow:** repository 동작, blob storage, 업무 service, 실제 fal adapter, worker loop, 제품 UI, export/experiment. 함수는 NOT_IMPLEMENTED로 실패한다. migration이 실제로 동작한다고 제품 persistence가 구현된 것은 아니다.

## 모듈과 의존 방향

```text
src/contracts/               외부 DTO, schema, entity, limits (Zod only)
src/domain/                  순수 상태 전이, 평가, AppError
src/application/ports.ts     DB/blob/image-inspect/image-composite/model/time/id 의존성 계약
src/application/services/    업무 정책과 orchestration
src/application/compiler.ts  순수 모델 요청 컴파일
src/infrastructure/          SQLite, local files, mock/fal 구현
src/server/                  HTTP/config/composition root, demo
src/worker/                  독립 작업 실행 프로세스
src/app/api/                 얇은 검증/응답 wrapper
src/app/{feature}/           제품 화면; 서버 파일 접근 금지
src/components/canvas/      client-only Konva UI
```

UI는 contracts 타입과 HTTP만 사용한다. application은 ports를 통해 I/O한다. infrastructure가 application ports를 구현한다. server/worker composition root만 구체 구현을 조립한다. 역방향 import는 `npm run check:boundaries`에서 차단한다. 테스트는 포트를 대체할 수 있다.

## 기술 스택 (고정)

| 분야 | 선택 | 이유 |
|---|---|---|
| UI/API | Next.js App Router, React, TS, Tailwind | 단일 저장소/Node runtime |
| 검증 | Zod, strict input objects | frontend/backend 타입 공유, 알 수 없는 입력 차단 |
| 데이터 | SQLite, better-sqlite3, Drizzle ORM | 로컬 transaction, 낮은 운영 복잡도 |
| migration | 번호 붙은 SQL + checksum runner | 생성 도구 없이 검토/재실행 가능 |
| binary/effects | 로컬 content-addressed 파일, sharp | 불변 원본, 실제 디코딩/출력 검증 |
| canvas | Konva/react-konva | client-only pen/box/mask/layer 편집 |
| 모델 | fal Queue REST(submit, 직접 fetch·재시도 0) + @fal-ai/client instance(upload/status/result) | server credential / submit·poll 분리, 유료 submit 자동 재시도 금지 |
| worker | 별도 tsx Node 프로세스 | 웹 요청 수명과 독립, Redis 없이 시작 |
| 테스트 | Vitest, Playwright Chromium | pure/API/SQLite/browser 검증 분리 |

실제 버전은 package-lock.json. Webpack은 현재 환경의 Turbopack port 제약 때문에 유지한다. Redis, 외부 queue, 인증 서비스, 클라우드 storage, training/LoRA/3D/video는 범위 밖이다. Drizzle-kit은 사용하지 않는다.

## 저장 모델

`projects`와 종류별 JSON aggregate 테이블을 사용한다. 공통 컬럼: id, project_id(projects 제외), revision, body. Zod가 body 구조를 검증하고 Drizzle가 타입을 연결한다. 프로젝트 body의 projectId는 자신의 id와 같아야 한다. FK는 project scope 및 run/preview/candidate의 주요 관계를 보강한다. JSON 내부 참조는 service에서 같은 transaction 안에 검증한다.

JSON aggregate를 선택한 이유는 prototype의 style/layout 구조가 복잡하고 SQL 분석은 아직 불필요하기 때문이다. 대가로 service 검증이 필수다. 정체성/중복 방지 컬럼은 별도로 인덱스화한다: style/asset(project, logicalId, version), run(project,idempotencyKey) 및 previewId, candidate(run,index), effects(candidate). mapper는 body와 이 컬럼을 반드시 함께 기록한다. 모든 record는 revision=0으로 시작한다.

SQLite: FK ON, WAL, busy_timeout=5000. explicit migration 먼저, openRepository는 schema 미설치 시 STORAGE 오류. `replace`는 expectedRevision CAS + exactly +1, root id/projectId/createdAt 고정. media/previews/candidates/reviews/exports는 append-only. style/asset는 approval만 최초 1회 변경 가능. run에서 snapshot/compiled/previewId/idempotencyKey는 불변. scene/effects는 CAS 변경 허용. project title/budget는 현재 변경 API 없음.

파일 경로는 `blobs/<sha256>.<extension>`, manifest도 JSON blob이다. DB와 파일을 하나의 transaction으로 묶지 않는다. 임시 파일→atomic rename→DB commit 순서; DB 실패로 남은 orphan blob은 허용하며 자동 삭제는 이번 범위 밖이다. 비어 있는 `data/`와 `db/migrations/`를 혼동하지 않는다.

## 생성 데이터 흐름

1. createPreview: scene/media/승인 style·asset 읽기 → snapshot 고정 → compile → canonical SHA-256 → 15분 expiry 저장.
2. submitRun: preview/hash/expiry/현재 scene revision/비용 확인 → transaction 내 replay 검사·전역 active cap 확인 → draft run 생성. HTTP는 provider에 제출하지 않는다.
3. worker: lease 확보 → draft를 submitting으로 commit → 참조 파일 읽기/upload → POST 직전 동기 권한 재검사(lease·run revision, T13) → provider submit 1회 → request ID와 queued commit. deadline/lease 상실은 같은 취소 신호로 이후 upload·POST를 막는다.
4. queued/running은 poll만, completed이면 downloading을 먼저 commit → download/검증/파일 저장 → candidate/미디어와 succeeded를 한 DB transaction에 commit.
5. 원본을 선택해 refine preview 생성 → 일반 submit 흐름 사용. 부모 후보/이전 run은 변경하지 않는다.
6. effects JSON 저장 → sharp로 deterministic export → PNG와 versioned manifest.

```text
draft -> submitting -> queued -> running -> downloading -> succeeded
                       \--------------------> downloading
submitting -> submission_unknown -> queued (명시적 request ID 연결)
                                  -> failed (명시적 abandon)
downloading -> download_failed -> downloading (명시적 다운로드 재시도)
```

허용된 실패 전이는 `src/domain/run-state.ts`가 기준. terminal 상태를 다시 submitting으로 바꾸지 않는다. worker의 lease/타임아웃 세부 정책은 contracts의 runs 절을 따른다.

## 실행 모드

- 현재: `npm run dev` → `/`에서 Mock 계약 실행. 외부 통신·DB·생성 없음, 1×1 fixture 응답, persisted=false. 실제 제품 경로는 501.
- T12 이후: `npm run db:migrate`, `npm run dev`, 별도 터미널 `npm run worker`. mock 기본. restart 테스트는 두 프로세스를 재시작한다.
- fal 모드: GENERATION_PROVIDER=fal + FAL_KEY. 모델 목록에서 구현/설정 상태를 표시한다. 실제 호출은 사용자 선택으로만.
- mock adapter는 결과/상태 순서가 결정적이며 request ID만 고유하다. request ID에 fixture 설정을 인코딩해 worker restart 후 복구 가능하다. 재시작 후 poll이 queued부터 시작할 수 있으므로 run 상태는 뒤로 이동시키지 않는다.

## 보안·운영 경계

127.0.0.1에만 listen. 브라우저 mutation은 same-origin; origin 없는 CLI/테스트 요청은 허용한다. 원격 공개 배포용 인증/CSRF 시스템이 아니며 공개 배포는 범위 밖이다. JSON 64KiB, upload 10MiB/16MP, 파일 실제 디코딩, path confinement를 고정한다. provider 응답 URL은 외부 입력으로 보고 HTTPS와 public IP 검증, redirect마다 재검증한다. 가격 unknown은 0이 아니다. fal 키는 env 또는 `APP_DATA_DIR/settings/settings.json`(평문, 0600/0700, T16)에만 있고 server/worker 프로세스 메모리 밖으로 나가지 않는다. 설정 변경은 서버와 worker 재시작 후 적용된다([ADR 005](decisions/005-local-provider-settings.md)).

## 설계 고정 / 위임

고정: 공개 DTO/signature, DB 저장 계약, 상태 전이, API 경로, refs 순서, 버전 불변성, cost 동의, worker 제출 규칙, 검증 gate.
위임: CSS/간격, 접근성 유지한 레이아웃, 파일 소유 범위 내 private helper, 오류 설명 문구(코드/상태 불변), 내부 SQL 구성 및 쿼리 최적화.
모델 schema가 바뀌어 기존 계약을 지킬 수 없으면 blocker로 등록한다. 구현자가 임의로 모델이나 요청 필드를 바꾸지 않는다.
