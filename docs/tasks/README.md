# Implementation task index

작업 순서는 아래 DAG를 따른다. 업무 코드 구현은 별도 세션에서 한다. T01–T12는 완료되었으며 실제 증거는 [status.md](status.md)를 따른다. 후속 작업 T13–T18은 [후속 구현 계획](follow-up-plan.md)에 따라 구현되었다(증거는 status.md).

```text
T01 → T02 → T03 → T04 → T05 → T06 → T08 → T09 → T10
                           └→ T07 ───────┐
T03 + T06 + T07 + T08 ────────────────→ T11
T01..T11 ─────────────────────────────→ T12
```

| Task | 목적 | 문서 |
| T01 | SQLite repository와 CAS/lease 구현 | [T01](T01.md) |
| T02 | 이미지 파일 저장과 업로드 경계 | [T02](T02.md) |
| T03 | 프로젝트와 승인 라이브러리 service | [T03](T03.md) |
| T04 | 장면 저장과 canvas 계약 | [T04](T04.md) |
| T05 | 순수 compiler와 immutable preview | [T05](T05.md) |
| T06 | 영속 생성 orchestration과 worker loop | [T06](T06.md) |
| T07 | fal boundary와 native payload adapter | [T07](T07.md) |
| T08 | 사람 평가와 child revision | [T08](T08.md) |
| T09 | 효과와 PNG/manifest export | [T09](T09.md) |
| T10 | 제품 UI와 API client 통합 | [T10](T10.md) |
| T11 | 실험 계획과 비교 보고 | [T11](T11.md) |
| T12 | composition root 연결과 전체 handoff 검증 | [T12](T12.md) |

## 후속 작업

[검토 수정 및 사용성 개선 계획](follow-up-plan.md): T13 늦은 제출 방지, T14 스케치 복원, T15 export 무결성, T16 fal 키 입력, T17 프로젝트 편집/삭제, T18 에셋 표기. 세부 범위와 테스트 예정 경로는 각 작업 문서를 따른다.

## 다음 세션용 지시 예시

> AGENTS.md와 docs/tasks/T01.md를 읽고 T01만 구현해줘. 고정 계약과 파일 소유 범위를 지키고, 해당 acceptance 테스트 및 공통 verify 결과를 docs/tasks/status.md에 기록해줘. 공개 계약을 변경해야 하면 blocker를 먼저 보고해줘.

완료한 suite는 매번 명시적으로 실행한다. 마지막 T12 전까지 default verify는 pending suite를 포함하지 않는다. 모든 기능 완료 gate는 `test:acceptance` + `test:e2e:acceptance`도 전부 green이어야 한다.

`index.json`은 task/file/test inventory의 기계 판독본이다. 소유 범위 겹침은 현재 없음; shared contracts와 schema는 architect-owned. 공통 status.md 업데이트만 공유한다. T12의 임시501 및 초기 M0/미구현 assertion 교체는 사전에 승인된 유일한 baseline assertion 변경이다.
