# Architecture handoff review

2026-10-26 · 설계자가 구현 에이전트 역할로 각 task의 입력/출력/의존성/검증 흐름을 따라가며 검토했다. 별도 에이전트가 구현했다는 의미는 아니다.

## 일관성 점검

- 공개 DTO는 Zod에서 타입을 추론하고 ports가 같은 타입을 사용한다. service signature와 route 연결이 존재한다.
- 12개 task의 소유 파일/선행 task/test 파일을 `check:handoff`가 확인한다. stub task ID와 소유 task도 일치해야 한다.
- 모듈 방향과 UI의 server import를 `check:boundaries`로 검사한다.
- migration runner의 재적용, SQLite FK, run preview uniqueness가 실행 테스트로 검증된다. repository 업무 정책은 T01에 남아 있다.
- 기본 테스트는 현재 구현된 기능만 검증한다. 구현 acceptance suite는 별도 설정에서 실제 실패하도록 실행된다. skip/todo로 성공을 꾸미지 않는다.
- 초기 UI + mock HTTP + provider protocol은 runnable. 프로덕션 업무 API/worker는 미구현을 명시한다.

## 구현자에게 남아 있었던 결정과 해결

| 질문 | 확정한 답 |
|---|---|
| long-running job을 어디서 실행하는가? | 별도 tsx worker, SQLite lease, HTTP는 draft만 생성 |
| 외부 submit 직후 crash는 어떻게 처리하는가? | submission_unknown, 자동 재제출 금지, 명시적 attach/abandon |
| queued에서 바로 완료되는 provider는? | queued→downloading 허용 |
| 다운로드 실패 때 작업 슬롯은? | download_failed가 유지; retry-download 또는 명시적 abandon |
| mock restart의 request ID는 유실되는가? | fixture 설정을 request ID에 인코딩, 새 adapter에서 복원 가능 |
| 비용을 모르면 0으로 계산하는가? | unknown 별도 타입, 명시 동의, finite budget에서는 차단 |
| ref가 모델 한도를 넘으면 어느 것을 버리는가? | 버리지 않고 차단, 사용자가 다시 선택 |
| 마스크가 없는데 수정 기능을 어떻게 제공하는가? | whole-image edit 경고, mask가 있으면 UNSUPPORTED |
| 승인 버전 수정은 patch인가? | 새 version 생성; approval만 1회 transition |
| scene 복사에 과거 runs를 복사하는가? | content deep copy만, 새 scene ID |
| 별도 Revision 테이블이 필요한가? | candidate parent + run snapshot.edit로 충분 |
| JSON 내부 FK는 누가 검사하는가? | service transaction, repository는 schema와 공통 컬럼 불변성 |
| 실험은 자동으로 18번 호출하는가? | 계획만 생성, 슬롯별 명시 preview/submit, attach API로 연결 |
| comparison repeat의 seed/count는? | seed0/1/2, outputCount1, 3scene×2route×3repeat |
| PNG+manifest만 다른 PC에 옮기면 복원 가능한가? | 아님. 전체 media bundle/import는 범위 밖, 로컬 blob 참조 유지 |
| Next와 worker가 env를 같은 방식으로 읽는가? | Next .env.local, CLI/worker shell env. 동일 경로를 사용하도록 README에 명시 |
| 제품 완성 후 초기 M0 화면과 테스트는? | T12가 root 화면/준비 상태 테스트/격리된 E2E 프로세스 실행기까지 소유 |
| task 파일 충돌은? | source 소유권 중복0, 공통 계약은 architect-owned, status/index만 공유 |

## 위임 가능한 로컬 구현 선택

CSS/간격/반응형 배치, 접근성 유지한 컴포넌트 구성, private helper 이름, parameterized SQL 작성 방식, fixture 추가, 한국어 오류 설명 문구. 공개 DTO/오류 코드/응답 상태/파일 경계/불변성/과금 정책을 바꾸는 선택은 위임하지 않는다.

## 명시적인 한계

- 모델의 실제 시각 품질/지연/청구 비용은 검증하지 않았다. user-authorized live pilot은 구현 뒤 수행한다.
- 계약 schema와 1×1 mock fixture는 작품 생성 기능이 아니다.
- 현재 pending acceptance 파일은 각 task의 최소 실행 명세다. task에 열거한 추가 경계/실패 테스트도 구현자가 작성해야 한다. 테스트를 확장할 여지는 남기되 비즈니스 정책은 contracts에 고정했다.
- T07의 외부 API schema 확인은 시간에 따라 달라지는 사실 검증이다. 변경이 있으면 blocker를 올리고 계약을 재설계하지 않는다.
- 가격 계산기, portable project archive, 외부 배포/인증, LoRA/ControlNet/video는 이번 계약 범위 밖이다.

## 다음 세션 시작점

T01 문서와 acceptance test부터 시작한다. 의존 task가 끝나기 전 후속 service의 동작을 mock 성공으로 대신하지 않는다. T12까지 완료해야 제품 구현 완료로 판단하며, 그 뒤 사람 품질 평가가 별도 남는다.
