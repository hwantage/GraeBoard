# 내부망 운영 서버 업데이트 가이드

## 퀵 가이드 — 이 순서대로 진행

**새 프로그램 폴더를 준비하고, 기존 DB·이미지·운영 설정을 그대로 연결합니다.** 아래 파일 경로는 실제 서버의 절대 경로로 바꿉니다. 서버에는 Node.js **22.13.0 이상**이 필요합니다.

| 순서 | 어디서 | 할 일 |
| --- | --- | --- |
| 1 | 맥북 | 배포할 변경을 검증·커밋하고 서버에 소스를 전달합니다. **미커밋 변경은 `git pull`로 전달되지 않습니다.** |
| 2 | 운영 서버 | `sqlite3 -readonly /실제경로/운영.sqlite 'PRAGMA user_version;'`로 DB 버전을 확인합니다. **29·30·31·32는 v33으로 변환, 33은 검사만, 나머지는 중단**합니다. SQLite CLI가 없으면 [Node 확인 명령](#2-2-앱을-실행하지-않고-db-읽기-전용-검사)을 사용합니다. |
| 3 | 서버의 새 프로그램 폴더 | 새 소스를 넣고 `npm ci --include=dev` → `npm run build`를 실행합니다. 기존 운영 설정을 연결하고 **DB·이미지 경로를 기존 자료의 절대 경로로 유지**합니다. |
| 4 | 운영 적용 전 | 백업 사본으로 **복구 → DB 변환 → 화면 확인**을 먼저 합니다. [사본 검증 명령](#4-사본에서-복구실제-변환구버전-복구-리허설) |
| 5 | 기존 프로그램 폴더 | **서비스와 모든 쓰기 작업을 중지**합니다. 기존 서비스와 같은 DB·이미지·동기화 환경에서 `npm run backup -- /백업경로/패치전.sqlite`를 실행합니다. DB와 `.sqlite.images/` 묶음을 보관하고 [최종 복구 검사](#5-점검-시작-모든-쓰기-중단과-최종-백업)를 통과해야 합니다. |
| 6 | 새 프로그램 폴더 | 아래 명령으로 운영 DB를 검사하고, **v29·v30·v31·v32일 때 실제 변환**합니다. 필요한 운영 DB 변환 승인은 적용 전에 완료합니다. |
| 7 | 서비스 설정 | 실행 폴더를 새 프로그램 폴더로 바꾸고, 검증한 Node.js와 기존 데이터 경로로 시작합니다. **구·신 서버를 같은 DB로 동시에 실행하지 않습니다.** |
| 8 | 브라우저 | 기존 계정 로그인 → 기존 업무·이미지 확인 → 저장·새로고침 → 두 탭 갱신을 확인합니다. 정상이면 사용자 접속과 예약 작업을 재개합니다. |

**6번에서 실행할 명령** — 한 줄씩 성공을 확인한 뒤 다음 줄로 진행합니다.

```sh
npm run migrate -- --engine sqlite --database /실제경로/운영.sqlite --dry-run
# 위 검사 성공 + 기존 DB가 v29·v30·v31·v32인 경우에만 실행
npm run migrate -- --engine sqlite --database /실제경로/운영.sqlite
# 변환 후 버전·이력·무결성 재검사
npm run migrate -- --engine sqlite --database /실제경로/운영.sqlite --dry-run
```

**실패하면:** 서비스를 멈추고 **이전 프로그램 + 패치 전 DB·이미지 백업**을 함께 복구합니다. 패치 후 저장된 자료가 있으면 먼저 보존합니다. [복구 순서](#8-실패-시-복구-순서)

### 외부 동기화 첫 연결 — 기존 외부 서비스 유지

이번 내부 운영 서버에는 동기화 기능을 처음 넣습니다. **외부 사이트·배포·자원은 유지하고 외부 DB를 초기화한 뒤 내부 운영 자료를 가져오는 계획**입니다. 내부 패치를 마친 후 아래 순서로 진행합니다.

1. **사전 확인:** 기존 Git 데이터 저장소에 테스트 동기화 이력(`sync-v1`)이 있는지 확인합니다. **이력이 남아 있으면 외부 DB만 초기화해서는 신규 내부 서버를 연결할 수 없습니다.** 현재 코드는 연결 신원 불일치로 거절하므로, 이 경우 기존 이력 처리 방법을 먼저 정해야 합니다.
2. **관리자 작업:** 외부 앱·자동 동기화를 중지하고 외부 DB를 백업한 뒤 초기화합니다. 업무 행만 삭제하면 기존 계정·연결 상태가 남으므로 `graeboard`와 `graeboard_site`를 함께 신규 상태로 준비합니다. DB 초기화 기능은 앱 UI에 없습니다. 실제 초기화 명령은 대상 DB와 범위를 확정한 뒤 수행합니다.
3. **외부 업데이트·연결 정보 확인:** 기존 배포 설정을 유지하며 외부 코드도 같은 릴리스로 업데이트하고 초기화한 DB에 PostgreSQL team v2/site v3 스키마를 준비합니다. 팀 UUID·상대 내부 설치 UUID가 실제 운영 서버와 일치하는지 확인합니다. 내부 서버에는 기존 Git 저장소용 프로필·토큰·설치 UUID를 등록합니다. 이 등록도 서버 설정 작업입니다.
4. **내부 UI:** `설정 → 팀 → 동기화`에서 **연결 저장 → 연결 검사 → 초기 게시 → 팀장 연결 키 발급**을 실행합니다.
5. **외부 UI:** Google 로그인 후 발급한 키로 사내 팀장 계정을 연결하고, `설정 → 시스템 → 서비스 연결 → 팀 가져오기`를 실행합니다. 기존 업무·문서·이미지와 양방향 저장 반영을 확인합니다.
6. **선택한 동기화 형식 전환:** 양쪽 자료가 일치하고 미전송·충돌이 없을 때, 양쪽을 일시정지한 채 [v2 전환 절차](OPERATIONS.md#동기화-v2-명시-전환)를 실행합니다. 내부·외부 모두 같은 v2 head·hash를 확인한 뒤 재개합니다. 코드 업데이트나 DB migration만으로 v1 이력은 바뀌지 않습니다.

외부 DB 초기화는 Git 이력이나 R2 이미지 파일을 지우지 않습니다. **서버·DB 준비가 끝난 이후의 연결 실행은 UI에서 진행**합니다. 세부 설정은 [클라우드 설치 안내](CLOUD_SETUP.md#9-빌드배포첫-팀-연결)를 따릅니다.

---

[운영 안내](OPERATIONS.md) · [DB 변경 지침](DATABASE_CHANGES.md) · [데이터 형식](DATA_FORMAT.md) · [개발·검증 안내](DEVELOPMENT.md#검증)

2026-10-29의 리뷰 반영 구현을 기준으로, 개발용 맥북에서 준비한 릴리스를 기존 내부망 서버에 적용하는 순서입니다. **운영 서버의 OS·배포 커밋·서비스 이름·실제 DB 버전은 아직 확인되지 않았습니다.** 아래 경로와 서비스 명령은 현장에서 확인한 값으로 바꿉니다.

대상은 **내부 Node 서버 + SQLite + 파일 이미지 저장소**입니다. 외부 Supabase·Cloudflare 배포와 외부 연결 신규 설정은 [클라우드 설치 안내](CLOUD_SETUP.md)를 따릅니다. 내부 서버는 SQLite 전용이며, 외부 PostgreSQL·R2는 별도 외부 백업 도구로 보존합니다.

진행 순서는 **배포본 확정 → 운영 정보·DB 버전 확인 → 새 릴리스 준비 → 사본 복구·변환 리허설 → 쓰기 중단·최종 백업 → 운영 DB 변환 → 서비스 전환·검증 → 접속 재개**입니다. 명령은 단계별로 실행하고 실패한 상태에서 다음 단계로 넘어가지 않습니다.

## 1. 개발 맥북에서 배포본 확정

### 1-1. 미커밋 변경 포함 여부 확정

작업 중인 미커밋 변경은 `git pull`, 커밋 기준 배포, `git archive HEAD`에 포함되지 않습니다. 배포할 변경을 검토·커밋하고, 이 가이드도 배포본에 포함한 뒤 **최종 커밋을 고정**합니다. 이 문서를 작성한 것만으로 커밋·푸시·배포가 이루어지지는 않습니다.

```sh
git status --short
git diff --stat
git diff --check
git rev-parse HEAD
```

### 1-2. 확정할 코드 검증

개발 환경 또는 분리된 검증 환경에서 실행합니다. 운영 DB와 운영 이미지 경로를 테스트에 사용하지 않습니다.

```sh
npm ci --include=dev
npm test
npm run build
npm run test:e2e
```

브라우저가 설치되지 않았다면 개발 안내에 따라 Playwright 브라우저를 준비합니다. 동기화·외부 저장소를 포함한 릴리스 검증에는 [외부 동기화 검증](DEVELOPMENT.md#외부-동기화-개발검증)의 PostgreSQL 필수 검사와 관련 빌드도 수행합니다. `npm test`에서 PG 검사가 `skip`되었다면 전체 동기화 검증 완료로 기록하지 않습니다. 성공·실패·건너뜀 수와 검증한 커밋을 기록하고, 이후 코드가 바뀌면 관련 검사를 다시 수행합니다.

### 1-3. 서버에 전달할 소스 준비

서버에서 저장소를 받을 수 있으면 **별도 새 릴리스 디렉터리**에 확정한 커밋을 checkout합니다. 실행 중인 릴리스에서 `git pull`·`npm ci`·빌드를 하지 않습니다.

소스를 파일로 반입한다면 커밋 후 맥북의 저장소 루트에서 다음처럼 만듭니다. 미커밋·미추적 파일이 있으면 패키징을 중단하는 예시입니다.

```sh
(
  set -eu
  if [ -n "$(git status --porcelain)" ]; then
    echo '배포할 변경을 먼저 확정하고 커밋하세요.' >&2
    exit 1
  fi
  PATCH_RELEASE="$(git rev-parse HEAD)"
  git archive --format=tar.gz --output="../graeboard-${PATCH_RELEASE}.tar.gz" HEAD
  shasum -a 256 "../graeboard-${PATCH_RELEASE}.tar.gz"
)
```

압축파일과 커밋·SHA-256 기록을 함께 전달합니다. Git archive에는 `.git`, `.env`, 운영 데이터, `dist/`, `node_modules/`가 포함되지 않습니다. 서버에서 압축파일 해시를 확인하고 비어 있는 새 릴리스 디렉터리에 풉니다. Linux에서는 `sha256sum 파일명`, macOS에서는 `shasum -a 256 파일명`으로 확인할 수 있습니다.

**내부망의 npm 접속 가능 여부를 점검 시간 전에 확인합니다.** 접근이 제한되면 사내 패키지 미러 또는 서버와 같은 OS·CPU·Node 환경에서 검증한 의존성 설치 수단과 빌드 산출물을 미리 준비합니다. macOS의 `node_modules/`를 Linux 서버에 복사하지 않습니다. `sharp` 등 네이티브 의존성이 있습니다. `dist/`만 전달해도 서버 API는 업데이트되지 않으므로 서버·공통 소스·관리 스크립트·잠금 파일과 런타임 의존성을 함께 준비합니다.

## 2. 운영 서버 현황과 DB 버전 확인

### 2-1. 실제 서비스 설정 기록

운영 서버에서 아래 항목을 먼저 확인합니다. 셸의 `.env`만 보지 말고 **실제 서비스에 주입된 환경과 작업 디렉터리**를 확인합니다. 환경 변수는 `.env`보다 우선합니다. 비밀값은 Git이나 작업 보고서에 붙여 넣지 않습니다.

| 항목 | 기록할 내용 |
| --- | --- |
| 기존 릴리스 | 커밋·태그 또는 배포 기록, 소스와 `dist/`, 기존 의존성 경로 |
| 런타임 | OS·CPU, Node.js/npm 버전과 실행 파일 경로 |
| 서비스 | 실행 계정, 작업 디렉터리, 프로세스 수, 시작·정지·로그 명령, 자동 재시작·예약 작업 |
| DB·이미지 | 실제 DB 파일과 이미지 폴더의 절대 경로, 디스크 여유·권한 |
| 접속 | HOST·PORT·APP_ORIGIN·COOKIE_SECURE·TRUST_PROXY, 역방향 프록시 설정 |
| 동기화 | 사용 여부, 설치 UUID, 프로필, Git clone 절대 경로, 암호화 키·토큰의 보관 위치 |
| 복구 | 이전 릴리스 보존 위치, 백업 보관 위치, 복구 소요 시간 |

신버전에는 `package.json` 기준 **Node.js 22.13.0 이상**이 필요합니다. 다른 서비스의 시스템 Node.js를 교체하지 말고 이 앱용 지원 런타임을 준비합니다. 빌드·마이그레이션·서비스·예약 백업이 사용할 정확한 실행 파일 경로를 기록합니다. nvm 설정이 서비스 관리자에 자동 적용된다고 가정하지 않습니다.

이후 명령은 Bash/Zsh 기준입니다. 아래는 **실제 경로로 교체할 예시**이며, 기존 데이터 이동을 요구하는 명령이 아닙니다. 상대 경로였던 데이터 설정은 기존 작업 디렉터리를 기준으로 해석해 절대 경로를 적습니다. 새 셸에서는 이 변수들을 다시 설정합니다.

```sh
PATCH_OLD='/srv/graeboard/releases/기존릴리스'
PATCH_NEW='/srv/graeboard/releases/새릴리스'
PATCH_DB='/srv/graeboard/data/weekly-plan.sqlite'
PATCH_IMAGES='/srv/graeboard/data/document-images'
PATCH_SYNC='/srv/graeboard/data/sync'
PATCH_RUN="$(date +%Y%m%d-%H%M%S)"
PATCH_BACKUP="/srv/graeboard/backups/patch-${PATCH_RUN}"
PATCH_REHEARSAL="/srv/graeboard/rehearsals/patch-${PATCH_RUN}"

node --version
npm --version
command -v node
test -f "$PATCH_DB"
```

백업·리허설 경로는 매번 새 경로를 사용하고 서비스 계정만 접근하도록 준비합니다. 백업·복구·마이그레이션은 실제 서비스 계정으로 실행하는 것을 기준으로 합니다. 다른 관리자 계정으로 수행했다면 새 파일·상위 디렉터리의 소유권과 접근 권한을 서비스 계정 기준으로 확인합니다. 운영 DB가 없다는 결과가 나오면 경로부터 재확인합니다.

### 2-2. 앱을 실행하지 않고 DB 읽기 전용 검사

**DB 버전을 알아보기 위해 새 앱을 운영 DB에 연결하지 않습니다.** 준비한 지원 Node.js에서 아래 명령을 실행합니다. 기존 파일을 읽기 전용으로 열기 때문에 오타 난 경로에 새 DB를 만들지 않습니다. 전체 무결성 검사와 건수 집계는 DB 크기에 따라 시간이 걸릴 수 있습니다.

```sh
PATCH_CHECK_DB="$PATCH_DB" node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.PATCH_CHECK_DB, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=5000; BEGIN');
  console.log('SQLite 엔진:', db.prepare('SELECT sqlite_version() AS version').get().version);
  console.log('DB 형식:', db.prepare('PRAGMA user_version').get().user_version);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  console.log('integrity_check:', integrity);
  console.log('foreign_key_check:', foreignKeys);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    const identifier = '"' + name.replaceAll('"', '""') + '"';
    console.log(name, db.prepare(`SELECT COUNT(*) AS n FROM ${identifier}`).get().n);
  }
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || foreignKeys.length) {
    process.exitCode = 1;
  }
} finally {
  db.close();
}
NODE
```

버전만 먼저 확인해야 하고 지원 Node.js가 아직 준비되지 않았다면, 설치된 SQLite CLI의 `sqlite3 -readonly "$PATCH_DB" 'PRAGMA user_version;'`를 사용할 수 있습니다. 여기서 비교하는 버전은 **앱의 DB 형식인 `user_version`**입니다. SQLite 엔진의 `3.x` 버전이나 JSON 반출 형식 `v6`와 구분합니다.

### 2-3. 버전별 진행 판단

| 확인 결과 | 이번 릴리스 적용 방법 |
| --- | --- |
| v29 | 기준 스키마 검사 통과 후 명시적 v29 → v30 → v31 → v32 → v33 변환 |
| v30 | 기존 migration 이력·checksum 검사 통과 후 명시적 v30 → v31 → v32 → v33 변환 |
| v31 | 기존 이력·checksum 검사 후 v32 일반 outbox 인덱스·v33 접속 토큰 테이블 추가 |
| v32 | 기존 이력·checksum 검사 후 v33 접속 토큰 테이블 추가 |
| v33 | 새 변환 불필요. 기존 이력·checksum과 무결성 검사 후 코드 업데이트 |
| v1~v28 | 현재 도구에 변환 경로 없음. 기존 서비스 유지, 해당 버전용 변환 구현·사본 검증을 먼저 준비 |
| v0 또는 DB 파일 없음 | 운영 DB 경로·기존 테이블·이전 릴리스부터 확인. 기존 서비스 업데이트를 신규 설치로 진행하지 않음 |
| v34 이상 | 이 코드보다 새 형식. 대응 릴리스를 확인하고 다운그레이드 중단 |
| 무결성·외래키·이력 오류 | 원본과 백업 보존, 원인 확인 전 변환·전환 중단 |

v29라는 숫자만 맞아도 되는 것은 아닙니다. 배포된 기준 스키마와 구조가 달라지면 변환을 거절합니다. v30·v31·v32·v33도 checksum 이력이 일치해야 합니다. **`PRAGMA user_version` 숫자 수정, 이력 삭제, `--initialize`, 빈 DB 경로 지정으로 검사를 우회하지 않습니다.**

이번 migration은 v30 동기화 테이블, v31 연결 키 테이블, v32 outbox 일반 인덱스, v33 무기한 접속 토큰 테이블·인덱스를 순서대로 추가합니다. 기존 업무·계정 행을 삭제하거나 재작성하는 변환은 없습니다. 실제 v29/v30/v31/v32 운영 DB 변환은 [DB 변경 지침](DATABASE_CHANGES.md#사용자-승인)에 따라 **확인한 시작 버전, 대상 DB 절대 경로, v33까지의 변환 범위, 점검·백업·복구 계획이 포함된 운영 실행 승인** 범위에서 수행합니다. 가이드 작성이나 버전 확인은 변환 실행이 아닙니다. 이미 승인된 같은 범위는 다시 승인받지 않습니다.

## 3. 운영 서비스와 분리해 새 릴리스 준비

새 소스를 `$PATCH_NEW`에 준비합니다. 기존 릴리스·`dist/`·의존성은 롤백용으로 남깁니다. 소스 반입 방식이라면 전달받은 압축파일을 **새 빈 디렉터리**에 해제합니다.

`main`으로 배포한다면 기능 브랜치의 PR이 먼저 `main`에 병합되어 있어야 합니다. `git pull`은 현재 브랜치만 갱신하므로 다른 브랜치에 푸시한 변경을 가져오지 않습니다. 아래에서 실제 브랜치·커밋과 `scripts.migrate`가 있는지 확인합니다. `Missing script: "migrate"`가 나오면 DB 변환은 실행되지 않은 상태이며, 배포할 릴리스부터 다시 확인합니다.

```sh
cd "$PATCH_NEW"
git branch --show-current
git log -1 --oneline
npm pkg get scripts.migrate
npm ci --include=dev
npm run build
test -f dist/index.html
```

망 제한으로 서버에서 설치·빌드하지 못한다면 1단계에서 준비한 대상 환경용 검증 산출물을 사용합니다. 실행 중인 기존 디렉터리에 의존성을 덮어쓰지 않습니다.

기존 운영 `.env` 또는 서비스 환경 설정을 새 릴리스에 연결하되 다음을 확인합니다.

- `NODE_ENV=production`, `GRAEBOARD_SITE=internal`을 사용합니다.
- `DB_PATH`, `DOCUMENT_IMAGES_DIR`, 동기화 사용 시 `GRAEBOARD_SYNC_DIR`을 **기존 실데이터의 절대 경로**로 지정합니다. 작업 디렉터리만 바뀌어 새 DB가 생성되지 않게 합니다.
- 기존 Origin·쿠키·프록시·포트·비밀 설정을 유지합니다. `.env.example`이나 맥북의 `.env`로 운영 설정을 덮어쓰지 않습니다. 외부용 `.env.cloud.local`을 합쳐 읽지 않습니다.
- 정상 제자리 업데이트는 기존 설치 UUID·동기화 프로필·암호화 키·Git clone을 유지합니다. 외부 동기화를 사용하지 않았다면 `GRAEBOARD_SYNC_PROFILES=[]`를 유지하고, 이번 패치 때문에 새 연결을 만들지 않습니다.
- 서비스 계정이 DB 상위 디렉터리와 이미지·sync 경로에 필요한 권한을 갖는지 확인합니다. SQLite의 WAL·SHM도 DB 옆에 생성됩니다.
- 접속 토큰 키 환경 변수 `GRAEBOARD_ACCESS_TOKEN_KEY`가 없으면 최초 토큰 발급 때 DB 폴더에 `access-token.key`를 자동 생성합니다(0600). 내부 서버는 별도 키 설정 없이 시작할 수 있습니다. 기존 키가 있다면 그대로 유지하고 DB·이미지 백업과 분리해 안전하게 보관합니다. 키를 잃거나 바꾸면 기존 토큰을 다시 표시할 수 없습니다.

이 단계에서는 새 서비스가 운영 DB로 자동 시작되지 않도록 합니다. 서비스 전환은 리허설과 최종 백업 뒤에 수행합니다.

## 4. 사본에서 복구·실제 변환·구버전 복구 리허설

### 4-1. 기존 릴리스 도구로 사전 백업

**기존 릴리스 디렉터리의 도구**를 기존 운영 설정·해당 릴리스가 지원하는 런타임으로 실행합니다. 다음 명령 형식도 구 릴리스에서 제공되는지 먼저 확인합니다. 없거나 백업 형식이 다르면 해당 릴리스의 절차를 확인하고, 새 도구로 대체해도 된다고 가정하지 않습니다.

```sh
cd "$PATCH_OLD"
DB_PATH="$PATCH_DB" DOCUMENT_IMAGES_DIR="$PATCH_IMAGES" \
  GRAEBOARD_SYNC_DIR="$PATCH_SYNC" \
  npm run backup -- "$PATCH_BACKUP/rehearsal.sqlite"
```

기존 방식에서 실행 중 백업을 지원하면 이 사전 백업은 서비스 중에 준비할 수 있습니다. 최종 백업은 5단계에서 쓰기를 중단한 뒤 다시 만듭니다. 새 경로의 백업은 덮어쓰지 않으며, 명령 성공과 실제 결과 파일을 확인합니다.

백업 DB와 `rehearsal.sqlite.images/`를 같은 위치에 함께 보관합니다. 이미지 참조가 없는 DB는 이미지 묶음이 생성되지 않을 수 있습니다. 참조가 있는데 이미지 묶음이 없거나, 이미지 해시가 다르면 정상 백업이 아닙니다. 동기화로 로컬에서 회수한 이미지는 기존 Git clone의 고정 head에서 읽으므로 Git 실행 파일과 기존 `$PATCH_SYNC`도 필요합니다.

### 4-2. 새 릴리스에서 새 경로로 복구 후 변환

현재 복구 도구는 **v29·v30·v31·v32·v33 백업을 원래 버전 그대로** 복구합니다. 기존 대상 DB는 덮어쓰지 않습니다. 리허설 자료도 운영 데이터이므로 접근을 제한하고, 회사 정책에 따라 허용된 환경 안에서만 다룹니다.

```sh
cd "$PATCH_NEW"
DOCUMENT_IMAGES_DIR="$PATCH_REHEARSAL/document-images" \
  npm run restore -- "$PATCH_BACKUP/rehearsal.sqlite" "$PATCH_REHEARSAL/check.sqlite"

npm run migrate -- --engine sqlite --database "$PATCH_REHEARSAL/check.sqlite" --dry-run
npm run migrate -- --engine sqlite --database "$PATCH_REHEARSAL/check.sqlite"
```

`--dry-run`은 읽기 전용 사전 검사이며 **실제 DDL을 실행해 보는 리허설이 아닙니다.** 반드시 위의 실제 사본 변환까지 통과해야 합니다. v29·v30·v31·v32는 결과 버전 33, 이미 v33이면 `applied: false`가 정상입니다. 마이그레이션 명령은 백업을 자동 생성하지 않습니다.

2-2의 읽기 전용 검사에서 첫 줄의 `PATCH_CHECK_DB`만 `$PATCH_REHEARSAL/check.sqlite`로 바꿔 다시 실행합니다. `user_version=33`, `integrity_check=ok`, `foreign_key_check`가 빈 배열이어야 합니다. 복구 과정에서 세션 삭제, v30 이상 동기화 연결의 `recovery` 전환·writer epoch 변경, v31 이상 연결 키 폐기와 v33 접속 토큰 폐기가 발생하므로 이 차이를 업무 데이터 손실과 구분합니다.

### 4-3. 원격 동기화를 끈 사본 서버 확인

다음은 비어 있는 로컬 포트 `4312`를 사용하는 예시입니다. `$PATCH_NEW`에서 실행하고, 복구한 사본만 연결합니다.

```sh
PATCH_REHEARSAL_ID="$(node --input-type=module -e "import { randomUUID } from 'node:crypto'; console.log(randomUUID())")"
NODE_ENV=production GRAEBOARD_SITE=internal HOST=127.0.0.1 PORT=4312 \
  APP_ORIGIN=http://127.0.0.1:4312 COOKIE_SECURE=0 TRUST_PROXY=0 \
  DB_PATH="$PATCH_REHEARSAL/check.sqlite" \
  DOCUMENT_IMAGES_DIR="$PATCH_REHEARSAL/document-images" \
  GRAEBOARD_SYNC_DIR="$PATCH_REHEARSAL/sync" \
  GRAEBOARD_SYNC_PROFILES='[]' GRAEBOARD_INSTALLATION_ID="$PATCH_REHEARSAL_ID" \
  npm start
```

서버의 로컬 브라우저 또는 허용된 SSH 터널로 접속합니다. 다른 터미널에서 `curl --fail --silent --show-error http://127.0.0.1:4312/api/health`도 확인합니다. 운영 프로필·활성 설치 ID로 사본을 동기화하거나 연결의 복구·재개 버튼을 누르지 않습니다.

기존 계정으로 다시 로그인해 다음을 대조합니다. 건수만으로 보존 여부를 판단하지 말고 대표 자료의 ID·값·수정번호·참조와 실제 화면을 함께 확인합니다.

| 대상 | 확인 내용 |
| --- | --- |
| 계정·권한 | 기존 계정 로그인, 관리자/팀장/팀원 권한과 소속 팀, 다른 팀 접근 제한 |
| 업무·서식 | 기존 연도별 업무, 셀 값·version, 행·열 서식과 공용/개인 필터 |
| 문서·이미지 | 본문·revision, 원본/사본 참조, 이미지 표시, 업로드·저장 후 재조회 |
| 사본·메모·일정 | 사본 시트, 연간 메모, 개인/공용 캘린더·태그·주간 할 일 |
| 저장·동시 화면 | 사본에서 값 수정·재조회, 실행취소, 두 탭의 셀·문서 갱신 |

확인 후 사본 서버를 정상 종료합니다. 이어서 **같은 사전 백업을 또 다른 새 DB·이미지 경로에 복구하고, 그 백업 버전과 맞는 이전 릴리스로 기동하는 롤백 리허설**도 수행합니다. 구버전 도구의 지원 형식을 확인하고, 운영 경로·원격 동기화는 계속 분리합니다. 두 리허설의 소요 시간을 점검 시간 산정에 사용합니다.

## 5. 점검 시작: 모든 쓰기 중단과 최종 백업

리허설을 통과하고 필요한 운영 실행 승인이 있는 경우에 진행합니다.

1. 점검 시간을 공지하고 사용자가 편집 내용을 저장하도록 안내합니다. 프록시 등 기존 운영 방식으로 사용자 접근을 제한합니다.
2. 앱을 **정상 종료**하고 예약 백업·가져오기·관리 명령·다른 앱 프로세스 등 DB에 쓰는 작업도 중단합니다. 자동 재시작으로 앱이 다시 올라오지 않는지 확인합니다.
3. 실제 프로세스 종료와 로그를 확인합니다. 종료 제한 초과, 미완료 동기화·정리·백업 상태가 있으면 원인을 처리한 뒤 진행합니다. 강제 종료나 작업 상태 행 삭제로 우회하지 않습니다.
4. 아래 최종 백업을 기존 릴리스 도구로 생성합니다. `.env`·서비스·프록시 설정 및 기존 릴리스도 별도로 보존합니다. 동기화 사용 시 clone과 키·토큰 보관 위치를 유지하고 키는 DB 백업과 분리해 보관합니다.

systemd로 운영 중인 Linux 서버라면 다음은 정지 예시입니다. 실제 unit 이름으로 바꾸며, 다른 관리 방식을 사용하면 2-1에서 기록한 정지·상태 확인 명령을 사용합니다.

```sh
PATCH_SERVICE='실제서비스이름.service'
sudo systemctl stop "$PATCH_SERVICE"
sudo systemctl status "$PATCH_SERVICE" --no-pager
```

최종 백업 명령:

```sh
cd "$PATCH_OLD"
DB_PATH="$PATCH_DB" DOCUMENT_IMAGES_DIR="$PATCH_IMAGES" \
  GRAEBOARD_SYNC_DIR="$PATCH_SYNC" \
  npm run backup -- "$PATCH_BACKUP/final-before-patch.sqlite"
```

DB 본체만 `cp`하면 WAL의 최신 변경이 빠질 수 있으므로 그것을 이 백업의 대체로 사용하지 않습니다. **백업 파일·이미지 묶음·대응 구 릴리스·기존 DB 버전·설정 보관 위치를 함께 기록**합니다. 백업 파일을 별도 보관소에도 보존합니다.

최종 묶음의 복구 가능성도 새 경로에서 확인합니다. 이 DB는 운영에 연결하지 않습니다.

```sh
cd "$PATCH_NEW"
DOCUMENT_IMAGES_DIR="$PATCH_BACKUP/final-verify-images" \
  npm run restore -- "$PATCH_BACKUP/final-before-patch.sqlite" "$PATCH_BACKUP/final-verify.sqlite"
```

최종 백업·복구 검사가 실패하면 운영 DB 변환과 서비스 전환을 중단합니다. 기존 DB를 변경하지 않은 상태에서 원인을 해결하거나, 기존 릴리스 재개 여부를 판단합니다.

## 6. 운영 DB 검사·변환

앱과 모든 쓰기 작업이 중단된 상태를 유지합니다. 2-2의 읽기 전용 검사로 **최종 백업 이후, 변환 직전의 운영 DB 버전과 기존 테이블 건수**를 기록합니다. 2-3에서 지원한다고 확인한 버전에 대해서만 진행합니다.

```sh
cd "$PATCH_NEW"
npm run migrate -- --engine sqlite --database "$PATCH_DB" --dry-run
```

사전 검사가 통과했으며 운영 DB가 v29·v30·v31·v32이면 승인된 경로에 실제 변환을 **한 번만** 실행합니다. 이미 v33이면 아래 변환 실행은 생략합니다.

```sh
npm run migrate -- --engine sqlite --database "$PATCH_DB"
```

2-2의 검사로 `user_version=33`, 무결성 정상, 외래키 오류 없음과 기존 테이블 건수 보존을 확인합니다. 다음 명령은 새 코드의 migration 이력·checksum도 다시 검사합니다.

```sh
npm run migrate -- --engine sqlite --database "$PATCH_DB" --dry-run
```

시작 버전에 따라 동기화·연결 키·접속 토큰 테이블, 일반 outbox 인덱스와 migration 이력이 추가되는 차이는 예상된 변화입니다. 기존 업무·계정·문서 등의 행이 줄거나 값·참조가 달라지면 서비스 개방 전에 원인을 확인합니다. 변환은 DDL·이력·버전 갱신을 한 트랜잭션으로 처리하지만, 실패 메시지만 보고 복구 상태를 추정하지 말고 실제 버전·무결성을 재확인합니다.

## 7. 새 릴리스로 서비스 전환 후 확인

1. 서비스의 작업 디렉터리를 `$PATCH_NEW`로, 실행 파일을 검증한 Node.js 절대 경로로 지정합니다. 기존 실행 방식과 단일 앱 프로세스 구성을 유지합니다. `npm start`는 `dist/`를 빌드하지 않습니다.
2. 실제 서비스 환경에서 DB·이미지·sync 절대 경로, production/internal, Origin·쿠키·프록시 설정을 다시 확인합니다. 리허설의 DB·설치 UUID·빈 프로필 설정을 운영 서비스에 복사하지 않습니다.
3. 새 서비스를 시작하고 시작 로그를 확인합니다. systemd unit을 수정했다면 `sudo systemctl daemon-reload` 후 기존 서비스의 `start`를 사용합니다. 구 프로세스와 신 프로세스를 같은 DB로 동시에 띄우지 않습니다.
4. 사용자 접근 제한을 유지한 채 앱 직접 주소와 실제 프록시 주소, 브라우저 화면을 검사합니다. 기존 동기화가 활성화된 설치는 시작 시 동기화도 재개될 수 있으므로 상태·미전송 변경·오류를 함께 확인합니다.

기본 로컬 포트가 `4310`인 경우의 확인 예시입니다. 실제 포트가 다르면 변경합니다.

```sh
curl --fail --silent --show-error http://127.0.0.1:4310/api/health
curl --fail --silent --show-error http://127.0.0.1:4310/api/setup
```

health의 `status: "ok"`, `site: "internal"`과 기존 설치의 setup `required: false`를 확인합니다. **최초 관리자 생성 화면이 나타나면 신규 설정을 진행하지 말고 서비스의 DB 경로·작업 디렉터리부터 확인합니다.** health의 `version`은 고정 앱 문자열이며 실제 배포 커밋이나 DB 버전 증명이 아닙니다. `dist/`가 없어도 health는 성공할 수 있습니다.

운영 화면에서 다음을 확인하고 결과를 기록합니다.

- 기존 계정 로그인, 팀·연도별 기존 업무 조회, 권한과 필터·서식 표시.
- 지정한 확인용 자료의 저장·새로고침·실행취소. 기존 자료의 임의 수정이나 대량 테스트를 하지 않습니다.
- 기존 문서·이미지·연간 메모·사본·캘린더 조회와 필요한 저장 확인.
- 프로필 아래 접속 토큰에서 무기한 생성·눈 아이콘 재조회·복사·삭제 확인. 최초 발급 후 DB 폴더의 키 파일(또는 기존 키 환경 변수)을 별도 보관합니다.
- 캘린더 제목 검색·숨긴 일정 목록, 꼬리 메모 전체 화면의 상단 헤더·닫기, PC 시각이 다른 환경의 저장을 확인합니다. 앱 응답의 `X-Server-Time`이 실제 접속 경로에서도 전달되는지 확인합니다.
- 같은 화면을 두 탭으로 열어 셀·문서 수정 전달과 연결 복구 확인. `POST /api/events` SSE가 프록시에서 버퍼링되지 않고 heartbeat를 전달하는지 확인합니다. 프록시 읽기 제한은 60초 이상이며 SSE 압축·버퍼링을 끕니다.
- 브라우저 콘솔·Network와 서버 로그의 반복 4xx/5xx, 저장 실패·동기화 오류 확인. 확인용 브라우저는 새로고침해 새 정적 파일을 읽도록 합니다.

정상일 때 사용자 접속과 예약 작업을 재개합니다. 실제 커밋, 시작/종료 시각, DB 전후 버전, 백업 위치, 검증 결과와 남은 문제를 기록합니다. 이전 릴리스·백업·검증 자료는 보관 정책에 따라 유지하며 즉시 삭제하지 않습니다.

## 8. 실패 시 복구 순서

### 8-1. 운영 DB를 변환하기 전

새 릴리스 준비·사본 검증 단계에서 실패했다면 기존 운영 DB와 기존 서비스를 유지합니다. 최종 백업 단계에서 이미 서비스를 정지했다면, DB가 원래 상태임을 확인한 뒤 기존 릴리스·기존 설정으로 재개합니다.

### 8-2. 변환 후, 사용자 접속 재개 전

새 앱과 쓰기 작업을 중지하고 실패한 DB·이미지·로그를 별도 보존합니다. 검증 중 저장이나 기존 동기화 수신으로 최종 백업 이후 변경이 생겼는지도 확인합니다. 그런 변경이 있으면 8-3의 데이터 보존 판단을 먼저 합니다.

**이전 릴리스와 최종 백업의 DB·이미지를 함께 복구합니다.** 이미 v33으로 바뀐 DB에 v29/v30/v31/v32 프로그램만 실행하지 않습니다. 현재 restore 도구가 지원하는 v29/v30/v31/v32/v33 백업이라면 다음처럼 새 경로로 복구할 수 있습니다.

```sh
PATCH_ROLLBACK="/srv/graeboard/rollback/patch-${PATCH_RUN}"
cd "$PATCH_NEW"
DOCUMENT_IMAGES_DIR="$PATCH_ROLLBACK/document-images" \
  npm run restore -- "$PATCH_BACKUP/final-before-patch.sqlite" "$PATCH_ROLLBACK/weekly-plan.sqlite"
```

복구본은 백업의 원래 DB 버전입니다. **구버전으로 돌아갈 복구본에는 v33 migration을 실행하지 않습니다.** 복구 도구는 디렉터리를 `0700`, DB·이미지 파일을 `0600` 권한으로 생성하므로, 서비스 계정이 복구 경로를 통과하고 DB·이미지를 읽고 쓸 수 있는지 확인합니다. 서비스의 작업 디렉터리·Node 경로를 기존 릴리스에 맞추고, `DB_PATH`와 `DOCUMENT_IMAGES_DIR`을 위 복구 경로로 함께 바꿉니다. 무결성·데이터 보존 확인 후 기존 릴리스로 시작해 로그인·업무·이미지를 검증하고 접속을 재개합니다. 복구 시 세션이 지워지므로 재로그인이 필요합니다. v33 백업에 있던 접속 토큰도 폐기되므로 필요한 토큰은 다시 발급합니다.

동기화가 있는 복구본은 일반 제자리 업데이트와 다릅니다. v30 이상 연결은 `recovery`로 시작하며, 활성 원본과 복구본이 같은 설치 ID로 동시 발신하지 않도록 해야 합니다. 구 서버·복구 서버의 쓰기 중단을 확인하고 **해당 릴리스·DB 버전에 맞는 복구 절차**를 먼저 수행합니다. 원격을 대조하기 전에 연결을 재개하지 않습니다.

현재 v33 릴리스로 복구하는 경우에만 올바른 운영 프로필·암호화 키·sync 경로를 설정한 뒤 [동기화 복구 절차](OPERATIONS.md#백업과-복구)에 따라 다음 순서를 사용합니다. 복구 설치 UUID는 한 번 생성해 기록하고, 명령을 재시도할 때도 같은 값을 사용합니다. 구버전 DB에 이 신버전 명령을 바로 적용하지 않습니다.

```sh
PATCH_RECOVERY_ID="$(node --input-type=module -e "import { randomUUID } from 'node:crypto'; console.log(randomUUID())")"
GRAEBOARD_INSTALLATION_ID="$PATCH_RECOVERY_ID" GRAEBOARD_SYNC_DIR="$PATCH_SYNC" \
  npm run sync:recover -- --database "$PATCH_ROLLBACK/weekly-plan.sqlite" \
  --images-dir "$PATCH_ROLLBACK/document-images" --team-id '실제팀UUID' --dry-run
GRAEBOARD_INSTALLATION_ID="$PATCH_RECOVERY_ID" GRAEBOARD_SYNC_DIR="$PATCH_SYNC" \
  npm run sync:recover -- --database "$PATCH_ROLLBACK/weekly-plan.sqlite" \
  --images-dir "$PATCH_ROLLBACK/document-images" --team-id '실제팀UUID' --confirm-drained
```

두 번째 명령은 복구 DB를 갱신하고 원격 이력을 대조합니다. 원격 게시를 수행하지 않으며 결과는 일시정지 상태입니다. 재시작할 서비스 환경의 `GRAEBOARD_INSTALLATION_ID`에도 **같은 `$PATCH_RECOVERY_ID` 값을 영구 반영**하고 복구 DB·이미지·sync 경로를 확인한 뒤 관리자가 별도로 재개합니다. v31 이상 백업의 복구로 폐기된 미사용 연결 키가 필요하면 새로 발급합니다.

### 8-3. 사용자 접속 재개 후 또는 백업 이후 새 변경이 있는 경우

현재 쓰기를 중단하고 **현재 DB·이미지·동기화 상태를 먼저 보존**합니다. 최종 백업으로 되돌리면 그 이후 저장을 잃을 수 있습니다. 수정 배포와 데이터 보존을 포함한 복구 방법을 판단한 뒤 승인된 범위로 수행합니다. 이전 백업을 현재 DB에 덮어쓰거나, 이전 코드만 켜서 문제를 우회하지 않습니다.

## 9. 당일 완료 기록

- [ ] 배포 커밋이 확정되었고 필요한 미커밋 변경이 빠지지 않았다.
- [ ] 운영 DB의 실제 버전과 경로를 확인했고 지원 변환 경로에 해당한다.
- [ ] 사본의 복구·실제 변환·화면 검증과 이전 릴리스 복구 리허설을 통과했다.
- [ ] 해당하는 운영 DB 변환 실행 범위가 승인되어 있다.
- [ ] 쓰기 중단 후 기존 릴리스 도구로 최종 DB·이미지 백업을 만들고 복구 검사를 통과했다.
- [ ] 실제 운영 버전의 백업 사본에서 복구 `--dry-run`, 실제 복구·migration과 기존 행·이미지 보존을 실증했다.
- [ ] 운영 DB v33·migration 이력·무결성·외래키 및 기존 자료 보존을 확인했다.
- [ ] 서비스의 런타임·작업 디렉터리·데이터 경로가 올바르고 기존 자료가 보인다.
- [ ] 로그인·저장·이미지·문서·사본·캘린더·탭 간 갱신을 확인했다.
- [ ] 동기화 사용 시 기존 설치 설정과 연결 상태를 확인했다.
- [ ] 접속·예약 작업을 재개하고 커밋·버전·검증 결과·백업·복구 경로를 기록했다.

이 가이드 작성 시 개발 환경의 임시 DB로 `tests/sync-migrations.test.mjs`와 `tests/backup.test.mjs`를 실행하여 **8건 통과, 실패·건너뜀 0건**을 확인했습니다. 이는 접속 토큰 도입 전의 v32 migration·백업 코드에 대한 당시 검사 기록이며, 실제 운영 DB의 버전 확인·사본 리허설이나 최종 배포본 전체 검증을 대신하지 않습니다.
