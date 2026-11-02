# 프로젝트 작업 규칙

이 규칙은 저장소 전체에 적용한다. 운영 중인 프로젝트이므로 기존 데이터의 보존을 전제로 작업한다.

## 기본 원칙

- 코드 탐색은 `codebase-memory-mcp` 그래프 도구를 우선 사용한다.
- 기존 구현과 호출 경로를 먼저 확인하고 공통 로직·스타일·사용자 흐름을 재사용한다.
- 사용자가 `/graphify`를 입력하면 다른 작업 전에 현재 세션의 `graphify` 스킬을 읽고 적용한다.

## 개선 작업 흐름

1. **작업 공간**: 로컬 개발 서버가 도는 메인 체크아웃(`main`)에서 직접 고치지 않는다. Orca CLI로 `origin/main` 기준 워크트리를 만든다. 브랜치는 `hwantage/<작업-이름>`, 경로는 `~/orca/workspaces/weekly_plan/<작업-이름>`이 된다. `node_modules`는 메인 체크아웃 것을 심볼릭 링크로 쓰고 커밋하지 않는다.
   ```sh
   orca worktree create --repo path:/Users/hwantage/works/somansa/weekly_plan --name <작업-이름> --base-branch origin/main --setup skip --json
   ```
2. **구현·검증**: [검증](docs/DEVELOPMENT.md#검증) 절차(`TEST_PG_BIN=<PostgreSQL bin> npm test`, `npm run build`, `npm run build:edge`, 관련 브라우저 테스트)를 통과시키고, 변경 이력을 `docs/DEVELOPMENT.md`에 남긴다.
3. **커밋·PR**: 커밋 메시지는 영어, PR 제목·설명은 한국어로 `main` 대상 PR을 올린다. DB·저장 형식 변경은 [DB 변경 지침](docs/DATABASE_CHANGES.md)의 승인을 먼저 받는다.
4. **main 병합**(사용자 지시 시): 개발 환경에서 확인한다. 로컬 사내 서버는 `main`, 개발 외부 사이트(somansadev Fork)는 `TEAM_SITE_CONFIG`의 `"branch": "main"`으로 `main`을 배포한다.
5. **release 반영**(사용자 지시 시): `main` → `release` PR을 merge commit으로 병합한다. 운영 외부는 Actions **팀 사이트 release 배포**로 자동 배포되므로 성공을 확인한다. 사내 운영 서버는 `release`를 체크아웃해 `git pull --ff-only origin release` 후 빌드·재시작한다([운영 안내: 업데이트](docs/OPERATIONS.md#업데이트)).
6. 문서만 고치는 작은 변경은 브랜치 없이 `main`에 바로 커밋한다.

## 작업별 지침

작업에 해당하는 문서를 먼저 읽고 그 지침을 따른다.

| 작업 | 지침 |
| --- | --- |
| 코드 탐색·기능 추가·수정 | [개발 안내: 작업 원칙](docs/DEVELOPMENT.md#작업-원칙) |
| 화면·사용 흐름 확인 | [사용 안내](docs/USER_GUIDE.md) |
| DB 구조·저장 형식·API 확인 | [데이터 형식](docs/DATA_FORMAT.md) |
| DB 스키마·저장 형식·기존 데이터 변환·백업 방식 변경 | [DB 변경 지침](docs/DATABASE_CHANGES.md)에 따라 사전 승인 후 진행 |
| 실행 환경·배포·백업·복구 | [운영 안내](docs/OPERATIONS.md) |
| 변경 검증 | [개발 안내: 검증](docs/DEVELOPMENT.md#검증) |
