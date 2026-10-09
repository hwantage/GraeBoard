# 그래보드 운영 안내

[처음으로](../README.md) · [개발 안내](DEVELOPMENT.md) · [데이터 형식](DATA_FORMAT.md)

## 실행 환경

Node.js 22.13 이상과 npm을 사용합니다. SQLite는 단일 서버의 로컬 디스크에 둡니다. 여러 호스트나 NFS 공유 파일을 통한 동시 운영을 전제로 하지 않습니다.

```sh
npm ci
npm run build
npm start
```

기본 주소는 `http://127.0.0.1:4310`입니다. 최초 접속에서 관리자를 만들며 기본 계정·비밀번호는 없습니다. 실제 팀을 빈 상태로 시작하려면 예시 업무 생성 옵션을 해제합니다. 예시 담당자는 로그인할 수 없는 비활성 계정입니다.

## 환경 설정

앱은 `.env`를 자동으로 읽지 않습니다. 환경 변수를 프로세스에 전달하거나 Node의 `--env-file`을 사용합니다.

```sh
cp .env.example .env
# .env를 운영 환경에 맞게 수정한 뒤 실행합니다.
node --env-file=.env server/index.mjs
```

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 서버 바인딩 주소 |
| `PORT` | `4310` | API와 정적 파일 제공 포트 |
| `DB_PATH` | `data/weekly-plan.sqlite` | 데이터베이스 위치 |
| `NODE_ENV` | 미지정 | 운영에서는 `production` |
| `SETUP_TOKEN` | 없음 | 최초 관리자 생성 시 확인할 설정 키 |
| `APP_ORIGIN` | 없음 | 프록시 뒤 실제 서비스 Origin, 예: `https://graeboard.example.com` |
| `COOKIE_SECURE` | `0`과 같은 동작 | HTTPS에서는 `1` |
| `TRUST_PROXY` | `0`과 같은 동작 | 신뢰하는 프록시가 정확히 하나일 때 `1` |

`NODE_ENV=production`으로 외부 주소에 바인딩하고 계정이 아직 없으면 `SETUP_TOKEN`이 필요합니다. 루프백 주소 뒤에 프록시를 두는 경우에도 첫 설정을 공개하기 전에 토큰을 지정하거나, 로컬에서 먼저 관리자를 생성하세요. 임의 토큰은 `openssl rand -hex 32` 등으로 생성하여 `.env` 또는 서버의 비밀 설정에 보관합니다. 첫 설정 완료 후 제거할 수 있습니다.

데이터 파일 이름 `weekly-plan.sqlite`는 기존 설치와의 호환성을 위해 유지합니다. 브랜드 변경과 DB 파일 이름 변경은 별개입니다.

## 사내 서버 배치

```sh
NODE_ENV=production HOST=127.0.0.1 PORT=4310 npm start
```

HTTPS 역방향 프록시가 앱으로 요청을 전달하도록 구성하고 앱 포트의 직접 외부 접근을 제한합니다. `APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY`는 실제 프록시 구성과 일치시킵니다. 프로세스 재시작 정책과 파일 접근 권한은 운영 환경에서 관리합니다.

비밀번호는 scrypt 해시로 저장합니다. HTTP-only 세션은 8시간이며 계정 비활성화와 비밀번호 변경 시 기존 로그인을 무효화합니다. 상태 확인은 `GET /api/health`, 오류 확인은 서버 표준오류를 사용합니다. 업무 데이터나 로그인 정보를 외부 오류 수집기로 자동 전송하는 기능은 없습니다.

감사 이력과 보고본은 자동 삭제하지 않습니다. 보관·반출 기준과 백업 용량을 운영자가 관리합니다. 개발 환경의 검증 결과는 운영 장비·네트워크의 성능 보장을 대신하지 않습니다.

## 백업과 복구

기본 백업은 `backups/graeboard-시각.sqlite`에 생성합니다. 다른 DB를 운영 중이면 같은 `DB_PATH`를 전달합니다.

```sh
npm run backup
npm run backup -- backups/manual.sqlite
npm run restore -- backups/manual.sqlite data/restored.sqlite
```

`.env`를 사용하는 운영 환경에서는 스크립트에도 명시적으로 적용합니다.

```sh
node --env-file=.env scripts/backup.mjs
node --env-file=.env scripts/restore.mjs backups/manual.sqlite data/restored.sqlite
```

백업은 실행 중인 SQLite의 일관된 사본을 생성하고 무결성을 검사합니다. 실행 중인 DB 본체 파일만 복사하면 WAL에 남은 변경이 누락될 수 있습니다.

복구 명령은 **새 파일**에만 쓰며 기존 대상 파일을 덮어쓰지 않습니다. 복구된 세션은 삭제되어 사용자가 다시 로그인해야 합니다. 서버를 중지하고 `DB_PATH`를 복구 파일로 지정한 뒤 재시작합니다. 이전 DB와 백업은 자동 삭제하지 않습니다.

백업을 정기 실행하고 접근이 제한된 별도 저장소에도 보관하세요. 실제 복구 훈련을 통해 계정·서식·보고본을 확인합니다. 팀 영구 삭제는 이미 생성한 별도 백업 파일까지 삭제하지 않습니다.

## 관리자 비밀번호 재설정

서버에 접근할 수 있는 관리자는 표준입력으로 새 비밀번호를 전달합니다. 다음 예시는 Bash/Zsh에서 사용할 수 있습니다.

```sh
read -s GRAEBOARD_RESET_PASSWORD
printf '%s' "$GRAEBOARD_RESET_PASSWORD" | npm run admin -- reset-password 사용자아이디
unset GRAEBOARD_RESET_PASSWORD
```

비밀번호는 10~128자이며 재설정한 계정의 기존 세션을 해제합니다. `.env`를 쓰는 경우에는 파이프 오른쪽 명령을 `node --env-file=.env scripts/admin.mjs reset-password 사용자아이디`로 바꿉니다. 비밀번호를 명령 인자·스크립트·저장소에 넣지 마세요.

## 업데이트

1. 현재 DB를 백업하고 복구 가능 여부를 확인합니다.
2. 별도 경로에서 새 소스의 `npm ci`, 빌드, 자동 검사를 수행합니다.
3. 서버를 중지한 뒤 프로그램을 교체합니다.
4. 동일한 운영 `DB_PATH`로 재시작하고 로그인·조회·저장을 확인합니다.
5. 문제가 있으면 이전 프로그램과 그 버전에 맞는 백업을 새 경로로 복구합니다.

## 저장소에 포함하지 않는 파일

`.gitignore`는 DB와 WAL·SHM 파일, 백업, 가져오기·내보내기 파일, 실제 `.env`, 인증서·개인 키, 빌드 결과와 의존성, 테스트 로그·스크린샷을 제외합니다. 원본 시트 링크가 들어 있는 초기 RFP도 로컬 참고 자료로만 보관합니다.

공유할 환경 설정은 비밀값이 없는 `.env.example`을 사용합니다. 테스트 코드의 예시 계정·문구는 임시 DB 검증용이며 실제 운영 데이터는 저장소에 포함하지 않습니다.
