# 그래보드 개발 안내

SheetClone 일회성 변환 명령은 최신 앱이 아닌 **고정 전체 커밋 `7fec065d1adc241da29d54474af06b390d12d72b`의 별도 checkout**에서 실행합니다. 개발 전환은 완료했으며 운영 전환은 전체 리팩토링 뒤에 수행합니다. 소스·lockfile·환경 파일·절대 데이터/Git 경로의 준비와 실행·재개는 [운영 안내](OPERATIONS.md#고정-전환-소스-준비)를 따릅니다.
[처음으로](../README.md) · [구성도](ARCHITECTURE.md) · [사용 안내](USER_GUIDE.md) · [운영 안내](OPERATIONS.md) · [데이터 형식](DATA_FORMAT.md) · [변경·검증 이력](DEVELOPMENT_HISTORY.md) · [프로젝트 작업 규칙](../AGENTS.md)

그래보드는 실제 운영 중입니다. 개발·테스트 환경은 운영 DB와 문서 이미지 경로를 분리하고, 기능 변경 시 기존 운영 데이터와 저장 형식의 호환성을 확인합니다. 이 문서는 현재 저장소의 구현을 설명하며 실제 서버에 배포된 커밋·Node.js·DB 버전은 배포 전에 별도로 확인합니다.

## 작업 원칙

- 코드 탐색은 `codebase-memory-mcp`를 우선 사용하며, 미인덱싱 저장소는 `index_repository`부터 실행합니다. `search_graph` → `trace_path` → `get_code_snippet` 순서로 심벌·실제 호출 관계·구현을 확인하고, 복잡한 관계는 `query_graph`, 전체 구조는 `get_architecture`로 살펴봅니다.
- 문자열·오류 메시지·설정값·비코드 파일은 `search_code` 또는 `rg`로 찾습니다. 그래프 도구를 사용할 수 없거나 결과가 부족할 때도 `rg`와 파일 읽기로 보완합니다.
- 기능 변경 전에 유사한 기존 기능의 호출 경로와 공통 컴포넌트·스타일·저장 로직·이벤트 처리를 확인합니다. 기존 명명·구조를 따르고 구현을 재사용하거나 확장·공통화합니다.
- 파일 추가·이동·폴더 분리·통합은 [코드 배치와 파일 명명 가이드](CODE_ORGANIZATION.md)를 따릅니다. 기능 접두어는 이동 후에도 유지하고, 가이드에 따른 책임·사용처 확인을 파일 재배치보다 먼저 수행합니다.
- 같은 사용자 동작은 버튼·폼·포커스·문구·알림·삭제·실행취소·저장 흐름까지 일관되게 제공합니다. 요청이나 실제 요구사항에 근거하지 않은 안내 메시지·아이콘·확인 단계를 추가하지 않습니다.
- 완료 전에 기준으로 삼은 기존 기능과 비교하여 불필요하게 달라진 부분이 없는지 확인합니다.

## 구조

`shared/`는 `calendar/`·`documents/`·`formatting/`·`http/`·`identity/`·`insights/`·`sheet-clones/`·`site/`·`storage/`·`sync/`·`transfer/`에 도메인 계약을 모읍니다. 루트의 domain·coreProperties·search·validation·date-validation 5개는 유지합니다. `http/link-title.mjs`의 Node 네트워크와 `transfer/workbook.mjs`의 Node crypto 의존을 브라우저 경계와 구분합니다.
Node와 외부 라우트는 문서·일정·업무·사본·인증/제어·이력·이관·이벤트/HTTP로 묶습니다. 공통 서비스는 `server/storage/` 기능 폴더에, SQLite repository는 같은 기능 폴더에, PostgreSQL repository는 `worker/storage/` 기능 폴더에 둡니다.

동기화는 `server/sync/core/` 17개(간접 전용 cache 포함)·`server/sync/node/` 20개·`worker/sync/` 11개로 배치합니다. 외부 direct import는 portable 16개와 공통 서비스/규칙 14개에 한정하며 background Worker·Git/자격 증명/SQLite 경계를 유지합니다.

`scripts/`는 `admin/`·`deploy/`·`performance/`·`sync/`·`testing/`·`transfer/`로 실행 목적을 구분하고 루트 `licenses.mjs`와 `team-site-deploy.mjs`를 유지합니다. 후자는 팀 Fork의 workflow 정의와 동기화 후 checkout SHA가 다른 버전이어도 호출할 수 있는 고정 CLI입니다. P7은 32개 이동과 이 정확한 경로 보존으로 완료했습니다. npm 명령은 같은 저장소 루트의 환경·데이터 경로를 사용합니다.

배포 suite는 고정 `7fec065d1adc241da29d54474af06b390d12d72b`의 workflow·CLI를 Git에서 읽어 구·신 버전 4개 조합을 실행합니다. shallow clone에 해당 커밋이 없으면 `git fetch origin 7fec065d1adc241da29d54474af06b390d12d72b`로 준비하며 구조 CI는 `fetch-depth: 0`을 사용하고 이 배포 회귀도 함께 실행합니다.

`tests/`는 기능별 Node 검사와 `sync/protocol/`·`sync/transport/`·`sync/recovery/`·`sync/integration/`으로 분류하고 공통 fixture/helper·수동 Deno probe는 `support/`에 둡니다. 브라우저 검사는 `browser/`의 기능 폴더에서 수집하며 `browser/support/`와 기존 `browser/fixtures/`는 실행 suite가 아닙니다. Node 재귀 수집기는 123개, Playwright는 46개 spec·각 엔진 676건을 수집합니다. 원본 전환 16건은 고정 전체 소스에서 별도 실행합니다.

아래는 현재 구현 경로입니다. 기능별 하위 디렉토리의 목표 배치와 지속적인 명명·유지보수 규칙은 [코드 배치 가이드](CODE_ORGANIZATION.md)에 있습니다. 실제 파일을 이동한 변경에서 이 표의 경로도 함께 갱신합니다.

외부 런타임은 `edge/main.mjs`(Supabase/Deno) → `edge/handler.mjs` → 기존 `worker/entry.mjs`의 API·repository를 재사용합니다. `worker/gateway.mjs`는 Cloudflare에서 HTTP 전달·정적 파일·R2/Images binding을 담당합니다. `scripts/deploy/build-edge.mjs`가 공통 모듈과 고정 버전 npm import를 묶습니다. `tests/site/edge-gateway.test.mjs`는 실제 workerd 전달/자원 경계를, `tests/site/team-site.test.mjs`는 Pages → gateway → Edge handler → PostgreSQL 및 내부 SQLite/Git 흐름을 확인합니다. Deno 호환성은 생성 함수의 실행과 실제 Supabase 배포로 별도 확인합니다.

| 경로                                                                                                                                                                                                                                                    | 역할                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app/`, `src/auth/`, `src/sheet/`, `src/settings/`, `src/sync/`                                                                                                                                                                                     | 앱 조합·인증·업무 표·설정·Git 동기화 UI를 기능별로 배치                                                                                                      |
| `src/main.tsx`, `app-version.d.ts`, `types.ts`, `Panels.tsx`, `styles.css`                                                                                                                                                                              | 루트 유지 5개: 진입점·선언·통합 타입·패널·전역 CSS                                                                                                           |
| `src/documents/`, `src/documents/editor/`                                                                                                                                                                                                               | 공용 문서 패널·브라우저·내보내기와 Milkdown 편집기 내부                                                                                                      |
| `src/calendar/`                                                                                                                                                                                                                                         | 일정·태그·주간 할 일·개인 일정의 UI·훅·타입·CSS                                                                                                              |
| `src/platform/`                                                                                                                                                                                                                                         | API·오류·사이트 환경·공통 조회 정책·SharedWorker SSE·리소스 구독 기반                                                                                        |
| `src/ui/`                                                                                                                                                                                                                                               | Select·색 선택·알림·도움말·공통 메뉴·포인터/모바일/목록 훅                                                                                                   |
| `src/app/App.tsx`                                                                                                                                                                                                                                       | 팀·연도·화면 조합, 선택·편집 UI와 업무 명령 연결; 조회·저장·필터·이력 상태는 sheet 훅이 소유                                                                 |
| `src/sheet/cell-sync.ts`, `cell-updates.js`                                                                                                                                                                                                             | SSE 연결·복구, 셀 버전 비교와 변경 병합                                                                                                                      |
| `src/sheet/PeriodPicker.tsx`                                                                                                                                                                                                                            | 2행 월·주차 표, 연속 드래그·키보드 범위 선택                                                                                                                 |
| `src/sheet/Grid.tsx`                                                                                                                                                                                                                                    | 가상 행, 범위 선택, 셀 편집, 텍스트 넘침, 행 드래그                                                                                                          |
| `src/sheet/InlineCellEditor.tsx`, `CellOptionPicker.tsx`                                                                                                                                                                                                | 셀 안의 텍스트·날짜·숫자 입력과 속성 선택                                                                                                                    |
| `src/sheet/Toolbar.tsx`, `FormatSelect.tsx`, `clipboard.ts`                                                                                                                                                                                             | 범위 서식, 현재 값 재적용, 서식을 포함한 복사·붙여넣기                                                                                                       |
| `src/settings/SettingsPanel.tsx`, `TeamSettings.tsx`, `UserAccounts.tsx`, `PropertiesManager.tsx`, `DefaultStyleManager.tsx`                                                                                                                            | 설정 화면: 팀·구성원·사용자 계정·속성·기본 서식                                                                                                              |
| `src/documents/TaskDocumentPanel.tsx`, `src/documents/TaskDocumentEditor.tsx`, `src/documents/editor/RichMarkdownEditor.tsx`, `src/documents/editor/DocumentToggle.ts`, `src/documents/editor/DocumentSlashMenu.tsx`, `src/documents/task-document.css` | 문서 지연 로딩·자동 저장·초안 복구, Milkdown 리치/원문 편집, 토글 블록·`/` 메뉴                                                                              |
| `src/documents/document-export.ts`, `DocumentToolMenu.tsx`                                                                                                                                                                                              | 문서 다운로드(PDF 인쇄 창·Markdown·HTML), 툴바 메뉴                                                                                                          |
| `src/documents/document-links.ts`, `src/documents/editor/DocumentLinkNode.ts`, `DocumentLinkPanel.tsx`, `CopyDocumentLinkButton.tsx`, `shared/documents/document-links.js`                                                                              | 문서 간 링크 형식·복사, 아이콘과 현재 제목 표시, 상세·메모 열기와 링크 주소로 열기                                                                           |
| `server/storage/documents/sqlite-document-links.mjs`, `worker/storage/documents/postgres-document-links.mjs`                                                                                                                                            | 링크한 대상의 현재 제목 조회(`GET /api/document-links`)                                                                                                      |
| `server/documents/task-documents.mjs`, `server/documents/document-storage.mjs`, `shared/documents/task-documents.js`                                                                                                                                    | 문서 권한·revision·공유 버전·참조 정리·크기·존재 표시                                                                                                        |
| `server/documents/document-images.mjs`                                                                                                                                                                                                                  | 문서 이미지 변환·저장·권한·백업 참조                                                                                                                         |
| `src/documents/AnnualMemoPanel.tsx`, `server/storage/documents/document-service.mjs`, `server/documents/memo-storage.mjs`                                                                                                                               | 원본·사본 연간 메모, 본문 공유와 독립 편집                                                                                                                   |
| `src/calendar/Calendar.tsx`, `server/calendar/calendar.mjs`, `shared/calendar/calendar-layout.js`                                                                                                                                                       | 개인·팀 공용 일정, 주간 할 일, 카드 배치와 기간 이동                                                                                                         |
| `src/calendar/CalendarTags.tsx`, `shared/calendar/calendar-tags.js`                                                                                                                                                                                     | 개인·공용 태그와 체크 상태                                                                                                                                   |
| `src/sheet/SheetTabs.tsx`, `useSheetCloneDraft.ts`                                                                                                                                                                                                      | 원본·사본 하단 탭, 자동 저장 큐·실행취소·재시도                                                                                                              |
| `src/Panels.tsx`, `src/auth/Auth.tsx`, `SessionLogin.tsx`, `src/ui/Modal.tsx`                                                                                                                                                                           | 업무 상세·이관·반출 패널, 인증 진입·재인증, 공용 dialog의 독립된 소유 모듈                                                                                   |
| `src/sheet/TaskPropertyEditor.tsx`                                                                                                                                                                                                                      | 상세 팝업 내부 속성 편집·셀 버전 보존·저장 재시도                                                                                                            |
| `shared/domain.js`, `coreProperties.js`                                                                                                                                                                                                                 | 날짜·주차, 필터·정렬·통계, 기본·예시 속성 양식과 설정 정규화                                                                                                 |
| `shared/formatting/fonts.js`, `themes.js`                                                                                                                                                                                                               | 지원 글꼴·크기·폴백과 팀 테마 변수                                                                                                                           |
| `server/app.mjs`                                                                                                                                                                                                                                        | 인증·권한, 업무·보기·스냅샷·관리 API 연결                                                                                                                    |
| `shared/formatting/compact.js`                                                                                                                                                                                                                          | 짧은 서식 키, 문서별 공통 서식 사전, 기본 서식 차이 정규화                                                                                                   |
| `shared/sheet-clones/sheet-clone-sync-data.js`                                                                                                                                                                                                          | 동기화·외부 저장의 사본 `data`를 저장과 같은 공유 사전 형태로 직렬화·해제, 형식 무관 내용 비교                                                               |
| `shared/formatting/formatting.js`, `src/sheet/format-selection.js`, `server/sheet/formatting.mjs`                                                                                                                                                       | 행·열 규칙 생성, 속성별 우선순위, 셀 예외, 공통 서식 저장·실행취소                                                                                           |
| `server/db.mjs`, `validation.mjs`                                                                                                                                                                                                                       | SQLite 초기화, 저장 모델과 입력 검증                                                                                                                         |
| `server/sheet/filters.mjs`                                                                                                                                                                                                                              | 연도와 독립적인 공용·개인 필터와 현재 선택, 권한 검사                                                                                                        |
| `server/control/settings.mjs`, `server/storage/tasks/task-command-rules.mjs`, `server/storage/tasks/sqlite-task-commands.mjs`, `worker/storage/tasks/postgres-task-commands.mjs`, `server/control/team-deletion.mjs`                                    | 설정 변환, 공통 업무 명령 검증과 엔진별 원자적 변경, 팀 삭제                                                                                                 |
| `server/transfer/transfer.mjs`, `archive.mjs`                                                                                                                                                                                                           | XLSX 분석·이관·반출과 압축 파일 제한 검사                                                                                                                    |
| `server/sheet/task-cache.mjs`                                                                                                                                                                                                                           | 팀 조회 캐시와 변경 무효화                                                                                                                                   |
| `server/history/system-audit.mjs`, `src/settings/SystemAuditLog.tsx`                                                                                                                                                                                    | 관리자 전용 공통 감사 로그 검색·페이지 이동·상세 조회                                                                                                        |
| `server/events/document-events.mjs`, `resource-events.mjs`, `src/platform/useResourceSync.ts`                                                                                                                                                           | 문서 스냅샷과 시트·문서 목록 변경 알림, 권한 재검사·연결 공유                                                                                                |
| `server/events/cell-events.mjs`                                                                                                                                                                                                                         | 팀·연도별 SSE 전송, 제한된 재전송 버퍼와 연결 권한 검사                                                                                                      |
| `server/events/event-streams.mjs`, `src/platform/event-stream.ts`, `event-stream.worker.ts`, `event-stream-broker.ts`                                                                                                                                   | 여러 탭의 SSE 연결 공유·중복 구독 병합·탭별 알림 전달·커서 복구                                                                                              |
| `server/sheet/cell-operations.mjs`                                                                                                                                                                                                                      | 셀 이력과 재시도 참조 저장, 기본키 조회로 최초 응답 재구성                                                                                                   |
| `edge/main.mjs`, `edge/handler.mjs`, `edge/resources.mjs`                                                                                                                                                                                               | Deno 진입점·PG pool·gateway 인증·R2/Images 어댑터                                                                                                            |
| `worker/entry.mjs`, `worker/events/events.mjs`, `worker/control/site-auth.mjs`, `worker/sync/sync.mjs`                                                                                                                                                  | Edge에서 재사용하는 업무 API·SSE·계정 연결·Git 동기화                                                                                                        |
| `worker/gateway.mjs`, `worker/forwarder.mjs`, `functions/[[path]].js`                                                                                                                                                                                   | Cloudflare 진입·정적 파일·이미지 자원·기존 binding 전달                                                                                                      |
| `wrangler.gateway.jsonc`, `wrangler.forwarder.jsonc`, `supabase/config.toml`                                                                                                                                                                            | 현재 외부 실행 환경별 배포 설정                                                                                                                              |
| `scripts/`                                                                                                                                                                                                                                              | 백업·복구·비밀번호 재설정·성능 확인·라이선스 고지                                                                                                            |
| `.github/workflows/team-site-release.yml`                                                                                                                                                                                                               | 팀 Fork의 원본 `release` 동기화와 외부 화면(gateway)·API(Edge) 자동 배포. `TEAM_SITE_CONFIG`가 비어 있지 않거나 기존 `TEAM_SITE_DEPLOY`가 `enabled`이면 실행 |
| `tests/`                                                                                                                                                                                                                                                | API·권한·동시 수정·이관·백업·브라우저 검증                                                                                                                   |

프런트엔드는 React·TypeScript·Vite를 사용합니다. 기본 내부 API는 Express·Node 내장 SQLite이고, 외부 API는 Supabase Edge·PostgreSQL입니다. `worker/`의 공통 업무 코드가 Cloudflare에서 실행된다는 뜻은 아닙니다. 행 가상화는 `@tanstack/react-virtual`, 파일 변환은 ExcelJS를 사용합니다.

## 개발 실행

Node.js **22.13.0 이상**이 필요합니다(`package.json`의 `engines.node`). Node.js 16에서는 현재 실행 옵션과 내장 SQLite를 사용할 수 없습니다. 다른 서비스의 Node.js와 충돌하는 경우 프로젝트 실행 셸·서비스에 별도의 지원 버전 경로를 지정합니다.

개발·검증 재현 기준은 **Node.js 22.23.1**입니다. 지원 최소 버전과 실제 검증 버전을 구분하고 `node --version`·`npm --version`을 검증 기록에 남깁니다. 동일 의존성에서 22.17.1의 Playwright 수집이 `Unexpected module status 3`으로 실패하고 22.23.1에서는 정상 수집된 사례가 있으므로, 수집 단계 오류는 먼저 실행 셸의 Node 버전과 설치 상태를 확인합니다. 테스트 skip이나 전역 사전 로딩으로 우회하지 않습니다.

```sh
npm ci --include=dev
npm run dev
```

Vite는 `5173`, API는 `4310` 포트를 사용합니다. 개발 프록시는 `/api`를 로컬 API로 전달합니다. 기본 포트를 변경할 때는 `vite.config.ts`도 함께 확인합니다. `.env`의 적용 방식은 [운영 안내](OPERATIONS.md#환경-설정)를 따릅니다.

개발용 `.env`를 만들 때는 `.env.example`을 참고하고 `DB_PATH`와 `DOCUMENT_IMAGES_DIR`가 개발 전용 경로인지 확인합니다. 이미 있는 `.env`는 덮어쓰지 않습니다. 예시 계정과 업무는 비어 있는 개발 DB의 최초 설정에서 선택하여 생성할 수 있습니다. 실제 운영 파일을 테스트 픽스처로 사용하지 않습니다.

| 명령            | 실행 내용                                                                     |
| --------------- | ----------------------------------------------------------------------------- |
| `npm run dev`   | API의 파일 변경 감시와 Vite 개발 서버를 함께 실행                             |
| `npm run build` | TypeScript 검사와 프런트엔드 배포 빌드. 결과는 `dist/`                        |
| `npm run start` | Node API 서버 실행. API와 준비된 `dist/`를 함께 제공하며 빌드는 수행하지 않음 |

운영은 빌드한 프런트엔드와 서버 소스·런타임 의존성을 함께 배포합니다. `dist/`만으로는 인증·업무 저장·문서·캘린더 API가 동작하지 않습니다. `start`가 `NODE_ENV=production`을 자동 설정하지 않으므로 운영 `.env` 또는 서비스 환경에서 지정합니다. 기존 운영 환경의 업데이트는 [운영 안내](OPERATIONS.md)의 절차를 따릅니다.

로컬 브라우저 테스트는 `npm run build` 후 `node scripts/testing/e2e-server.mjs`로 실행합니다. 기본 주소는 `http://127.0.0.1:4311`이며, 기본 테스트 계정은 **`test@somansa.com` / `1234`**입니다. 이 계정은 테스트 전용 임시 DB에 생성되며 서버 종료 시 테스트 데이터가 삭제됩니다. 다른 포트는 `E2E_PORT`로 지정합니다.

## 운영 데이터에 영향을 주는 변경

DB 스키마·영속 데이터 형식·기존 데이터 일괄 변환·백업 호환성을 변경할 때는 [데이터베이스 변경 지침](DATABASE_CHANGES.md)을 먼저 읽고, 명시적 사용자 승인과 해당 문서의 구현·검증·배포 절차를 따릅니다. 현재 저장 구조와 지원 버전은 [데이터 형식](DATA_FORMAT.md#버전과-운영-호환성)에서 확인합니다.

## 주요 처리 흐름

### 조회와 개인 보기

로그인 세션은 기존 `sessions.expires_at`와 HTTP-only·SameSite=Strict 쿠키를 이용해 30일 유지합니다. 유효한 인증 요청에서 하루에 한 번만 갱신하여 매 요청의 DB 쓰기와 Set-Cookie를 피합니다. 로그아웃·비밀번호 변경은 자체 삭제·재발급 경로를 사용하며 만료·비활성 계정은 갱신하지 않습니다. DB 버전·형식은 변경하지 않습니다.

로그인 후 `/api/bootstrap`에서 소속 팀·사용자를 읽고 사용자·팀·기준 연도별 보기를 복원한 다음, `startMonth`부터 12개월에 해당하는 업무를 조회합니다. `getTasks`는 한 연도 또는 인접한 두 연도를 받아 SQL의 EXISTS 조건으로 중복 없이 업무를 읽습니다. 화면의 기준 연도는 업무 추가·삽입의 등록 연도입니다. 업무 응답은 ETag로 조건부 조회합니다. 팀·연도가 바뀌면 이전 요청 결과가 새 화면을 덮어쓰지 않도록 조회 대상을 검사합니다. 셀 값 저장은 SSE로 즉시 전달합니다. 행 추가·삭제·순서·공통 서식·설정과 사본 시트 변경은 리소스 SSE 알림으로 재조회합니다. 원본의 보완 조회는 내부망 7초·외부망 30초로 구분하며, 편집·저장 중에는 전체 목록 교체를 보류합니다. SSE 셀 갱신은 편집 중에도 처리합니다. 같은 범위·변경 버전의 동시 목록 갱신은 하나로 합치고, 429는 Retry-After와 증가하는 재시도 간격을 지킵니다. 업무·화면 정보 재조회가 성공하면 해당 조회 오류만 해제하며 저장·보기 저장·다른 작업의 오류는 보존합니다. 명시적인 내부 사이트 설정은 Access 인증 모드보다 우선합니다.

원본 조회가 세션 만료(401)로 재시도 대기에 들어간 경우, 같은 조회 범위의 셀 복구 스냅샷을 인증된 요청으로 받으면 `useTaskData`가 그 대기와 조회 오류를 해제합니다. 재인증 뒤 새 행의 리소스 알림이 이전 세션의 대기에 막히지 않도록 하기 위한 처리이며, 429의 Retry-After와 다른 오류의 재시도 정책은 유지합니다.

브라우저에서 공유 strict 스키마를 불러오기 전에 `main.tsx`의 첫 `platform/polyfills.ts`가 Zod를 `jitless`로 설정합니다. 잡아서 무시하는 eval 기능 확인도 strict CSP의 위반 이벤트가 되므로, 브라우저는 같은 스키마를 인터프리터로 실행합니다. CSP에 unsafe-eval을 추가하지 않고 Node/Edge의 스키마 실행 정책도 바꾸지 않습니다. 초기 진입·편집 검증·저장·새로고침과 기존 Mermaid의 CSP 회귀를 실제 브라우저에서 확인합니다.

변경되지 않은 ETag 요청은 업무를 조회·직렬화하기 전에 304로 응답합니다. 조회 캐시의 전체 예산은 64MiB입니다. 원문과 gzip의 합이 예산보다 크면 gzip만 보관하고, 압축을 받지 않는 클라이언트의 응답 시에만 원문을 복원합니다. 압축본도 예산을 넘으면 캐시하지 않습니다. 이전 팀의 보기 저장이 뒤늦게 실패해도 현재 팀 화면에 오류를 표시하지 않습니다.

팀·연도 전환과 월 이동·월·주차 기간 선택은 왼쪽 업무 열에서 시작합니다. 달력은 항상 12개월이며 화살표는 한 달씩 이동합니다. `movePeriodView`는 월 선택을 실제 연월로, 주차 선택을 날짜로 유지하고 구간 경계에서만 선택 길이를 보존해 이동합니다. 연도 화살표의 전체 연도 초기화와 구분하며 원본·사본에 같은 규칙을 적용합니다. `taskQuery`는 같은 두 연도에 걸친 월들을 같은 요청 경로로 정규화하므로 월 이동마다 데이터를 재조회하지 않습니다. 보기의 저장 키와 업무 조회 범위를 분리하고, 늦은 조회 응답과 SSE가 다른 범위를 덮어쓰지 않도록 검사합니다. 기간 표는 포인터 캡처로 월/주 단위의 연속 범위를 선택하고 드래그를 마칠 때 보기를 저장합니다. 기존 보기 설정 모달은 제거했으며 열 고정은 머리글 메뉴, 팀 기본 셀 높이는 기본 서식 관리에 있습니다. 연도·기간 바, 서식 툴바와 팝업 제목 옆 `?` 도움말은 즉시 툴팁을 공유합니다. 팝업 소개 문구는 `Modal`의 `help`로 전달하며, 마우스 호버나 키보드 포커스로 확인합니다. 기본 서식과 표는 `Toolbar`를 공유하고, 서식 선택·테두리 팝업은 모달 안에서 열리면 해당 dialog를 portal 대상으로 사용합니다. 발표 모드는 현재 보기와 위치를 유지하며 종료하면 화면 위치를 복원합니다.

필터 목록과 현재 조건·선택은 팀을 열 때 `/api/filters?teamId=…`에서 읽고, 연도 전환 때 다시 읽거나 초기화하지 않습니다. 표 배치의 `views`와 별도로 연도 컬럼이 없는 `saved_filters`, `filter_states`에 저장합니다. `/api/filters/current`는 본인의 현재 상태만 저장하며, 공용·개인 정의 변경은 `/api/filters/:id`에서 권한을 검사합니다. 팀원이 공용 조건을 바꾸면 개인의 현재 조건으로 분리합니다. 스냅샷과 UI에서만 배치·조건을 하나의 View로 합칩니다.

필터 신규 저장·같은 이름 저장이 완료되면 갱신한 목록에서 이름과 공개 범위가 일치하는 필터를 찾아 바로 선택·적용합니다. 목록에서 선택할 때도 `applySavedFilter`로 같은 조건·선택 저장 경로를 사용합니다. 목록에서 필터를 선택할 때는 `Grid`의 기존 `jump`를 통해 렌더링 후 세로 스크롤을 0으로 이동하고 가로 위치는 유지합니다. 원본·사본과 같은 필터 재선택에 공통 적용하며, 저장 완료 경로는 `scrollToTop: false`로 현재 위치를 유지합니다. 사본에서 원본으로 돌아올 때의 위치 복원도 유지합니다. 이름 변경만 할 때는 현재 선택을 바꾸지 않습니다. 선택 상태는 필터 보기 표시줄과 목록 항목의 `aria-pressed`에 반영하며 목록 오른쪽 체크 아이콘은 표시하지 않습니다.

### 셀 저장과 동시 수정

작업 완료 안내는 `src/ui/Toast.tsx`의 `Toast`·`useToast`를 사용합니다. 설정·비밀번호·이력 정리·사본 이름 모달 안에서 렌더링하여 열린 dialog 위에 표시하며, 같은 문구를 다시 알려도 4초 표시 시간을 갱신합니다. 사본 표의 자동 저장 상태는 보조기기에 알리고, 저장 오류는 표 위에서 확인·재시도할 수 있습니다. 오류·입력 검증과 현재 진행 상태는 해당 화면에서 유지합니다.

`src/platform/api.ts`는 `shared/http/api-error-message.js`로 플랫폼 오류의 작업명·원인별 조치·HTTP 상태·제공된 요청 ID를 표시합니다. Supabase의 `sb-error-code`/JSON `code`, `Retry-After`를 읽으며 provider의 임의 `message`·HTML·SQL 원문은 표시하지 않습니다. 기존 앱 검증·권한·충돌 메시지와 `ApiError.details`는 보존합니다. 네트워크 실패와 잘못된 성공 응답 형식도 분류하며 호출자가 취소한 요청은 그대로 전달합니다. `tests/site/api-error-message.test.mjs`와 `tests/browser/platform/api-errors.spec.ts`는 429·실행 한도·인증·시간 초과·비정상 본문을 검사합니다.

기본 셀 툴바와 발표 도구는 `ZoomControls`의 50~200% 입력·증감·복원을 공유합니다. 확대는 `.grid-area`에만 적용하며 `Grid`의 행·열 크기 드래그는 포인터 이동량을 배율로 나눠 원래 치수에 반영합니다. 확대율은 화면 상태이며 업무 데이터와 View에 저장하지 않습니다. 발표 모드는 기본 배율을 초기값으로 받아 별도로 조절하고 종료 시 기본 배율을 복원합니다.

기간 밖 주차와 접힌 월을 포함한 현재 12개월 전체 열 순서로 숨김 구간을 계산합니다. 날짜 구간을 펼칠 때는 현재 보이는 주차와 펼칠 주차만 남기고 나머지를 `hiddenWeeks`로 표현하여 다른 구간의 숨김을 유지합니다. 달력의 선택 표시도 실제 표시 주차를 사용합니다.

서식 선택 범위와 테두리의 인접 셀은 필터를 통과한 전체 행(숨긴 행 포함)과 숨김 전 전체 열 순서로 계산합니다. 값 편집·복사·붙여넣기·행 이동은 보이는 셀 기준을 유지합니다.

`Toolbar`의 서식 복사는 `App`에 선택 범위의 표시 서식을 보관하고, `Grid`의 선택 드래그 종료 또는 Enter에서 적용합니다. 값은 보내지 않고 기존 `mutate`·`submitChanges` 경로로 셀 버전과 공통 서식 revision을 검사합니다. 한 셀의 서식을 행·열·전체에 적용할 때는 기존 공통 서식 scope를 사용하며 사본도 기존 저장·실행취소 경로를 공유합니다. 복사한 셀의 표시 서식을 재현하기 위해 공통 scope에도 기본 글꼴·크기 값을 명시하고, 없는 서식 속성은 null로 전달하여 대상에 남은 강조·배경색 등을 제거합니다. 대상 업무의 기본 서식으로 되돌리는 reset과 구분합니다. 단일 적용은 완료 후 해제하고 두 번 클릭한 연속 적용은 Esc·버튼 클릭·시트 전환으로 해제합니다. 서식 복사의 전역 Esc는 열린 dialog에 양보합니다. 그 외에는 이벤트 전파를 유지해 저장된 필터 메뉴도 닫히게 하며, Grid는 이미 처리된 Escape(`defaultPrevented`)나 서식 복사 중인 Escape에서 선택을 해제하지 않아 이벤트 도중 렌더링 시점에 영향을 받지 않습니다. 저장 중 추가 적용은 `submitChanges`와 같은 `rejectPendingChanges` 안내를 사용하고 복사 상태를 유지합니다. DB·저장 형식은 변경하지 않습니다.

주차 기본 경계선은 `settings.weekBorders`에 저장하며 `shared/formatting/borders.js`의 `weekBoundaryStyles`와 `withWeekBoundaries`로 실제 표시·반출 열의 첫 날짜와 마지막 날짜에 적용합니다. 같은 경계를 공유하는 두 셀을 함께 계산하며, 셀이나 행·열에 직접 지정한 선이 경계선보다 우선합니다. `null`·`none`이나 업무 기본 서식에서 상속된 선은 주차 경계선을 가리지 않습니다. 원본 셀 서식은 수정하지 않으며 그리드의 머리글·셀·텍스트 넘침 경계와 XLSX에서 같은 계산을 사용합니다. 셀 클립보드는 저장된 서식만 복사합니다.

이번 주 기본 좌우 테두리는 선택 설정 `settings.currentWeekBorders`를 같은 `weekBoundaryStyles` 계산에 전달합니다. 실제 표시·반출 열 중 한국 시간의 월요일 키에만 적용하며, 설정한 방향은 양 끝 경계선보다 우선합니다. 직접 지정한 셀·행·열·이웃 셀의 선은 기존 `withWeekBoundaries` 경로로 우선합니다. `Grid`와 `PeriodPicker`는 `useTodayKey`로 한국 시간 자정과 탭 복귀 시 날짜를 갱신하므로, 자동 조회가 없는 사본에서도 이번 주 표시가 이동합니다. 기존 `teams.settings` JSON에 선택 필드만 추가하며 SQLite v30·JSON v6, 셀·이력·사본의 기존 읽기 호환성을 유지하고 데이터 변환은 하지 않습니다.

`shared/formatting/compact.js`의 서식 사전을 HTTP 요청·응답, SSE, JSON 반출, 이력·스냅샷에 공통 적용합니다. DB는 `styles` 테이블을 `cells.style_id`·`tasks.default_style`·`tasks.row_style`·`format_rules.style_id`에서 참조합니다. 새 셀의 빈 내용과 불필요한 서식은 생략하되, 삭제·실행취소 후에도 기존 셀 버전은 유지합니다. `tests/formatting/compact-storage.test.mjs`는 실제 생성 API, 3,180셀 범위 저장, 공통 사전 크기, 서식 정리 후 이력 복원·재시도, 변경 없는 요청과 충돌, 잘못된 압축 참조를 검증합니다.

공통 서식의 범위 판정은 요청별로 행·열·제외 열을 `Set`으로 한 번 인덱싱하고 재사용합니다. 각 셀마다 선택 행 배열 전체를 다시 검색하지 않습니다.

압축 응답을 풀 때는 참조가 바뀌는 경로만 복제하며 원본 전송 데이터는 변경하지 않습니다.

셀 편집을 확정하면 `/api/cells/batch`로 `operationId`·최초 `createdAt`, 셀별 `expectedVersion`, 값 또는 서식을 보냅니다. 서버는 인증·팀 접근·업무 편집 권한·속성 종류를 확인하고 전체 변경을 한 트랜잭션으로 저장합니다.

한 셀이라도 버전이 다르면 409로 전체 작업을 취소합니다. 같은 사용자의 동일 작업 ID 재시도는 이전 성공 결과를 재사용합니다. 저장 실패 시 입력과 요청을 유지하고, 재적용 시 최신 버전을 확인합니다. 실행취소도 같은 버전 검사와 저장 경로를 사용합니다. 업무 추가 취소는 삭제 응답의 `updatedAt`을 보관하고 재실행할 때 서버에 보내며, 그 사이 다른 복구·수정·삭제가 있으면 실제 복구와 감사 기록 전에 409로 거절합니다.

전후 셀 데이터는 `audit`에 한 번만 저장하고 `operations`에는 이력 ID·팀 ID·응답 시각·업무 수정시각만 남깁니다. 여러 팀이 섞인 요청은 팀별 원래 위치 번호를 함께 기록합니다. 정상 저장에서는 현재 셀과 같은 변경을 건너뛰며 과거 이력을 읽거나 비교하지 않습니다. 재시도에만 `audit.id` 인덱스로 읽어 최초 응답을 재구성합니다. 참조가 사라졌으면 410을 반환하고 재적용하지 않습니다. `tests/sheet/cell-operations.test.mjs`는 저장량, 정상 저장의 이력 조회 부재, 재시도의 인덱스 사용, 재시작·후속 편집·복원·권한 변경·팀 삭제·트랜잭션 롤백을 검증합니다.

시스템 감사 로그는 `server/history/system-audit.mjs`와 `src/settings/SystemAuditLog.tsx`에서 조회합니다. 공통 이력만 관리자에게 공개하고 한국 시간 날짜·수행자·종류로 필터링합니다. `(created_at,id)` 커서로 50건씩 조회하며 목록은 전후 JSON을 읽지 않습니다. 브라우저는 상세를 펼칠 때만 가져오고 필터가 바뀌거나 화면을 닫으면 이전 요청을 취소합니다. `tests/history/system-audit.test.mjs`는 실제 로그인·로그아웃 기록, 세션 확인·재발급 시 중복 방지, 권한·날짜 경계·같은 시각의 페이지 경계·정리 중 커서 유지·큰 상세·인덱스 사용을, `tests/browser/settings/system-audit.spec.ts`는 로그인 화면부터 오늘 로그 조회, 검색·초기화·페이지 이동·상세 지연 조회·오류 재시도·늦은 응답 무시를 검증합니다.

시스템 이력 정리는 `server/history/history-cleanup.mjs`와 `src/settings/HistoryCleanup.tsx`가 담당합니다. 팀별 본문 용량을 집계하고 관리자 전용 미리보기 토큰에 고정된 팀·한국 시간 기준 날짜로 작은 묶음을 처리하며, 일반 저장 경로에는 요청 시각의 상수 시간 검사만 추가합니다. `tests/history/history-cleanup.test.mjs`는 권한·토큰 만료·한국 시간 날짜 경계·팀별 UTF-8 용량·다른 팀 및 다중 팀 참조 보호·묶음 한도·롤백·만료 요청 재실행 방지를 실제 API로 검사합니다. `tests/browser/settings/history-cleanup.spec.ts`는 별도 임시 서버에서 팀·날짜 변경 시 미리보기 폐기·늦은 응답 무시·확인창 취소·실행·중단·재개·팀장 메뉴 제한과 재시도 생성시각 보존을 확인합니다.

`GET /api/tasks`의 `X-Cell-Event-ID` 헤더는 스냅샷 시점의 SSE 커서입니다. 304 응답에도 포함합니다. 프런트엔드는 스냅샷을 표시한 뒤 `/api/cells/events?teamId=…&year=…&after=…`에 연결하므로 조회와 연결 사이의 변경도 재전송받습니다. 서버는 DB 커밋 후 값 또는 개별 서식이 바뀐 셀 레코드를 전송합니다. 레코드의 값·서식·버전은 일관된 저장 결과를 사용하며, 공통 서식 변경은 팀 리소스 알림으로 최신 목록을 읽어 반영합니다. 재시도된 작업·실패한 트랜잭션·개인 View 저장은 셀 이벤트를 발생시키지 않습니다.

SSE는 로그인 세션과 팀 접근을 구독 시점, 이벤트 전송 전, 15초 heartbeat마다 검사합니다. 여러 연도에 속한 업무의 셀 변경은 해당 연도 구독자에게 전달합니다. `startMonth`로 두 연도를 구독할 때도 SSE 연결은 하나이며, 작업별 변경 셀을 중복 제거하여 하나의 이벤트로 전송·재전송합니다. 따라서 하나의 커서가 두 연도의 변경 전체를 나타냅니다. `Last-Event-ID`로 재접속하며, 서버 메모리의 최근 512개 작업·8MiB 범위에서 재전송합니다. 서버 재시작·버퍼 만료 또는 256KiB 초과 이벤트는 `reset`을 보내 최신 DB 스냅샷과 새 커서로 복구합니다. DB 스키마 변경이나 별도 메시지 서버는 필요하지 않으며 단일 앱 프로세스를 전제로 합니다.

연간 업무의 셀 위치 표시는 사내 서버에만 있습니다. `useSheetPresence`가 선택 셀(편집 중이면 편집 셀)을 150ms 뒤와 10초마다 `POST /api/presence` `{teamId, taskId, key, editing}`로 보내고(보이는 탭만, `X-Client-ID`별 1건), `/api/presence/events?teamId=` SSE로 같은 팀 다른 사용자의 위치를 받습니다. `server/events/presence-events.mjs`는 위치를 프로세스 메모리에만 두고 30초 동안 다시 받지 못한 탭을 15초 주기·위치 수신 때 지우고(사람당 탭 20개까지), 구독·보내기·이벤트 전송 전과 15초 heartbeat마다 로그인·팀 접근을 검사합니다. 이벤트에는 팀별 순번 id를 붙여, 같은 브라우저의 다른 탭이 이미 연 스트림에 합류한 탭도 공유 연결을 다시 열어 현재 목록을 받습니다. DB·동기화·이력에는 남기지 않습니다. 외부 서버는 요청마다 실행 환경이 달라 메모리를 공유할 수 없으므로 표나 별도 인프라를 추가하지 않고 기능을 끕니다(사용자 결정). 사본·발표·연간 업무 밖 화면에서도 보내지 않으며, 화면을 떠나거나 `pagehide` 때 빈 위치를 보냅니다. 위치 스트림은 App의 `usePresenceStream`이 팀 스트림과 같은 조건(캘린더가 아니고 준비된 원본 시트)으로 열어 연간↔인사이트 전환에도 공유 연결을 다시 열지 않습니다. 받은 위치는 React 상태 밖 저장소에 두어 `Grid`의 `useSheetPresence`(`useSyncExternalStore`)만 다시 그리고, 위치 보내기는 연간 업무 화면의 `Grid`가 있을 때만 합니다. `Grid`는 행마다 다른 사람의 셀을 문자열로 묶어 바뀐 행만 다시 그리고, 셀 안 `.sheet-presence`로 사용자 색 테두리와 이름표(아바타와 같은 `inkFor` 글자색)를 그립니다. 이름표는 `data-name`을 CSS `attr()`로 그려 셀 글자(textContent)에 섞지 않고, 내가 편집 중인 셀에서는 숨깁니다. 전체 이름과 상태(선택 중·편집 중)는 셀 툴팁과 `aria-description`으로도 제공합니다.

수신한 변경은 40ms 동안 모아서 셀별 최신 버전만 반영하고 바뀌지 않은 행 객체는 재사용합니다. 느린 연결의 서버 송신 버퍼와 클라이언트 대기 셀 수에도 한도를 둡니다. 숨긴 셀도 내부 데이터는 갱신하지만 개인 View·선택·스크롤·실행취소 기록은 바꾸지 않습니다. 편집 시작 시점의 값과 버전을 보관하여 입력 중 원격 변경으로 저장 기준이 바뀌지 않도록 하며, 해당 행의 필터·정렬 재평가는 편집 종료까지 미룹니다. 본인이 입력 중 적용한 서식 저장만 편집 기준 버전을 올립니다. 늦은 HTTP 응답과 재접속 스냅샷도 최신 셀을 되돌리지 않습니다.

전체 행·열 선택은 선택한 업무 ID·열 키와 서식만 서버로 보내며 셀마다 요청을 만들지 않습니다. 서버는 공통 규칙과 영향을 받는 기존 셀 예외만 변경합니다. `shared/formatting/formatting.js`가 표시·행 복사·XLSX 반출에서 같은 상속 계산을 사용하고, `src/sheet/format-selection.js`가 숨김을 포함한 선택 영역의 테두리를 같은 패턴끼리 묶습니다. 셀 예외와 값은 개별 버전으로, 공통 규칙은 팀별 revision으로 충돌을 검사합니다. `format-audit` 재시도·이력 정리·업무별 이력 조회도 일반 셀 변경과 같은 보관 계약을 따릅니다. 공통 규칙 전송은 문서별 `$formats` 사전으로 중복을 제거합니다.

저장 규칙의 기준 문서는 [데이터 형식과 API](DATA_FORMAT.md#저장-규칙-요약)입니다. 내부 모델은 긴 서식 이름을 사용하되, 변경 이력의 JSON 표시는 `pack`으로 저장 형식을 그대로 재구성합니다. 셀 서식 요약 JSON도 `compactStyle`로 축약합니다. 업무 생성·이동·삭제 이력에는 `taskAuditSnapshot`으로 관계없는 행 규칙과 업무 ID를 제외합니다. 실시간 업무 응답의 팀별 공통 상태는 유지합니다.

`tests/formatting/common-formatting.test.mjs`는 공통 행·열 저장, 연도 경계, 1,000행 빈 셀 미생성, 속성별 우선순위, 셀 예외 재적용, 복사, 충돌·권한·이력 복원과 업무 이력의 불필요한 규칙 제외를 실제 API로 검증합니다. `tests/browser/sheet/common-formatting.spec.ts`는 화면의 행 선택→월 이동→새해→새로고침, 열 서식→셀 예외→재적용→실행취소·재실행, 큰 글자의 행 높이·테두리, 축약된 이력 JSON 표시를 확인합니다.

`/api/teams/:id/events`와 `/api/sheet-clones/:id/events`는 성공한 변경 뒤 재조회 알림을 보냅니다. 개인 보기 저장은 알리지 않으며 셀 값은 기존 델타 스트림을 유지합니다. `useResourceSync`는 같은 리소스의 연결을 탭 안에서 공유하고 짧은 연속 알림을 묶습니다. 페이지별 `X-Client-ID`로 이미 응답을 반영한 자기 변경 알림의 중복 조회를 줄이며 같은 계정의 다른 탭은 별도로 갱신합니다. 편집·저장 중에는 갱신을 보류하고 화면·팀을 떠날 때 연결과 요청을 정리합니다. 사본의 독립 셀 수정은 `rebaseSheetCloneCells`로 최신 시트에 재적용하되 동일 셀·행 삭제·구조 작업 충돌은 기존 오류 흐름으로 남깁니다. 원격 변경 뒤 실행취소 기준에는 상대방의 최신 값이 포함됩니다. 문서 유무·개수는 사본 시트 revision과 독립적이므로 같은 revision 응답에서도 기존 문서 메타데이터 갱신 경로를 사용합니다. 조회 중 로컬 문서나 이름이 바뀌면 오래된 응답을 적용하지 않고 다시 읽습니다.

### 업무 문서와 에디터 선택

업무 상세·꼬리 메모의 순서 변경은 `DocumentPanel` → 기존 `/reorder` 명령을 공유합니다. 원본 업무는 기존 `task_documents.position`, 사본 업무는 기존 문서 배열 순서, 외부는 기존 document entity의 position을 사용합니다. `expectedIds` 충돌·재시도·숨긴 문서 위치·권한 검사를 유지하며 DB 스키마·영속 형식은 변경하지 않습니다. 상세를 처음 열 때는 요청한 문서·보관된 초안이 없으면 저장된 순서의 첫 탭을 선택합니다. 외부 문서 브라우저도 업무별 문서를 같은 position 순서(`byDocumentPosition`)로 돌려주므로 작업 이름이 첫 탭의 문서를 엽니다.

`DocumentImageView` → `DocumentImageEditor`는 `DocumentImageTools`의 아이콘 도구 모음과 `document-image-annotations.ts`의 좌표·그리기 계산으로 펜·사각형·원·삼각형·글자를 편집합니다. `DocumentImageTextInput`은 이미지 좌표·배율·회전에 맞춘 textarea로 직접 입력하며 기존 글자는 더블클릭 또는 글자 도구로 다시 엽니다. Enter는 줄바꿈, 바깥 클릭·Ctrl/Cmd+Enter는 확정, Escape는 현재 입력 취소입니다. 조합 중 Enter/blur는 기존 인라인 편집기와 같은 IME 방어를 적용하며 확정한 한 번의 입력을 하나의 실행취소 단위로 기록합니다. 적용 직전의 DOM 값과 최신 이력을 읽어 마지막 입력을 합성하고 입력 테두리·커서는 저장하지 않습니다. 선택한 도형·글자를 이동·크기 조절·회전하거나 선/채우기 색상·굵기·글자 크기를 바꾸고, 실행취소·다시실행·선택 삭제·전체 지우기를 지원합니다. 확대·축소·화면 맞춤·이동은 표시 상태만 바꾸며 내보내기는 선택 테두리를 제외한 원래 이미지 해상도로 만듭니다. 그리기·이동·크기 조절은 기존 `trackPointerDrag`를 공유하여 캡처 해제를 취소로 보지 않고 버튼 해제 이동에서는 마지막 누른 좌표를 한 번만 확정합니다. 실제 pointercancel·blur·Escape는 진행 중 작업만 취소합니다. 주석과 편집 이력은 편집창의 메모리에만 있으며 저장 시 합성 이미지 한 장을 기존 이미지 업로드 경로에 전달합니다.

이미지 수정창의 취소는 이번 편집을 버리고 닫으며 저장 중에는 비활성화합니다. 원본 보기는 `DocumentImagePreview`의 확대 팝업에서만 제공합니다. 적용 시 편집본과 기존 toggle 블록 안 원본 이미지 참조를 한 트랜잭션으로 반영하고, 보관 블록의 일반 Markdown 링크로 편집본과 원본을 연결합니다. `document-image-original.ts`는 보관 블록을 본문에서 숨기고 커서가 그 안으로 들어가지 않게 하며 HTML/PDF에서도 제외합니다. 숨김과 제외는 연결된 편집본 이미지가 문서에 있을 때(링크 없는 이전 형식은 이미지가 하나인 앞 블록 바로 뒤일 때)만 적용하며, 편집본을 지워 연결이 사라진 보관 블록과 같은 모양의 일반 토글은 본문·HTML·PDF에 그대로 표시합니다. Markdown 원문·동기화·백업에는 일반 이미지 참조가 남으므로 기존 이미지 권한·보존 경로를 유지합니다. 상대 링크는 검증된 첨부 이미지 경로만 추가 허용합니다. 재편집은 같은 보관 블록의 연결만 바꾸고 최초 원본을 유지합니다. 이전의 링크 없는 보관 블록은 앞 블록의 이미지가 하나일 때 연결하며 조회만으로 본문을 다시 저장하지 않습니다. 원본 주소는 기존 DocumentImages.source로 조회하고 팝업을 닫은 뒤 도착한 결과는 버립니다.

업로드 중 원본 노드·읽기 권한·뷰 생존 상태가 달라지면 적용하지 않습니다. 업로드 대기는 붙여넣기와 같은 관리자에서 합산합니다. 블록 메뉴 복사는 기존 Markdown/HTML 직렬화와 클립보드 helper·토스트를 공유하며 본문을 수정하지 않습니다.

캘린더 날짜 입력은 PC에서 각각 150px로 나란히 배치하고 600px 이하에서만 남은 폭을 나눠 사용하거나 줄을 바꿉니다. 이미지 크게 보기의 편집·원본·크기 버튼은 28px 높이와 8px 간격으로 배치하고 아이콘을 표시하며 좁은 화면에서는 줄을 바꿉니다.

발표 커서 CSS는 꼬리 메모 hover를 중단 조건에서 제외하고 실제 modal 팝업에서만 일반 커서로 전환합니다. 필기 좌표계는 기존 표 스크롤 영역을 유지하므로 메모 위 필기는 지원하지 않습니다. `CalendarRangeEditor`는 유효한 기간을 fieldset 밖 blur와 상세 닫기의 기존 flush에서 저장하며 충돌·초안·재시도를 유지합니다. 종료일이 시작일보다 이른 기간은 fieldset을 벗어날 때 같은 flush 검증 오류를 표시합니다.

브라우저 제목은 `App`의 Workspace가 `useWorkspaceRoute`의 현재 화면과 열린 링크 패널 순서로 결정합니다. 문서 주소로 시작한 탭에서만 `DocumentPageTitleContext`로 각 패널의 제목을 받고 맨 위 패널을 표시합니다. 업무는 `DocumentPanel`의 선택한 문서명(기본 **문서 1**은 업무명), 일정은 편집 중 일정명, 메모는 열린 메모명을 사용합니다. 이름·선택 변경은 기존 상태에서 전달하고 패널을 닫으면 아래 패널 또는 화면 제목으로 복원합니다. 일반 화면의 상세 열기는 기존 화면 제목을 유지하며 인쇄의 임시 제목·복원 경로도 유지합니다. 새 API·저장 형식은 추가하지 않습니다.

문서 브라우저의 검색은 선택한 팀·연도·원본/사본 범위에서 작업 이름만 부분 일치로 비교하며, 앞뒤 공백과 영문 대소문자를 무시합니다. 문서 제목과 본문은 검색하지 않고, 일치한 작업의 모든 문서를 순서대로 표시합니다. 작업 이름을 클릭하면 첫 문서를 엽니다. 본문은 결과 페이지의 짧은 미리보기를 만들 때만 읽습니다.

리치 편집기는 MIT 라이선스의 Milkdown Kit를 사용하며 ProseMirror의 편집·IME·history와 Remark의 Markdown 파이프라인을 연결합니다. CommonMark·GFM 확장과 기존 앱 버튼·팀 테마를 재사용하고 React effect에서 편집기 인스턴스를 생성·정리합니다. 한글 조합·붙여넣기·실행취소·키보드 경로는 실제 브라우저로 검증하며, 번들은 빌드 청크와 초기 네트워크 요청으로 확인합니다. 후보 비교와 채택 당시 검증은 [에디터 선택 이력](DEVELOPMENT_HISTORY.md#에디터-선택)에 보존합니다.

`DocumentEditor`는 모든 Markdown 저장 경로에서 본문 SSE를 구독합니다. 업무·사본 업무·원본 메모·사본 메모·캘린더 문서의 저장 시 최신 스냅샷을 전달하며 재연결에서는 마지막 커서 이후 변경된 경우에만 본문을 보내고 `shared/documents/document-merge.js`로 독립 변경을 병합합니다. `sync: {session,sequence}`는 서버 프로세스 내 전송 순서이며 숫자 또는 UUID인 영속 revision과 분리합니다. HTTP 응답이 SSE보다 먼저 도착해도 오래된 스냅샷을 다시 적용하지 않습니다. 접근 권한은 전송마다 다시 확인합니다. 업무 상세의 여러 문서 탭은 선택한 문서만 본문 스트림을 유지하고, 다시 선택할 때 최신 스냅샷을 받습니다. 꼬리 메모는 여러 본문을 나란히 표시하므로 펼친 패널에서 로딩한 모든 메모의 구독을 유지합니다. 다른 메모를 선택해도 이미 표시된 본문은 자동 갱신하며, 패널을 접으면 구독을 해제합니다. 문서 목록의 추가·이름·순서는 별도 목록 알림으로 갱신합니다.

`GridCell`의 작업명 오른쪽 문서 버튼은 기존 `rowMenu` 상세 열기 경로를 공유합니다. 본문이 없는 업무에서는 행 hover·작업명 선택·키보드 초점에서 흐리게 표시하고, 본문이 있으면 문서 개수 표시와 함께 항상 표시합니다. 편집 중에는 버튼을 숨기고 발표 모드에서는 빈 업무의 버튼을 만들지 않습니다. 발표 중 문서가 있는 업무의 버튼은 기존 `RowPanel`을 읽기 전용으로 열며 업무 동작 버튼을 숨깁니다. 버튼의 포인터·키보드 이벤트는 셀 편집·범위 선택으로 전파하지 않습니다.

`TaskDocumentPanel`과 `RichMarkdownEditor`를 동적 import로 분리합니다. 목록에는 `hasDocument`만 보내고 상세에서 문서 제목 목록, 선택한 탭의 본문을 순서대로 조회합니다. 내용도 로컬 초안도 없으면 캐릭터 안내와 작성 버튼을 표시하고 본문·리치 편집기 조회를 미룹니다. 작성 버튼은 저장 부작용 없이 편집기를 열고, 기존 본문·초안은 바로 복원합니다. 방문한 문서만 편집기를 만들고 숨겨진 탭의 상태는 유지합니다. 원문 입력창은 팝업의 문서 영역에 flex로 맞춰지고 내부에서 스크롤하며, 리치 본문은 기존처럼 상세 영역을 스크롤합니다. 한글 조합 중에는 저장하지 않으며 전환·닫기 전에 입력을 flush합니다. 초안 저장 키는 사용자·팀·원본/사본·업무·문서 ID로 나눕니다.

상세는 `DocumentLoading`으로 중앙의 같은 캐릭터와 높이를 유지한 뒤 탭·도구·본문을 함께 표시합니다. `LoadingState`를 앱 초기화·업무표 조회·XLSX 처리·감사 로그·용량 조회에서도 공유합니다. `GraeLoading`은 기존 캐릭터의 네 칸을 순서대로 밝히고 reduced-motion에서는 정지합니다.

Milkdown 진입 전 AST 왕복 검사를 하고 안전한 `<br>`만 줄바꿈으로 표시합니다. `RichMarkdownEditor`의 `remarkTableShape`는 행마다 열 개수가 다른 표를 가장 긴 행의 열 개수에 맞춰 빈 셀로 채우고 기존 정렬과 모든 셀 내용을 보존합니다. 이 변환은 왕복 검사와 실제 편집기 파서에 같이 적용하며, 토글 안의 표와 Markdown 붙여넣기도 같은 경로를 사용합니다. 지원하지 않는 HTML·외부 이미지 등은 원문을 보존합니다. 이미지 붙여넣기·드롭은 문서별 권한 API를 거치며 크기 조절 값은 로컬 이미지 URL에 보존합니다. 문서 제목은 탭 안에서 글자 길이에 맞춰 늘어나는 입력 상자로 수정하며, UI 및 원본·사본 생성/이름 변경 API에서 최대 50자를 허용합니다. 탭에는 10자 이상인 이름을 앞 9자와 …로 줄여 표시하되 접근성 이름·툴팁·저장값은 전체 제목을 유지합니다. 조합 입력을 보호하고 blur·Enter·탭 전환·닫기에서 동일한 저장 Promise를 기다립니다. 문서별 편집기의 원문/리치 토글은 선택된 탭의 오른쪽으로 portal 렌더링하여 본문 상태를 유지합니다. 리치 편집의 저장 상태는 툴바 오른쪽 실행취소·재실행 버튼 앞에 렌더링하고, 원문·읽기 전용·편집기 오류 상태에서는 제목 줄에 표시합니다. 제목 줄과 그 바로 아래 리치 툴바는 스크롤 상단에 고정합니다. 제목 탭은 가로 스크롤하고 수평 wheel 이벤트 및 overscroll 경계를 처리해 브라우저 탐색을 방지합니다. 전체 페이지에서도 업무 속성을 유지합니다.

`src/documents/editor/DocumentToggle.ts`는 `<details>`·`<summary>` HTML 블록을 remark 변환 단계에서 `details` 노드로 묶고 `toggle`·`toggle_summary`·`toggle_content` ProseMirror 노드, 직렬화 핸들러, Enter·Backspace 처리, 요약 줄의 접기 버튼 node view를 제공합니다. `open` 속성과 `<summary>` 안의 `<h1>`~`<h6>`만 허용하며 그 외 속성·태그나 불완전한 요약 태그는 html 노드로 남겨 `checkMarkdown`이 원문 모드로 유도합니다. 지원하는 시작·요약 태그가 있고 `</details>`만 빠졌다면 같은 문서·목록·인용 컨테이너의 끝까지 토글 본문으로 묶고, 중첩 토글은 안쪽부터 닫습니다. 열기·모드 전환만으로는 원문을 저장하지 않으며 실제 편집 시 기존 직렬화기로 닫는 태그를 포함해 저장합니다. 같은 줄에 이어진 본문이나 `</details>` 뒤 텍스트는 Markdown으로 다시 파싱해 묶습니다. 요약은 `text*`만 담아 이미지·HTML이 들어가지 않으므로 서버의 이미지 참조 검사는 기존 파서로 본문 이미지를 찾습니다. 접힘 상태는 `open` 속성으로 문서에 저장하고 체크박스처럼 실행취소 이력에 포함하며, 읽기 전용에서는 DOM에서만 바꿉니다. `checkMarkdown`은 remark 변환 후 트리를 검사합니다. `src/documents/editor/DocumentSlashMenu.tsx`는 문단에서 `/`와 이어진 글자를 찾아 툴바와 같은 명령 목록을 거르고, 표 셀에서는 열지 않습니다. 메뉴 위치·선택 상태와 Esc 해제는 `RichMarkdownEditor`의 플러그인 view와 `handleKeyDown`에서 갱신합니다. 공식 `trailing` 플러그인은 표·코드·목록·토글·이미지로 끝나는 문서 뒤에 빈 문단을 유지하며 doc 직렬화가 마지막 빈 문단을 제외하므로 저장 결과는 같습니다. 원격 병합의 비교 문서에도 같은 빈 문단을 붙여 그 줄에 있던 커서를 보존합니다. 업로드로 삽입한 이미지는 `appendTransaction`에서 다음 문단(없으면 새로 생성)으로 커서를 옮기고, 본문 아래 여백 클릭은 문서 끝으로 이동합니다. `tests/browser/documents/document-editor-blocks.spec.ts`가 세 동작을 검증합니다.

연간 업무의 `canEdit(user, task)`는 팀별 `canContribute`를 사용합니다. 팀장·팀원은 작성자·담당자·지원자와 관계없이 같은 팀의 표·속성·문서를 편집하고 업무를 삭제·실행취소할 수 있습니다. 담당자·지원자 지정과 묶음 행 삽입·붙여넣기도 같은 기준을 사용합니다. 꼬리 메모는 기존 `canContribute` 검사로 공동 편집하며, 열람자와 외부 팀 사용자의 쓰기는 거절합니다. 캘린더 개인 일정의 소유자 검사와 팀 관리 권한은 별도로 유지합니다. 권한 설정 필드·SQLite 스키마·기존 데이터 변환은 추가하지 않습니다.

원본과 사본 문서 모두 자동 저장합니다. 각 사본은 자체 문서 배열을 갖고 불변 본문만 공유하며, 저장은 해당 문서 참조만 교체합니다. 분기 UI·원문/분기 연결 API는 제거했습니다. 사본 표의 `useSheetCloneDraft`는 저장 중 새 입력을 대기열에 추가하고 완료 후 이어 저장합니다. 실행취소는 셀/행 상태를 복원하지만 현재 행의 문서 참조는 유지합니다. 삭제 직전 문서를 읽어 행 복원에 포함합니다. 사용자 자료는 검증 fixture로 사용하지 않습니다.

사본 본문 자동 저장은 `sheet_clone_documents`의 해당 참조만 갱신하고 이전 본문 버전만 정리합니다. 문서 조회용 행 ID·제목 인덱스는 압축 BLOB 해시로 무효화하며, 셀·본문을 보관하지 않는 16MiB 예산의 캐시를 사용합니다. 표를 해제한 뒤에는 `readSheetClone`으로 최신 문서 참조를 합쳐야 합니다. 여러 행 삭제·실행취소는 `POST /api/sheet-clones/:id/documents/batch`로 최대 100개 행씩 읽고 실행취소 이력을 한 번에 갱신합니다. 응답 본문 합계는 8MiB에서 다음 행으로 나누되 한 행의 문서는 분할하지 않으며, 클라이언트는 반환된 행 수부터 이어 읽습니다. 화면에서 문서가 없어 보이는 행도 함께 조회해 다른 사용자의 최근 저장을 보존합니다.

사본 메모는 `server/documents/memo-storage.mjs`의 참조 복사와 `DocumentBusinessService`의 공통 편집 경로를 사용합니다. 사본 표를 읽거나 저장할 때 메모 본문을 읽거나 표 BLOB에 포함하지 않습니다. 테스트는 복사 전후 `document_versions` 수, 공유 참조 ID, 메모 편집 전후 표 BLOB·revision 동일성, 재복사·재시도·권한·충돌·정리·이미지·JSON 반출·백업과 화면의 닫힌 상태 복사·저장 직후 재복사·원본 분리를 검증합니다.

업무 상세와 꼬리 메모는 `DocumentPanel`의 같은 탭·제목 입력·메뉴 구현을 사용합니다. 각 탭은 편집 여부와 관계없이 40px 높이를 유지하며, 제목 입력은 측정용 텍스트가 결정한 grid 영역 위에 배치해 팝업의 공통 입력칸 너비가 탭 폭을 늘리지 않게 합니다. 제목을 조합하는 중 다른 탭을 누르면 조합 확정에 따른 브라우저의 레일 스크롤을 누른 시점 위치로 되돌려, 좁은 화면의 더블클릭이 누른 탭에서 이름 변경을 시작하게 합니다. 화살표 hover는 사본 탭과 같이 색상을 바꾸지 않으며 선택 상태만 표시합니다. 각 문서 탭 오른쪽의 아래 화살표에서 공통 이름 변경·삭제 메뉴를 엽니다. 다른 문서의 메뉴를 열 때도 기존 `select()`로 현재 입력을 저장한 뒤 대상을 전환합니다. 메뉴는 `SheetTabs`와 같이 가로 스크롤 영역 밖의 제목 줄에 배치하고 화살표 위치를 따라가며, 화면 밖으로 스크롤되면 닫습니다. 기존 바깥 클릭·Escape·Tab 닫기와 열람자 권한을 유지합니다. 문서 폭은 `DocumentPage`가 포인터 캡처로 조절하며 키보드 조절·취소를 지원합니다. 폭은 사용자·팀·원본 연도/사본·문서별 localStorage에 보관하고 본문·순서는 기존 API를 이용합니다. `AnnualMemoPanel`은 제목 버튼·중앙 가로 스크롤 영역·별도 본문으로 아코디언을 구성하고, 사용자·팀·원본 연도/사본별 `weekly-plan:memo-open:…` 키에 펼침 상태를 기억합니다. 닫기는 기존 문서 `flush()`가 성공한 뒤에만 상태를 저장하며, 접힌 상태에서는 `DocumentPanel`을 마운트하지 않아 메모를 조회하지 않습니다. 저장소 접근이 차단되어도 현재 화면에서는 열고 닫을 수 있습니다. 아코디언은 `.sheet-scroll` 밖, 같은 `.grid-area`(세로 flex)의 아래쪽에 놓여 접으면 제목 행만, 펼치면 높이가 있는 패널로 고정되며 열고 닫아도 표의 스크롤 위치를 바꾸지 않습니다. 패널 높이는 사용자가 정하면 `weekly-plan:memo-height:…` 키에 기억하고 위쪽 가장자리 구분선(`.memo-height-handle`)으로 바꿉니다. 탭 선택은 탭 레일의 가로 위치만 조절합니다. 아코디언은 서식 툴바와 같은 높이 변수와 팀 테마를 사용하고 글자는 11px입니다. 발표 모드에서도 같은 패널을 읽기 전용으로 유지하며, 발표 도구의 입력 가로채기에서 메모·업무 문서 버튼·열린 dialog를 제외해 아코디언·문서 탭·팝업을 조작할 수 있습니다. 꼬리 메모에 마우스를 올려도 레이저·필기 커서는 유지하며, 실제 modal dialog가 열린 동안에만 발표 커서 덮어쓰기를 멈추고 레이저·지우개 표시를 숨겨 기본 커서를 복원합니다. 전역 Escape 처리도 열린 dialog에 양보하므로 중첩 이미지 팝업을 닫을 때 발표가 종료되지 않습니다. `SheetHorizontalScroll`은 업무 표의 가로 스크롤을 메모 위에 표시하며, 기존 `.sheet-scroll`의 좌표와 동기화해 행 가상화·고정 열·위치 복원을 유지합니다. 표의 가로 wheel·터치 이동을 처리하고 메모 내부 제스처는 각 문서와 메모 영역에 맡깁니다.

### 접속 토큰과 클라이언트 시각

`AccountMenu` → `AccessTokens` → `/api/access-tokens`는 본인 토큰의 생성·목록·재조회·삭제를 처리합니다. 내부 `server/auth/access-tokens.mjs`는 SQLite 트랜잭션을, 외부 `worker/control/access-tokens.mjs`는 기존 `controlTransaction`을 사용하며 입력 검증·난수·해시·AES-GCM은 `server/storage/control/access-token-service.mjs`를 공유합니다. 신규 토큰에는 만료일이 없으며 원문은 암호화해 저장하고 눈 아이콘을 눌렀을 때 본인에게만 복호화해 반환합니다. 내부 키는 `access-token-key.mjs`에서 DB 밖의 파일 또는 환경 변수로 관리합니다. 브라우저 영속 저장소와 감사 로그에는 토큰을 넣지 않으며, 조회용 Bearer 인증은 아직 연결하지 않습니다. 미배포 신규 기능의 스키마 변경을 v33/site v3/control v2 마이그레이션 하나에 포함합니다. 배포·키 관리·백업 취급은 [운영 안내](OPERATIONS.md#접속-토큰-도입-업데이트)를 따릅니다.

`api.ts`는 내부·외부 JSON 응답의 `X-Server-Time`을 받아 monotonic clock에 고정합니다. 표 저장·명시적 덮어쓰기·상세 속성 저장은 `serverNow()`로 새 작업의 시각을 만들고, 재시도는 기존 ID와 시각을 유지합니다. 서버의 7일 재시도 유효기간과 미래 시각 검증은 유지합니다. `tests/browser/sheet/workspace-improvements.spec.ts`는 빠른/느린 PC 및 로그인 후 시각 변경, 숨긴 일정 목록, 검색 위치 보존, 마지막 문서 삭제, 꼬리 메모 편집·전체 화면·스크롤, 토큰 메뉴를 검사합니다. `tests/auth/access-tokens.test.mjs`는 두 실제 DB의 소유권·해시·동시 발급 상한·migration 롤백·복구 폐기를 확인합니다.

### 속성과 상태 통계

작업·팀원·상태는 필수 속성입니다. 팀원과 지원자는 업무 담당 정보를 나타내며 단일·복수 선택 구성을 유지합니다. 연간 업무의 편집 권한은 담당자·지원자 값에 의존하지 않습니다. 설정의 `revision`은 관리자 간 충돌을 검사합니다. 속성 종류 변경은 기존 셀을 변환하고, 변환 불가능한 값이 있으면 전체 변경을 취소합니다.

상단 통계는 인사이트 설정에서 고른 선택형 속성(기본은 상태)의 실제 옵션을 기준으로 현재 달력의 최대 두 연도에 속하는 전체 업무를 중복 없이 집계합니다. 필터·숨김은 통계 분모를 바꾸지 않습니다. 보관된 속성과 값은 기존 셀·스냅샷을 해석할 수 있도록 보존합니다.

### 이관과 삭제

XLSX 분석·생성은 내부 SQLite와 외부 PostgreSQL에서 `shared/transfer/workbook.mjs`를 직접 사용하며, 빌드 중 서버 소스를 잘라 별도 파서를 생성하지 않습니다. XLSX는 미리보기 후 담당자·예외 확인을 거쳐 적용합니다. 파일·팀·행 범위 및 열 연결 설정·시트·모드·연도 조합으로 중복 적용을 방지합니다. 담당자가 비어 있으면 미지정으로 유지합니다. 여러 표가 섞인 원본에는 API의 `sheetOptions`로 업무 표의 범위를 지정할 수 있습니다. 사본은 생성 당시 값·사용자·설정·보기를 보존하고 이후 독립적으로 편집합니다.

사본 편집은 `src/sheet/useSheetCloneDraft.ts`의 자동 저장 큐·실행취소 기록을 사용합니다. `shared/sheet-clones/sheet-clone-editing.js`가 브라우저와 서버에서 같은 편집 작업을 적용하고, `server/sheet-clones/sheet-clone-editing.mjs`는 팀 기여 권한·사본의 속성·BLOB revision을 검증한 뒤 해당 사본만 저장합니다. 현재 업무의 mutation·SSE·실행취소·필터 저장 경로와 연결하지 않습니다. `tests/sheet-clones/sheet-clones.test.mjs`는 원본 속성 변경·원본 업무 삭제·권한·원자성·동시 수정·재시작·응답 유실 재시도를, `tests/browser/sheet-clones/sheet-clone-editing.spec.ts`는 편집·추가·삭제·서식·실행취소·자동 저장·실패 재시도·기존 필터 복귀를 검증합니다.

업무 삭제는 복구 가능한 삭제 상태로 보존하며, 별도 휴지통 UI 없이 시트별 변경 이력에서 복구합니다. 원본 다중 삭제·복구는 전체 권한과 버전을 검사하고 하나의 트랜잭션으로 처리합니다. 사본 삭제 이력은 삭제 직전 행·문서 본문·참조된 사용자 이름을 보관하며, 복구는 해당 사본에만 적용합니다. 팀 삭제는 시스템 관리자가 확인한 경우 모든 연도의 업무와 연관 데이터를 트랜잭션으로 영구 삭제합니다. 다른 팀·공용 계정은 보존합니다.

## 신규 기능을 추가하는 순서

1. 그래프로 유사 기능의 화면 → 명령 → API → 공통 업무 서비스 → SQLite/PostgreSQL repository 호출 경로를 확인합니다. 실행 환경과 변경할 책임을 정한 다음 파일 위치를 선택합니다.
2. 아래 책임 표에서 변경 주체를 고릅니다. 화면을 조합하는 `App`에 새 저장 큐·조회 타이머·필터 API를 추가하지 않습니다. 원본 업무와 사본 초안의 저장·실행취소는 각각 기존 경로를 확장합니다.
3. 같은 기능 폴더에 구체적인 파일명으로 추가합니다. 새 폴더가 필요하면 `scripts/testing/code-organization-rules.json`의 `allowedDirectories`에 **정확한 경로와 이유**를 등록하고 [배치 가이드](CODE_ORGANIZATION.md)를 함께 수정합니다. 파일의 직속 부모도 등록 대상입니다. 기존 접두어를 유지하고 범용 이름·중복 구현·재노출 barrel을 만들지 않습니다.
4. API 추가는 해당 `shared/http/*-routes.js` 계약과 공통 `server/storage/<기능>/*-service.mjs`, 두 엔진의 repository를 먼저 확인합니다. 내부 `server/app.mjs` 등록과 외부 `worker/entry.mjs` dispatch를 함께 연결합니다. 외부 쓰기는 `mutationTeam`의 사전 최신화·게시 대상 식별에도 들어가는지 확인합니다. DB·저장 형식 변경은 [DB 변경 지침](DATABASE_CHANGES.md)의 승인을 먼저 받습니다.
5. 외부에서 새 공통 서비스를 import할 때는 `tests/tooling/storage-import-boundaries.test.mjs`의 정확한 경로 목록과 지원 환경을 검토합니다. 디렉토리 전체 허용으로 넓히지 않습니다. 브라우저에서 `shared/`를 사용할 때도 간접 Node 의존을 확인합니다.
6. 실제 화면/호스트 진입점의 회귀 검사를 고릅니다. `external-route-fixture.mjs`는 자체 라우트 목록을 사용하므로 해당 fixture 통과만으로 `worker/entry.mjs` 등록을 입증하지 않습니다. 호스트 연결 변경은 실제 worker/Edge handler를 쓰는 `tests/site/team-site.test.mjs`와 함께 확인합니다.
7. `npm run check:structure`, `npm run check:architecture`, [필수 검증](#검증)을 실행합니다. 새 의존성 위반 검사는 고장 난 import나 순환을 넣었을 때 실패해야 합니다. 현재 안내를 갱신하고 결과·기준 커밋·미검증 범위는 `DEVELOPMENT_HISTORY.md`에 남깁니다.

`docs/code-organization-moves.json`과 `--migration-phase P8`은 #100에서 수행한 이동의 기록·재현용입니다. 이후 기능 추가나 책임 분리마다 과거 manifest를 고쳐 현재 파일 목록에 맞추지 않습니다.

### 브라우저 상태와 저장 책임

| 변경 대상                          | 소유 모듈                                                                                        | 확장 시 지킬 계약                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 화면 전환·선택·열린 패널·명령 조합 | `src/app/App.tsx`, `useWorkspaceRoute.ts`                                                        | 저장·편집 완료 확인 후 이동하고 화면의 선택/스크롤 처리를 연결                                                                                                                             |
| 원본 업무 조회·캐시·재시도·SSE     | `src/sheet/useTaskData.ts`                                                                       | `initialize`는 배치 복원 뒤 최초 조회, `refresh`는 공유 조회. 명령 시작 시 `invalidate`, 성공 후 `replace`로 반영. 팀·연도·조회 범위·로컬/원격 변경 세대를 모두 검사                       |
| 원본 저장 중 상태·실패 입력·재시도 | `src/sheet/useSheetOperations.ts`                                                                | 셀은 `submit`/`retry`, 행 명령은 `begin`이 반환한 종료 함수를 `finally`에서 호출. 재전송은 같은 operation ID, 명시적 충돌 덮어쓰기는 최신 버전과 새 ID. 완료 결과를 App이 화면·이력에 연결 |
| 원본 실행취소·재실행               | `src/sheet/useSheetHistory.ts`                                                                   | 셀/서식 결과는 `recordCells`, 행 추가/삭제/복구는 `recordTask`. 두 스택을 함께 갱신하며 이전 버전 재기반은 기존 `history.ts`를 사용                                                        |
| 원본 개인 배치                     | `src/sheet/useSheetLayout.ts`                                                                    | 팀·연도별 `/views` 지연 저장·flush·해제. 필터 조건은 포함하지 않음                                                                                                                         |
| 인사이트 파생값·필터·차트 설정 | `src/insights/Insights.tsx`, `shared/insights/insights.js` | 원본은 같은 `useTaskData`의 공개 tasks/ready/queryError/retry를 사용. 파생 캐시는 보고서가 소유하며 별도 원본 GET·poll·SSE를 만들지 않음 |
| 저장 필터·현재 조건·선택           | `src/sheet/useSavedFilters.ts`                                                                   | 팀별 목록과 순차 저장을 소유하며 빈 팀 ID로 조회하지 않음. 연도 이동은 같은 큐, 팀을 나갔다 돌아온 경우는 새 조회 소유 범위. App은 반환된 조건 적용과 스크롤만 결정                                                     |
| 필터 이름 입력                     | `src/sheet/SavedFilterDialog.tsx`                                                                | 폼·초기 포커스·입력 오류만 관리하고 `onSave`를 호출. 자체 API/별도 저장 큐를 만들지 않음                                                                                                   |
| 사본 편집·저장·실행취소            | `src/sheet/useSheetCloneDraft.ts`                                                                | 원본 셀 저장 API와 분리된 기존 draft/command 경로 유지                                                                                                                                     |
| 로그인·세션 복구                   | `src/auth/Auth.tsx`, `SessionLogin.tsx`                                                          | `resumeSession`을 포함한 내부/외부 인증 흐름 유지. 공용 UI가 인증 화면을 import하지 않음                                                                                                   |
| 공용 표시와 조작                   | `src/ui/Button.tsx`, `Modal.tsx`, `Empty.tsx`, `ErrorNote.tsx`, `Avatar.tsx`, `ZoomControls.tsx` | 기능·App·API를 알지 않고 전달된 값/콜백으로 동작                                                                                                                                           |

시트의 사용자 명령은 `useSheetRowCommands`(행 추가·복제·삽입·삭제·복구·순서·문서 복사), `useSheetCellCommands`(권한/버전 확인·값/서식·붙여넣기·서식 브러시), `useSheetUndo`(원본 이력 또는 사본 초안으로 실행취소 전달)가 소유합니다. 원본 저장과 이력은 위 담당 훅을 재사용하고 사본은 `useSheetCloneDraft`의 명령을 사용합니다. 행 복사 상태와 서식 브러시의 취소 수명도 해당 명령 훅에 있습니다. 새 명령은 이 경로를 확장하며 App은 선택·편집·알림 콜백을 연결합니다.

`src/app/useWorkspaceNavigation.ts`는 연간·인사이트·캘린더·문서 화면 전환 전에 메모 flush와 문서 탐색의 기존 저장 경로를 조정합니다. 인사이트 설정 저장 중 이동 금지와 원본 시트 준비도 이 경로를 확장합니다. URL·뒤로/앞으로 기록은 기존 `useWorkspaceRoute`가 소유하고, 각 기능의 저장 구현은 그 기능에 남습니다. 기능이 전달한 이동 가능 여부와 준비 동작을 사용해 메뉴 이동과 브라우저 이동의 같은 조건을 유지합니다.

`useTaskData`의 조회 오류와 `useSheetOperations`의 실패 입력은 별도 상태입니다. 조회 복구로 저장 실패를 지우지 않습니다. 비동기 응답은 반영 직전 소유 범위를 검사하며, 팀 ID 문자열이 다시 같아졌다는 이유로 이전 화면의 응답을 허용하지 않습니다. 읽기/저장 담당 훅의 내부 ref나 큐를 App에 노출해 직접 조작하지 않습니다.

### Grid 입력 책임

`Grid.tsx`는 행·열 렌더링과 메뉴 조합을 담당합니다. 선택·포커스·IME 준비는 `useGridSelection`, 행 이동은 `useGridRowDrag`, 크기 조절은 `useGridResize`, 가상 스크롤·이동은 `useGridViewport`가 소유합니다. 범위 계산은 `grid-selection.ts`, 호출 타입은 `grid-types.ts`를 직접 참조합니다. 새 제스처는 공용 `trackPointerDrag`를 재사용하고 취소·화면 전환·해제 시 정리합니다. `scopeKey`는 팀·연도·사본을 식별하며 바뀌면 진행 중인 드래그를 취소합니다. 크기 조절 미리보기는 훅 내부 상태이며 정상 종료할 때만 기존 `onView` 저장 경로를 호출합니다.

### 캘린더 명령 책임

`Calendar.tsx`는 보기·날짜·패널과 일정 배치를 조합합니다. 조회·요청 취소는 기존 `useCalendarData`, 드래그는 기존 `useCalendarDrag`를 사용합니다. `useCalendarMutation`은 요청 직렬화와 조회 중단/재개를, `useCalendarCreation`은 새 일정의 임시 보관·저장을, `useCalendarCommands`는 일정·태그·주간 목록 변경과 단일 삭제 복원 기회를 소유합니다. 새 명령은 이 경로를 통해 조회 캐시를 갱신하고 기존 서버/시크릿 저장소를 재사용합니다. 일정의 기간 충돌과 패널 열림 상태는 화면에서 전달하며 별도 저장 경로를 만들지 않습니다.

월간 보기의 이어지는 달은 `src/calendar/useCalendarMonthScroll.ts`가 맡습니다. `useCalendarMonthRange`는 처음·마지막 달(`range`), 기간 선택에 보이는 달(`month`), 화면에 보이는 달(`onScreen`), 옮길 행(jump)을 소유하고 열기·오늘·이전 달·다음 달·연월 선택·구성원 변경을 처리합니다. 보기 전환과 처음 열기는 `open()`으로 오늘 달부터 다시 시작하며, 팀 주간에 넘겨줄 주는 기간 선택의 달에서 정합니다. 조회는 달마다 나눕니다(`calendarMonthChunks`). 처음 달은 기존 `monthWeeks` 전체이고, 다음 달부터는 앞 달의 마지막 주 다음 주부터 그 달 `monthWeeks`의 끝까지입니다. 이 구간은 처음 달과 무관한 4~5주라 서버의 62일 제한 안에 있고, 달을 붙여도 그 달만 조회합니다. `useCalendarData`는 결과를 소유자·구간 시작일별로 보관하고(`slotFor`), `ranges`로 구간별 결과를, `schedules`로 소유자별 한 캘린더를 돌려줍니다. 합칠 때 구간을 넘는 일정은 revision이 높은 사본을, 배치는 `mergeCalendarLayout`을, 실패는 첫 구간의 것을 씁니다. 소유자당 구간이 하나인 팀 주간은 이전과 같은 결과 객체를 씁니다. 화면 밖 달의 조회는 `lazy`로 표시해, 팀 변경 알림(`reload`)에는 화면에 보이는 달(보통 1~2개)만 다시 읽고 나머지는 가진 결과를 유지했다가 다시 화면에 들어올 때 읽습니다. `lazy`만 바뀌면 `ranges`·`schedules`를 다시 만들지 않습니다. `Calendar`는 앞에서부터 이어서 불러온 달만 그리고 그다음 달의 불러오는 중·실패를 그 아래에 표시합니다. 숨긴 요일 일정은 연속된 표시 주 범위로 일정 기간을 잘라 7일 미만일 때만 그 요일들을 확인합니다. 기존 명령의 `updateData`는 구간마다 적용되고 `updateWeekly`는 그 주를 포함한 구간에만 넣습니다. 월간 보기의 scope는 팀·보기·소유자·처음 달이므로 달을 붙여도 열린 메뉴·드래그·저장 응답이 유지됩니다. 늦은 응답은 기존처럼 바뀐 조회의 요청을 중단해 버립니다.

`useCalendarMonthScroll`은 jump 행을 머리글 바로 아래로 옮깁니다(오늘은 열도). 옮기면서 그 스크롤 영역의 브라우저 스크롤 앵커링(`overflow-anchor`)을 끄고, 사용자가 휠·터치·키·포인터로 조작하면 다시 켭니다. 앵커링이 켜져 있으면 웹 글꼴 적용 등으로 머리글 높이가 바뀔 때 브라우저가 위치를 스스로 옮겨 행이 몇 px 어긋나고 입력 없는 스크롤 이벤트가 생깁니다. 목록 끝에 막혀 덜 옮겨졌으면 다음 달을 그린 뒤 마저 옮기며, 위 입력이 있을 때만 그만둡니다. jump가 남긴 위치의 스크롤 이벤트는 기간 선택을 바꾸지 않습니다. 사용자가 스크롤하면 맨 위 줄의 토요일이 속한 달을 기간 선택에 반영하고(늘릴 수 없는 목록의 끝에서는 마지막 달), 화면에 보이는 첫 줄·마지막 줄을 이진 탐색해 `onScreen`을 갱신하고, 끝에서 한 화면 이내면 다음 달을 붙입니다. 12개월(`CALENDAR_SCROLL_MONTHS`)이나 2100년 12월에 이르면 더 붙이지 않습니다(`full`, 안내 문구는 `capped`). 앞 달은 자동으로 붙이지 않습니다. 저장 형식·API 변경은 없습니다.

### 리치 문서 편집 책임

`DocumentEditor.tsx`는 기존 문서 자동 저장·초안·충돌 병합·SSE 계약을 유지합니다. `editor/RichMarkdownEditor.tsx`는 편집 화면과 도구를 조합하며 아래 소유자를 사용합니다.

| 변경 대상 | 소유자 |
| --- | --- |
| Milkdown 생성·해제, 원격 내용 적용, 읽기 전용 전환 | `useRichEditorLifecycle.ts` |
| 키보드·붙여넣기·드롭 규칙 | `document-editor-input.ts` (기존 입력 규칙 모듈 재사용) |
| 이미지 업로드·취소·진행 수·삽입 후 선택 | `document-image-uploads.ts` (`dispose()`를 수명 종료 때 호출) |
| 링크 폼·툴팁·열기·복사 | `useDocumentLinkActions.ts` |
| 슬래시 메뉴 상태·키보드·명령 적용 | `useDocumentSlash.ts` |
| 목록·블록·표의 편집 명령 | `document-editor-commands.ts` |
| Markdown 스키마·변환 보존 검사·클립보드 직렬화 | `document-markdown.ts` |

문서 내보내기는 `document-markdown.ts`의 동일 스키마와 링크 규칙을 직접 참조합니다. 변환 규칙은 편집 화면에 추가하지 않습니다. 저장 형식에 영향을 주는 변경은 DB 변경 지침을 따르며, 미지원 문법은 원문 보존과 기존 Markdown 전환 경로를 유지합니다.

### 내부·외부 API의 연결 책임

| 계층 | 내부 Node | 외부 Edge |
| --- | --- | --- |
| 호스트 조합 | `server/app.mjs:createApp`의 `install…Routes` 등록 | `worker/entry.mjs:createWorker`의 dispatcher 등록, `edge/` 환경 어댑터 |
| 신원·HTTP 경계 | `server/auth/local-auth.mjs`, `server/http/` | `worker/control/access.mjs`, `control.mjs`, `site-auth.mjs` |
| 도메인 입력·업무 규칙 | 두 호스트가 같은 `server/storage/<기능>/*-service.mjs`와 공유 라우트/명령 규칙 사용 | 동일 |
| 권한 조회·DB 트랜잭션·이벤트 기록 | `Sqlite…Repository`, `server/auth/sqlite-access.mjs` | `Postgres…Repository`, `RequestContext` |

기존 업무 API에 동작을 추가할 때는 공유 라우트 표 → 서비스/명령 규칙 → 엔진별 repository → 실제 HTTP 등록 → SQLite/PG 계약 및 라우트 검사 순서로 연결합니다. Node의 동기 트랜잭션과 PG의 비동기 트랜잭션은 각 repository가 유지합니다. 라우트에 SQL이나 공통 업무 검증을 복제하지 않습니다. 새로운 도메인은 기존 서비스의 적합성을 먼저 확인한 뒤 필요한 항목만 추가합니다.

외부 변경 요청은 `worker/entry.mjs:mutationTeam`을 거쳐 최신화하고, 커밋 후 `changedTeams`의 게시를 예약합니다. 본문에 `teamId`가 없는 새 리소스 경로는 팀 판별도 연결해야 합니다. 이것은 권한 검사 대신이 아니며, 서비스와 repository의 권한 검사를 모두 유지합니다. `/events`와 이미지 읽기는 별도 응답 경로를 사용하므로 일반 JSON 라우트에 섞지 않습니다.

### 기능 추가 예시

| 요청 | 수정 순서와 확인할 동작 |
| --- | --- |
| 기존 셀 서식을 일괄 적용하는 버튼 | UI는 선택과 명령만 전달하고 `useSheetCellCommands`의 기존 서식 명령을 확장합니다. 원본은 `useSheetOperations`·`useSheetHistory`, 사본은 `useSheetCloneDraft`로 전달하며 권한·동시 수정·실행취소를 함께 검사합니다. |
| 일정 메뉴에 새 조작 추가 | `Calendar`에서 메뉴와 선택을 연결하고 `useCalendarCommands`에서 명령을 수행합니다. 서버/시크릿 분기와 `useCalendarMutation`의 대기·화면 전환 보호를 재사용합니다. 새 일정 입력의 보관 방식은 `useCalendarCreation`에서 관리합니다. |
| 문서 편집 단축키 추가 | `document-editor-input`에서 실제 키를 연결하고 `document-editor-commands`의 기존 명령을 재사용합니다. 본문 변경은 기존 Milkdown listener → `DocumentEditor` 저장 경로를 타도록 하며 읽기 전용·한글 조합·실행취소를 검사합니다. |
| 업무 API 추가 | 공유 라우트/서비스와 양쪽 repository, 내부 라우트 등록·외부 dispatcher/`mutationTeam`을 연결합니다. SQLite·PG 서비스 검사와 실제 호스트 요청을 모두 확인합니다. 저장 계약을 바꾸면 구현 전 DB 변경 지침을 적용합니다. |

메모 카드의 열린 `<dialog>`는 모달 팝업과 다릅니다. 전역 Escape 우선순위나 발표 포인터 차단에는 `dialog:modal`을 사용하고, 문서 안의 키보드 입력은 해당 편집기가 처리하도록 유지합니다.

## 확장과 변경

- 짧은 저장·드래그로 입력을 잠글 때는 `src/ui/busyProps.ts`로 실제 `disabled`와 임시 잠금 표시를 함께 전달합니다. 권한·필수값 부족으로 비활성화한 컨트롤의 흐린 표시는 유지하고, 임시 잠금 때문에 화면 전체를 흐리게 만들지 않습니다. 저장 상태는 변경 중인 항목에 표시합니다. 캘린더 저장은 해당 팀원의 데이터만 교체하고, 변경 없는 주간 배치는 다시 정렬하지 않습니다.
- 포인터 드래그의 이동·종료·취소는 `src/ui/trackPointerDrag.ts`를 공유합니다. 캘린더 이동·기간 조정, 기간 선택, 행 이동, 속성 값 순서 변경에 적용되어 있습니다. 새 드래그도 이 모듈을 사용하고 각 화면은 시작 임계값·대상 계산·스크롤·저장만 담당합니다. 캡처 해제는 취소가 아니며, 버튼이 풀린 이동 이벤트가 먼저 오면 마지막으로 누른 위치를 한 번만 확정합니다. 실제 `pointercancel`·창 포커스 이탈·Escape와 화면 해제는 취소하고, 일반 `pointerup`에서는 최종 좌표를 반영합니다. 브레이브 트랙패드의 캡처 해제 → 버튼 해제 이동 → 늦은 `pointerup` 순서는 `tests/browser/calendar/monthly-calendar.spec.ts`에서 재검증합니다.
- 일반 폼의 `input`·`select`·`textarea` 테두리와 포커스는 `src/styles.css`의 공통 규칙을 사용합니다. 화면별 CSS는 필요한 크기·배치만 조정하고, 입력칸 바깥으로 떨어지는 `outline`이나 별도 테두리·모서리 규칙을 중복 지정하지 않습니다. 공통 버튼도 같은 스타일 파일에서 포커스 선을 기존 테두리 안쪽에 겹쳐 그려 이중 테두리가 생기지 않게 합니다. 셀 편집기와 테두리 없는 도구 모음은 기존 전용 표시를 유지합니다.
- 일반 폼 선택은 `Select.tsx`, 같은 값을 재선택하여 적용해야 하는 서식 선택은 `FormatSelect.tsx`를 사용합니다.
- 입력 팝업의 초기 포커스는 `Modal.initialFocus`로 지정해 `showModal()` 뒤에 적용합니다. 생성은 폼 제출로 버튼과 Enter를 연결하고, 한글 조합 확정 Enter와 저장 중 중복 제출을 구분합니다.
- 일정 제목의 자동 저장은 입력 초안과 서버 제목을 분리합니다. 저장값의 앞뒤 공백은 정리하되 응답으로 편집 중인 초안을 덮어쓰지 않아 공백·커서·한글 조합을 보존합니다. 저장 여부와 초안 보관은 공백 정리 후 비교하여 공백만 바뀐 경우 중복 요청이나 불필요한 미저장 표시가 생기지 않도록 합니다.
- 캘린더 태그의 고정 팔레트는 `shared/calendar/calendar-tags.js`, 관리·선택 UI는 `src/calendar/CalendarTags.tsx`를 공유합니다. 이름·색상은 팀·소유자별 목록에 한 번 저장하고 일정에는 순서가 있는 ID만 연결합니다. 개인 일정·태그는 사용자 ID로, 팀 공용 일정·태그는 `userId: null`로 구분합니다. `Calendar`의 팀 월간·개인 월간·팀 주간은 같은 카드·편집·저장 경로를 사용하고 조회·태그·배치 캐시는 소유자별로 분리합니다. 태그 목록 변경은 다른 소유자의 태그 연결과 체크 상태를 정리하지 않습니다. 공용 일정과 공용 태그는 열람자를 포함한 모든 팀원이 관리할 수 있습니다. 개인 일정·태그는 기여 권한이 있는 본인과 해당 팀장·관리자만 편집합니다. 관리 버튼·팝업 제목은 소유자에 따라 개인 태그 관리·팀 태그 관리로 일치시킵니다. 목록 변경은 표시 캐시를 갱신하며 캘린더 전체를 재조회하지 않습니다. 제목·기간·문서·태그의 독립 저장 응답은 다른 필드를 덮어쓰지 않도록 병합합니다. `tests/calendar/calendar.test.mjs`와 `tests/browser/calendar/calendar-tags.spec.ts`에서 권한·충돌·삭제·복구·배경색과 동시 저장을 검증합니다.
- 캘린더 삭제·실행취소도 업무와 같은 복구 가능한 삭제를 사용합니다. `Toast.tsx`의 `UndoToast`를 공유하고, 상세에서 편집 중인 제목·기간·본문 저장을 마친 뒤 확인 팝업 없이 삭제합니다. 실행취소는 본문과 태그 연결을 유지한 동일 일정 ID를 복구하며 삭제/복구 요청 ID로 응답 유실 재시도를 보호합니다. 전체 목록을 재조회하지 않고 영향받은 소유자의 일정과 위치 정보만 병합합니다. 실행취소 알림은 8초 표시하되 저장·다른 팝업 사용 중에는 만료를 멈춥니다.
- 주간 할 일 기준은 연간 업무의 `PropertyFilter`를 그대로 사용합니다. 작업(`title`)·팀원(`owner`)을 제외한 활성 속성의 값 검색·복수 선택·미지정·일치/제외·필터 해제를 공유하고, 텍스트·날짜·숫자 값은 기존 업무 API와 `taskQuery`로 한 번 조회해 재사용합니다. `matchesPropertyFilter`를 화면 필터와 서버 가져오기에서 함께 사용하므로 숫자 0·빈 셀·복수 팀원도 같은 규칙으로 판정합니다. 기준 가져오기는 대상 사용자가 `owner`인 업무에만 적용하며 지원자·검토자로만 참여한 업무는 제외합니다. 작업·팀원 속성은 화면에서 선택을 비활성화하고 서버에서도 저장·가져오기를 거절합니다.
- 주간 할 일의 직접 선택과 이번 주 기준 가져오기는 공통 `server/storage/calendar/calendar-service.mjs`를 거쳐 각 엔진 repository의 `addWeeklyItems`를 사용합니다. 내부 구현은 `server/storage/calendar/sqlite-calendar.mjs`, 외부 구현은 `worker/storage/calendar/postgres-calendar.mjs`가 소유합니다. `CalendarTaskPicker`는 공통 Modal(`wide`)·Button·검색 폼을 사용하고 원본 업무 ID만 선택합니다. 검색은 제목·연도·팀원·상태·문서 수 요약을 50개씩 조회하며 이전 검색을 취소하고 결과 키를 검사합니다. 속성 필터는 연간 업무의 `PropertyFilter`와 주간 할 일 기준의 값 목록 조회(`usePropertyFilterTasks`)를 재사용합니다. 조건은 `filters` JSON 한 값으로 보내고 두 저장소가 `matchesPropertyFilter`로 페이지를 나누기 전에 거릅니다. 주간 항목 삭제는 추가와 같은 권한으로 그 주의 연결만 지우고, 실행취소는 같은 업무를 이전 `importedAt` 위치로 다시 연결합니다. 원본 업무는 바꾸지 않으며 원본이 삭제된 항목도 되돌릴 수 있습니다. 외부는 tombstone을 남기므로 추가·가져오기는 tombstone을 없는 항목으로 봅니다. 응답 유실 후 재시도도 같은 주에 중복 연결을 만들지 않습니다. `Calendar`는 응답의 `weekly`를 대상 사용자·주에만 병합하고 원본 제목 수정도 기존 업무 상세 저장 경로를 재사용합니다. 과거·미래의 직접 선택, 서울 일요일 기준 가져오기 제한, 권한·중복·제목 연동은 API와 브라우저 테스트에서 검증합니다.
- 캘린더 문서는 기존 Markdown/revision 저장 형식을 유지한 채 `/calendar/entries/:id/document/events` SSE로 최신 저장본을 전달합니다. 구독·전송·주기 점검마다 세션과 팀 접근 권한을 재검사하고 재연결은 마지막 커서 이후 변경된 경우에만 최신 스냅샷을 받습니다. 같은 저장의 전송 본문은 한 번만 직렬화해 연결들에 공유하며, 각 연결의 현재 권한·revision은 별도로 검사합니다. `DocumentEditor`의 동기화는 모든 Markdown 문서에 기본 적용하며, `shared/documents/document-merge.js`로 독립적인 문자 구간을 병합하고 같은 부분의 상충하는 교체는 기존 충돌 UI에서 입력을 보존합니다. 저장 중 추가 입력·한글 조합·이미지 업로드는 보류한 원격 문서와 합칩니다. 리치 편집기는 최상위 블록 단위로 달라진 묶음을 찾아 묶음마다 바뀐 글자 구간만 교체하고(`document-markdown.ts`의 `replaceChangedBlocks`). 블록 비교는 화면 스레드에서 하므로 `document-merge.js`처럼 편집 길이 200·50ms 한도를 두고, 넘으면 이전처럼 첫 차이부터 마지막 차이까지 한 번에 교체합니다, 원격 변경을 로컬 실행취소 이력에 추가하지 않습니다. Git 동기화처럼 위·아래 여러 곳의 변경이 한 번에 와도 그 사이에서 입력 중인 블록은 교체 범위에 들지 않아 커서가 제자리에 남습니다. 병합한 원격 본문은 `DocumentEditor`가 준비된 편집기에 즉시 적용하므로(`RichMarkdownEditor`의 `useImperativeHandle` 핸들 `applyRemote`, 준비 전에는 기존 `remoteMarkdown` prop 경로), React 렌더링 전에 입력한 글자가 그 입력을 모르는 병합본에 덮이지 않습니다.
- 일정 생성은 저장 후 목록으로 돌아갑니다. 카드 우클릭은 공통 `GridHeaderMenu`를 쓰고, 복제는 새 UUID와 `/calendar/entries/:id/copy`로 기간·선택 태그·체크만 저장하고 제목에 번호를 붙입니다. 서버 트랜잭션에서 같은 소유자의 전체 날짜 이름을 확인하며 일반 생성과 같은 저장 함수를 사용합니다. 응답 유실 재시도에는 같은 UUID의 결과를 돌려줍니다. 본문은 복사하지 않습니다. 카드와 상세의 삭제는 `calendar-entry-actions.ts`를 공유하며 같은 실행취소로 복원합니다. 상세 제목은 공통 Modal의 `titleContent`에 배치하고 삭제는 하단에 둡니다. 제목이 비어 있으면 측정용 텍스트와 입력 placeholder에 같은 문구를 사용해 다시 클릭할 폭을 유지합니다. 모달 바깥에서 끝난 텍스트 선택은 닫기로 처리하지 않습니다. 태그 선택 목록은 클릭 처리 뒤 닫아 생성 버튼의 위치가 pointerdown과 pointerup 사이에 바뀌지 않게 합니다.
- 일정별 선택 태그 드래그·Alt+좌우 정렬은 기존 dnd-kit 구현 패턴과 태그 저장 API를 사용합니다. 순서는 기존 `calendar_entry_tags.position`에 저장하며 태그 정의 목록의 정렬·DB 버전은 변경하지 않습니다. 태그 체크·제거와 드래그 이벤트는 분리합니다.
- 체크 태그의 체크 상태는 일정별 연결에 저장합니다. 카드·상세는 `CalendarCheckTag`와 `calendar-tag-checks.ts`의 저장·병합 함수를 공유합니다. 체크박스는 카드 버튼 바깥에 배치하고 포인터·키보드 이벤트를 분리하여 드래그·상세 열기를 방지합니다. 체크 저장은 해당 필드만 갱신하며, 다른 저장 응답의 오래된 체크 상태로 덮어쓰지 않습니다.
- 캘린더 카드의 현재 행과 순서는 `calendar_entries.lane`에 저장합니다. `shared/calendar/calendar-layout.js`를 서버와 낙관적 화면 배치에서 공유하며 날짜 기준 재정렬 대신 겹치는 카드의 상대 순서를 보존합니다. 날짜 이동·기간 변경·삭제 뒤에는 전체 날짜 구간의 위쪽 빈칸을 채웁니다. 드래그 미리보기도 같은 배치 함수로 행을 계산합니다. 기존 카드와 날짜 칸은 움직이지 않으며, 공간이 부족한 주에서는 미리보기의 표시 위치만 그 주 안으로 제한합니다. 일정 7개 중 다섯 번째의 같은 날짜 순서 변경·빈 주와 채워진 주로 이동·여러 주 기간 확장은 브라우저 테스트에서 재검증합니다. 변경 전후 구간과 겹침으로 연결된 일정만 조회하고 구간 최댓값을 이용해 O(k log k)로 재배치합니다(`k`는 영향받는 일정 수). 시작일·종료일 인덱스로 연결 범위가 확장될 때 새로 닿는 날짜 띠만 읽으므로 긴 연쇄에서도 같은 행을 반복 조회하지 않습니다. 조회의 `layout`에는 화면 밖 연결 일정과 최대 61일 이동할 수 있는 좌표도 포함하며, 서버·미리보기·낙관적 배치가 동일한 좌표를 사용합니다. 월간 배치·정렬과 드래그 미리보기는 소유자별로 한 번 계산하고 주별 컴포넌트는 표시 구간만 자릅니다. 카드 본문을 같은 날짜에서 세로로 끌거나 Alt+Shift+위/아래 방향키로 순서를 변경합니다. 본문 드래그는 `useCalendarDrag`와 공통 `trackPointerDrag`를 사용하고, 순서 저장은 날짜를 변경하지 않습니다. 응답의 위치 정보는 같은 소유자의 캐시에만 병합하며 전체 캘린더 GET을 하지 않습니다. 순서·기간 변경은 한 트랜잭션에 저장하고 응답 유실 재시도에도 같은 위치를 유지합니다.
- 셀 스타일을 추가하면 화면·서버 검증·기본 서식·클립보드·XLSX 변환을 함께 확인합니다. 글꼴과 6~36pt 범위는 `shared/formatting/fonts.js`에서 정의합니다.
- 새 속성 동작은 기본값·설정 정규화·셀 검증·이관·필터·스냅샷을 함께 검토합니다. DB나 저장 형식 변경이 필요하면 [데이터베이스 변경 지침](DATABASE_CHANGES.md)을 따릅니다.
- 팀 테마는 `shared/formatting/themes.js`의 CSS 변수로 연결합니다. 사용자 지정 셀·칩 색상과 구분합니다.
- 캘린더의 `useCalendarTheme`는 밝기와 팔레트를 독립적으로 관리합니다. 카툰 외의 팔레트는 `shared/formatting/themes.js`를 재사용하고 캘린더에만 적용하며, 선택값은 기존 밝기 설정처럼 localStorage에 기억합니다. 팀 설정·DB 저장 형식은 변경하지 않습니다. 일정 추가의 바깥 클릭은 `Modal.onOutsideClick`에서 처리하고, 제목이 있을 때만 폼 제출과 같은 `saveCreating` 경로로 저장합니다. 빈 입력은 닫고, 태그만 있으면 제목 입력으로 돌아가며, 실패·조합 입력·중복 제출은 입력을 유지합니다. 닫기 버튼·Esc의 초안 보관은 그대로입니다.
- `#` 다음 여섯 자리 이슈 번호의 Redmine 링크는 현재 `shared/domain.js`의 `textLinks`에서 사내 주소를 사용합니다. 다른 설치처에 맞출 때 링크 규칙과 `tests/documents/text-links.test.mjs`를 함께 수정합니다.
- GraeBoard는 표시 브랜드입니다. DB 경로, 세션 쿠키, 쓰기 요청 헤더, 클립보드 MIME과 JSON 포맷 식별자는 `weekly-plan` 계열 값을 씁니다.

여러 탭의 실시간 구독은 `StreamBroker`를 SharedWorker에서 실행합니다. 채널 집합·필요 커서가 같으면 살아 있는 POST 연결을 유지하고, 추가·제거 시 재연결하더라도 기존 문서·리소스의 커서를 보내 변경 없는 초기 프레임을 생략합니다. 내부 Node의 `createDocumentEvents`는 무구독 중 변경도 추적하며 본문 없이 revision·전송 순서만 최대 10,000개 키까지 보존합니다. 메타데이터 퇴출이나 서버 세대 변경은 최신 스냅샷으로 복구합니다. 각 리스너는 자기 커서 이하의 재전송을 받지 않아 새 스냅샷을 과거 셀로 되돌리지 않습니다. 종료 사유 없는 `closed`와 `rejected` 5xx는 커서를 유지한 일시 종료로 처리하고, 백오프 동안 같은 연결의 정상 채널과 같은 청크의 후속 프레임은 계속 처리합니다. 사유 없는 부분 종료 대기 중 구독 추가·제거는 연결 재시도 시각에 반영합니다. `rejected` 5xx는 해당 채널에만 1.5~30초 백오프를 두며 기한 전 POST에서 제외합니다. 정상 채널·새 구독은 10ms 묶음 처리 후 연결하고, 별도 채널 타이머가 기한에 재연결을 예약합니다. 채널이 15초 이상 유지되면 해당 채널의 지연을 초기화합니다. EOF·네트워크·heartbeat 부재와 단독 `closed`는 기존 연결 단위 백오프를 쓰며 채널 지연과 독립적입니다. 마지막 구독 제거는 즉시 정리하고, 과거 커서로 새 리스너가 합류하면 재전송을 건너뛰지 않도록 먼저 연결을 끊습니다. `access-revoked`는 `{status}`를 전달하며 401은 세션 손실, 403·404는 권한 상실·삭제입니다. 상태 코드가 없는 기존 프레임은 403으로 해석합니다. 401 이외의 `access-revoked` 또는 비재시도 `rejected`가 선행된 종료만 해당 구독의 영구 종료입니다. 모든 리스너가 떠나면 그 키를 제거해 다음 구독은 새 채널을 만듭니다. HTTP 400의 `rejectedIds`만 종료하고 정상 채널은 실패 백오프를 늘리지 않고 다시 연결합니다. 요청 수준 HTTP 401은 전체 연결을, 연결 중 `access-revoked {status:401}`은 해당 채널을 세션 종료로 분류합니다. 문서·리소스 화면은 세션 종료에서 스트림을 닫지 않으며 문서 편집을 권한·삭제 오류로 막지 않습니다. `src/auth/Auth.tsx`·`SessionLogin.tsx`의 초기 로그인과 재인증 성공은 `resumeSession()`을 호출합니다. 워커의 `resume` 또는 페이지 내 fallback 브로커의 `resume()`이 스트림 키 변화 없이 모든 탭의 세션 종료 채널을 새 ID·보존 커서로 재승인합니다. 구독 없는 로그인 화면도 워커에 신호를 보내고 확인 응답 후 임시 포트를 닫습니다. 세션 종료 채널이 없으면 재연결하지 않습니다. 셀 복구 등 새 스트림 추가·재합류에 의한 기존 재승인도 유지합니다. 반복 전송 실패는 1.5~30초 백오프하고, 셀 스냅샷 복구와 셀의 `rejected` 5xx도 SSE `ready`를 받기 전까지 1~30초 백오프를 유지합니다. 문서·리소스 구독의 비재시도 거부는 기존 접근 거부 처리로 정리하고, 5xx 복구는 브로커가 맡습니다. 워커 대기열 4MiB 초과·리스 만료는 페이지에 즉시 재구독을 요청합니다. 미지원 환경도 같은 브로커를 페이지 안에서 사용합니다. 탭은 `EventStream` 인터페이스를 유지하므로 셀·문서·목록의 기존 동기화 호출부를 재사용합니다. 배포 시 서버와 빌드 결과를 함께 갱신하고 기존 탭을 새로고침합니다. 서로 다른 빌드의 워커 URL은 별개이므로 이전 탭은 새 워커에 자동 합류하지 않습니다.

외부 문서의 GET·PUT·충돌 응답·SSE에는 같은 PG 문서 revision 기준의 `sync`를 사용합니다. SSE 전송 커서 `pg:<site_events cursor>`와 문서 `sync.sequence`는 서로 다른 순서이므로 비교하거나 덮어쓰지 않습니다. `worker/events/events.mjs`는 `payload.sync`를 보존합니다. 열린 연간 메모·업무 문서에서 변경을 누락하지 않도록 실제 Edge handler → PG 조회·저장·SSE 경로와 리치/Markdown 편집 화면을 함께 확인합니다. [실시간 동기화 계약](DATA_FORMAT.md#실시간-동기화)

### 색 선택

`ColorMenu`·`ColorPicker`는 셀 글자·배경, 테두리, 속성 값·점, 주차 머리글, 아바타에서 공통으로 사용합니다. 기본 팔레트 아래에 HEX 입력과 브라우저 기본 색 선택기를 두며, `EyeDropper`가 있는 브라우저에서는 스포이드를 제공합니다. 기본 선택기의 `input`은 HEX 초안만 갱신하고 네이티브 `change`에서 호출자의 기존 적용 경로를 한 번 실행합니다. 설정·프로필의 명시적 저장과 원본·사본의 실행취소 흐름은 유지합니다.

`RecentColorsProvider`는 로그인 사용자별 `weekly-plan:recent-colors:<userId>`에 정규화한 HEX를 중복 없이 최대 6개 보관하고 `storage` 이벤트로 다른 탭을 갱신합니다. 캘린더 태그는 기존 고정 색 ID를 저장하므로 별도 팔레트를 유지합니다. 자체 채도·명도 선택기를 도입했다가 되돌린 과정은 [색 선택 이력](DEVELOPMENT_HISTORY.md#색-선택)에 있습니다.

### 시크릿 캘린더

`src/calendar/secret-calendar.ts`·`useSecretCalendar`는 사용자별 localStorage에 시크릿 일정의 제목·기간·태그 연결·체크·표시 순서와 보이기 선택을 저장합니다. 본인 개인 월간과 팀 주간의 본인 줄에 표시 전용으로 합치며 서버 일정의 저장 순서는 바꾸지 않습니다. 사용법과 저장 범위는 [시크릿 일정 안내](USER_GUIDE.md#시크릿-일정)를 따릅니다.

`DocumentEditor`는 선택적 `DocumentStorage`로 조회·저장·이미지·구독 경로를 주입받으며, 미지정이면 기존 API·SSE를 사용합니다. `src/calendar/secret-document-storage.ts`는 사용자별 IndexedDB v2의 `documents`에 본문·revision·이미지 메타데이터를, `images`에 이미지 바이트를 분리해 저장합니다. 로컬 자료는 서버·Git 동기화·DB 백업에 포함하지 않으며 브라우저 저장소를 지우면 사라집니다. 구버전 저장소 이전과 정리 검증은 [시크릿 캘린더 이력](DEVELOPMENT_HISTORY.md#시크릿-캘린더)에 보존합니다.

### 모바일

모바일 배치는 기존 700px 경계를 사용하고, 터치 입력 판정은 화면 폭과 별도로 처리합니다. 연간 표는 데스크톱에서 `overflow-x: hidden`과 `SheetHorizontalScroll`의 별도 가로 스크롤 막대를 쓰지만, `(hover: none) and (pointer: coarse)` 기기(휴대폰·태블릿)에서는 표 자체의 가로 스크롤을 켜고 막대를 숨겨 브라우저가 가로·세로 이동을 모두 처리합니다. 스크립트로 정한 가로 위치는 iOS의 다음 세로 스와이프에서 왼쪽 끝으로 되돌아갈 수 있어서입니다. 스크립트 가로 이동과 그 터치 리스너는 표가 가로 스크롤을 숨긴 경우에만 등록합니다. iOS는 16px보다 작은 입력칸(15px 문서 본문 등)에 포커스하면 화면을 확대하고 편집이 끝나도 되돌리지 않아, `main.tsx`가 iOS WebKit(`CSS.supports("-webkit-touch-callout", "none")`)에서만 viewport에 `maximum-scale=1`을 더합니다. iOS는 이 값이 있어도 손가락 확대를 허용하며, 다른 브라우저는 손가락 확대가 막히므로 적용하지 않습니다. 모바일의 문서 탭 순서 변경은 탭 메뉴의 왼쪽·오른쪽으로 이동을 사용합니다(탭 줄의 손가락 스크롤과 겹치지 않도록 터치 끌기는 받지 않음). `useTouchPress`로 시트·일정의 길게 누르기 메뉴를 공유하며 스와이프·스크롤·취소가 선택이나 편집으로 이어지지 않도록 합니다. 모바일 문서는 `useDocumentFullPage`에서 전체 화면·전체 너비를 파생하고 데스크톱에 저장된 선택은 유지합니다. 문서 서식·블록 이동 도구는 숨기며 원문/리치 전환·다운로드·목차는 남깁니다. 모바일 진입 때 편집 모드를 강제로 바꾸지 않습니다. 입력란과 contenteditable의 최소 글자 크기는 16px이며 사용자 핀치 확대는 제한하지 않습니다. 가로 문서 탭의 터치는 브라우저 스크롤에 넘기고 마우스 드래그·Alt+방향키·메뉴로 순서를 변경합니다. 현재 사용법은 [업무 문서](USER_GUIDE.md#업무-문서), 실제 기기와 자동 검사 범위는 [모바일 검증 이력](DEVELOPMENT_HISTORY.md#모바일)을 참고합니다.

## 검증

```sh
npm run check:structure
npm run check:architecture
TEST_PG_BIN=/절대경로/PostgreSQL/bin npm test
npm run build
npm run build:edge
npx playwright install chromium firefox webkit
npm run test:e2e
```

작은 기능 수정의 반복 확인에는 빌드 후 `npm run test:e2e:core`로 행/셀·사본·화면 전환·캘린더·문서 입력/동기화/내보내기의 핵심 spec을 3개 엔진에서 실행합니다. `-- --project=chromium`으로 개발 중 범위를 줄일 수 있습니다. 큰 구조 변경의 완료 전에는 `npm run test:e2e` 전체와 수정 기능의 실패·권한·취소 경로를 확인합니다.

전체 Node/PG 검사와 전체 브라우저 검사는 같은 머신에서 순차 실행합니다. 무거운 Git·DB 작업과 여러 브라우저가 겹치면 장애 주입이나 동기화 검사의 제한시간에 영향을 줄 수 있습니다. 실패를 부하 탓으로 단정하거나 제한시간을 늘리지 말고, 동일 소스를 단독 재실행해 결과를 비교합니다. 브라우저를 `--project`·`--shard`로 나누는 경우에는 실행별 `E2E_PORT`·결과 경로를 구분하고 모든 조합의 누락·중복을 확인합니다. 검증 중 구현을 계속해야 한다면 소스·테스트·빌드를 고정한 독립 사본을 사용합니다. 수집 수·실행 수·통과·실패·취소·skip과 재실행 결과를 구분해 기록합니다.

`npm test`와 `npm run test:postgres`는 `scripts/testing/node-test-files.mjs`의 공통 재귀 수집기를 사용합니다. `node scripts/testing/run-node-tests.mjs --list`로 실행 목록을 확인합니다. `tests/`의 일반 `*.test.mjs`만 정렬해 수집하며 `browser/`, `support/`, 모든 `fixtures/` 하위와 symlink는 제외합니다. #100 통합 기준 `ad1e57d`의 기존 Node suite 114개에 P0 도구 검사 2개를 별도로 추가했습니다. 이후 책임 분리와 인사이트를 포함한 현재 목록은 위 수집 수를 따릅니다. PR #103의 대형 충돌 회귀는 같은 `data-sync.spec.ts`에 있습니다. `tests/support/worker-sheet-clone-sync-deno.mjs`는 수동 Deno 검사이며 Node suite가 아닙니다.

`check:structure`는 Git 추적·미추적(제외되지 않은) 소스의 명명·폴더·정확한 기존 예외와 고정 바이트를 읽기 전용으로 검사합니다. 규칙은 `scripts/testing/code-organization-rules.json`, 전체 608개 이동 대응표와 신규 파일은 `docs/code-organization-moves.json`에 있습니다. `--migration-phase P3` 같은 옵션은 #100의 해당 시점 checkout에서 이동 기록을 재현할 때만 사용합니다. 후속 책임 분리·신규 기능이 포함된 현재 HEAD는 기본 `check:structure`로 검사하며, 과거 manifest 목록으로 새 기능을 제한하지 않습니다. `check:architecture`는 `src/shared/server/worker/edge/functions`의 정적 런타임 import·re-export·문자열 dynamic import를 수집해 순환, UI/통신 기반의 화면 역참조, 기능의 App 역참조, 브라우저의 간접 Node/호스트 의존을 검사합니다. 타입 전용 import는 런타임 순환에 포함하지 않으며 npm 패키지 내부·실행 시 계산한 import 경로는 이 검사의 범위 밖입니다. 외부 저장소 검사도 `edge/` 진입과 간접 의존을 포함합니다. PR의 경량 CI는 구조·도구·import 경계·고정 전환 의존성 격리를 검사하며 아래 DB·빌드·브라우저 검증을 대신하지 않습니다. import 경계는 공통 업무 14개·portable sync 16개를 정확한 경로로 관리하고, 허용 서비스 뒤의 간접 의존에서도 SQLite·파일·프로세스 모듈 제한을 검사합니다.

`TEST_PG_BIN`은 실행 가능한 PostgreSQL 서버 바이너리 경로로 바꿉니다([외부 동기화 개발·검증](#외부-동기화-개발검증)). `npm test`는 임시 DB에서 API·권한·동시 수정·이관·백업/복구·이슈 링크를 검증합니다. `DEBUG_HTTP=1`로 실행하면 서버가 거절한 요청(4xx)의 경로와 사유를 콘솔에 남겨 테스트 실패 원인을 바로 볼 수 있습니다. `npm run test:e2e`는 별도 임시 서버와 DB를 만들고 Chromium·Firefox·WebKit에서 실제 UI를 조작합니다. `4311` 포트를 사용하며 실행 중에는 앱·테스트 소스를 바꾸지 않습니다. Linux 환경에서 브라우저 시스템 의존성이 없다면 `npx playwright install --with-deps chromium firefox webkit`를 사용합니다.

실패한 브라우저 검사는 `test-results/`에 스크린샷·트레이스를 남기고 HTML 보고서는 `playwright-report/`에 생성됩니다. 이 파일들은 Git에서 제외합니다. 테스트 데이터는 코드에서 생성한 가상 업무·계정이며 운영 DB를 사용하지 않습니다.

필요한 경우 다음 보조 명령을 실행합니다.

```sh
npm run performance
npm run performance:stress
npm run licenses
```

성능 명령은 임시 DB에 큰 데이터 집합을 생성하여 조회·저장·렌더링을 측정하고 `docs/validation/`에 로컬 결과를 저장합니다. `npm run performance:ui`는 빌드 후 Chromium에서 화면 처리 시간을 측정해 콘솔에 출력합니다. 문서의 날짜가 붙은 수치는 해당 시점의 로컬 측정 기록이며 현재 릴리스의 검증 결과나 운영 환경의 용량·지연시간 보장이 아닙니다. `docs/validation/`은 Git 제외 경로이므로 새로 clone한 저장소에는 과거 결과 파일이 없을 수 있습니다. 라이선스 명령은 잠금 파일과 설치 패키지에서 [고지 목록](THIRD_PARTY_NOTICES.json)과 [원문](THIRD_PARTY_NOTICES.txt)을 갱신합니다.

`performance:stress`는 1천·1만·2만 업무를 별도 서버 프로세스에서 검증합니다. 53주 일정 열의 점유율은 각각 30%·30%·100%이며, 마지막 시나리오는 128만 셀입니다. 100개 가상 계정 중 30개 세션의 동시 조회·저장, 변경 없는 조회, 2천 셀 서식 변경, 동일 셀 충돌, Chromium의 검색·묶음·스크롤·편집 후 재조회를 확인합니다. 클라이언트의 동시 응답은 스트리밍으로 소비하여 테스트 도구가 대용량 JSON을 중복 보관하지 않게 합니다. 실제 사용자 데이터는 사용하지 않습니다.

특정 규모만 실행하려면 `npm run performance:stress -- 10000:30`처럼 `업무수:일정점유율`을 전달합니다. 결과는 `docs/validation/load-test-results.json`, 화면은 같은 폴더에 저장합니다. Node.js 22.13.0 이상과 설치된 Chromium이 필요하며, 2만 업무 시나리오는 수 GB의 메모리를 사용하므로 운영 서버와 분리해 실행합니다. 30개 HTTP 세션과 한 브라우저의 검증이며, 30개 브라우저 동시 사용이나 사내 네트워크의 지연시간을 측정하는 검사는 아닙니다.

검증 한계: 클립보드 자동 검사는 합성 이벤트와 브라우저 API 대역을 포함하므로 외부 Excel·OS 클립보드의 모든 조합을 보장하지 않습니다. 운영 서버의 HTTPS·프록시·재시작 설정, 백업 복구 시간과 실제 사용 데이터 규모에서의 동작은 배포 환경에서 별도로 점검합니다. 내부 인증은 로컬 계정·세션 방식이며 외부는 전용 Cloudflare Access JWT와 앱 사용자·팀 권한을 검증합니다. 실제 Cloudflare Access/Images/Supabase 계정 배포와 모바일 실기기의 OS 키보드·터치 동작은 로컬 브라우저 검증과 구분합니다. 릴리스마다 실행한 검사와 결과를 기록하고 과거 통과 건수를 현재 결과로 재사용하지 않습니다.

### 고정 전환 소스의 개발·CI 검증

최신 앱에서 `TEST_PG_BIN=/절대/PG/bin npm run test:cutover:frozen`을 실행하면 Git 커밋 `7fec065d1adc241da29d54474af06b390d12d72b`의 전체 소스를 임시 디렉터리에 재현하고 원래 전환 2개 suite를 변경 없이 실행합니다. `tests/support/frozen-cutover-source.json`은 원래 16개 보호 hash와 lockfile hash를 보존합니다. 고정 checkout 자체의 lockfile로 `npm ci --include=dev`를 실행하며 현재 앱의 `node_modules`를 공유하지 않습니다. `npm test`·`test:postgres`는 실행 시작 시 한 번 준비한 고정 의존성 트리를 자식 검사에 전달합니다. 전달된 경로의 고정 lockfile hash·설치 표식(Node 버전/OS/아키텍처)과 실제 디렉터리를 확인합니다. 현재 앱 lockfile이 달라도 고정 도구는 원래 의존성을 사용하며, 설치나 검증 실패는 즉시 실패로 처리합니다. npm 캐시가 없으면 최초 준비에 네트워크가 필요합니다. Node는 최소 22.13 이상이고 실제 실행 버전을 기록합니다. shallow clone은 `git fetch origin 7fec065d1adc241da29d54474af06b390d12d72b`으로 준비하며 CI checkout은 `fetch-depth: 0`을 사용합니다. 커밋·hash·PG 누락은 skip으로 성공 처리하지 않습니다.

`TEST_PG_BIN=/절대/PG/bin npm test`는 기존 권한·migration 회귀와 `sheet-clone-frozen-compatibility.test.mjs`의 현재 앱 교차 검증을 실행합니다. 후자는 고정 도구의 실제 전환 결과를 최신 SQLite/외부 PostgreSQL API에서 읽고 수정하며, 동기화 재개·protocol 4 전환·신규 사이트 checkpoint 합류·복구까지 검사합니다. 현재 앱 교차 검증도 `TEST_PG_BIN`을 명시해야 하며 누락은 명시적 오류입니다. 원래 고정 도구 검사의 통과와 현재 앱의 호환성 결과는 따로 집계합니다. 운영 전환·배포는 실행하지 않습니다.

## 저장소 범위

소스, 잠금 파일, 테스트 코드, 실행 안내와 데이터 명세를 관리합니다. DB·백업·반출 파일·실제 환경 설정·로그·스크린샷·원본 시트가 참조된 초기 RFP는 Git에 포함하지 않습니다. `.env.example`에는 비밀값 없이 설정 항목만 제공합니다.

## 연간 업무 인사이트

`/insights`는 `src/app/useWorkspaceNavigation.ts`의 prepare/저장 조정과 `useWorkspaceRoute.ts`의 URL·방문 기록을 거쳐 연간 업무·문서·캘린더와 전환합니다. `src/insights/`는 고정 통계·팀 차트 7종·설정/편집기·필터·drill-down을 소유하며 `ColorMenu`/`ColorPicker`, `PropertyFilter`, `Modal`/`Button`/`Select`, `Toast`/`ErrorNote`, `useListReorder`, `useTodayKey`를 재사용합니다. App의 `annualHeading`·`dateControls` JSX를 연간/인사이트가 공유합니다. 상단 주 메뉴의 인사이트 텍스트 대신 전체 통계 오른쪽 `ChartColumn` Button을 사용하며 동일 prepare 경로로 열고 닫습니다. 모바일에서 숨기는 heading-actions 밖에 아이콘을 두고 활성 상태·툴팁을 제공합니다. 기존 `PeriodPicker`에 같은 View·changeView·moveYear·moveCalendar를 전달하고 연간의 발표/가져오기/내보내기·서식/검색 도구는 보고서에 노출하지 않습니다. 보고서의 속성 필터·인사이트 설정은 공유 날짜 선택기 오른쪽 같은 행에 함께 배치합니다. App이 날짜 행의 호스트를 제공하고 Insights는 기존 상태·권한·저장 이벤트를 유지한 채 버튼을 portal로 배치합니다. 보고서에만 적용하는 flex 규칙으로 모바일에서도 버튼을 함께 유지하고 날짜 영역만 가로 스크롤합니다. 속성 필터 팝업은 기존 `usePopover`의 별도 portal로 overflow 밖에 띄워 `PropertyFilter`·뷰포트 배치·Escape/포커스 복귀를 그대로 사용합니다. 연간 Toolbar의 업무 색별 가방 버튼은 `{backgroundColor, work:true}`를 즉시 적용하며 일반 ColorPicker에는 업무 프리셋을 전달하지 않습니다. 업무 색상 편집기는 `src/settings/WorkColorsEditor.tsx`가 소유하며 팀 일반의 ThemePicker 바로 아래 한 곳에만 놓고, 인사이트 설정은 상단 통계와 목표일 기준을 편집합니다. 실제 업무 상세는 원본 시트의 기존 RowPanel로 엽니다. 현재 순환 달력에 이미 포함된 다음 해 업무는 기준 연도를 바꾸지 않아 날짜 선택을 유지하며, 현재 자료 밖의 업무만 필요한 연도로 이동합니다.

PDF 출력은 `Insights.tsx`의 공유 날짜 행 다운로드 Button에서 `insights-export.ts`로 전달합니다. 입력 경계는 보고서 제목·팀·연간 보기 설명·정확한 period.weeks·실제 적용 필터·현재 렌더링된 보고서 본문입니다. 클릭 시 동기적으로 DOM을 복제하여 비교/레이더/속성 통계의 실제 선택과 같은 aggregate 결과를 고정하고, 인쇄 자원 대기 중 들어오는 SSE 결과와 섞지 않습니다. 조회·캐시·집계·설정 저장 소유자를 추가하지 않습니다. 화면 본문 밖의 설정/편집/드릴다운/알림과 카드 도구는 출력하지 않으며, select는 현재 선택한 이름으로 바꾸고 수치 버튼은 정적 텍스트로 바꿉니다. 사용자 문구와 메타데이터는 DOM textContent로 작성해 HTML로 해석하지 않습니다. 빈 선택은 0/없음으로 표시하지만 미설정·미완료 조회·조회 오류·aggregate.errors 상태를 정상 보고서로 내보내지 않습니다. 읽기 권한으로 출력하며 revision/PATCH는 호출하지 않습니다.

`InsightsChartData.tsx`는 SVG와 같은 aggregate의 모든 실제 행/계열/0·제외 수·전체 원값을 inert template의 출력용 표로 제공합니다. 화면 DOM/접근성 검색에는 중복 표를 노출하지 않고, 클릭 시 복제한 template 내용만 인쇄 본문으로 펼칩니다. `insights-print.css`는 화면의 scroll/sticky/최대 높이와 모바일 미디어 규칙을 덮어 A4 가로 페이지를 만들고, 넓은 매트릭스의 열 묶음은 머리글/책임자 행과 기존 교차값·합계를 그대로 복제합니다. 합계를 다시 더하거나 출력용 집계를 만들지 않습니다. 긴 가로 막대 SVG는 행 사이에서 나누고 전체 이름/숫자는 부속 표에 보존합니다. 수치·단위·농도/계열 범례·경고·정확한 선택 주차와 생성 시각을 포함합니다. 기본 PDF 저장 대화상자의 대상·배경 그래픽·배율은 브라우저가 결정하므로 자동 바이너리 다운로드라고 표시하지 않습니다.

표 앞의 제목·필터/경고 문단·농도 범례와 scroll wrapper는 인쇄 전용 keep-with-next 규칙을 연결하여 머리글과 첫 데이터 행까지 같은 페이지에 둡니다. Chromium은 네이티브 table-caption을 본문과 분리할 수 있으므로 분할 매트릭스의 열 묶음명은 표 직전 `h4`와 그 표의 접근성 이름으로 제공합니다. 소제목의 keep-with-next는 해당 표의 머리글·첫 행까지 연결하며 원래의 행·교차값·합계는 그대로 유지합니다. 표 전체나 긴 카드 전체에 break-inside 금지를 적용하지 않으며 나머지 행은 계속 다음 페이지로 나눕니다.

`tests/browser/support/insights-pdf-pagination.mjs`는 실제 Chromium PDF를 Poppler `pdftotext`로 읽어 Top50 제목과 여섯 매트릭스 열 묶음명 각각의 페이지에 해당 열 머리글과 전체 첫 행이 함께 있는지 검사합니다. 제목 **뒤부터 첫 행 전까지**의 머리글만 확인하므로 앞 표의 문구가 잘못 통과시키지 않습니다. HTML의 높이만으로 통과시키지 않으며 Top50 섹션의 모든 39개 합성 업무도 직렬화된 PDF에서 확인합니다. 이 Chromium 브라우저 검사에는 PATH의 `pdftotext`가 필요합니다(macOS: `brew install poppler`, Linux: `apt-get install poppler-utils`). 도구가 없으면 명시적으로 실패하며 skip하지 않습니다. 런타임 PDF 방식·라이브러리·서버를 추가하는 의존성이 아닙니다.

문서/인사이트가 함께 사용하는 `platform/browser-print.ts`는 폰트 규칙 URL 정규화, iframe/자원 대기·20초 자원 오류 제한·인쇄 창·호스트 제목·afterprint/포커스 복귀·취소/실패 정리를 소유합니다. 문서의 Markdown/Milkdown 렌더링은 여전히 `documents/document-export.ts`에 있습니다. 보고서는 동시 요청을 막고 화면 이탈 시 AbortSignal로 프레임을 정리하며, 출력 때문에 사용자 날짜·필터·차트 설정을 쓰지 않습니다. 현재 단일 보고서의 렌더링 입력을 받으며 계획 중인 여러 reports/템플릿 저장 계약·마이그레이션은 구현하지 않습니다. import graph는 Vite의 정확한 `.css?inline` 자산 import를 실제 CSS 파일 의존성으로 해석하며, 없는 CSS와 JS/TS query는 계속 실패합니다. 런타임 계층·순환 검사 예외를 추가하지 않습니다.

`shared/insights/insights.js`는 서식 상속을 포함한 순수 계산, `insights-schema.js`는 내부 Node/외부 Edge 설정 저장과 브라우저 편집기의 strict 계약입니다. 기간은 기존 연간 View의 개인 보기 저장/450ms debounce를 그대로 사용하고 보고서 속성 필터만 사용자·팀별 sessionStorage에 둡니다. 속성·차트 필터 목록(`InsightsFilters`)은 값이 업무마다 다른 `title`·`description` 열을 표시하지 않으며, 이미 저장된 필터의 해석은 바꾸지 않습니다. 이전 Insights.period는 읽지 않습니다. `periodForWeeks`가 실제 visibleWeeks의 key/year/month를 내부 period.weeks에 복사하며, 월·주 범위/숨김/접힘/빈 선택과 순환 달력 경계의 표시 월을 집계·착수/완료 기준·드릴다운에 공유합니다. 이는 저장 차트나 DB 필드가 아닙니다. 레거시 월 전용 순수 계산 문맥은 그대로 허용합니다. 팀별 WeakMap이 변경 없는 업무의 주 목록·파생값을 재사용하고 업무/색 집합/선택 주차와 표시 월/KST 이번 주/목표일 기준 변경 때 무효화합니다.

연간 표·머리글·인사이트는 같은 `useTaskData`의 원본 목록을 사용합니다. 기존 `taskQuery(teamId, year, startMonth)` 한 요청이 서버에서 실제 달력의 한두 연도를 중복 없이 읽으며, 보고서별 연도 조회·poll·SSE 훅은 없습니다. `useTaskData`는 조회 범위/세대·로컬/원격 변경·취소를 검사하고, `cell-updates.js`의 스냅샷 병합은 변경 없는 행 객체를 재사용해 보고서의 파생 캐시도 유지합니다. 헤더의 원본 통계와 보고서는 이 공개 목록을 함께 읽으므로 보고서에서 App의 private ref를 수정하지 않습니다. 인사이트 설정 저장을 시작하면 공개 `invalidate`를 호출하고 읽기를 보류하며, 이미 시작한 bootstrap 응답도 그 사이 적용된 최신 설정을 덮어쓰지 않습니다. `snapshot()`은 기존 Task[] 계약을 유지하며 private cursor/큐를 노출하지 않습니다. 모든 훅은 팀 없음 조기 반환 전에 호출합니다. 빈 팀 필터 조회는 담당 `useSavedFilters`에서 생략하고, 재배정은 기존 포커스/bootstrap·설정/구성원 저장 흐름을 사용합니다.

주차 Monday 연도나 선택 표시 월로 원본 조회 연도를 추측하지 않습니다. 따라서 2000년 첫 주에 1999년 API를 호출하지 않고, 2026년 업무의 마지막 주가 순환 달력의 2027년 1월로 표시돼도 갱신 후 보존합니다. 같은 원본 연도 집합 안의 날짜 선택은 조회/오류 대기를 재시작하지 않고 계산 문맥만 바꿉니다. 캘린더 전환 때 원본 셀 구독·poll을 해제하고 복귀 시 같은 담당 훅이 재개합니다. 별도 집계 API나 차트 라이브러리는 없습니다. 계산·카디널리티·백분율·합계 규칙은 [데이터 형식](DATA_FORMAT.md#인사이트-팀-설정)을 따릅니다.

`InsightsComparison.tsx`는 요약 아래의 책임자×선택 속성 비교를 소유합니다. 기본값은 활성 분류→category→상태 외 선택 속성→첫 선택 속성이며 업무 수·작업 주 합·숫자 합을 고를 수 있습니다. 기존 table 정의와 하나의 aggregate 결과를 매트릭스/가로 누적으로 전환하고 현재 기간·PropertyFilter·업무 표식을 그대로 따릅니다. `InsightsMatrix.tsx`는 저장된 두 기준 표에도 같은 농도·행/열/전체 합계·고정 머리글/행 이름을 적용하고 값 1~4개의 범례를 분리합니다. 단일 기준 표는 기존 통계 표로 유지합니다. `InsightsBarChart.tsx`·`InsightsRadarChart.tsx`는 0 기준 눈금·값과 실제 음수 위치를 그리며 0 막대 길이를 부풀리지 않습니다. 평균·비율·최댓값·계열 안 %는 누적하지 않습니다. 색·수치·농도/대비는 `insights-chart-presentation.tsx`, 기존 필드로 만든 빠른 시작은 `insights-chart-templates.ts`에서 재사용합니다. 선택형/책임자 계열 색은 전체 옵션/사용자 목록을 기준으로 정해 필터 변화로 바뀌지 않습니다. 유효하고 구분되는 옵션/사용자 색을 먼저 사용합니다.

aggregate의 내부 `rowTotals`는 열/전체와 같이 업무 ID·주차 집합에서 다시 계산합니다. `ChartCell.scope`는 교차값·row·series·grand의 기여 업무를 기존 drillDown→목록→연간 RowPanel로 전달하며 API/저장 필드가 아닙니다. 서로 다른 열 분모의 %는 행 합계에서 원값으로 표시합니다. `insights-matrix.test.mjs`는 교차값/0·보관/누락·중복 제거·평균/비율/숫자 제외·필터/기간·행/열/전체 드릴다운을 독립 기대값으로 검사합니다. 브라우저는 실제 비교 조작부, 정확한 사람×분류 목록과 연간 상세, 양쪽 표시, 빠른 시작 저장/편집, 0/음수 도형, 다섯 테마 대비와 1404·390·360px 스크롤/고정 열을 검사합니다. 매트릭스의 표시 방식·합계·드릴다운은 기존 차트 필드를 사용하며 별도 저장 형식이나 마이그레이션을 추가하지 않습니다.

선택형/숫자 후보는 활성 팀의 속성 ID·종류·이름·값에서 구합니다. 분류 이름/category ID는 기본 선택 우선순위뿐이며 값·팀원을 하드코딩하지 않습니다. 고정 속성별 통계의 선택 속성이 사라지거나 Option이 아니게 되면 유효한 Option으로 돌아갑니다. 비교·레이더도 유효한 활성 선택으로 해석하고 숫자 후보는 Number 또는 실제 파싱 가능한 Text만 제공합니다. 일반 count/workWeeks/duration/status는 공통 지표이며 Date는 목표일 기준입니다. 저장 차트의 참조는 보존합니다. 보관 참조는 경고와 과거 값을 유지하고, 누락·종류 불일치는 해당 차트의 집계를 중단해 재선택을 안내합니다.

`InsightsAnalysis.tsx`는 매트릭스 아래의 업무 개수 추이·월별 작업량·책임자별 업무 비중·업무 기간 분포·목표일 준수 현황을 소유합니다. 같은 tasks/ctx와 aggregate/렌더러/드릴다운을 사용하고 기존 저장 차트를 변경하거나 시드하지 않습니다. 작업 월 막대는 실제 선택 주차가 있는 표시 월/분기의 0을(선택이 비면 월 축도 비움), 기간 막대는 실제 4개 기간 구간을, 목표일 막대는 범위 내 업무의 실제 6개 상태를 유지합니다. 작업 없는 업무는 기본 분석의 분모에 넣지 않으며 목표일 없음은 별도 상태입니다. 월 눈금은 월·연도를 나눠 표시합니다. 숫자 leaf 머리글·값의 오른쪽 정렬/안쪽 여백과 이름·상태의 왼쪽 정렬은 인사이트 표에만 적용합니다.

`InsightsPeopleRadar.tsx`는 초기 업무 수 상위 3명(동률은 ID)과 사용자의 명시적 사람/속성 선택을 소유합니다. 일반 SSE 갱신은 선택을 바꾸지 않습니다. 실제 owner PropertyFilter를 검색/일치/제외/해제에 재사용하고, 내부 선택은 저장 설정이 아닙니다. count/series %의 분모는 현재 기간·필터 내 각 책임자의 고유 업무 수이며 0이면 0%입니다. 관측 없는 선택자는 0 계열로 표시하되 축은 실제 활성/관측된 보관·누락 값만 사용합니다. 축 3~12/사람 8명 밖이면 기존 table 정의로 같은 원자료를 다시 집계하며, 자료가 없으면 빈 상태를 표시합니다. 레이더 빠른 시작도 같은 정의와 상위 3명 owner 필터를 기존 차트 필드로만 만듭니다.

팀 차트만 `useListReorder(..., "grid")`로 참여합니다. `list-reorder-grid.ts`는 변경하지 않은 카드 경계로 2차원 대상/빈 간격을 찾고, sparse row-major 배치·실제 열 폭·gap·행 최대 높이로 이동 카드의 미리보기 칸을 계산합니다. 호버 중 실제 카드를 재배치하지 않고 overlay는 pointer-events:none이므로 hit test를 흔들지 않습니다. 같은 Y의 가로 이동도 임계값을 넘으면 시작하고 실제 유효한 순서 변경만 기존 settings PATCH/CAS로 저장합니다. 활성 grid 드래그 동안만 카드/컨테이너 ResizeObserver와 scroll/resize를 관찰해 실시간 크기 변경도 반영합니다. 취소·blur·pointercancel·ID 목록/disabled 변경·unmount는 공통 trackPointerDrag가 정리하고 observer/이벤트도 해제합니다. 캡처 해제만으로는 취소하지 않는 기존 브라우저 복구 동작은 유지합니다. 속성 값·주간 업무·업무 색상·메모 탭의 기존 vertical/horizontal 경로와 Alt 방향키는 유지합니다. `insights-reorder.test.mjs`와 실제 포인터 브라우저 검사에서 미리보기 경계/저장 순서, 혼합 폭·높이·간격과 실시간 변경, 취소·권한·CAS를 확인합니다.

`Style.work`는 선택적인 boolean/null이며 `STYLE_KEYS.work = "wk"`로 같은 사전·저장 경로를 사용합니다. 일반 배경색은 `backgroundWorkStyle`로 업무 의미도 교체하고, 개별 셀 정규화는 상속된 true를 취소하는 false를 남깁니다. 공통 서식의 색·work 적용 순서와 초기화 tombstone을 함께 처리하며 PG도 SQLite와 같은 초기화/재적용 우선순위를 사용합니다. 글자·테두리는 값을 보존하고 브러시·행 복사·셀 클립보드(JSON/HTML)는 표식을 전달합니다. `insights-work-marker.test.mjs`는 해석·상속·strict/compact·복사/초기화를, 실제 양쪽 HTTP와 백업 계약은 `insights-storage-contract.test.mjs`, Git 왕복은 `sync-calendar-documents.test.mjs`에서 확인합니다. 기존 무표식 자료는 외형만 유지하고 집계하지 않으며 자동 보정하지 않습니다.

연간과 인사이트가 공유하는 `useTaskData`는 `useSite()`와 기존 `queryPolicyFor`를 따릅니다. 보이는 탭에서 성공 후 내부는 7초, 외부는 30초 주기로 확인합니다. 일반 오류는 내부 7초, 외부 5·10·20·40·60초(상한)의 연속 실패 대기를 사용하며, 429는 `ApiError.retryAfterMs`와 지수 대기 중 긴 값을 적용합니다. 같은 팀·연도 범위의 SSE·포커스·주기 재시도는 그 시각 전에는 업무/설정 HTTP를 보내지 않습니다. 원본 업무와 bootstrap을 함께 공유·취소하고 병렬 오류 중 가장 긴 대기를 보존합니다. 명시적 다시 조회 버튼만 대기를 초기화하며 자동 알림은 대기 시각을 유지합니다. 필요한 연도가 달라지면 새 범위를 즉시 조회하며 이전 범위의 오류가 새 범위를 막지 않습니다. 기존 Workspace의 탭 복귀 시 회원정보 확인 bootstrap 1회는 별도 흐름으로 유지합니다. 숫자 레이더의 저장된 차트와 편집 미리보기에도 막대와 같은 `제외 N건` 표시를 사용하며 빈값은 제외 건수에 포함하지 않습니다.

저장은 기존 공통 `prepareSettings`와 SQLite/PostgreSQL 설정 repository의 권한·revision CAS를 사용하며 생략한 insights를 보존합니다. 팀 일반 PATCH의 `workColors`는 필수 `settingsRevision`과 함께 이름·테마와 원자적으로 저장하고 서버가 최신 차트·목표일을 유지한 채 색상만 병합합니다. 일반 초안은 열린 revision을 고정하고 관리자 목록을 처음 불러오기 전에는 편집기를 마운트하지 않아 오래된 bootstrap revision으로 시작하지 않습니다. 관리자 목록 조회가 실패하면 오류를 표시하고 bootstrap의 팀 정보로 편집기를 열며, 그 revision이 오래되었으면 기존 CAS가 409로 저장을 막습니다. `TeamGeneral`은 불러온 업무 색상마다 `origin`을 두고 색을 바꾼 항목을 요청 전용 `workColorChanges`로 보냅니다. `generalWorkRecolor`·`workRecolorMap`이 이전 목록에서 빠지고 새 목록에 들어온 색만 고르고, SQLite `recolorWorkMarks`(인터닝된 스타일 ID 기준 셀·업무 기본/행 서식·`format_rules`, 감사 `work-color`)와 PostgreSQL `recolorPostgresWorkMarks`(`cellsStyling(["work"])`·task·formats)가 설정 저장 트랜잭션 안에서 `recolorWorkStyle`로 바꿉니다. 속성 종류 변환과 같이 캡처·outbox가 팀 변경과 함께 한 동기화 작업으로 전달합니다. 인사이트 설정·차트 PATCH가 성공한 뒤의 `/bootstrap` 갱신 실패는 저장 결과와 분리해 새 revision을 편집기에 돌려주고 다음 bootstrap 주기에서 화면을 맞춥니다. 저장 계약은 `tests/insights/insights-storage-contract.test.mjs`에서 실제 양쪽 HTTP 경로, 팀원/열람자 403·입력 400·CAS 409, 속성/서식/테마 보존, 다른 연도 셀, SheetClone 제외·JSON v7 포함과 실제 백업을 검사합니다. 기존 `sync-calendar-documents` 통합 검사는 실제 Git/SQLite/PG 왕복 후 생략 저장의 보존을 함께 확인합니다. 계산은 `insights-calculation.test.mjs`, 화면·편집·미리보기·다른 탭과 늦은 응답은 `tests/browser/insights/insights.spec.ts`로 검증합니다. 이 브라우저 검사는 실제 팀 설정 PATCH의 SSE로 실패한 조회를 유발한 뒤 가상 시계와 보류 응답으로 내부/외부의 Retry-After·보완 주기·복구 공유를 확인하고, 숫자 Text의 비숫자/빈값이 포함된 저장 레이더와 미리보기를 검사합니다.

```sh
TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node --test --test-concurrency=1 tests/insights/*.test.mjs tests/sync/integration/sync-calendar-documents.test.mjs
E2E_PORT=4399 npx playwright test tests/browser/insights/insights.spec.ts
```

PostgreSQL 경로는 설치 위치에 맞게 바꾸며 생략해 성공 처리하지 않습니다. 전체 검증·실패와 재실행은 날짜별 [변경 이력](DEVELOPMENT_HISTORY.md)에 기록합니다. 운영/개발 DB의 연결 경로가 검증되지 않은 경우 실데이터 대조는 미검증으로 남깁니다. 이슈의 2026-11-08 관찰값을 오늘의 데이터·KST 상태와 같다고 가정하지 않습니다. 두 환경의 양쪽 서버 업데이트 후 설정을 입력하는 순서와 롤백 한계는 [운영 안내](OPERATIONS.md#인사이트-설정-입력과-롤백)에 있습니다.

### 인사이트 상단 통계·추이·파이

`SheetSummary`는 연간/인사이트 공통 머리글의 전체 업무와 속성별 수치를 담당하며 기존 `statusSummary`가 선택적인 `insights.summaryPropertyId`를 읽습니다. 생략은 `status`, null은 전체 업무만 표시합니다. 선택형 속성의 이름·옵션 순서·점 색·미지정·보관된 값 집계를 재사용합니다. `insights-references.js`는 상단 참조 경고와 차트의 명시적 참조, 속성 보관 확인창에 표시할 사용처를 공유합니다. 보관 시 값과 참조를 유지하며 누락·종류 불일치 시 해당 집계만 멈춥니다.

차트 추가·편집·복제·삭제·순서 변경은 `Insights.saveCharts`가 현재 `settings.insights`를 포함한 완전한 객체에 새 `charts`를 넣어 기존 PATCH/revision CAS 경로로 저장합니다. 상단 기준 속성 ID와 명시적인 null(전체 업무만 표시), 업무 색상·목표일 설정을 보존합니다. 서버는 제공된 `insights` 객체를 교체하는 기존 계약을 유지하며 부분 병합·구버전 우회·자동 재전송을 추가하지 않습니다. 브라우저 회귀는 두 상단 설정을 실제 설정 창에서 저장한 뒤 다섯 변경 각각의 API 값·revision·기존 차트/순서와 새로고침 후 공통 머리글을 확인합니다.

`InsightsTrend`는 기본 분석의 주별/월별 업무 개수와 팀/책임자 선택을 소유합니다. `InsightsLineChart`·`InsightsPieChart`는 기존 `aggregate`의 결과와 색·수치·드릴다운·인쇄 수치표를 사용합니다. 새 조회나 저장 경로, 차트 라이브러리를 추가하지 않습니다. 시간 집계는 연간 보기의 정확한 주차·표시 월에 연결하며 월별 개수는 ID로 중복 제거합니다. 꺾은선은 빈 선택 구간을 0으로 채우고 표시된 직전 구간과의 차이를 점의 설명에 표시합니다. 파이는 가산 집계만 허용하고 음수는 오류, 0 합계는 빈 상태, 양수 한 분류는 완전한 원으로 표시합니다.

공유 스키마에는 선택적인 `summaryPropertyId`, 차트 `line|pie`, 시간 단위 `week`만 확장했습니다. 팀장 권한·revision CAS·생략 필드 보존·백업·Git 동기화는 기존 설정 경로를 그대로 사용합니다. 관련 검증은 `tests/insights/insights-trends.test.mjs`, 기존 저장/백업 계약·Git 통합, `tests/browser/insights/insights.spec.ts` 및 기간·보고서·인쇄 검사입니다. 운영 적용은 양쪽 서버 업데이트 후 새 설정을 저장하는 기존 절차를 따릅니다.

## 과거 검증 기록

날짜별 구현·측정·검증 기록은 [개발 변경·검증 이력](DEVELOPMENT_HISTORY.md)에 보존합니다. 현재 동작을 변경할 때는 이 안내와 관련 사용·운영·데이터 문서를 함께 갱신하고, 당시 결과와 후속 수정은 이력에 날짜를 붙여 남깁니다. 이전 결과를 현재 릴리스의 검증 결과로 재사용하지 않습니다.

## 외부 동기화 개발·검증

[설치 안내](CLOUD_SETUP.md)와 [프로토콜](SYNC_PROTOCOL.md)을 기준으로 `server/sync/`, `server/storage/`, `worker/`, `edge/`의 호출 경로를 함께 확인합니다. 내부 `transaction`은 동기 콜백만 허용하고, PG는 하나의 client에서 모든 await·COMMIT·rollback을 끝냅니다. Node의 timer는 readonly SQLite worker에서 Git·병합·해시·재투영을 수행하고 메인 쓰기 경계에서 현재 head·로컬 변경·L·작업 guard를 다시 검사합니다. 사이트 이벤트는 commit 뒤 기존 SSE 경로로 전달합니다.

```sh
npm test
npm run build
npm run build:edge
npm run build:pages
npm run test:e2e -- tests/browser/sync/data-sync.spec.ts
npm run performance:sync
```

PG 테스트는 임시 서버를 직접 실행합니다. 일반 `npm test`에서는 사용할 PG 서버 바이너리가 없으면 관련 검사를 `skip`하고 성공 종료할 수 있으므로, 종료 코드만으로 PG 검증을 주장하지 않습니다. 릴리스 검증은 `TEST_PG_BIN=/absolute/PostgreSQL/bin npm run test:postgres`를 사용합니다. macOS 개발 PC는 `brew install postgresql@17`로 서버 바이너리를 준비합니다. `libpq`가 이미 설치되어 `brew link`가 헤더 충돌로 실패하면 `initdb`가 찾는 공유 파일이 연결되지 않으므로, `/opt/homebrew/share/postgresql@17`과 `/opt/homebrew/lib/postgresql@17`을 Cellar의 `share/postgresql`·`lib/postgresql`로 링크한 뒤 `TEST_PG_BIN=/opt/homebrew/Cellar/postgresql@17/<버전>/bin`을 지정합니다. `libpq`의 `initdb`는 `postgres` 실행 파일이 없어 사용할 수 없습니다. 이 명령은 `postgres`, `initdb`, `pg_ctl`을 먼저 실행 확인하고 하나라도 없거나 실행할 수 없으면 테스트를 시작하기 전에 실패합니다. 준비가 확인되면 같은 경로를 모든 테스트에 전달해 전체 단위·통합 검사를 실행하며, 최종 pass/fail/skip 수도 기록합니다. 공통 외부 API 테스트는 임시 control/team PG와 실제 JWT 검증, 대역 R2/Images/GitHub HTTP를 사용합니다. Git CLI 경합·복구 테스트는 임시 bare 저장소를 사용합니다. 실제 cloud 변환 품질·도메인/Access policy·rate limit·운영 DB는 별도 검증 대상입니다.

**저장 형식은 내부·외부와 동기화 경로에서 같게 유지합니다.** 동기화 로직을 제외한 저장 방식·코드 흐름이 사이트마다 달라지면 한쪽에서만 실패하는 경우가 생깁니다. 사본 `data`는 사내 BLOB·HTTP 응답·동기화 명령·외부 `site_entities`에서 모두 `$styles`/`$formats` 공유 사전 형태입니다([사본 저장 형태](DATA_FORMAT.md#보기사본계정)). 직렬화는 `shared/sheet-clones/sheet-clone-sync-data.js`의 `packSheetCloneData`(키 정렬 후 pack)로, 해제는 `unpackSheetCloneData`로만 합니다. 사본 payload를 비교하는 새 코드는 `equal` 대신 `payloadEqual`을 사용해 기존 평문 payload와 공유 사전 payload를 내용으로 비교합니다. 사내 진입점은 `server/sync/node/entities.mjs`의 `readEntity`(직렬화)·`materializeEntity`(해제), 외부 진입점은 `worker/storage/data.mjs`의 `DataSession`(읽을 때 해제, 저장·명령 생성 때 직렬화)입니다. 검증(`validateEntityPayload`)·프로토콜 4 분할(`splitSheetCloneRecord`)·조합(`applicationEntities`)·reducer 비교도 두 형태를 받아들입니다. 성능 픽스처에 팀 공통 서식이 없으면 이런 중복이 측정에 드러나지 않으므로, 사본·동기화 크기를 검증할 때는 `tests/sync/protocol/sync-sheet-clone-format.test.mjs`처럼 운영 규모의 행·열 규칙을 넣습니다.

외부 동기화는 기본 수신 4커밋·발행 50명령 제한에 더해 실행당 명령 바이트 예산 1MiB를 적용합니다. 활성 연결에서 수신이 미전송 명령의 기록·부모·이름·태그·의존성·수신 이력·충돌에 영향을 주지 않으면 기존 사이트 행을 유지하고 미전송 명령을 다시 투영하지 않습니다. 관련 입력이 바뀌면 전체 미전송 명령을 기존 순서로 투영하며 그 바이트도 예산에 포함합니다. 이미지 참조와 미전송 행 보호에는 항상 전체 미전송 명령을 사용하고, 트랜잭션에서 새로 저장된 편집까지 다시 확인합니다. 작은 독립 수신 뒤에도 첫 큰 원자 명령은 통째로 발행할 수 있어, 매 실행마다 작은 원격 변경이 추가되어도 사본이 계속 밀리지 않습니다. 완료된 canonical 트랜잭션 또는 CAS 시도 경계에서 나머지를 다음 실행에 맡깁니다. 사본처럼 큰 저장 후에는 같은 요청의 CPU를 공유하는 `waitUntil` 자동 발행을 시작하지 않고 다음 Cron 또는 직접 실행에서 발행합니다. 작은 변경의 기존 묶음 처리와 `maxCommits`를 명시한 운영자 Node 가져오기 처리량은 유지합니다. 바이트 예산은 작업량 지표이며 실제 Supabase CPU 상한 내 완료를 보장하는 수치는 아닙니다.

`server/sync/core/sync-operation-cache.mjs`는 한 동기화 실행에서 읽은 동일 outbox JSON을 깊게 동결해 재사용합니다(입력 8MiB·128건, canonical 텍스트 8MiB 한도). 동결한 입력의 구조·본문 검증과 canonical 직렬화를 재사용하되 현재 상태의 protocol·identity·resolution·receipt·의존성·이름·부모 검사는 계속 수행합니다. 변경된 JSON, 일반 mutable 호출자, 한도를 넘는 입력은 검증·파싱을 다시 하고, 실행 성공·실패 뒤에는 캐시를 비웁니다. `tests/sync/integration/worker-sheet-clone-sync-performance.test.mjs`는 합성 480업무·공유 서식·주간 셀·11문서의 외부 생성 API, 실제 PG, GitHub 에뮬레이터/SQLite를 연결해 큰 명령 발행, 매 실행 사이 원격 변경 추가, 수신 도중 편집 저장, CAS 이동, 이름 충돌과 문서 편집 보존을 확인합니다. `TEST_PG_BIN=/테스트/PG/bin node --test --test-concurrency=1 tests/sync/integration/worker-sheet-clone-sync-performance.test.mjs`로 재현하며 CPU·wall time·실행별 파싱/수신 횟수와 최종 해시를 출력합니다. 시간 임계값 대신 중복 작업 횟수와 결과 보존을 검사합니다.

같은 PG 행·outbox·Git 부모를 복원하는 전후 비교는 기준 커밋을 별도 임시 디렉토리에 `git archive`로 풀고 그 디렉토리에 기존 `node_modules`를 연결한 뒤 `TEST_PG_BIN=/테스트/PG/bin node scripts/performance/sync-sheet-clone-performance.mjs --baseline /임시/기준소스 --output docs/validation/sheet-clone-sync-performance.json`으로 실행합니다. `--backlog 0`은 원격 이력이 없는 발행 비교입니다. `--hotpath-output /tmp/clone-hotpath.json`을 더하면 같은 합성 명령을 Deno 보조 검사에 사용할 수 있습니다: `deno run --allow-read --node-modules-dir=manual --no-config --no-lock tests/support/worker-sheet-clone-sync-deno.mjs /비교할/소스 /tmp/clone-hotpath.json`. Deno 보조 검사는 반복 투영·검증·직렬화의 첫 실행/워밍 후 시간을 측정하며 PG·Git·Supabase의 실행 한도 검증을 대신하지 않습니다.

공유 상태 전체에는 기본 상한이 없고 `SYNC_MAX_STATE_BYTES`·`SYNC_MAX_ENTITIES`를 지정한 경우에만 검사합니다(`shared/sync/sync-capacity.mjs`의 `capacityLimits`). snapshot은 64MiB, 이벤트 파일은 32MiB(사본 복사처럼 나눌 수 없는 명령 하나가 들어가도록 정한 값), receipt는 별도 16MiB로 검사합니다. `tests/sync/protocol/sync-state-capacity.test.mjs`는 27.88MiB·30,714개 합성 자료(2026-11-02 이전 28.76MiB·33,021개, 본문 없는 일정 문서 2,307개 제외)의 SQLite 최초 게시, 외부 `serviceFor`의 PG 가져오기, 기존 4MiB 환경값에서의 원자적 거절, HTTP 후속 저장·역방향 수신을 검증합니다. 상태·파일 예산을 결합해 이벤트 제한까지 풀리는 회귀, 미전송 변경의 임의 삭제, DB 계수와 메모리 계수의 불일치를 확인합니다. Node 테스트의 성공은 Supabase/Deno 자원 한도 내 실행 보장이 아닙니다. 형식과 스키마를 유지한 한도 상향에는 DB 버전 증가를 하지 않으며 양쪽 런타임 배포와 기존 낮은 환경값 확인이 필요합니다.

`performance:stress -- 10000:30`은 이전 릴리스 비교용 기존 시나리오이고 `performance:sync`는 같은 팀/자료에서 미연결·연결·외부 장애·초기 게시·백업 중 저장 및 commit→30개 SSE 도착을 비교합니다. 결과는 Git 제외 `docs/validation/`에 저장합니다. 측정 당시의 실제 결과와 목표 미달은 릴리스 보고서에 기록하며 통과 수치를 고정 보장으로 설명하지 않습니다.

안정 상태 paired 비교는 `schedule:false`로 주기 발신을 끄고 저장·캡처 비용을 측정합니다. 실제 게시·수신과 겹치는 비용은 별도 작업 행으로 보고합니다. 초기 Git 장애 검사는 bare 저장소 경로를 바꾼 즉시 실패이며 지연·무응답 원격 검증을 대신하지 않습니다. 별도 자식 프로세스의 PG/S3 장애 probe는 내부 서버에 연결되지 않으므로 그동안의 저장 표본을 외부 장애 격리 성능으로 주장하지 않습니다. 두 팀의 동시 동기화와 동기화 작업 중 대량 붙여넣기도 별도 근거가 필요합니다.

충돌 해결 API는 두 서버 모두 해결 명령을 미전송 명령(P) 뒤에 적용해 보고, 다시 충돌하면 409와 `details.code: "resolution-rejected"`로 거절합니다. 사내는 `background-worker.mjs` resolve가 `project()`의 `held`·`reasons`로, 외부는 `worker/control/admin.mjs`가 `reduceSlice(state, [...pending, op])`로 판정합니다. 사내 백그라운드 스레드는 오류의 `details`를 `node-background.mjs`의 `HttpError`까지 그대로 넘깁니다. `SyncConflictBox`는 이 코드를 받으면 오류 문구 대신 줄에 **덮어쓰기 불가**(직접 고친 경우 **고친 내용 충돌**) 표시를 붙입니다. 펼친 영역에는 `RefusalGuide`(사라질 나중에 수정 확인 → 복사 → 먼저 수정으로 유지 순서)를 보여 주고, 먼저 수정으로 유지 버튼을 강조합니다. 일괄 해결은 거절된 개수와 정리 방법을 따로 알리며, 거절된 충돌은 선택된 채 남습니다.

충돌 보관함은 내부·외부 모두 `SyncConflictBox` → `SyncConflictDiff` → `shared/sync/conflict-diff.js`로 비교 내용을 표시합니다. 사본 전체처럼 큰 payload의 줄 배열은 함수 인자로 펼치지 않고 순서대로 옮겨 브라우저 인자 수 한도를 피합니다. 표시할 줄이 200개를 넘으면 업무표에서 사용하는 `@tanstack/react-virtual`로 화면에 들어오는 줄만 그리며, 접힌 같은 줄을 펼친 경우도 동일하게 처리합니다. 비교 내용과 줄 번호는 유지하고 긴 줄의 실제 높이를 측정합니다. `tests/sync/protocol/conflict-diff.test.mjs`는 16만 줄의 생성·삭제·접힘을, `tests/browser/sync/data-sync.spec.ts`는 외부 모드에서 문서 11개와 큰 사본을 포함한 12개 항목 펼치기·끝까지 스크롤·긴 같은 줄 펼치기·비교 전환·닫기를 확인합니다.

원본 JSON은 `SyncConflictRaw`에서 펼친 동안만 직렬화·표시하고, 접으면 표시 내용과 측정 상태를 해제합니다. 긴 JSON은 같은 가상 스크롤 라이브러리를 사용하며, JSON 문자열 안의 긴 문서도 조각별 배치 크기를 제한합니다. UTF-16 서로게이트 쌍을 나누지 않고 전체 텍스트를 순서대로 표시하며 짧은 값과 직접 편집의 문자열 변환은 기존 형식을 유지합니다. 끝에 도달한 뒤 줄 높이를 측정해도 마지막 값을 유지하고, ResizeObserver 측정은 애니메이션 프레임으로 모아 처리합니다. 같은 브라우저 suite에서 내부·외부 모드의 900업무×30셀 사본 세 버전, 긴 문자열·한글·이모지, 처음/끝 이동·키보드 스크롤·접기/다시 열기와 기존 해결 동작을 확인합니다.

## 업무 저장소 계약

Node와 Edge의 일반 업무 API는 `server/storage/`의 도메인 서비스에 repository를 주입합니다. SQLite 구현은 기존 관계형 테이블, prepared statement, task cache와 동기 `transaction()`을 유지합니다. PostgreSQL 구현은 `site_entities`/`site_operations`/`site_audit`/`site_events`를 같은 PG 트랜잭션에서 변경하며 C+P 기준으로 outbox를 작성합니다. API와 공통 명령은 SQL dialect나 `s.tx.query`에 의존하지 않습니다. `DatabaseAdapter`는 이 업무 계약 아래의 sync 상태·트랜잭션 포트입니다.

| 계약                                                     | 실제 명령 범위                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| TaskBusinessService                                      | 조회/ETag, 셀 배치·서식·재시도, 생성/복제/수정/삭제/복원/순서, 개인 보기                                        |
| DocumentBusinessService                                  | 원본/사본 문서, 연간/사본 메모, 일정 Markdown, 제목/순서/본문 CAS, 이미지 접근 권한과 선택된 저장소의 읽기/쓰기 |
| SheetCloneBusinessService                                | 사본 생성·복사·이름·행/셀/서식 편집·삭제·revision                                                               |
| CalendarBusinessService                                  | 일정·태그·배치·주간 업무·자동 가져오기·개인 규칙                                                                |
| SettingsBusinessService / FilterBusinessService          | 팀 설정·이름/테마, 셀 종류 변환, 보기/필터 정규화, 공유/개인 필터·선택 상태                                     |
| ControlBusinessService                                   | bootstrap·참조 인물/연도, 프로필, 사용자·팀·멤버십 관리                                                         |
| HistoryBusinessService / AdminHistoryBusinessService     | 팀 이력·복원, 관리자 감사 검색·상세, 사이트 이력 정리                                                           |
| DocumentBrowserBusinessService / TransferBusinessService | 문서 탐색, CSV/XLSX/JSON 내보내기, 실제 업로드 미리보기·적용·재시도                                             |

`createApp()`은 내부 SQLite 저장소만 구성합니다. Node에서 PG repository를 선택하는 테스트 전용 모드와 factory 주입은 제거했습니다. 외부 API는 `worker/`의 route 함수와 `worker/storage/` PostgreSQL 구현을 사용하며, 인증·멤버십도 외부 PG control/site 저장소에서 확인합니다. 공통 도메인 서비스는 양쪽 명령 검증을 공유하지만 Node 라우트의 SQLite 트랜잭션은 동기를 유지합니다. 문서 이미지 준비와 XLSX 생성·읽기는 필요한 비동기 처리를 명시적으로 기다립니다.

외부 Edge는 `RequestContext.data`와 `capacityLimits(env)`를 통해 쓰기 전 DB 용량 검사와 commit 전 상태 검사를 수행합니다. 내부 SQLite 업무 경로의 행 수 시험이나 PG 어댑터 직접 호출 시험은 외부 API의 지원 규모를 보장하지 않습니다. [용량 범위](CLOUD_SETUP.md#14-실행-한도와-검증-범위)를 함께 확인합니다.

이미지 변환은 내부 Node의 sharp·`FileImageStore`, 외부 Edge의 Cloudflare Images·`R2ImageStore`를 사용합니다. PG 이미지 업로드는 작업 lease를 기록해 정리·연결 교체와 겹치지 않게 합니다. Git 실행기 설정과 인증은 논리 팀 자료 이관과 별도로 관리합니다.

기능별 `*-storage-contract.test.mjs`, `task-command-contract.test.mjs`, `task-storage-events.test.mjs`, `ordinary-data-contract.test.mjs`는 두 실제 엔진의 permission/CAS/replay/L/late rollback을 비교합니다. 외부 HTTP 계약은 `tests/support/external-route-fixture.mjs`에서 실제 worker route 함수·PG control 인증·SSE를 실행하며, Node의 SQLite 업무 행에 의존하지 않는지 확인합니다. 이미지 업로드→본문 저장→R2 조회→JSON 반출, 관리 이력 정리와 멤버십 철회도 포함합니다. SQLite 검사는 반환값의 동기성, 커밋 후 다른 연결에서의 P·본문 가시성, 커밋 실패 시 이벤트 부재를 확인합니다. release 검사에서는 `TEST_PG_BIN`을 지정해 PG skip을 허용하지 않습니다.

## 팀별 외부 설치와 계정 연결

`SettingsPanel`의 팀 동기화와 `ServiceConnections`의 팀 선택은 `SyncSetupWizard`를 공유합니다. 내부에서는 GitHub까지의 게시(**내부 프로필 설정**: GitHub 저장소·GitHub 연결)와 **외부 서비스 설정**(Cloudflare·Supabase·배포·외부 계정·양방향 확인)을 별도 과정으로 표시하며, 단계 번호는 `shared/sync/sync-setup.js`의 `setupStep`을 사용합니다. 실제 저장 응답으로 생성/서버 적용 상태를 구분하고, 내부 GitHub 토큰은 저장소 주소와 같은 단계에서 저장합니다. 토큰(암호문 또는 `tokenEnv`)이 없으면 GitHub 연결로, 초기 게시 전이면 외부 서비스로 진행하지 않습니다. 연결된 팀에 토큰이 없으면 저장소 단계에서 열고, 초기 게시한 팀은 외부 서비스 단계를 직접 선택할 수 있습니다. 시스템 관리자가 아닌 팀장은 설치 식별자가 필요한 운영자 단계 없이 GitHub 연결·외부 계정·양방향 확인만 사용합니다. 식별자는 배포 예시에 자동 반영하고, 평상시에는 팀·시스템 화면의 접힌 `SyncConnectionDetails`에서만 조회합니다. 내부 시스템 관리자가 펼칠 때 기존 설정 조회 API로 설치 UUID를 읽으며, 팀 전환·접기 시 이전 요청을 취소합니다. 각 과정의 단계를 별도로 표시합니다. 프로필 없는 팀도 설정 탭으로 진입하되 기존 상태 polling은 연결된 팀에만 유지하며, 안내를 연 동안에는 바깥 화면의 polling을 멈추고 안내 안의 embedded 인스턴스만 조회합니다. 외부 사이트의 설정 안내 진입점은 시스템 관리자에게만 표시합니다. 마법사의 접속 주소·Access issuer/audience·bucket·Reference ID·Account ID는 비밀이 아닌 설정값으로, `graeboard:sync-setup:<teamId>` 키의 localStorage에 보관하고 재진입 시 복원합니다. 확인 체크·토큰 초안·생성한 배포 값은 React 메모리에만 유지하며 팀별 key로 분리합니다. `shared/sync/sync-setup.js`는 값 검증, 현재 팀의 배포 예시, 최신 상대 적용 확인 조건을 공유합니다. 연결·초기 게시·일시정지·재연결은 기존 `TeamSyncSettings`를, 팀장 연결 키는 외부 계정 단계에서 기존 `TeamSetupKey`를 재사용합니다. 상태 패널의 연결 키와 일시정지 안내는 초기 게시 뒤에만 표시하고, 안내 안에 넣은 `TeamSyncSettings`에는 연결 키를 표시하지 않습니다. 연결 검사·실행 버튼은 공통 토스트 대신 버튼 아래에 진행 중 문구와 성공 결과를 유지하며, 초기 게시·지금 동기화의 결과는 실행 뒤 다시 읽은 상태의 Git 반영 시각·공유 대기·충돌 보관 건수로 만듭니다. 오류 표시로 스크롤할 때는 `scroll-margin`으로 여백을 남겨 소수점 줄 높이에서 테두리가 잘리지 않게 합니다.

내부 `setup-config.mjs`는 기존 dotenv 형식의 지정 변수만 원자 교체하고 파일 revision·기존 연결·중복 저장소·환경 우선순위·키 누락을 검사합니다. 프로필은 시작 시 검사와 같은 `server/sync/node/profiles.mjs` 규칙으로 파일·실행 목록을 검증한 뒤 `sync.apply`로 실행 중 목록에 바로 적용하며, 설치 식별자가 없는 최초 설치만 재시작으로 적용합니다. 환경 변수 우선순위는 프로세스 시작 시 읽은 값과 비교하므로 같은 서버의 이전 저장이 재정의로 오인되지 않습니다. 토큰 UI 저장은 작업이 없는 팀의 실행기 캐시만 무효화합니다. 설정 조회의 `tokenEnvironment`는 프로필의 환경 변수 토큰 유무를, `tokenPreview`는 `server/sync/node/credentials.mjs`의 `tokenPreview`로 계산한 토큰 앞부분(GitHub 공통 접두어 뒤 10자, 길이의 절반 이하)만 알립니다. 저장 형식 변경 없이 조회 때 기존 암호문을 풀어 계산하며, 현재 키로 풀 수 없으면 빈 값입니다. `DELETE /api/admin/teams/:id/sync-credential`은 토큰 저장과 같은 권한·작업 중 검사 뒤 암호문 행만 지우고 실행기 캐시를 비웁니다. 마법사는 저장된 토큰이 있으면 입력란 대신 앞부분과 삭제 버튼을 표시합니다. 내부 연결 검사는 GitHub 저장소에 쓸 토큰이 하나도 없으면 GitHub 호출 전에 409로 토큰 미등록을 안내합니다. 새 스키마·백업 형식은 없습니다. `tests/sync/integration/sync-setup.test.mjs`는 실제 임시 SQLite/API/환경 파일과 암호문·기존 연결 보존을 검사하고, `--env-file` 재시작과 같은 환경 변수 적재 후 연속 저장·연결 전 수정·즉시 적용된 프로필의 토큰 저장과 연결, 시작 시 거절될 프로필 목록과 쓸 수 없는 파일의 409 응답을 포함합니다. `tests/browser/sync/sync-setup.spec.ts`는 실제 내부 설정 저장과 즉시 적용, 최초 설치의 재시작 안내와 재시작 후 적용, 안내를 연 동안 상태 polling이 중복되지 않는지, 외부 팀장 진입점 비표시, 입력 검증·팀 전환·작은 화면을 확인하며 외부 응답/영수증 경계는 route fixture로 검사합니다. 실제 외부 통합은 기존 `team-site`·`worker-sync-integration` 검사와 구분합니다.

Pages 접속은 `functions/[[path]].js` → `GRAEBOARD_BACKEND` → gateway Worker → Supabase Edge의 경로입니다. `worker/forwarder.mjs`는 이전 Worker 이름으로 들어오는 Service binding을 같은 gateway에 전달합니다. Hyperdrive binding과 이전 Cron, 전체 Worker 호환성 빌드 설정은 제거합니다. `public/_routes.json`으로 모든 경로를 Functions에 전달합니다. `tests/site/pages-gateway.test.mjs`는 누락된 binding의 JSON 503, 헤더·업로드·쿠키·스트리밍 보존을 검사하고, `tests/site/edge-gateway.test.mjs`는 실제 gateway의 workerd 실행으로 전달·정적 파일·인증 경계를 검증합니다. 팀 사이트 통합 검사는 이 Pages 진입점을 거쳐 SQLite/Git/PostgreSQL 간 구성원·승인·탈퇴 흐름을 확인합니다.

신규 외부 설치는 `PG_SITE` + `SITE_TEAM_ID`와 프로필 하나로 구성합니다. 사내 모든 팀은 내부 SQLite에 남고 연결된 팀의 구성원만 `server/sync/core/directory.mjs`를 통해 별도 Git 브랜치에 게시합니다. `worker/sync/directory.mjs`가 단방향 반영하고 `worker/control/site-auth.mjs`가 최초 팀장 연결·계정 선택·팀장 승인·접속 세션을 처리합니다. 기존 분리형 `PG_CONTROL` 경로는 호환용으로 유지합니다.

`tests/site/team-site.test.mjs`는 실제 SQLite·Git·PostgreSQL과 외부 API fetch를 연결해 팀장 연결 설정, 다른 팀 제외, 승인 전 차단, Google 신원에 묶인 세션, 팀원 추가/역할 변경/탈퇴, site migration 롤백·재실행·기존 team 보존, 백업 v3의 승인 보존·세션 제외를 검사합니다. `tests/browser/sync/data-sync.spec.ts`는 계정 선택·대기·승인 후 접속과 팀장 승인 화면을 확인합니다. release 검증은 `TEST_PG_BIN=/경로/postgresql/bin npm run test:postgres`, 프런트엔드/gateway/Edge/Pages 빌드, 세 브라우저의 해당 흐름을 사용합니다. `tests/site/team-site.test.mjs`의 Edge handler는 Node 테스트 프로세스에서 실행하므로 실제 Google/Cloudflare/Supabase 배포 및 Deno 실행 검증은 별도입니다.

팀장 키: `TeamSetupKey` → 내부 `/teams/:id/setup-key` → `external_setup_keys` → 기존 동기화 실행 뒤 Git 키 브랜치 → `worker/control/setup-keys.mjs` → 외부 site 저장소 → `/auth/setup` 순서입니다. 원문은 React 메모리/발급 응답에만 두고 저장하거나 로그로 남기지 않습니다. `tests/site/team-site.test.mjs`는 내부 실제 API 발급, Git 전송, 다른 팀/일반 구성원 거부, 만료·재발급, 동시 소비, 연결 해제 뒤 재사용 거부, 반영/사용 영수증과 백업을 확인합니다. `tests/sync/recovery/sync-migrations.test.mjs`는 기존 SQLite 자료 보존과 원자적 업그레이드를 검사합니다. 현재 지원 버전은 [버전과 운영 호환성](DATA_FORMAT.md#버전과-운영-호환성)을 따릅니다. 실제 운영 DB에는 테스트를 실행하지 않습니다.

외부 팀의 `Team.status`가 `unconnected`, `importing`, `maintenance`이면 업무 조회 대신 준비 상태 안내를 표시하고, 같은 팀이 active로 바뀌면 필터·보기·업무 조회를 다시 시작합니다. 내부 팀은 이 외부 상태로 화면을 차단하지 않습니다. 최초 조회 실패는 무기한 로딩으로 남기지 않습니다. `tests/browser/platform/external-loading.spec.ts`와 기존 auth/data-sync 브라우저 검사를 함께 실행합니다.

배포 역할은 `shared/site/site-mode.js`에서 `GRAEBOARD_SITE`와 서버 호스트를 대조합니다. Node는 DB를 열기 전에 internal을, 외부 API는 요청·Cron 전에 external을 검사합니다. 화면은 bootstrap/setup의 명시적 `site`를 우선하며 기존 배포와 호환할 때만 `authMode`를 사용합니다. 초기 게시 API는 외부에서 403으로 거절하며 가져오기로 대체 실행하지 않습니다. `tests/site/site-mode.test.mjs`, `tests/site/team-site.test.mjs`, `tests/browser/sync/data-sync.spec.ts`는 설정 오류·요청 값 변조·외부 게시 차단과 환경별 버튼을 확인합니다.

`TeamSyncIndicator`는 bootstrap/setup에서 계산한 공통 `site` 객체를 Context로 받아 상단 표시를 구분합니다. 내부는 정상·미전송·상대 확인 대기를 숨기되 오류·충돌·복구·중단·조회 실패를 표시하며, 최초 조회 실패도 숨기지 않습니다. 외부는 클라우드 저장·Git 반영·내부망 반영을 세 태그로 분리하고 대기/진행 중은 회색, 완료는 푸른색으로 표시합니다. 저장 중·실패에는 후속 단계도 완료로 표시하지 않습니다. 상태 조회는 기본 15초이며 내부 미연결 팀은 60초 간격으로 줄입니다. 포커스 갱신은 유지하고, 저장 후 상태 조회는 외부에서만 마지막 알림 이후 2초 뒤에 실행합니다. 내부 저장 및 인증·관리 API의 성공은 이 추가 조회를 만들지 않습니다. 팀 전환 시 이전 조회 실패 상태를 초기화합니다. `tests/browser/sync/team-sync-indicator.spec.ts`는 같은 URL에서 서버 환경 값에 따른 표시, 오류 복구, 최초 조회 실패, 적용 확인 조건, 색상과 좁은 화면 배치를 검증합니다.

내부 재연결은 `TeamSyncSettings` → `POST /api/teams/:id/sync/reconnect` → `createNodeSync.reconnect` → readonly background snapshot의 경로입니다. 같은 설치의 disconnected 상태만 허용하고 팀장 권한을 계산 전후에 확인합니다. C+P와 실제 업무 자료의 차이를 기존 operation 형식으로 P에 추가한 뒤 같은 트랜잭션에서 active(초기 게시 전은 paused)로 전환합니다. 기존 C·P ID·writer epoch·L은 유지합니다. capture가 꺼진 동안의 문서 변경도 감지하도록 메인 연결의 total_changes와 data_version, 기존 snapshot guard를 커밋 직전에 검사하며 동시 저장 시 재계산합니다. 새 DB 스키마나 백업 형식은 도입하지 않습니다. `sync-integration`·`sync-lifecycle-review`·`browser/data-sync` 검사는 실제 API/Git에서 재연결·본문 보존·충돌·동시 저장·권한 철회·롤백을 확인합니다.

### 리뷰 반영 검증 기준

내부 오류 응답의 원문은 그대로 표시하며 외부 연결 오류의 진단 문구와 구분합니다. 내부 업무 polling은 7초, 외부는 30초이고 실패 재시도는 공통 정책과 Retry-After를 따릅니다. 내부 미연결 팀의 동기화 상태 조회는 60초 간격이며 업무 저장마다 조회하지 않습니다. 외부 저장 알림은 마지막 알림 이후 2초 뒤 한 번의 조회로 합칩니다. 공유 refresh는 마지막 소비자가 취소한 경우에만 네트워크를 취소합니다.

프로토콜 3·4의 기준 이력 재생과 명시 전환 수신, `sheetCloneTask`·`sheetCloneCell` 독립성, receipt 별도 용량, SQLite·PostgreSQL migration 및 정리 경계는 합성 DB에서 검증합니다. 옛 프로토콜 1·2와 SQLite v33·PostgreSQL team v2 fixture는 일회성 SheetClone 전환 도구의 입력으로 검증합니다. PostgreSQL strict는 `TEST_PG_BIN=/테스트/PG/bin npm run test:postgres`로 실행합니다. 운영 백업은 별도 새 DB·이미지 경로에 실제 복구하고, `cutover:sheet-clone --dry-run` 사전 검사와 실제 사본 전환·행/이미지 보존 결과를 [패치 체크리스트](PATCH_GUIDE.md)에 별도로 기록합니다. 내부 SQLite의 `npm run restore -- 백업.sqlite 새경로.sqlite`에는 dry-run 옵션이 없습니다. 개발 합성 DB 통과를 운영 사본 확인으로 대신하지 않습니다.
