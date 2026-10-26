# 이전 제품 계획 (참고)

> 구현 설계와 작업 ID는 [architecture.md](architecture.md), [contracts.md](contracts.md), [tasks/README.md](tasks/README.md)가 대체합니다. 아래 M0–M7은 제품 milestone 참고이며 현재 실행 task는 T01–T12입니다.

# 구현 계획과 완료 기준

기준일: 2026-10-26 (America/Los_Angeles). 원본: [참고 기획서](source-prototype-plan.md).
원본은 설계 참고 자료이며, 모든 기능을 이번 작업에서 구현하라는 지시로 취급하지 않는다.

## 1. 구체적인 목표

**대상:** 로컬에서 애니메이션풍 캐릭터 일러스트를 반복 제작하는 1인 사용자.
**문제:** 프롬프트만 바꾸며 생성하면 캐릭터·스타일·구도가 흔들리고, 어떤 입력이 좋은 결과를 만들었는지 추적하기 어렵다.
**가설:** 스타일, 캐릭터, 구도 입력을 분리하고 승인 버전과 생성 이력을 보존하면, 승인 가능한 결과를 얻는 시도 수와 비용을 줄일 수 있다.

### 첫 목표: 하나의 수직 흐름 (M1–M5)

Wind Duel 프로젝트에서 캐릭터/스타일/스케치 각 1장과 장면 설명을 저장한다. 요청을 확인하고 이미지 1장을 생성한다. 평가 후 한 차례 수정하고 원본과 수정본을 함께 유지한다. PNG와 manifest를 내보내고 서버 재시작 후 같은 이력을 다시 연다. 소스 코드 수정 없이 UI로 완료해야 한다.

### MVP 목표 (M6–M7)

동일한 승인 캐릭터·스타일로 서로 다른 구도 3개를 제작한다. reference 경로와 text baseline 경로를 비교한다. 정체성≥4, 스타일≥4, 구도≥4, 해부학≥3 (각 5점), 최종 사용자 승인을 모두 충족하는 결과가 각 구도에 최소 1개 있어야 한다. 수정본은 추가로 비대상 영역 보존≥4를 요구한다. 모델이 기준에 못 미치면 앱 완료와 별도로 **제품 가설 미검증/실패**를 기록한다.

초기 제외: LoRA 학습, ControlNet 전처리, 3D/스켈레톤, 영상, 협업, 결제, 클라우드 배포. 먼저 실패 사례를 모은 뒤 추가 범위를 판단한다.

## 2. 구현 순서

아래 항목은 각각 별도 작업 단위다. `[ ]`는 미구현이며 테스트 계획을 적었다고 완료 처리하지 않는다. 각 작업은 정상·실패 사례와 검증 증거를 함께 남긴다.

| ID | 구현 단위 / 예정 파일 | 의존성 | 합격 기준 및 실패 사례 | 검증 |
|---|---|---|---|---|
| M0 | 개발 환경, 초기 화면, 테스트 실행기 | 없음 | 앱 실행/타입/린트/빌드/브라우저 smoke 성공 | 현재 구현 |
| M1a | SQLite 연결·migration, `src/lib/persistence/` | M0 | 새 DB에 migration 적용, 프로젝트 생성·조회; 빈 제목 거부 | integration: 임시 DB |
| M1b | 프로젝트 UI/API, `src/app/projects/`, `src/app/api/projects/` | M1a | UI 생성 후 재실행해 같은 ID/제목 복원; 없는 ID는 404 | integration + E2E |
| M1c | 파일 저장·조회, `src/lib/media/`, `src/app/api/media/` | M1a | PNG/JPEG/WebP의 실제 디코딩·크기 검사, hash·stable ID 저장; 위장 MIME/경로 탈출/초과 용량 거부 | integration + E2E |
| M2a | 장면 폼과 참조 역할 저장, `src/app/scenes/` | M1b,c | 캐릭터/스타일/스케치 역할과 prompt 저장·복원; 빈 prompt 거부 | integration + E2E |
| M2b | adapter 계약·compiler·preview, `src/lib/models/`, `src/lib/planning/` | M2a | 실제 요청, 참조 순서, 누락 제약, 가격 unknown 표시; 참조 초과는 차단하고 선택 요구 | unit + API |
| M2c | 결정적인 mock adapter와 후보 UI | M2b | 외부 호출 없이 성공/실패/지연 상태, 로컬 fixture 결과 표시; mock 배지 표시 | integration + E2E |
| M3a | fal schema 검증과 서버 adapter | M2c | endpoint별 schema/확인일 기록, 키 서버 격리, submit/poll/normalize; 미지원 mask 명시 | API mock + opt-in live |
| M3b | durable run 상태·복구·중복 방지 | M3a | provider ID 영속화, 재시작 poll 복구, 중복 클릭 단일 submit; submit 응답 유실은 unknown으로 중단 | integration fault injection |
| M3c | 결과 로컬 복사·이력 UI | M3b | provider URL 없이 결과 재열람, 깨진/만료 결과는 복구 가능한 오류; 성공 상태는 파일 저장 후에만 | integration + E2E |
| M4a | 평가·승인, `src/app/review/` | M3c | 1–5 범위 검증, 평가 재열람, 사용자 승인 보존 | unit + E2E |
| M4b | child revision·부모 비교 | M4a | 수정 후 부모 이미지 hash/입력 불변; mask 미지원 경로는 전체 편집 안내 | integration + E2E + 사람 평가 |
| M5a | PNG overlay·위치·투명도·회전 | M4b | 원본 hash 불변, layer JSON 복원, 고정 fixture 합성 결과 일치 | integration + E2E |
| M5b | PNG + manifest export | M5a | 파일·입력 snapshot·부모 연결 포함, 키/비밀 URL 제외; 누락 파일은 명시적 실패 | integration + E2E |
| M6a | Style DNA/asset 승인 버전 | M5b | 승인본 수정은 새 버전; 과거 run snapshot 불변, 미승인 기본 사용 금지 | integration + E2E |
| M6b | sketch pen/eraser·box editor | M6a | PNG+normalized layout 복원, 범위 밖 box 거부 | unit + E2E |
| M7a | text baseline adapter·실험 그룹 | M6b | 같은 task snapshot, 경로별 실제 요청 보존, baseline 참조 제외 표시 | unit + integration |
| M7b | 3구도 실험·요약 보고서 | M7a | 품질/승인율/시도 수/지연/비용 보고, 미측정은 unknown | 아래 실험 프로토콜 |

진행 체크: M0 완료 (검증 기록 참조). M1a–M7b는 모두 미착수.
다음 작업: **M1a → M1b → M1c**, 그 후 API를 붙이기 전에 M2 mock 흐름 완성.

## 3. 아키텍처 결정

- Next.js App Router + TypeScript + Tailwind: UI/서버를 한 저장소에서 운영. 현 lockfile이 설치 버전의 기준.
- SQLite + Drizzle을 M1에서 도입. 로컬 `data/`에 DB/원본/결과 파일을 보관하고 migration을 버전 관리. 브라우저 localStorage는 원본 저장소로 사용하지 않는다.
- Vitest: 순수 로직·API·임시 DB integration. Playwright: 브라우저 흐름. 실제 모델 호출은 기본 테스트에서 제외.
- Canvas는 M6에서 react-konva 도입. 첫 흐름은 스케치 업로드로 검증한다.
- 서버 모듈은 `server-only` 경계 사용 예정. FAL_KEY를 client props, logs, DB snapshot, export에 포함하지 않는다.
- 모델 후보명·참조 한도·비용은 원본의 수치를 그대로 확정하지 않는다. M3에서 공식 endpoint schema를 검증하고 support matrix를 만든다. 이번 셋업에는 fal SDK/유료 호출이 없다.
- 기본 1 output / 1 active run, 2–4 variants는 명시 선택. 상한/가격/미지원 제약을 preview에서 확인한다. unknown 가격은 0원이 아니다.
- Preview는 후반이 아니라 M2의 필수 항목. Preview와 submit은 동일 immutable snapshot/hash를 사용하고 입력 변경 시 재생성한다.

### 저장 계약

Project → Scene → GenerationRun → Candidate → Review/Revision/EffectLayer.
StyleDNAVersion / AssetVersion / MediaFile은 stable ID로 연결한다.
Run은 scene snapshot, style/asset version IDs, 역할별 reference 순서, 실제 endpoint/params, parent ID, provider request ID, 시간, 예상/실제 비용 및 통화·출처를 보존한다.
미디어 파일은 상대 저장 경로와 SHA-256을 기록한다. 승인본과 부모 candidate는 덮어쓰지 않는다.

### 상태 전이와 결제 경계

`draft → submitting → queued → running → downloading → succeeded`.
실패 상태: `failed`, 제출 결과를 알 수 없는 경우 `submission_unknown`.
로컬 run과 중복 방지 키를 먼저 저장하고 submit한다. 응답을 받으면 provider ID를 즉시 저장한다. submitting 중 프로세스가 죽어 provider ID를 모르면 자동 재제출하지 않는다. provider 조회/사람의 확인을 거쳐 명시적으로 새 run을 만든다. 다운로드 재시도는 생성 재제출과 분리한다.

## 4. 테스트와 완료 판정

공통 Definition of Done:
1. 작업표의 UI 행동과 오류 사례가 구현됨.
2. 관련 unit/integration/E2E 통과. 준비되지 않은 테스트를 pass 처리하지 않음.
3. `npm run verify` 및 관련 브라우저 테스트 성공.
4. 재시작 후 persistence를 검증; 페이지 새로고침만으로 DB 복구 테스트를 대체하지 않음.
5. `docs/VERIFICATION.md`에 실제 명령/결과/미검증 항목 기록.
6. 시각 품질은 자동 테스트 성공과 분리하여 사람 승인 필요.

예정 테스트 파일과 명령 (각 파일은 해당 작업에서 생성):

| 범위 | 파일 | 명령 |
|---|---|---|
| 저장·업로드 | `tests/integration/storage.test.ts` | `npm run test:unit -- tests/integration/storage.test.ts` |
| 참조·지원 제약 | `tests/unit/compiler.test.ts` | `npm run test:unit -- tests/unit/compiler.test.ts` |
| 복구·중복·timeout | `tests/integration/runs.test.ts` | `npm run test:unit -- tests/integration/runs.test.ts` |
| 불변 버전·수정 | `tests/integration/lineage.test.ts` | `npm run test:unit -- tests/integration/lineage.test.ts` |
| 전체 mock 흐름 | `tests/e2e/workflow.spec.ts` | `npm run test:e2e -- tests/e2e/workflow.spec.ts` |
| 현재 초기 화면 | `tests/e2e/setup.spec.ts` | `npm run test:e2e` |

업로드 한도는 M1 기본 제안: 10 MiB/파일, 16 MP/이미지, PNG/JPEG/WebP, SVG 제외. 수치는 모델 지원 크기와 별개이며 테스트로 경계를 검증한다.

## 5. 제품 가설 검증 프로토콜

고정 캐릭터 1개, 스타일 1개, 구도 3개(정면 전신 / 저각도 액션 / 측면 원경)를 사용한다. 각 구도에 reference 경로와 text baseline을 각각 3회 실행: 총 18개 후보. 시작 전에 실제 endpoint 가격으로 batch 예산을 정하고 사용자 선택으로 실행한다. 가격을 모르면 unknown을 표시하고 임의의 예산을 가정하지 않는다.

가능하면 모델명을 숨겨 평가한다. task intent/크기/불변 특성을 고정하되 경로별 실제 요청 차이를 기록한다. 정체성·스타일·구도·해부학을 따로 평가한다. 최소 승인 결과를 각 구도에서 1개 확보하고, 선택한 결과 하나의 얼굴/무기만 수정해 보존 점수를 추가한다. 효과 합성과 재시작은 별도 공학 테스트로 검증한다.

보고 항목: 합격률(합격/전체), 승인 결과당 시도 수, 성공 latency 중앙값, 경로별 비용 합계/승인 수, 실패/unknown 비율. 승인 0개이면 승인당 비용은 N/A, 누락 비용은 unknown. 예상 비용과 청구 실제 비용을 혼합하지 않는다. 작은 표본이므로 통계적 우월성을 주장하지 않는다.

원본 E01–E08은 M7 이후 확장 실험으로 보존한다. 18개 pilot은 그 전체를 대체하거나 완료했다고 주장하지 않는다. baseline보다 개선되지 않으면 참조 역할/품질/모델 한도를 먼저 분석한 뒤 ControlNet/LoRA 도입을 결정한다.
