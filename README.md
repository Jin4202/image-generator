# AI Art Direction Studio

로컬 1인용 이미지 작업실입니다. 승인된 캐릭터·스타일 버전과 장면(참조, 스케치, 레이아웃)을 저장하고, 정확한 요청과 비용을 확인·동의한 뒤에만 생성하며, 평가·수정본·효과·PNG+manifest 내보내기와 3장면 비교 실험까지 모든 이력을 보존합니다.

구현은 contract-first 설계와 task T01–T12로 완료되었습니다. 진행 기록과 검증 결과는 [docs/tasks/status.md](docs/tasks/status.md)에 있습니다.

## 실행

```sh
npm ci
npm run db:migrate
npm run dev
```

다른 터미널에서 같은 환경변수로 worker를 실행합니다(생성 제출·polling·다운로드는 worker만 합니다).

```sh
npm run worker
```

[로컬 화면](http://127.0.0.1:3000)의 "프로젝트 시작"에서 시작합니다. 화면 상단의 준비 상태가 "준비됨"이어야 합니다. migration 전에는 `/api/health`가 503과 `npm run db:migrate` 안내를 반환합니다.

- 기본 provider는 `mock`입니다. mock 결과는 1×1 테스트 이미지이며 품질 평가용이 아닙니다.
- 데이터: `APP_DATA_DIR`(기본 `./data`)에 `studio.sqlite`와 `blobs/`가 저장됩니다. migration은 자동으로 실행되지 않습니다.
- Next.js는 `.env.local`을 읽지만 worker/CLI는 자동으로 읽지 않습니다. `APP_DATA_DIR`, `GENERATION_PROVIDER`, `FAL_KEY`를 shell 환경변수로 두 프로세스에 똑같이 전달하세요. API 키를 명령 인수나 Git, `NEXT_PUBLIC_` 변수에 넣지 않습니다.
- worker는 SIGINT/SIGTERM에서 진행 중인 단계를 마치고 lease를 해제한 뒤 DB를 닫습니다. 비정상 종료 후 다른 worker는 lease 만료(60초) 뒤에 이어받습니다.

### 실제 생성 (fal, 유료)

`GENERATION_PROVIDER=fal`과 `FAL_KEY`를 Next와 worker 모두에 설정하면 `fal-flux2-edit`(참조 경로)와 `fal-flux2-text`(텍스트 기준선)가 활성화됩니다. 가격은 확인되지 않은 상태(unknown)로 표시되며, 요청마다 "가격을 알 수 없음"에 명시적으로 동의해야 제출됩니다. 프로젝트 예산을 설정하면 가격 미확인 요청은 차단됩니다. 제출은 자동 재시도하지 않으며, 응답이 불명확하면 `submission_unknown`으로 멈추고 request ID 연결 또는 추적 중단을 사용자가 선택합니다. 이 저장소에서는 실제 fal 호출을 검증하지 않았습니다([모델 지원 표](docs/model-support-matrix.md)).

## 검증

```sh
npm run verify               # task inventory, 모듈 경계, lint, typecheck, unit/contract/integration, production build
npx playwright install chromium
npm run test:e2e             # production stack(E2E 전용 임시 DB + worker + next start)에서 smoke
npm run test:acceptance      # task별 acceptance (임시 DB, 실제 worker 프로세스 포함, mock만)
npm run test:e2e:acceptance  # 화면 흐름 (T10/T11은 page.route mock, T12는 실제 stack 전체 흐름)
```

E2E는 `scripts/e2e-stack.ts`가 임시 `APP_DATA_DIR`를 만들고 migration·build 후 worker와 `next start`를 띄우며, 종료 시 두 프로세스를 정리하고 임시 디렉터리를 삭제합니다. 기본 `./data` DB는 사용하지 않습니다. 모든 기본 검증은 mock으로 실행되며 모델 품질이나 실제 청구를 증명하지 않습니다.

## 문서

1. [AGENTS.md](AGENTS.md) — 구현 규칙. Claude는 [CLAUDE.md](CLAUDE.md)에서 참조합니다.
2. [아키텍처](docs/architecture.md), [행동 계약](docs/contracts.md), [ADR](docs/decisions/)
3. [작업 목록](docs/tasks/README.md), [진행 기록](docs/tasks/status.md), [결정·blocker 기록](docs/blockers.md)

Node 버전은 `.nvmrc`, dependency 버전은 `package-lock.json`. Next.js(webpack), SQLite(better-sqlite3 + Drizzle), Zod, sharp, Konva, @fal-ai/client(업로드·조회만, 유료 submit은 재시도 없는 직접 Queue REST 호출).
