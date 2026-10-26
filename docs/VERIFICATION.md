# Verification record

2026-10-26 · Contract-first hollow architecture handoff.

## 현재 통과한 검증

- `npm run verify`: task inventory, dependency boundary 검사, ESLint, TypeScript, contract/unit/integration **30 tests / 7 files**, production build 통과.
- `npm run test:e2e`: Chromium **2 passed**. 초기 화면/reload/mobile overflow 및 실제 mock HTTP 흐름, production 501 확인.
- `npm run check:handoff`: **12 tasks**, 파일 존재/선행 DAG/stub 소유 task/파일 소유 충돌 없음.
- SQLite migration integration: 임시 DB에 2회 migration, FK/preview uniqueness 확인. 실제 repository CRUD는 아직 구현하지 않음.
- npm dependency 설치 최종 audit 요약: **0 vulnerabilities**. drizzle-kit은 사용하지 않아 제거하고 SQL migration runner를 사용함.

## 예상 실패 확인

- `npm run test:acceptance`: **11 files / 13 tests failed**, 원인은 T01/T05/T07 등의 NotImplementedError와 T12의 501≠200. 의도된 구현 대기 상태이며 숨기지 않음. 기본 verify에서는 제외.
- `tests/e2e-acceptance/T10.spec.ts`: 제품 생성 UI 대기 테스트. 파일/설정/타입 검증 완료, 아직 실행하지 않음. 현재 placeholder 화면에서는 실패해야 함.
- `npm run worker`: 현재 CLI stub, T12 NOT_IMPLEMENTED 종료 예정. 실제 worker 동작 검증을 주장하지 않음.

## 검증 중 발견·수정한 문제

- Next.js가 Request.url hostname을 localhost로 정규화하여 127.0.0.1 Origin이 거부됨. loopback Host 검증 후 same-origin 비교로 수정하고 회귀 테스트 2개 추가. 브라우저 재검증 통과.
- Vitest mergeConfig의 include 배열 병합으로 pending suite에 기본 tests가 섞임. 별도 include override로 분리, 13 pending failure만 집계됨.
- Mock output bytes는 sharp로 완전 디코딩 가능한 PNG fixture로 고정. 새 adapter 인스턴스에서도 request ID를 이용해 다운로드 가능함을 확인.
- submission rejection과 결과 불명확 오류를 구분할 타입이 필요해 SubmissionError.certainty 및 보수적인 상태 판정 helper를 계약에 추가.

## 미검증 / 미구현

T01–T12 업무 구현, 실제 fal endpoint 호출, API 비용, 생성 품질, production persistence/worker restart, 전체 사용자 흐름은 완료하지 않았다. 유료 API 호출0. pending 테스트를 모델 성능 증거로 해석하지 않는다.

향후 증거는 `docs/tasks/status.md`에 task별로 기록한다. architecture 문서의 current-state 설명은 이 시점의 snapshot이다.
