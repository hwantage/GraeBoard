# 외부 서비스와 팀 동기화 설치

[운영 안내](OPERATIONS.md) · [데이터 형식](DATA_FORMAT.md) · [동기화 규약](SYNC_PROTOCOL.md)

이 안내는 내부 Node/SQLite 서버와 외부 Cloudflare Worker/Supabase 서버를 연결하는 관리자를 위한 절차입니다. 운영 자원 생성·배포·운영 DB 변환은 대상과 점검 시간이 승인된 뒤 수행합니다. 개발 환경의 검증과 실제 클라우드 계정의 연결 검사는 서로 다른 단계입니다.

## 1. 준비할 자원

사내에서는 모든 팀을 기존 SQLite DB 하나에서 관리합니다. 외부 접근이 필요한 팀만 동기화를 켜며, 각 팀이 독립된 외부 사이트를 운영합니다.

| 범위 | 준비할 것 |
| --- | --- |
| 내부 공통 | 기존 Node/SQLite 서버·이미지 경로·Git CLI |
| 외부 연결 팀마다 | 비공개 GitHub 데이터 저장소 하나 |
| 외부 연결 팀마다 | Cloudflare Pages 접속 주소·비공개 Worker + Static Assets 앱·Google 전용 Access 앱 |
| 외부 연결 팀마다 | Supabase 프로젝트 하나와 Hyperdrive 하나 |
| 외부 연결 팀마다 | 비공개 R2 bucket·Images binding |

외부 연결 팀이 N개면 Supabase 프로젝트도 N개입니다. 한 프로젝트 안의 `graeboard`는 업무 자료, `graeboard_site`는 그 팀의 사용자·연결 승인·설정 정보를 보관합니다. 별도 공통 관리 프로젝트는 만들지 않습니다. 기존에 빈 관리용 프로젝트를 만들었다면 그 프로젝트를 해당 팀 전용으로 사용할 수 있습니다.

외부 접속 주소는 팀별 Pages의 `https://프로젝트.pages.dev`를 사용할 수 있습니다. `functions/[[path]].js`가 모든 요청을 `GRAEBOARD_BACKEND` Service binding으로 비공개 Worker에 전달합니다. Worker가 정적 화면·API·인증·Hyperdrive·R2·Cron을 처리하므로 기존 권한 검사와 동기화 경로를 재사용합니다. 브라우저의 주소·요청 본문·Access JWT·계정 쿠키·SSE 스트림은 그대로 유지합니다. `public/_routes.json`은 정적 파일도 이 경로를 거치게 합니다. 연결이 없거나 Worker에 도달하지 못하면 JSON 503을 반환하며 Pages의 정적 HTML로 대체하지 않습니다.

팀이 추가되면 Pages·Worker·DB·bucket·Access 앱을 각각 준비합니다. 기존 자체 도메인에서 Worker에 직접 접속하는 배포도 유지합니다.

내부 서버에는 팀별 Git 토큰만 등록하며 외부 DB 비밀번호·R2 키는 복사하지 않습니다. 자원 이용 조건은 [Supabase](https://supabase.com/pricing), [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/)에서 확인합니다.

## 2. 값을 어디에 입력하는가

내부망 서버의 외부 접속은 팀 GitHub 저장소만 허용합니다. Supabase·Hyperdrive·R2·Cloudflare 관리 API로 내부 서버가 직접 접속하지 않습니다. 외부 DB 초기화와 배포는 인터넷에 연결된 별도 운영 환경에서 수행하고, DB 비밀번호·외부 설정 키를 내부 서버의 환경 파일에 저장하지 않습니다. 로컬 Node/SQLite를 내부망으로 시험할 때도 같은 경계를 지킵니다.

`binding`은 Worker에 설치한 자원을 가리키는 이름입니다. 앱 화면에서 bucket 이름을 입력한다고 자원이 생성되지는 않습니다.

| 값                     | 입력 위치          | 의미                                            |
| ---------------------- | ------------------ | ----------------------------------------------- |
| `APP_ORIGIN`           | Worker 변수        | 경로 없는 외부 HTTPS origin 하나                |
| `GRAEBOARD_BACKEND` | Pages Service binding | 같은 팀의 비공개 Worker |
| `ACCESS_ISSUER`        | Worker 변수        | `https://조직이름.cloudflareaccess.com`         |
| `ACCESS_AUDIENCE`      | Worker 변수        | GraeBoard 전용 Access 앱의 Application Audience |
| `PG_SITE` | Hyperdrive binding | 해당 팀의 단일 Supabase 프로젝트 |
| `SITE_TEAM_ID` | Worker 변수 | 기존 내부 팀 UUID |
| `R2_TEAM_A`            | R2 binding         | 팀 A 비공개 bucket                              |
| `IMAGES`               | Images binding     | 업로드 이미지를 WebP로 변환                     |
| `GIT_TEAM_A`           | Worker Secret      | 해당 팀 저장소만 허용한 GitHub 토큰             |
| `SYNC_PROFILES`        | Worker 변수        | 팀 UUID와 설치된 binding·Secret 이름의 연결     |
| 팀장 연결 키 | 내부 팀 설정에서 발급 | 검증 해시만 GitHub를 통해 Supabase로 전달 |
| `INSTALLATION_ID`      | Worker 변수        | 외부 설치의 고정 UUID, DB 복구 사본과 구분      |
| `PEER_INSTALLATION_ID` | Worker 변수        | 적용 확인을 받을 내부 설치 UUID                 |

`ACCESS_TEAM_DOMAIN`과 `ACCESS_AUD`도 발급자·Audience의 호환 이름입니다. 한 설치에서는 한 가지 이름을 일관되게 사용하세요. 발급자에는 `https://`를 포함하고 끝에 `/`를 붙이지 않습니다.

DB 비밀번호는 Hyperdrive에, GitHub 토큰은 Secret에 보관합니다. `teams.settings`, 일반 변수, 감사 로그, 브라우저 폼, 앱 소스, Git 데이터 저장소에 비밀을 넣지 않습니다. 조직 전체 Cloudflare 관리 토큰을 앱의 팀 연결 화면에 입력하는 기능은 없습니다.

## 3. SQLite v29·v30을 v31로 올리기

실제 운영 DB 버전은 저장소 버전으로 추정하지 않습니다. 먼저 승인된 DB 경로와 현재 배포 커밋을 기록하고 읽기 전용으로 `PRAGMA user_version`을 확인합니다. 이 릴리스의 SQLite 업그레이드 지원 경로는 **v29 → v30 → v31**입니다. 일반 서버 시작은 기존 v29·v30 DB를 자동 변환하지 않습니다.

1. 기존 릴리스로 DB와 문서 이미지 백업을 만들고 별도 경로에 복구해 확인합니다.
2. 운영 적용 때는 서버와 다른 DB 쓰기 작업을 중지합니다.
3. 새 릴리스에서 정확한 대상 경로로 dry-run을 실행합니다.

```sh
npm run migrate -- --engine sqlite --database /srv/graeboard/data/weekly-plan.sqlite --dry-run
```

4. 출력의 `from`, `to`, `checksum`을 확인한 뒤 같은 대상에 적용합니다.

```sh
npm run migrate -- --engine sqlite --database /srv/graeboard/data/weekly-plan.sqlite
```

5. 같은 명령을 다시 실행하면 이력과 무결성을 검사하고 중복 변환하지 않습니다. 서버를 시작해 기존 계정·팀·업무·문서·이미지를 확인한 뒤 접속을 재개합니다. 동기화는 팀별로 연결하기 전까지 미연결입니다.

새 설치의 빈 경로에는 명시적으로 `--initialize`를 사용합니다. 상위 디렉터리는 실행 계정만 접근할 수 있게 먼저 준비합니다.

```sh
npm run migrate -- --engine sqlite --database /srv/graeboard/new/weekly-plan.sqlite --initialize --dry-run
npm run migrate -- --engine sqlite --database /srv/graeboard/new/weekly-plan.sqlite --initialize
```

변환 중 실패하면 해당 단계의 스키마·버전·이력이 함께 롤백됩니다. 원인을 해결한 뒤 같은 명령으로 재시도합니다. checksum 불일치, 지원하지 않는 구버전·미래 버전, 사용자 테이블이 있는 버전 0 DB는 보존한 채 거절합니다. checksum 값을 직접 고치거나 버전 검사만 제거하지 않습니다. 이 명령은 백업이나 다운그레이드를 자동으로 수행하지 않습니다.

접속 재개 전 되돌릴 때는 이전 릴리스와 검증된 DB·이미지 백업을 **새 경로**에 복구합니다. 접속 재개 후에는 새 저장과 outbox가 생길 수 있으므로 현재 DB·원격 head부터 보존하고 복구 계획을 다시 정합니다. 상세 백업 명령은 [운영 안내](OPERATIONS.md#백업과-복구)를 따릅니다.

## 4. Supabase 팀 프로젝트 하나 만들기

팀마다 프로젝트 하나를 만들고 **Connect → Direct connection**의 PostgreSQL 주소를 사용합니다. Project URL이나 publishable/anon/service_role API key는 사용하지 않습니다. 이 앱은 Hyperdrive를 통해 PostgreSQL에 연결하므로 Supabase Data API와 Supabase Auth는 필요하지 않습니다. Data API를 켜더라도 `graeboard`와 `graeboard_site`를 exposed schemas에 추가하지 않습니다. [Supabase Data API 보안](https://supabase.com/docs/guides/api/securing-your-api)

아래 UUID는 기존 사내 팀의 실제 UUID로 바꿉니다. 연결 URL은 터미널에서 숨김 입력으로 읽고 환경 변수로 전달합니다.

```sh
read -s PG_SITE_URL
export PG_SITE_URL
npm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id 11111111-1111-4111-8111-111111111111 --team-name '팀 A' --initialize --dry-run
npm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id 11111111-1111-4111-8111-111111111111 --team-name '팀 A' --initialize
unset PG_SITE_URL
```

이 명령은 `graeboard`의 team v1과 `graeboard_site`의 site v2를 **같은 트랜잭션**으로 만듭니다. dry-run·실패는 전체 롤백하며 재실행은 중복 적용하지 않습니다. 다른 팀 UUID·체크섬 불일치·미지원 스키마는 기존 자료를 보존하고 거절합니다. 사내 SQLite는 v31로 별도 변환합니다.

기존 분리형 설치의 **team v1 DB**를 전환할 때는 백업과 쓰기 중단 후 같은 명령에서 `--initialize`를 빼고 실행합니다. 기존 업무 스키마·ID·C/P/L을 그대로 두고 site 스키마만 추가합니다. 기존 공통 control DB는 건드리지 않습니다. 그 DB의 계정·Google 연결을 가져오지 않으며, 내부 구성원 동기화 후 팀장 최초 연결과 팀원 승인을 다시 합니다. 이전 외부 계정 ID로 작성한 업무의 표시 참조는 이력으로 보존합니다. 기존 control DB 자체에 site migration을 적용하는 것은 거절합니다.

DB 관리자가 별도 `graeboard_app` LOGIN 역할과 비밀번호를 준비하고 migration 역할로 다음 권한을 부여합니다. 향후 migration도 동일 역할로 실행합니다.

```sql
GRANT USAGE ON SCHEMA graeboard, graeboard_site TO graeboard_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graeboard, graeboard_site TO graeboard_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graeboard, graeboard_site TO graeboard_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA graeboard, graeboard_site
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO graeboard_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA graeboard, graeboard_site
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO graeboard_app;
```

앱 역할에는 schema 소유권·superuser·새 role 생성 권한을 주지 않습니다. 기존 분리형 `PG_CONTROL` + 팀 DB 설치는 호환 경로로 유지하지만 신규 설치의 기본 구성은 `PG_SITE`입니다.

## 5. Hyperdrive, R2, Images 연결

팀 Supabase 프로젝트의 Direct connection과 `graeboard_app` 계정으로 Hyperdrive **하나**를 만듭니다. Hyperdrive가 풀링하므로 Supabase pooler 주소를 이 경로에 겹치지 않습니다. [Cloudflare의 Supabase 연결 안내](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)

계정 철회·revision·outbox를 최신으로 읽도록 **query caching을 끕니다**. 설정 파일의 binding 선언만으로 캐시가 꺼지지는 않습니다. [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)

```sh
npx wrangler hyperdrive update ACTUAL_SITE_HYPERDRIVE_ID --caching-disabled
npx wrangler hyperdrive get ACTUAL_SITE_HYPERDRIVE_ID
```

| 자원 | Worker binding | 설정 |
| --- | --- | --- |
| 팀 Hyperdrive | `PG_SITE` | 팀 프로젝트, 캐시 끄기 |
| 비공개 R2 bucket | `R2_TEAM_A` | 해당 팀 전용, public access 끄기 |
| Images | `IMAGES` | 이미지 변환 |

이미지는 앱의 권한 검사를 거쳐 `/api/document-images/...`로 제공합니다. R2 native binding에는 S3 access key가 필요 없습니다. [R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

Images binding은 10MiB·4천만 화소 이하 PNG/JPEG/WebP 정지 이미지를 최대 4096px WebP로 변환합니다. 실제 계정에서 업로드·회전·용량 초과·애니메이션 거절·조회도 확인합니다. [Images binding](https://developers.cloudflare.com/images/optimization/binding/)

## 6. 팀별 GitHub 저장소와 토큰

GitHub에서 팀별 **Private repository**를 만들고 README를 추가해 `main`을 초기화합니다. 앱은 별도의 `sync-v1` 브랜치를 만들며 일반 소스 브랜치와 섞지 않습니다. 완전히 빈 저장소에는 GitHub Git refs API로 새 ref를 만들 수 없는 제약이 있습니다. [Git refs API](https://docs.github.com/en/rest/git/refs#create-a-reference)

GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**에서 해당 저장소 하나만 선택하고 **Contents: Read and write**를 허용합니다. 조직 승인, 발급 계정의 저장소 권한, 만료일도 확인합니다. 내부와 외부용 토큰은 구분해 관리할 수 있습니다. [GitHub PAT 안내](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

외부 토큰은 Worker의 Secret `GIT_TEAM_A`에 등록합니다. 앱 소스 저장소·배포 관리 토큰과 팀 데이터 저장소 토큰을 구분합니다. 토큰 값을 저장소 URL이나 명령 인자에 넣지 않습니다.

```sh
npx wrangler secret put GIT_TEAM_A
```

이 명령은 토큰을 대화형 입력으로 받습니다. Secret 변경도 새 Worker version·배포에 영향을 줄 수 있으므로 변경 대상과 배포 시점을 확인합니다. [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 7. 팀 전용 Worker에 프로필 하나 등록

저장소의 `wrangler.jsonc`를 복사해 팀의 도메인·Hyperdrive ID·bucket·UUID를 입력합니다. `SITE_TEAM_ID`와 프로필의 `teamId`는 내부 팀 UUID와 같아야 하며 `databaseBinding`은 `PG_SITE`입니다. 팀 사이트에 여러 프로필·다른 팀·`replaces`를 넣으면 거절합니다.

```json
[
  {
    "profileId": "team-a-prod",
    "name": "팀 A 외부",
    "teamId": "11111111-1111-4111-8111-111111111111",
    "repository": "example/graeboard-team-a-data",
    "databaseBinding": "PG_SITE",
    "bucketBinding": "R2_TEAM_A",
    "githubSecret": "GIT_TEAM_A"
  }
]
```

위 배열을 `SYNC_PROFILES`에 JSON 문자열로 지정하고 같은 이름의 R2 binding·Git Secret을 등록합니다. `INSTALLATION_ID`는 이 팀 외부 사이트의 고정 UUID, `PEER_INSTALLATION_ID`는 사내 서버의 고정 설치 UUID입니다. `APP_ORIGIN`·`ACCESS_ISSUER`·`ACCESS_AUDIENCE`도 이 팀 사이트의 값을 사용합니다.

정적 화면에도 인증을 적용하도록 `assets.run_worker_first: true`, `workers_dev: false`, `preview_urls: false`를 유지합니다. Pages에서 연결할 Worker는 별도 공개 주소가 필요 없습니다. `APP_ORIGIN`에는 사용자 접속 주소(예: `https://graeboard.pages.dev`)를 지정합니다. Cron은 `* * * * *`입니다. 외부 사이트의 DB·bucket을 교체할 때는 점검 중 새 자원에 백업을 복구하고 검증한 뒤 같은 팀 프로필의 binding을 전환합니다. 실행 중 다른 팀 DB로 바꾸지 않습니다. [Wrangler 설정](https://developers.cloudflare.com/workers/wrangler/configuration/)

기존 분리형 설치에서만 다중 프로필과 `replaces`를 통한 온라인 교체 경로를 유지합니다.

## 8. GraeBoard 전용 Google Access

Pages의 `pages.dev` 주소를 사용할 때는 Pages **Settings → General → Enable access policy**로 시작합니다. 기본 생성된 앱은 미리보기 `*.프로젝트.pages.dev`만 보호합니다. 운영 주소 `프로젝트.pages.dev`도 별도 보호하고, 미리보기 정책을 유지합니다. 운영 앱의 Audience를 Worker에 지정하며 미리보기의 다른 호스트·Audience로 운영 DB에 접근하지 못하게 합니다. [Pages Access 설정](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)

1. 기존 Zero Trust 조직에서 **Access controls → Applications → Add an application → Self-hosted**를 선택합니다.
2. GraeBoard의 `APP_ORIGIN` 호스트 전체를 대상으로 별도 앱을 만듭니다.
3. 해당 팀 앱에만 적용하는 Allow 정책을 만들고 그 팀의 Google 사용자·그룹을 지정합니다.
4. 이 앱의 로그인 방법은 Google IdP만 허용하고 OTP·다른 IdP·Bypass는 사용하지 않습니다. 다른 서비스의 넓은 Allow 정책을 공유하지 않습니다.
5. 조직 team domain을 `ACCESS_ISSUER`, 이 앱의 Application Audience를 `ACCESS_AUDIENCE`에 등록합니다.

조직 전체 Users 목록은 공통으로 남습니다. 이 구성에서 분리하는 것은 GraeBoard 접근 정책과 앱의 사용자·팀 권한입니다. [Self-hosted Access 앱](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

Worker는 `Cf-Access-Jwt-Assertion`의 서명·발급자·Audience·만료를 검사합니다. 이메일 헤더만으로 로그인시키지 않으며 다른 앱 Audience의 토큰도 거절합니다. Static Assets에서는 `ctx.access` 전달만을 인증 근거로 사용하지 않습니다. [JWT 검증](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

내부 초기 게시 후 팀장 본인이 **설정 → 팀 → 동기화 → 팀장 연결 키 발급**을 누릅니다. 키 원문을 한 번 복사하고 GitHub 전달 상태를 확인합니다. 외부에서 Google 로그인 후 **같은 사내 팀장 계정을 선택하고 팀장 연결 키로 연결**합니다. 키는 24시간 동안 한 번만 유효합니다. 원문은 파일/DB/GitHub에 보관하지 않으며 Worker `SETUP_TOKEN` 등록은 필요하지 않습니다. 기존 팀 사이트의 수동 토큰은 더 이상 검증하지 않습니다.

이후 사용자는 Google 로그인 → 해당 팀의 사내 계정 선택 → 연결 신청 → 승인 대기 순서로 진행합니다. 팀장은 **설정 → 팀 → 구성원 → Google 계정 연결**에서 승인·거절·연결 해제를 처리합니다. 승인된 계정만 접속할 수 있으며 마지막으로 연결된 팀장의 연결은 다른 팀장을 연결하기 전까지 해제할 수 없습니다. 이름이나 이메일이 같다는 이유로 자동 연결하지 않습니다. 인증 신원은 검증된 Access의 `(issuer, subject)`에 연결하고 선택 세션도 그 신원에 묶습니다.

구성원·활성 상태·팀 역할은 사내에서 계속 반영합니다. 외부에서 사용자 생성·팀원 추가/탈퇴·역할 변경·사내 이름 변경은 하지 않습니다. 비밀번호·사내 세션·다른 팀 소속·사내 시스템 관리자 권한은 가져오지 않습니다. 해당 팀의 활성 팀장에게만 이 외부 사이트의 관리 권한을 부여합니다. 외부에는 아이디/비밀번호 로그인과 Supabase Auth 로그인이 없습니다.

사내 인사 변경으로 연결된 활성 팀장이 한 명도 없어진 경우, 새 팀장이 내부 설정에서 자신의 연결 키를 발급하고 같은 연결 절차를 수행합니다. 기존 팀원 연결은 보존하며 기존 Google 연결을 다른 계정으로 강제 덮어쓰지 않습니다.

최초 관리자를 특정 계정으로 제한하려면 `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_SUBJECT` Secret을 설정할 수 있습니다. subject는 Access가 확인한 계정 식별자이며 임의 이메일 문자열로 대신하지 않습니다. 이 제한을 사용해도 팀장 연결 키 검사는 유지됩니다.

## 9. 빌드·배포·첫 팀 연결

소스 저장소와 운영 DB·Secret을 분리한 릴리스 디렉터리에서 준비합니다.

```sh
npm ci --include=dev
npm run build
npm run build:worker
npm run build:pages
```

빌드 성공은 클라우드 연결 성공과 별개입니다. 운영 배포가 승인된 경우에만 설정·Access 정책·DB 버전·Secret을 확인한 뒤 팀 설정으로 `npx wrangler deploy`를 실행합니다. Pages 방식에서는 다음을 추가로 확인합니다.

1. Pages의 소스 저장소는 앱 소스 저장소이고 팀 데이터 Git 저장소와 다릅니다. 검증할 코드를 커밋·푸시한 뒤 **Production branch**를 해당 브랜치로 지정합니다. 그래야 `프로젝트.pages.dev`에 그 코드가 배포됩니다. preview 브랜치 배포만으로 운영 주소의 코드가 바뀌지 않습니다.
2. 빌드 명령은 `npm run build`, 출력은 `dist`, root directory는 저장소 루트, 빌드 변수는 `NODE_VERSION=22`입니다. Cloudflare가 루트 `functions/`를 별도로 빌드합니다. 루트 `wrangler.jsonc`는 백엔드 Worker용이며 Pages 설정은 대시보드에서 관리합니다. 여기에 `pages_build_output_dir`를 섞어 넣지 않습니다.
3. 먼저 같은 브랜치로 백엔드 Worker를 배포하고 Pages의 **Settings → Bindings → Service binding**에 `GRAEBOARD_BACKEND`를 등록해 그 Worker를 선택합니다. Pages에는 DB·Git 비밀을 복사하지 않습니다. Service binding 변경 후 Pages를 다시 배포합니다.
4. Pages 전체 경로가 Worker로 전달되는지, Google 인증 전에는 화면·API·정적 파일이 거절되는지, 쿠키와 POST·이미지·SSE 응답이 유지되는지 확인합니다. Worker가 없는 초기 Pages 배포는 JSON 503이며 연동 완료 상태가 아닙니다.

Pages Functions에서 Worker를 호출하는 방식은 [Service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings)를 따릅니다. 자체 도메인으로 Worker에 직접 접속하는 기존 방식은 `APP_ORIGIN`과 같은 호스트를 [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)에 연결합니다.

최초 연결 순서는 다음과 같습니다.

1. 내부 DB·이미지 백업과 팀 UUID를 확인합니다.
2. 내부 서버의 팀 연결 프로필과 설치 식별자를 준비하고 서버를 시작합니다.
3. 내부 **설정 → 팀 → 동기화**에서 설치된 프로필을 선택해 **연결 저장**을 누릅니다.
4. **연결 검사** 결과를 확인한 뒤 **초기 게시**를 실행합니다. 초기 게시 중 새 내부 편집도 대기 변경으로 보존됩니다.
5. 내부 초기 게시에 팀 구성원 정보도 포함됐는지 확인하고, 외부에서 팀장 계정을 최초 연결합니다. **설정 → 시스템 → 서비스 연결**에서 연결 검사 후 **팀 가져오기**를 실행합니다. 기존 업무를 초기화해 덮어쓰지 않습니다.
6. 본문·이미지·팀 신원을 확인한 뒤 팀원에게 주소를 전달하고, 각자의 연결 신청을 팀장이 승인합니다. 역할은 사내에서 설정합니다.
7. 양쪽에서 작은 업무 변경과 문서 이미지를 저장해 반대쪽에서 확인합니다. 같은 내부 서버의 다른 브라우저는 Git 주기를 기다리지 않고 SSE로 즉시 갱신되는지 확인합니다.

`로컬 저장`, `Git 반영`, `상대 반영 확인`은 서로 다른 단계입니다. Git 게시 시각만 있다고 내부 반영이 끝난 것은 아닙니다. 상대 서버 상태가 오래됐거나 복구 점검 중이면 현재 확인 불가로 표시합니다. 내부가 꺼져 있어도 외부 저장·Git 게시가 가능할 수 있으며, 이 경우 내부 적용 확인은 대기합니다.

## 10. 내부 서버 설정

내부는 기존 Node 서버와 SQLite·이미지 경로를 유지합니다. `GRAEBOARD_INSTALLATION_ID`는 DB 파일 밖의 서버 환경에 저장한 설치 UUID입니다. 다른 서버나 복구 훈련에는 새로운 UUID를 사용합니다.

`GRAEBOARD_SYNC_PROFILES`에는 해당 내부 팀과 GitHub 저장소를 지정합니다. `tokenEnv`는 서버에만 등록한 토큰 환경 변수의 이름이며 값 자체가 아닙니다.

```json
[
  {
    "profileId": "team-a-internal",
    "name": "팀 A 내부",
    "teamId": "11111111-1111-4111-8111-111111111111",
    "repository": "https://github.com/example/graeboard-team-a-data",
    "tokenEnv": "GRAEBOARD_GIT_TEAM_A",
    "peerInstallationId": "22222222-2222-4222-8222-222222222222"
  }
]
```

내부 설정은 서비스 실행 계정만 읽을 수 있는 환경 파일·비밀 보관소에 등록합니다. 토큰이 URL·Git config·프로세스 인자·로그에 들어가지 않게 합니다. 앱 화면에는 등록 여부와 프로필 이름만 표시합니다. 기존 `.env`를 예제 파일로 덮어쓰지 않습니다.

`peerInstallationId`에는 외부의 `INSTALLATION_ID`를, 외부의 `PEER_INSTALLATION_ID`에는 내부의 `GRAEBOARD_INSTALLATION_ID`를 넣습니다. 상대 설치 ID가 없으면 Git 게시까지 확인할 수 있지만 상대 서버 적용을 확인할 수 없습니다. 사내 설치 UUID는 서버 공통으로 유지하고, 외부 설치 UUID는 각 팀 사이트마다 따로 발급합니다.

내부 토큰을 DB에 암호화해 등록하려면 별도 비밀 보관소에 32바이트 임의 키의 base64 값인 `GRAEBOARD_SYNC_KEY`와 키 이름 `GRAEBOARD_SYNC_KEY_ID`를 준비합니다. 키 이름의 기본값은 `default`입니다. 키는 DB·백업 bundle과 분리해 보관하고 실행 계정만 읽을 수 있게 합니다. `GRAEBOARD_SYNC_PROFILES`를 설정한 뒤 서비스 실행 계정과 같은 DB 경로로 다음 명령을 실행합니다.

```sh
npm run sync:credential -- team-a-internal < /run/secrets/graeboard-team-a-token
```

입력 파일에는 토큰 원문만 넣고 파일 권한을 제한합니다. 명령은 표준 입력을 읽어 AES-256-GCM 암호문과 키 ID를 `sync_credentials`에 저장하며 토큰을 출력하지 않습니다. 등록 후 서버를 재시작해 새 자격증명을 읽습니다. 암호화 등록값이 있으면 해당 프로필의 `tokenEnv`보다 우선합니다. 키를 잃으면 암호문을 복원할 수 없으므로 발급처에서 토큰을 다시 발급해야 합니다. 키를 변경할 때는 서비스를 중지하고 모든 토큰을 새 키로 다시 등록한 뒤 시작하며 이전 백업에 필요한 이전 키는 별도 보존합니다.

`GRAEBOARD_SYNC_DIR`은 내부 bare Git clone을 보관하는 상위 경로이며 기본값은 실행 디렉터리 기준 `data/sync`입니다. 운영에서는 `/srv/graeboard/data/sync`처럼 릴리스 밖 절대 경로를 사용합니다. 각 clone은 `<GRAEBOARD_SYNC_DIR>/<profileId>`에 만들어지므로 위 프로필의 경로는 `/srv/graeboard/data/sync/team-a-internal`입니다. 서버·백업·이관 실행 계정에 같은 설정, 디렉터리 권한, Git CLI 실행 PATH를 제공합니다. L로 회수한 이미지는 백업·이관 때 이 clone의 고정 Git head에서 읽으므로 임의로 지우거나 다른 릴리스의 상대 경로로 바꾸지 않습니다.

## 11. 연결 검사와 오류 진단

| 화면·증상               | 먼저 확인할 것                                        | 보존할 상태                           |
| ----------------------- | ----------------------------------------------------- | ------------------------------------- |
| 관리 DB 오류            | `PG_SITE` 대상, site migration, 앱 역할·TLS     | 팀 DB를 초기화하지 않음               |
| 팀 DB 신원 불일치       | 내부 UUID, team migration의 UUID, 프로필 binding      | 기존 업무·연결 유지                   |
| Git 인증/권한 실패      | 토큰 만료·Contents 쓰기 권한·조직 승인·private 저장소 | outbox 유지, 토큰만 교체              |
| R2 검사 실패            | 선택 팀 bucket·binding·PUT/GET/DELETE 권한            | 다른 bucket을 지우지 않음             |
| 이미지 변환 실패        | `IMAGES` binding·사용량·입력 포맷/화소                | 문서 입력 보존 후 재업로드            |
| Access 401              | 이 앱 AUD·정확한 발급자·로그인 만료                   | 다른 서비스 토큰 재사용 금지          |
| Access는 통과했는데 403 | 사내 활성 계정·연결 승인·팀 역할                             | 조직 전체 사용자를 자동 추가하지 않음 |
| 오래된 내부 확인        | 내부 실행 상태·Git 통신·복구 모드                     | 마지막 확인과 현재 상태 구분          |
| 복구 점검 필요          | 원격 이력 변경·DB 복사·restore 여부                   | 강제 push·새 genesis로 덮지 않음      |

연결 검사는 PG에서 검사 쓰기를 롤백하고 R2에서 자신이 만든 임시 객체만 제거합니다. Git 검사도 실제 업무 이력을 수정하는 용도로 사용하지 않습니다. 초기 게시 대기·가져오기 대기는 정상 동기화 완료를 뜻하지 않습니다.

외부 `/api/health`도 Access 인증과 팀장이 연결을 승인한 활성 계정 검사를 거칩니다. 내부의 공개 health와 다르므로 모니터링도 허용된 인증 경로로 구성합니다.

외부의 진입·포커스·편집 전 최신화는 팀별 30초 간격으로 원격 head를 확인하고 변경이 있을 때 수신합니다. 이 보조 요청은 상태 브랜치를 조회·게시하지 않으며 상태 확인은 Cron이 담당합니다. 따라서 여러 화면의 조회 횟수를 GitHub 전체 동기화 횟수로 늘리지 않습니다. 실제 GitHub 요청 한도·네트워크 지연은 운영 계정에서 별도 확인합니다.

외부 저장 뒤의 자동 게시는 팀별 첫 미전송 변경이 저장된 시각부터 2초 동안 변경을 모으고, 이후 자동 게시 시도 사이에는 최소 5초 간격을 둡니다. 연속 저장이 첫 대기 시간을 계속 연장하지 않으며, 게시 시도 시각은 DB에 남아 다른 Worker 실행에서도 간격을 지킵니다. 네트워크 오류나 실행 소유권 충돌이 생겨도 미전송 변경은 유지합니다. Worker 종료로 대기 작업이 사라지면 다음 Cron이 처리합니다. 이미 진행 중인 게시가 미전송 목록을 읽은 뒤 저장된 마지막 변경도 그 주기에 포함되지 않고 후속 저장 또는 다음 1분 Cron 주기까지 남을 수 있습니다. 변경은 미전송 상태로 보존됩니다. Cron과 사용자가 직접 실행하는 동기화는 이 자동 게시 대기 시간을 적용하지 않습니다. 이 간격은 요청을 줄이기 위한 것으로 GitHub 계정의 요청 한도나 운영 환경의 지연을 보장하지 않습니다.

## 12. 정리·중단·복구

**설정 → 시스템 → 변경 이력 정리 → 연도·문서·이미지**에서 현재 서버·팀을 확인하고 대상과 용량을 조회합니다. 기존 변경 이력 정리와 별도 탭입니다. 선택한 자료는 이 서버에서만 제외되며 상대 DB와 Git 이력은 삭제하지 않습니다.

현재 자료, 다른 문서·사본의 공유 이미지, 미전송 변경, 미해결 충돌, 진행 중 업로드는 보호합니다. 정리된 항목은 사이트별 제외 목록에 남아 다음 수신 때 자동 재공개되지 않습니다. **보관본에서 복원**은 최신 공유 내용과 Git의 이미지를 검증한 뒤 제외를 해제합니다. 파일 다운로드가 실패하면 제외 상태를 유지합니다.

최근 24시간 안에 업로드했거나 업로드 시각을 확인할 수 없는 이미지, 검증된 Git 보관 사본이 없는 이미지는 삭제하지 않습니다. 미리보기는 10분 동안 해당 관리자·팀·자료 revision에만 유효합니다. 미리보기 뒤 자료가 바뀌면 다시 확인합니다. 실행·복원은 한 번에 이미지 25개씩 처리하며 **중단**은 현재 묶음의 응답 뒤 멈춥니다. 같은 팀의 편집·동기화·다른 정리는 작업 완료까지 대기하고 진행 중 백업과는 정리 작업을 겹쳐 실행하지 않습니다. 네트워크 오류 뒤에는 저장된 작업의 **이어서 정리** 또는 **이어서 복원**을 사용합니다.

내부 SQLite의 정리 준비 검사는 선택 팀만이 아니라 **같은 DB 파일 전체의 쓰기**를 감지합니다. 다른 팀 편집이나 세션 갱신과 겹쳐도 참조 자료를 새로 읽어 최초 시도 포함 최대 3회 준비하며, 계속 쓰기가 겹치면 서버의 다른 작업으로 준비를 마치지 못했다는 409를 반환합니다. 이 경우 잠시 후 다시 시도하세요. 대상 팀의 자료나 이미지 참조가 바뀌어 미리보기가 낡았다면 새 미리보기를 받아야 합니다. 재시도 중에는 정리 guard가 활성화되기 전까지 파일을 삭제하지 않습니다. 이 보수적인 검사는 새 이미지 참조를 놓치지 않기 위한 것으로, 지속적인 DB 쓰기 중에는 정리 시작이 계속 미뤄질 수 있습니다.

내부 프로세스가 강제 종료되어 작업 소유자가 남은 경우 시간 만료만으로 소유권을 빼앗지 않습니다. 이전 프로세스가 늦게 파일을 지우는 동안 새 편집을 허용하는 일을 막기 위해서입니다. 앱·백그라운드 동기화·정리 프로세스를 모두 중지하고 이전 실행자가 남지 않았음을 확인한 뒤 DB·이미지를 보존합니다. 작업 ID는 정리 작업 기록 `site_maintenance_jobs.job_id`에서 확인합니다.

```sh
npm run sync:maintenance-recover -- --database /srv/graeboard/data/weekly-plan.sqlite --job-id '확인한-작업-ID' --dry-run
npm run sync:maintenance-recover -- --database /srv/graeboard/data/weekly-plan.sqlite --job-id '확인한-작업-ID' --confirm-drained
```

`--confirm-drained`는 이전 실행자가 모두 중지됐다는 운영자의 명시 확인입니다. 이 명령은 남은 소유권만 해제하고 작업 manifest·진행 위치·C/P/L과 편집 차단을 보존합니다. 앱을 다시 시작한 뒤 해당 작업을 이어서 완료하세요. 완료 표시로 강제 변경하거나 `site_retention` 행을 직접 삭제하지 않습니다.

외부 Worker에서 같은 상황이 생기면 Cron을 중지하고 해당 팀의 유지보수 차단을 유지한 채, 이전 Worker 실행과 업로드가 실제로 모두 끝났음을 운영 로그·실행 관리에서 확인합니다. 경과 시간만으로 종료됐다고 판단하지 않습니다. 이후 인증된 시스템 관리자 요청으로 `POST /api/admin/teams/:id/maintenance/recover`에 `{jobId, dryRun:true}`를 보내 대상을 확인하고 `{jobId, confirmedDrained:true}`로 남은 소유권을 해제합니다. 이 API도 C/P/L·작업 기록·편집 차단을 보존합니다. 정리 화면에서 작업을 이어서 끝낸 뒤 Cron과 접근을 재개합니다.

L로 제외하지 않은 삭제 표식과 로컬 복원 이력이 참조하는 기존 이미지도 보호하며, 삭제 뒤 시간이 지났다는 이유만으로 이 보호를 만료시키지 않습니다. 따라서 모든 삭제 이미지가 즉시 정리되는 것은 아닙니다. Git 수신은 현재 표시할 문서와 미전송 입력·미해결 충돌에 필요한 이미지만 설치하므로, 삭제 표식·이력만의 파일 또는 정리한 문서 파일을 새 수신 때 자동으로 다시 내려받지 않습니다. 과거 커밋을 순서대로 재생하는 동안 당시 살아 있던 문서의 파일을 설치하는 경우는 있습니다. 정리한 사이트에서 새 사본을 만들면 현재 제공되는 연도·업무·문서만 새 사본으로 공유하며 숨긴 원본은 삭제하지 않습니다. 숨긴 내용까지 복사하려면 먼저 보관본을 복원합니다.

공유 기준본의 본문·메타데이터는 DB에 남습니다. 이 기능은 R2/파일 이미지 공간과 앱 제공 범위를 정리하며 DB 전체 내용을 비우는 기능이 아닙니다. 자동 TTL·Git 이력 재작성은 제공하지 않습니다.

일시정지는 로컬 저장과 변경 캡처를 계속하며 업무 자료의 Git 송수신을 중단합니다. 팀 구성원·권한 갱신과 상태 확인은 계속합니다. 연결 해제는 미전송 변경·충돌을 보존하고 전송을 중단합니다. 복구한 DB는 자동 발신하지 않고 복구 점검으로 시작해야 합니다. 원격 head·opId 처리 여부를 대조하고 새 writer 세대를 준비한 뒤 재개합니다. 팀 프로젝트의 업무·계정 승인 스키마와 이미지·미전송 변경을 함께 보존합니다. 업무만 논리 복구할 때는 계정·승인을 덮어쓰지 않습니다.

내부 DB 복구나 내부 연결 프로필 교체 후에는 원래 서버와 복구 사본의 쓰기 프로세스를 모두 중지하고 검증한 백업을 확보합니다. 대상 DB 경로·팀 UUID·이미지 경로와 서버 환경의 `GRAEBOARD_INSTALLATION_ID`, `GRAEBOARD_SYNC_PROFILES`를 확인한 뒤 다음 명령을 사용합니다. 내부 연결 교체는 일시정지·작업 종료 후 같은 팀의 보관 이력이 있는 저장소에만 허용하며 곧바로 발신하지 않습니다.

```sh
npm run sync:recover -- --database /srv/graeboard/data/weekly-plan.sqlite --team-id '실제-팀-UUID' --images-dir /srv/graeboard/data/document-images --dry-run
npm run sync:recover -- --database /srv/graeboard/data/weekly-plan.sqlite --team-id '실제-팀-UUID' --images-dir /srv/graeboard/data/document-images --confirm-drained
```

복구 점검은 기존 pending의 ID·payload를 유지하고 원격 receipt와 수신 이력을 대조합니다. 실행 중 데이터를 Git에 게시하지 않으며 성공 후 상태는 **일시정지**입니다. 앱에서 미전송 변경·충돌·복원한 이미지와 마지막 수신을 확인한 다음 **재개**로 명시적으로 발신을 허용합니다. 원격 이력 자체가 바뀌었거나 검증이 실패하면 복구 점검을 유지하고 강제 push나 새 genesis로 덮지 않습니다.

새 사이트 합류·명시 드레인 복구는 설정된 비공개 Git 저장소의 인증된 작성자를 신뢰하고 checkpoint를 사용할 수 있습니다. 해시·스키마·개수·식별자·ancestry를 검증하지만 checkpoint 이전 reducer 이력을 처음부터 다시 계산하지는 않습니다. 저장소 쓰기 권한은 이 신뢰 경계를 포함하므로 허용한 서버/운영 계정으로 제한합니다. 정상 실행 중인 사이트는 커밋별 검증·재생을 계속합니다. 자세한 기준은 [동기화 규약](SYNC_PROTOCOL.md#최초-게시checkpoint복구)에 설명합니다.

### 외부 PostgreSQL 복구를 끝내는 절차

`sync:recover` 명령은 내부 SQLite 전용입니다. `restore:external` 또는 논리 이관 후에는 아래 외부 API 절차를 사용합니다. 복구한 팀을 **처음 가져오기**로 다시 초기화하지 않습니다.

1. 이전 Worker의 해당 팀 쓰기·Cron·업로드 실행을 모두 종료하고 원본 DB/R2와 백업을 보존합니다. 복구한 팀 사이트 DB와 R2를 새 binding에 연결하고, 해당 팀의 `SYNC_PROFILES`와 새 `INSTALLATION_ID`를 설정합니다. 이 단계에서도 팀은 공개하지 않습니다.
2. 복구한 승인 정보에 연결된 팀장의 Google 계정으로 공식 `APP_ORIGIN`에 로그인하고 사내 계정을 선택합니다. **설정 → 시스템 → 서비스 연결**에서 복구한 자원을 검사하고, 팀 연결에 복구 대상 프로필을 선택합니다. 관리 API를 사용한다면 `PUT /api/admin/teams/:id/connection`에 `{ "profileId": "복구-프로필-ID" }`를 보냅니다. control DB가 `unconnected`인 복구 팀의 프로필만 이렇게 다시 지정합니다. 운영 중인 팀은 앞 절의 연결 전환 절차를 사용합니다.
3. `GET /api/admin/teams/:id/maintenance/uploads/recover`로 남은 업로드 실행을 확인합니다. 이전 실행이 끝났음을 확인한 ID만 `POST` 같은 경로에 `{ "confirmedDrained": true, "leaseIds": ["확인한-ID"] }`로 해제합니다. 이 작업은 시간 경과만으로 자동 수행하지 않습니다. 미완료 정리는 앞 절의 복구 절차로 이어서 완료합니다. 중단된 백업은 `POST /api/admin/teams/:id/maintenance/recover`의 `{ "jobId": "확인한-ID", "dryRun": true }`로 확인하고, 이전 백업 실행이 종료된 뒤 `{ "jobId": "확인한-ID", "confirmedDrained": true }`로 guard를 `cancelled` 처리합니다. 시간 경과만으로 해제하지 않습니다. C/P/L/head와 부분 백업 파일은 보존되며 부분 파일은 완전 백업이 아닙니다. 이후 백업은 새 출력 경로에 만듭니다.
4. `GET /api/teams/:id/sync`의 `canonicalHead`와 현재 프로필·설치 UUID를 확인합니다. 같은 origin의 인증된 관리자 요청으로 `POST /api/admin/teams/:id/sync/recover`에 다음 내용을 보냅니다. `expectedHead`는 실제 조회한 값이며 최초 커서가 없으면 JSON `null`입니다.

```json
{
  "confirmedDrained": true,
  "expectedHead": "조회한-canonicalHead",
  "expectedProfileId": "복구-프로필-ID",
  "installationId": "Worker의-새-INSTALLATION_ID"
}
```

5. 응답 `jobId`를 기록합니다. `hasMore: true`면 `POST /api/admin/teams/:id/sync/recover/:jobId/resume`을 호출해 이어갑니다. 실패 후에도 새 작업을 만들지 말고 원인을 해결한 뒤 같은 작업을 이어갑니다. `phase: complete`, `mode: paused`가 될 때까지 편집은 차단됩니다.
6. 복구는 기존 P의 ID·본문을 보존하고, 연결 해제 동안의 미캡처 변경도 별도 P로 보존합니다. 새 writer 세대와 설치 ID를 적용하고 L도 새 설치로 옮긴 뒤 **수신만** 수행합니다. 현재 Git head와 커서가 일치해야 control 팀을 다시 사용할 수 있으며 Git 발신은 여전히 일시정지입니다. 업무·문서·이미지·미전송·충돌을 확인하고 팀 동기화 화면의 **재개** 또는 `POST /api/teams/:id/sync/resume`으로 명시 재개합니다. 정상 확인 뒤 Cron을 복구합니다.

위 요청은 공식 주소에 로그인한 관리자 세션과 동일한 origin에서 실행합니다. Git 토큰이나 PostgreSQL 비밀번호를 브라우저 요청 본문에 넣지 않습니다. 다른 사이트·다른 팀·원격 이력 불일치는 복구 성공으로 처리하지 않습니다.

공개 전에는 허용 Google 계정, 미허용 계정, 다른 서비스에만 허용된 계정, 다른 팀 계정, 공식 주소 이외의 우회 주소를 확인합니다. 실제 계정의 GitHub 접근·Supabase TLS·R2 권한·Images 변환과 정상 내부망의 성능은 배포 환경에서 별도 확인하고 결과를 운영 기록에 남깁니다.

중단된 내부 백업도 이전 프로세스가 종료되었음을 확인한 뒤 기존 복구 명령으로 guard만 해제할 수 있습니다. 부분 파일은 검사·보관하고 새 출력 경로로 다시 백업합니다. CLI는 부분 파일을 자동 삭제하지 않습니다.

```sh
npm run sync:maintenance-recover -- --database /srv/graeboard/data/weekly-plan.sqlite --job-id '확인한-jobId' --dry-run
npm run sync:maintenance-recover -- --database /srv/graeboard/data/weekly-plan.sqlite --job-id '확인한-jobId' --confirm-drained
```

외부 PG 백업의 관리 API를 사용할 수 없으면 같은 확인 뒤 `--engine postgres --url-env PG_SITE_URL --team-id '실제-팀-UUID' --job-id '확인한-jobId'`에 `--dry-run` 또는 `--confirm-drained`를 사용합니다. URL 원문은 명령 인자로 넣지 않습니다.

## 13. SQLite와 PostgreSQL 사이의 논리 이관

일반 업무 API는 `server/storage/*-service.mjs`의 같은 명령 계약과 SQLite/PostgreSQL repository를 사용합니다. Node `createApp({storage: createPostgresBusinessStorage({env})})`는 **팀 업무 저장소**를 PG로 선택하고 내부 비밀번호·세션·사용자·멤버십의 원본은 같은 SQLite control에 유지합니다. PG control 사용자/권한을 미러할 필요가 없습니다. 외부 Worker는 Access+PG control과 같은 업무 계약을 사용합니다. 인증과 control을 분리해 Node 로그인은 SQLite인데 관리자 쓰기만 PG로 보내는 구성은 시작 시 거절합니다. Node 비밀번호/세션까지 모두 PG로 옮기는 제품은 제공하지 않으며, 향후 그 변경에는 별도 auth/control adapter와 이관이 필요합니다.

엔진 변경 시 먼저 이 절의 논리 이관과 이미지 검증을 완료하고 서버의 팀 repository 설정을 바꾸어 다시 시작합니다. 실행 중인 트랜잭션을 다른 DB로 전환하지 않습니다. 이미지 저장소는 DB provider와 독립적입니다. Node의 PG 팀 업무는 기본 파일 저장소를 사용하고 외부 Worker는 R2를 사용하며, 업로드·조회·본문 검증은 동일한 ImageStore 포트를 사용합니다. Git 백그라운드 실행기와 인증은 호스트별 포트이므로 팀 논리 이관에 암묵적으로 포함되지 않습니다. 이 설정은 Node의 기본 SQLite 동기화 실행기를 PG 실행기로 바꾸는 배포 명령이 아닙니다. 자세한 연결 예시와 검사 범위는 [개발 안내의 업무 저장소 계약](DEVELOPMENT.md#업무-저장소-계약)을 참고하세요.

Node의 **SQLite control + PG 팀 업무 + 파일 이미지** 조합은 일반 업무 저장·권한·이벤트·이미지 계약까지 검증했으며, 이 조합 전체의 일관된 오프라인 백업/복구 절차는 현재 제공하지 않습니다. `npm run backup`은 SQLite와 SQLite가 참조한 이미지만 읽고 PG 자료·PG에만 참조된 파일 이미지는 포함하지 않습니다. 아래 PG `transfer --resources`와14절 외부 백업 명령은 R2 전용 설정을 사용하므로 Node 파일 이미지 조합에도 그대로 적용된다고 해석하지 않습니다. 운영 적용 전에 별도 복구 절차가 필요한 범위는 [백업과 복구](OPERATIONS.md#백업과-복구)에 명시합니다.

`transfer`는 팀의 ID, 현재 제공본, canonical C, pending P, 제외 목록 L, 충돌, 영수증, 객체와 revision을 보존하는 운영 도구입니다. 로그인 비밀번호·세션·팀 권한은 팀 논리 묶음에 넣지 않습니다. SQLite의 이전 문서 버전·감사 이력·개인 설정처럼 엔진별 표현이 다른 자료는 비공유 보관 레코드로 함께 유지하며, 엔진을 다시 바꿀 때도 버리지 않습니다. 새 SQLite 사용자 참조는 비활성 표시 계정으로 만들고 기존 계정의 권한은 자동으로 올리지 않습니다. 외부 팀 구성원과 Google 연결 승인은 같은 프로젝트의 site 스키마에서 별도로 확인합니다.

먼저 원본 DB·이미지 전체 백업을 확보하고 진행 중 동기화·정리·업로드가 끝났는지 확인합니다. 다음 예시의 경로와 팀 UUID를 실제 값으로 바꿉니다. `--dry-run`은 내보낼 행 수와 해시를 확인하며 원본을 동결하지 않습니다.

```sh
npm run transfer -- --action export --engine sqlite --database /srv/graeboard/data/weekly-plan.sqlite --team-id '실제-팀-UUID' --file /private/team-transfer.json --dry-run
npm run transfer -- --action export --engine sqlite --database /srv/graeboard/data/weekly-plan.sqlite --team-id '실제-팀-UUID' --file /private/team-transfer.json --freeze --images-dir /srv/graeboard/data/document-images --git-directory /srv/graeboard/data/sync/team-a-internal
```

`--freeze`는 해당 팀의 편집을 유지보수 상태로 막고 동기화를 일시정지합니다. 이미지가 있는 팀은 JSON 옆의 `team-transfer.json.assets` 디렉터리도 함께 생성합니다. 두 항목을 같이 보관·전달하며 이미지 묶음은 DB 묶음의 해시에 연결됩니다. 미전송 문서 이미지도 로컬 저장소에서 읽고, 로컬에서 제외된 이미지는 고정 Git head에서 읽습니다. 누락 이미지를 건너뛰어 성공 처리하지 않습니다. 출력된 `jobId`를 보관합니다. 실패 후 같은 동결 상태로 다시 내보낼 때는 `--freeze` 대신 `--job-id '출력된-jobId'`를 사용하고 새 출력 파일 경로를 지정합니다. 기존 파일과 기존 대상 데이터를 덮어쓰지 않습니다.

PostgreSQL 대상은 앞 절의 team migration으로 동일 팀 UUID의 빈 DB를 먼저 준비합니다. 연결 URL은 지정한 환경변수에만 보관합니다.

```sh
npm run transfer -- --action import --engine postgres --url-env PG_SITE_URL --file /private/team-transfer.json --dry-run
npm run transfer -- --action import --engine postgres --url-env PG_SITE_URL --file /private/team-transfer.json --profile-id team-a-new --resources /private/graeboard-restore-resources.json
```

PostgreSQL에서 내보낼 때는 `--engine postgres --url-env PG_SITE_URL --resources /private/graeboard-backup-resources.json`을 사용합니다. SQLite로 가져올 때는 신규 파일을 명시적으로 초기화한 뒤 가져옵니다. 빈 SQLite 파일에는 묶음의 팀을 하나의 트랜잭션 안에서 생성합니다.

```sh
npm run migrate -- --engine sqlite --database /private/new-site.sqlite --initialize
```

완전히 새 내부 설치라면 먼저 이 파일을 사용하는 격리된 내부 서버를 실행하고 기존 첫 관리자 설정 화면을 완료한 뒤 서버를 중지합니다. 팀 논리 가져오기는 로그인 비밀번호를 만들지 않으며 비활성 사용자 참조가 생기면 최초 관리자 화면 조건인 빈 사용자 DB가 아니게 되므로, 관리자 설정을 먼저 수행합니다. 기존 관리자가 있는 SQLite 설치라면 이 단계는 필요하지 않습니다. 이후 원본 팀은 원래 팀 UUID를 가진 별도 팀으로 생성되며 기존 관리자는 유지됩니다.

```sh
DB_PATH=/private/new-site.sqlite DOCUMENT_IMAGES_DIR=/private/new-site-images HOST=127.0.0.1 PORT=3210 npm start
# 첫 관리자 설정 완료 후 위 서버를 중지한 다음 실행합니다.
npm run transfer -- --action import --engine sqlite --database /private/new-site.sqlite --file /private/team-transfer.json --images-dir /private/new-site-images
```

가져오기는 JSON과 모든 이미지의 해시·팀 경계·행 상태를 검사하고 DB 변경 실패 시 롤백합니다. `--images-dir`는 내부 파일 저장소, `--resources`는 다음 절의 R2 리소스 설정을 지정합니다. 활성 자료·pending·미해결 충돌의 이미지부터 설치하고 L로 제외된 이미지는 sidecar에 남깁니다. 이미 있는 대상 이미지는 같은 해시인지 확인하며 다른 내용으로 덮어쓰지 않습니다. PostgreSQL을 사용하는 Node와 외부 Worker의 팀 업무 저장소 한도는 논리 이관 성공으로 늘어나지 않으므로 프로필 전환 전에 15절의 한도를 확인합니다. 대상은 새 writer 세대와 **복구 점검 필요** 상태로 시작합니다. `--installation-id '새-설치-UUID'`를 지정하면 해당 원본 설치의 L도 새 설치로 옮깁니다. 기존 원본을 보관하고, 대상의 ID·본문·버전·pending·충돌·이미지를 확인한 뒤 앞 절의 복구 대조와 연결 프로필 전환을 진행합니다. 새 대상에서 저장을 시작했다면 원본을 단순 재개하지 않습니다.

원본 편집 차단을 해제해야 할 때만 다음 명령을 사용합니다. 이 명령 이후에도 Git 동기화는 일시정지 상태이며 별도 확인 후 재개합니다.

```sh
npm run transfer -- --action release --engine sqlite --database /srv/graeboard/data/weekly-plan.sqlite --team-id '실제-팀-UUID' --job-id '출력된-jobId'
```

## 14. 팀 사이트 DB·승인 정보·R2 백업과 복구

팀 사이트 백업 v3는 한 팀의 `graeboard` 업무 C/P/L·제공본, `graeboard_site` 사용자·승인·Google 연결, R2 및 고정 Git head의 보관 이미지를 포함합니다. 접속 세션 토큰은 포함하지 않습니다. 작업 중에는 사용자 쓰기·Cron·계정 승인을 중지하여 업무와 권한 snapshot 사이의 변경을 막습니다.

저장소 밖에 다음 JSON을 만들고 실제 자원·경로로 바꿉니다. 비밀값은 환경 변수로 주입합니다.

```json
{
  "site": {
    "teamId": "실제-팀-UUID",
    "urlEnv": "PG_SITE_URL",
    "endpoint": "https://실제-계정-ID.r2.cloudflarestorage.com",
    "bucket": "graeboard-team-a-images",
    "accessKeyEnv": "R2_ACCESS_KEY_ID",
    "secretKeyEnv": "R2_SECRET_ACCESS_KEY",
    "repository": "소유자/비공개-팀-저장소",
    "gitDirectory": "/private/graeboard-git-cache/team-a",
    "githubTokenEnv": "GITHUB_TOKEN"
  }
}
```

```sh
npm run backup:external -- --config /private/graeboard-backup-resources.json --output /private/team-backup --dry-run
npm run backup:external -- --config /private/graeboard-backup-resources.json --output /private/team-backup
```

복구 대상은 아직 서비스에 연결하지 않은 새 팀 프로젝트·R2입니다. 같은 팀 UUID로 `--scope site --initialize`를 적용하고 대상 자원용 설정 파일에 `profileId`·`installationId`를 지정합니다. 같은 DB를 가리키는 site 설정 한 항목만 사용합니다.

```sh
npm run restore:external -- --config /private/graeboard-restore-resources.json --input /private/team-backup --dry-run
npm run restore:external -- --config /private/graeboard-restore-resources.json --input /private/team-backup
```

dry-run은 manifest·모든 자료/이미지 해시·대상 DB 형식·팀 UUID·빈 대상 여부를 검사합니다. 복구는 승인·Google 연결을 보존하고 접속 세션은 재사용하지 않습니다. 내부 구성원 정보를 다시 받아 현재 권한을 확인한 뒤 로그인합니다. 업무 동기화는 recovery 상태, 팀 연결은 미연결로 시작하므로 앞 절의 복구 점검을 마친 뒤 접속을 재개합니다. 중간 실패 후 같은 백업으로 재실행할 수 있으며 새 저장이 생긴 대상은 덮어쓰지 않습니다.

기존 분리형 백업 v1은 `{ "control": { "urlEnv": "..." }, "teams": [...] }` 설정과 기존 DB로 계속 복구합니다. v1과 site v2를 서로 바꾸어 복원하지 않습니다. 기존 팀 DB를 site로 전환할 때는 v1 복구·검증을 마친 업무 DB에 4절의 추가 migration을 수행합니다.

기존 릴리스로 돌아갈 때는 쓰기 중단 상태에서 보존한 이전 control·team DB/이미지 백업과 이전 설정을 함께 복구합니다. site 스키마를 삭제하거나 migration checksum을 고쳐 다운그레이드하지 않습니다. 접속 재개 후 되돌리면 백업 이후 업무·승인이 사라질 수 있으므로 현재 자료를 먼저 보존하고 변경분 이관 계획을 정합니다. PostgreSQL 자체 백업은 `pg_dump`로 프로젝트 하나를 보관할 수 있지만 R2는 포함하지 않습니다. [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)

## 15. PostgreSQL 업무 저장소의 한도와 Worker 검증 범위

이 구현의 **PostgreSQL 팀 업무 저장소는 내부 Node와 외부 Worker 모두** 공유 상태·미전송 명령에 대해 **4 MiB**, 공유 엔티티 **12,000개** 한도를 적용합니다. Node의 `createPostgresBusinessStorage`도 Worker와 같은 `RequestContext.data`·`capacityLimits(env)`를 사용하므로 파일 이미지를 쓰거나 Node에서 실행해도 이 한도가 해제되지 않습니다. receipts와 충돌 보관도 상태 용량에 포함됩니다. 행 하나에 여러 셀·문서가 있으므로 엔티티 개수를 업무 행 수로 해석하지 않습니다. DB 검사와 commit 전 검사는 같은 canonical UTF-8 직렬화 기준으로 엔티티·receipt·충돌·P의 바이트를 합산합니다. 두 호스트의 서버 설정 `env`는 `SYNC_MAX_STATE_BYTES=4194304`, `SYNC_MAX_ENTITIES=12000`를 기본값으로 사용하며 더 낮출 수만 있습니다. 기본 SQLite 업무 경로에는 이 PG 한도를 적용하지 않습니다.

두 PG 호스트의 새 편집은 한도 초과 시 `413 / EXTERNAL_SYNC_CAPACITY`로 중단하며 기존 C/P/L을 보존합니다. 외부 Worker의 발신·수신에도 같은 상태 한도를 적용하고, 원격 snapshot은 JSON 파싱 전에 압축 해제 크기를 제한하며 Git blob도 스트리밍 중 크기를 제한합니다. 동기화 거절 시 마지막 정상 canonical cursor를 유지하며 기존 자료 조회·백업·일시정지 등 복구 접근은 유지합니다. Worker 한 isolate에서는 동기화 계산을 하나씩 실행하고 한 수신 주기는 최대 4개 커밋을 처리합니다. 초과한 팀을 작은 데이터로 덮어쓰거나 부분 가져오기 성공으로 표시하지 않습니다. 사이트 정리는 C나 receipts를 축소하지 않으므로 이 한도를 늘리는 수단이 아닙니다.

`tests/worker-capacity.test.mjs`는 실제 workerd에서 공유 `SyncService`의 gzip bootstrap·reducer·후속 커밋 적용을 실행합니다. 한글 값이 있는 1,000개 업무와 업무당 6셀, 문서·삭제표식·receipts·충돌을 포함한 총 7,023개 엔티티의 약 3.44 MiB snapshot을 적용했고 후속 변경까지 2개 커밋을 처리했습니다. 같은 구성의 2,000행 약 6.87 MiB와 5,000행 약 17.17 MiB는 cursor를 한 번도 이동하지 않고 거절했습니다. 이는 고정 행 수 보장이 아니라 그 fixture의 결과입니다. 실제 Worker의 boundStore·materialize·imageSync도 명시적인 SQL 행 메모리 모델과 R2 바이트 저장소로 실행하며 미전송 명령 2개와 이미지 보존을 검사합니다. canonical 쓰기·이미지 projection·500개 행 materialize 경계와 요청 완료 후 inspector heap을 표본 측정합니다. 표본 최대치는 연속 측정한 순간 최대 메모리나 운영 서비스 지연을 보장하지 않으며 wall time에는 표본 수집 시간이 포함됩니다. 2026-10-27 M6 계약 소스(`ca4a85d`)의 보관 표본에서 1,000행 fixture의 used heap+backing의 표본 최대는 47,065,941바이트, V8 allocated `totalSize`는 98,091,008바이트, total+backing은 99,300,833바이트였습니다. 그러나 5,000행 입력을 거절하는 단계의 allocated total+backing은 **137,299,355바이트로 128 MiB를 초과**했습니다(used+backing 81,001,875바이트). 따라서 이 모델을 production 128 MiB 안전성 입증으로 사용할 수 없습니다. 이전 used+backing 58,077,600바이트·allocated totalSize 111,542,272바이트 표본도 검증 자료에 보존했습니다. `totalSize`는 V8가 확보한 heap 크기로 used heap이나 전체 프로세스 RSS와 다릅니다. 메모리 테스트는 SQL 문자열을 처리하는 in-memory 행 모델, fixture 진입점, 가짜 GitHub/R2를 사용하며 운영 번들·Hyperdrive·실제 PG 드라이버 연결의 메모리를 포함하지 않습니다. 배포 전 실제 PG 경로와 동시 요청을 Workers Metrics/Logs로 다시 확인해야 합니다. 재현 명령은 다음과 같습니다.

```sh
node --test tests/worker-capacity.test.mjs tests/worker-runtime.test.mjs
```

Cloudflare의 공식 한도는 isolate당 메모리 128 MB이며 동시 요청이 이 메모리를 공유합니다. Workers Free CPU 한도는 요청당 10 ms, Paid의 1시간 미만 주기 Cron은 CPU 30초이므로 이 동기화를 Free 요금제로 안정 운영할 수 있다고 보장하지 않습니다. 로컬 wall time을 클라우드 CPU 사용량으로 해석하지 않습니다. 실제 사용량은 Workers Metrics/Logs에서 측정하고 사용 요금제를 선택해야 합니다. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

두 PG 호스트의 일반 조회는 read-only PG 트랜잭션을 사용해 쓰기용 advisory lock을 잡지 않습니다. 다만 저장은 현재 한도 내의 C/P/receipt/충돌 전체를 읽고 투영하므로 비용이 전체 상태 크기에 비례합니다. 변경 엔티티만 계산하는 증분 저장 최적화나 실제 운영 PG 저장 p95 측정은 이 검증에 포함되지 않습니다.

내부 서버의 10,000행 SQLite 성능 시험과 Node 프로세스에서 수행한 PostgreSQL 저장 어댑터 스트레스 시험은 이 업무 API 한도 및 외부 Worker 용량 검증과 별도입니다. SQLite 시험이나 어댑터 직접 호출 결과를 Node PG 또는 Cloudflare Worker에서 10,000행을 지원한다는 근거로 사용하지 않습니다. 실제 Cloudflare·Supabase·GitHub·Images 운영 자원으로 배포한 시험은 이 로컬 검증에 포함되지 않습니다.
