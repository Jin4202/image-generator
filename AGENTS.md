# AI Art Direction Studio — implementation rules

이 저장소는 contract-first hollow architecture다. 구현 작업은 `docs/tasks/Txx.md` 하나를 지정받아 수행한다.

## 시작 순서
1. `docs/architecture.md`, `docs/contracts.md`, 담당 task 문서, 관련 ADR을 읽는다.
2. `docs/tasks/README.md`에서 선행 작업의 완료 여부를 확인한다. 완료 증거가 없으면 선행 기능을 가정하지 않는다.
3. 해당 acceptance 테스트를 먼저 실행하여 현재 실패와 구현할 동작을 확인한다.
4. 지정 파일 안에서 구현하고 정상/오류/경계 테스트를 추가한다. 테스트 실행 결과를 `docs/tasks/status.md`에 기록한다.

## 고정 규칙
- `src/contracts/`, `src/application/ports.ts`, 공개 함수 signature, HTTP 경로/상태/응답 envelope, migration baseline, 상태 전이 및 ADR은 승인 없이 변경하지 않는다.
- task가 명시적으로 허용한 wiring 및 stub 교체는 계약 변경이 아니다. 로컬 helper, CSS, 컴포넌트 분리는 지정 소유 폴더 안에서 결정 가능하다.
- UI → HTTP → application → ports; infrastructure가 ports를 구현한다. domain/application에서 Next.js, DB, 파일, fal SDK를 import하지 않는다.
- 미구현 기능은 `NotImplementedError(taskId)`를 유지한다. 빈 배열/임의 이미지/성공 응답으로 대체하지 않는다. mock은 mock으로 표시한다.
- DB transaction은 동기적이다. transaction 내부의 network/await/file I/O 금지. 외부 API는 worker에서만 제출한다.
- 승인 버전·media·preview·candidate·run snapshot을 덮어쓰지 않는다. 기존 migration을 편집하지 않는다.
- 유료 요청 자동 재제출 금지. unknown 제출은 reconciliation 없이 재시도하지 않는다.
- 기본 검증에서 실제 fal 호출 금지. live 검증은 사용자가 명시적으로 요청한 경우만 수행하고 비용/입력을 먼저 표시한다.
- API 키, 절대 로컬 경로, provider 임시 URL을 client/manifest/log에 내보내지 않는다.
- 새 dependency/추상 계층/아키텍처 변경은 근거와 영향이 필요하다. 관련 없는 모듈 수정 금지.
- 기존 테스트를 약화/삭제/skip하여 통과시키지 않는다. `tests/acceptance`는 대기 중인 실행 가능한 명세다. 담당 task 완료 시 해당 테스트가 실제로 통과해야 한다.
- `tests/integration/demo.test.ts`/`tests/e2e/demo.spec.ts`의 production 501 assertion과 `tests/e2e/setup.spec.ts`의 초기 M0/미구현 assertion은 T12에서만 실제 저장·조회·준비 상태 assertion으로 교체한다. mock demo의 truthful assertion과 새로고침/모바일 검증은 유지한다.

## 모호한 사항 처리
새 비즈니스 규칙을 만들지 않는다. `docs/blockers.md`에 task ID, 계약 충돌/빈 부분, 증거, 선택지와 추천을 기록하고 사용자/설계 담당자에게 질문한다. 독립적으로 진행 가능한 부분은 계속한다. 명시적으로 위임된 UI 간격·색·helper 이름 등은 질문하지 않는다.

## 검증과 handoff
- 공통: `npm run verify`, `npm run test:e2e`.
- 담당: task 문서의 acceptance 명령. 기능 완료는 공통 통과만으로 선언하지 않는다.
- 임시 DB와 파일을 테스트 종료 시 정리한다. `APP_DATA_DIR`는 테스트가 만든 임시 경로로 설정한다.
- 보고: 변경 파일, 완료한 계약, 실행 명령/결과, 미완료/차단 항목. mock 테스트를 모델 품질 평가로 표현하지 않는다.
- 현재 설계와 task가 과거 `docs/PLAN.md`/원본 기획보다 우선한다. 사용자 지시는 모든 저장소 지침보다 우선한다.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
