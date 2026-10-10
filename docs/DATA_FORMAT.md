# 그래보드 데이터 형식과 접근 규칙

[처음으로](../README.md) · [개발 안내](DEVELOPMENT.md) · [운영 안내](OPERATIONS.md)

## 기준

표시 브랜드는 그래보드(GraeBoard)이며, 기존 데이터와 연동 호환성을 위해 포맷·세션·헤더 식별자를 유지합니다. 다운로드 파일명은 `graeboard-연도.확장자`입니다.

JSON 반출의 `format`은 `weekly-plan`, `schemaVersion`은 `1`입니다. `exportedAt`은 UTC ISO 시각입니다. `year`는 조회 연도이며, 한 업무는 `years` 배열을 통해 여러 연도에서 같은 ID로 조회할 수 있습니다. 기본 운영 시각은 한국 기준, 날짜 키는 시간대가 없는 `YYYY-MM-DD`입니다.

## 업무와 셀

계정의 `username`은 로그인 아이디(이메일)입니다. 생성·수정 요청은 이메일 형식만 받으며 앞뒤 공백을 지우고 소문자로 저장합니다. 이메일 형식이 아닌 기존 값은 로그인에만 허용하고, `PATCH /api/admin/users/:id`에서 `username`을 생략하면 유지합니다. 계정의 `avatarInitials`는 빈 문자열(이름 첫 글자), 영문 1~3자 또는 한글 1~2자이며 `avatarImage`는 빈 문자열 또는 PNG·JPEG·WebP data URL입니다. `color`는 아바타 배경색(`#RRGGBB`)입니다. 계정 생성·수정 API에 선택적으로 전달하며 생략한 필드는 기존 값을 유지합니다. 이미지는 클라이언트에서 160×160으로 맞추고 서버에서 형식·150,000자 한도를 검사합니다. DB `user_version=3`은 `users.avatar_initials`·`avatar_image` 열을 추가하며 기존 계정은 빈 값으로 이행합니다. DB `user_version=4`는 `memberships.role`(팀 내 권한 `lead`·`member`·`viewer`)을 추가하고 `users.role`을 시스템 권한(`admin`·`user`)으로 바꿉니다. 이행 시 기존 시스템 관리자·팀 관리자는 소속 팀의 팀장, 팀원·열람자는 같은 팀 내 권한이 되어 기존 권한을 유지합니다. 계정 응답은 `systemRole`, `teamIds`, `teamRoles`(팀 ID별 팀 내 권한)를 가집니다. 기존 버전 1~3 백업과 버전 4 백업을 복구할 수 있습니다.

`bootstrap.users`에는 접근 가능한 팀에 현재 배속된 계정과 그 팀 업무의 Member 셀에 참조된 이전 팀원의 최신 프로필이 포함됩니다. 표시 목록과 선택 목록을 구분하며 선택·필터에는 현재 팀의 `teamRoles`가 팀장(`lead`)·팀원(`member`)인 계정만 사용합니다. 서버는 해당 셀에 남아 있는 이전 팀원 ID만 보존하도록 허용하고, 제거 후 재배정은 거절합니다. 내보내기와 새 보고본에도 이전 팀원의 프로필을 포함합니다.

업무는 `id`, `teamId`, `years`, `position`, `defaultStyle`, `createdAt`, `updatedAt`, `deletedAt`, `cells`를 가집니다. 셀 키는 팀 설정에 정의된 속성 ID 또는 주의 월요일 날짜입니다. 필수 키는 `title`, `owner`, `status`이며, 과거 양식에는 `category`, `type`, `description`, `supporters`, `progress`, `deadline`, `score`, `current`가 있을 수 있습니다. 동적으로 추가한 속성은 `prop_<UUID>` 키를 사용합니다. 날짜 키 하나를 두 연도에서 조회하더라도 같은 값입니다. 연말의 일부 주는 앞·뒤 연도에 걸쳐 표시될 수 있습니다.

```json
{
  "value": "검토\n완료 예정",
  "style": {
    "color": "#243642",
    "backgroundColor": "#d1eee6",
    "fontFamily": "Noto Sans KR",
    "fontSize": 11,
    "textAlign": "left",
    "verticalAlign": "middle",
    "bold": false,
    "italic": false,
    "underline": false,
    "strike": false,
    "wrap": true,
    "textMode": "wrap"
  },
  "version": 3
}
```

기본 열의 초기 종류에서 `owner`는 사용자 ID 또는 빈 문자열, `supporters`는 사용자 ID 배열입니다. `score`와 `current`는 숫자 또는 빈 문자열입니다. `progress`는 최대 10,000자의 일반 텍스트로, 백분율·문구·줄바꿈을 그대로 저장합니다. 기존 숫자형 진척률도 조회·실행취소·복제를 위해 허용하며 일괄 변환하지 않습니다. 엑셀 가져오기는 진척률 문구를 다른 필드로 옮기지 않고, 백분율 서식의 숫자는 `37.5%`처럼 변환합니다. `deadline`은 날짜 또는 빈 문자열입니다. `title`·`description`과 주차 셀은 텍스트이며, `category`·`type`·`status`는 선택형 값입니다. 동적 속성의 값은 아래 종류별 계약을 따릅니다.

주차 셀의 빈 값에도 배경색을 저장할 수 있습니다. 색상은 `#RRGGBB`, 글자 크기는 6~36pt 정수이며 새 팀의 기본 크기는 9pt입니다. 지원 글꼴은 Noto Sans KR·Pretendard·맑은 고딕·Noto Serif KR·Nanum Gothic Coding입니다. `맑은 고딕`은 저장 이름이며 HTML/XLSX 가져오기에서는 `Malgun Gothic`도 같은 이름으로 정규화합니다. 실제 화면은 설치된 맑은 고딕이 없으면 자체 제공 Pretendard로 표시하지만 저장된 글꼴 이름은 유지합니다.

셀·기본 서식의 `borderTop`, `borderRight`, `borderBottom`, `borderLeft`는 선택적인 `{style, color}` 또는 `null`입니다. `style`은 `none`·`solid`·`medium`·`thick`·`dashed`·`dotted`·`double`, `color`는 `#RRGGBB`입니다. 누락 값은 업무 기본 서식을 상속하며 상속된 선이 없으면 기본 격자선을 유지합니다. `null`은 상속된 선까지 해제해 기본 격자선을 표시하고 `none`은 기본 격자선까지 숨깁니다. 테두리 도구의 지우기는 네 방향에 `null`을 저장합니다. 선택 영역의 맞닿은 안쪽 경계는 위·왼쪽 셀의 `borderBottom`·`borderRight`에만 선을 저장하고 아래·오른쪽 셀의 `borderTop`·`borderLeft`에는 `null`을 저장합니다. XLSX는 thin/medium/thick/dashed/dotted/double을 대응시키며 `null`은 선 없이 반출하고 대각선은 지원하지 않습니다. HTML·앱 클립보드와 실행취소도 네 방향을 보존하며 HTML의 `data-grid-borders`는 기본 격자선으로 해제한 방향을 기록합니다.

업무의 `defaultStyle`은 생성 시 팀의 기본 서식을 복사한 값입니다. 셀 서식이 이를 덮어쓰며, 빈 일정 셀도 업무 기본 서식을 사용합니다. 기존 업무에 없는 기본 서식은 앱 기본값입니다. SQLite 스키마 v2는 `tasks.default_style`을 추가하며, v1 DB는 기존 값을 유지한 채 자동 확장됩니다. 백업 복구는 v1·v2·v3를 허용합니다. 텍스트에 포함된 수식이나 HTML을 실행하지 않습니다.

텍스트의 `#` + 여섯 자리 숫자는 화면에서 `http://redmine.somansa.com/redmine/issues/{숫자}` 링크로 표시합니다. 원문·복사·저장 값은 바꾸지 않습니다. 여러 이슈 번호는 각각 연결하며 HTTP(S) URL 안의 `#`는 별도 이슈로 해석하지 않습니다.

`textMode`는 `overflow`(기본)·`wrap`·`clip` 중 하나이며 `verticalAlign`과 독립적입니다. 구 데이터에 `textMode`가 없으면 `wrap: true`는 줄바꿈, 그 외는 오버플로우로 해석합니다. 개별 셀의 구 `wrap` 값은 새 업무 기본 `textMode`보다 우선하며 새 편집 UI는 두 필드를 함께 저장합니다. HTML 클립보드는 `data-text-mode`로 자르기와 오버플로우를 구별합니다. 오버플로우는 연속된 빈 셀과 같은 고정 영역 안에서만 표시합니다. 줄바꿈 변경은 정렬 값을 덮어쓰지 않으며, 기본 서식과 HTML 복사도 선택한 정렬을 보존합니다. 화면에서는 내용이 셀 높이를 넘을 때만 첫 줄부터 표시하고, 이는 저장된 정렬을 변경하지 않습니다. 기존에 저장한 위 정렬도 자동 변경하지 않습니다.

셀의 `version`은 동시 수정 검사에 사용합니다. 수정 요청은 클라이언트가 읽은 `expectedVersion`을 보내고, 현재 버전과 다르면 HTTP 409를 받습니다. 범위 변경은 한 트랜잭션으로 처리합니다. 같은 사용자·`operationId`의 재시도는 최초 성공 결과를 재사용합니다. 서버에서 수신한 최신 버전을 확인한 뒤 새 `operationId`로 재적용해야 합니다.

여러 영역 선택은 UI 상태의 `areas`와 활성 `anchor`·`focus`로 표현하며 저장 보기에 포함하지 않습니다. 영역이 겹치면 셀 ID를 중복 제거하여 동일 배치에 한 번만 포함합니다. 숨긴 행의 번호·구간은 필터와 정렬을 적용한 결과에서 개인 숨김을 제외하기 전 순서로 계산합니다.

## 보기·보고본·계정

새 보기의 열 고정 기본값은 `frozenColumns: 0`입니다. 팀 설정의 `defaultDensity`는 `comfortable`(넉넉하게)·`compact`(편안하게, 기본)·`dense`(촘촘하게)이며 기본 서식 화면에서 저장합니다. 기존 설정에 값이 없으면 `compact`를 사용하고, 해당 필드가 없는 구 클라이언트의 설정 저장은 현재 팀 값을 유지합니다. `dense`는 `compact`의 약 2/3(기본 서식에서 26px)입니다. 개인 보기의 `density` 필드는 저장 형식 호환을 위해 남지만 화면 높이는 팀의 `defaultDensity`를 사용합니다. 개별 `rowHeights`는 26~500px을 허용하며 팀 기본 높이보다 우선합니다. 보고본은 저장 당시 팀 설정의 높이를 사용합니다.

기간 선택 표는 `weeksForYear`의 월 배정과 날짜 키를 그대로 사용합니다. 월 드래그는 `fromMonth`·`toMonth`를 설정하고 주 범위를 비우며, 주 드래그는 `fromWeek`·`toWeek`와 전체 월 범위를 설정합니다. 두 선택 모두 `hiddenWeeks`·`collapsedMonths`를 비워 연속 범위를 표시합니다. 드래그 중에는 미리보기만 바꾸고 포인터를 놓을 때 한 번 저장합니다.

셀 복사 단축키는 `application/x-weekly-plan-cells+json` (`version: 1`, `rows: {text, style}[][]`)과 `text/html`, `text/plain`을 함께 제공한다. 속성·담당자는 표시명으로 전달하고 대상 열의 옵션·사용자에 다시 연결한다. 출처 셀의 적용된 서식과 기본값을 복사하여 대상 업무의 기본 서식이 남지 않도록 한다. 붙여넣기 시 지원하는 서식 필드만 허용하고 HTML을 화면에 삽입하지 않는다. 일반 텍스트에는 서식 변경을 포함하지 않는다. 행·열 크기와 속성의 칩 정의는 셀 복사 대상이 아니다.

행 번호 메뉴의 복사는 시스템 클립보드와 별개로 메모리에 업무 스냅샷과 개인 행 높이를 보관한다. 모든 셀의 값·서식과 업무 기본 서식을 복사하고 셀 버전·업무 ID는 새로 생성한다. 원본을 이후 수정해도 복사 당시 값은 유지한다. 팀·연도 전환이나 페이지 새로고침 시 초기화한다.

발표 모드는 현재 브라우저 화면 상태이며 DB·개인 보기에 저장하지 않는다. 필터·묶음·숨김·열 너비를 유지하고 메뉴와 편집 도구를 숨긴다.

보기는 사용자·팀·연도별 필터, 숨긴 업무 ID, 숨긴 주차, 접힌 월, 표시 열, 크기와 정렬을 저장합니다. 개인 보기의 숨김은 원본이나 접근 권한을 변경하지 않습니다. `propertyFilters`는 속성 ID별 선택 값 배열입니다. 한 배열의 값은 OR, 서로 다른 속성은 AND로 평가하고 빈 배열은 필터 없음, 빈 문자열 값은 미지정 업무를 뜻합니다. 선택적인 `propertyFilterModes`는 속성 ID별 `include`(일치)·`exclude`(제외)를 저장합니다. 필드나 속성별 모드가 없으면 기존처럼 일치로 해석하며, 제외는 선택 값 중 하나라도 일치하는 업무를 제거합니다. 복수 Member의 빈 배열도 미지정으로 평가하고, 제외 모드라도 선택 값이 없으면 필터를 적용하지 않습니다. 보관된 속성의 모드는 보기 정규화 시 제거합니다. 과거 단일 `category`·`status` 필터는 조회 시 변환합니다. 모드는 개인 보기·보고본·JSON 반출에 함께 보존되며 DB 스키마 변경은 없습니다. `__current`는 최근 보기입니다. JSON의 현재 범위 내보내기는 선택한 업무와 열만 포함하며, 전체 반출을 대신하지 않습니다.

통합 팀원 필터는 제거되었으며, 과거 보기에 저장된 `people`과 `personRole`은 조회·정규화 시 각각 `[]`와 `either`로 초기화합니다. 열별 `propertyFilters`는 유지합니다.

`fromWeek`·`toWeek`는 월요일 날짜 키 또는 제한 없음을 뜻하는 빈 문자열입니다. 월 범위와 함께 표시할 주차를 제한합니다. `frozenColumns`는 왼쪽에서 고정할 업무 정보 열 수이며, `groupBy`는 묶음 속성 ID입니다. `sortKey`와 `sortDirection`(`asc`·`desc`·`default`)은 업무 정보 컬럼 정렬입니다. 주간 날짜 키는 정렬 대상에서 제외합니다. 과거 `sort` 설정은 조회 시 새 형식으로 변환합니다. 그룹 제목은 별도의 업무 레코드가 아닙니다. `compactWeekColumns: true`는 주간 열 너비 전환이 끝난 보기입니다. 이 값이 없는 과거 보기는 날짜 키에 해당하는 저장 너비만 절반(최소 40px)으로 전환하며, 재조회 때 다시 줄이지 않습니다. 새 보기의 주간 열 기본 너비는 40px입니다.

보고본은 `tasks`, 당시 사용자 ID·이름·색상, `view`를 독립적으로 저장합니다. 기준일·생성 시각·고유 보고본 ID로 구별합니다. 같은 기준일에 다시 저장하면 새 보고본이 생성됩니다. 계정 이름 변경이나 원본 업무 삭제가 과거 스냅샷을 수정하지 않습니다.

JSON 내보내기는 비밀번호·세션·전체 계정 권한을 포함하지 않습니다. 다른 시스템으로 옮길 때 사용자 ID를 매핑하고, 날짜 키·업무 ID·색상·보고본을 유지해야 합니다. 현재 앱의 JSON 직접 재가져오기 기능은 없습니다. 완전 복구는 SQLite 백업으로 수행합니다. XLSX 가져오기는 새 업무 ID를 부여하며, 동일 파일 재시도용 키를 별도로 관리합니다.

## 동적 속성

팀 설정 `propertiesVersion: 3`의 `properties` 배열이 모든 업무 정보 열과 순서를 정의합니다. 이전 선택형 전용 설정은 조회 시 기존 ID·배치를 유지한 채 통합 정의로 해석하고, 저장할 때 v3 형식을 기록합니다. v2 이하의 설정은 작업·팀원·상태 정의를 복원하고 기본 상태 다섯 값을 보완하며, 기존 속성 ID·순서·추가 값·사용자 지정 색상·명시적 기본 서식은 보존합니다. 기존 책임자라는 기본 이름만 팀원으로 변경합니다. DB 스키마는 바뀌지 않습니다. 속성은 `id`, `name`, `kind`, `display`, `values`, `visible`, 선택적인 `multiple`·`archived`를 가집니다. `kind`는 `option`·`text`·`date`·`number`·`member`입니다. Option의 `display`는 `text`·`round`·`square`·`dot`·`emoji`, Member는 `text`·`avatar`입니다. `title`은 항상 활성 Text이며 삭제·숨김·종류 변경을 거절합니다. `owner`는 삭제 불가한 단일 Member, `status`는 삭제 불가하고 활성 값이 하나 이상인 Option입니다. `supporters`는 선택 속성으로 보관·복원이 가능하며 복수 Member와 권한 연계를 유지합니다. 새 팀에는 `title`, `owner`, `status`만 생성합니다. 기본 상태는 예정·검토 중·진행 중·완료·보류입니다. `POST /api/admin/teams`의 `templateTeamId`는 원본 팀 설정을 복사하며 새 revision은 0입니다. 속성·값·순서·표시·기본 서식·테마를 포함하고 업무·회원 배정·개인 보기는 복사하지 않습니다. 값 배열의 순서가 선택 목록·묶음 순서이며, 각 값에는 `id`, `label`, `backgroundColor`, `dotColor`, `emoji`, 선택적인 `archived`가 있습니다.

신규 속성 키는 `prop_<UUID>`입니다. Option 셀 값은 옵션 ID, Text는 문자열, Date는 유효한 `YYYY-MM-DD`, Number는 유한한 숫자, 단일 Member는 소속 팀의 사용자 ID 또는 빈 문자열, 복수 Member는 중복 없는 사용자 ID 배열입니다. 기본 Score·Current의 기존 0 이상 제약을 유지하고 새 Number는 음수와 소수를 허용합니다. 이름 수정 시 ID를 유지합니다. 기존 `category`·`type`·`status` 셀은 호환성을 위해 문자열을 유지하며 값 이름 변경 시 서버가 셀 값과 버전을 원자적으로 갱신합니다. 설정의 `revision`을 보낸 수정 요청은 동시 관리자 변경을 검사합니다. 종류 변경 시 기존 값을 새 종류로 변환·검증하고 셀 버전과 이력을 함께 갱신합니다. 하나라도 변환에 실패하면 설정과 셀을 모두 되돌립니다. 제거된 정의는 보관하여 기존 셀을 설명할 수 있게 합니다. 보고본은 `settings` 사본도 보존합니다.

새로 추가하거나 이름을 변경하는 속성 값은 최대 15자입니다. 화면의 `maxLength`와 서버의 설정 저장 검사를 함께 적용하며, 호환 API로 기본 속성 목록을 변경할 때도 같은 제한을 적용합니다. 저장 형식은 기존 긴 값(최대 60자)을 읽을 수 있도록 유지합니다. 기존 옵션 ID와 이름이 같으면 다른 설정 저장·보관을 허용하여 데이터와 과거 기록을 자르지 않습니다. 저장 전 빈 속성·값 초안을 지울 때는 보관 목록에 추가하지 않습니다.

`visible`은 열 표시 기본값입니다. 보기의 `columnVisibility`는 마지막으로 적용한 기본값을 기록하여 변경된 열만 반영하고 다른 개인 숨김은 보존합니다. 팀 설정의 속성 탭에서 현재 보기와 다른 기본값을 가진 열의 체크를 바꾸는 경우 현재 보기에도 직접 적용합니다.

속성의 `placement`는 `beforeWeeks`(기본) 또는 `afterWeeks`입니다. 표의 순서는 날짜 앞 속성 → 표시 중인 주차 날짜 → 날짜 뒤 속성이며, 각 쪽 안에서는 `properties` 배열의 순서를 따릅니다. 속성 탭의 ‘주차 날짜’ 항목은 날짜 묶음을 나타내는 UI 항목으로, 별도 속성이나 셀로 저장하지 않습니다. 기존 설정의 누락 값은 `beforeWeeks`로 읽고, 구 설정 수정 요청에서 이 필드를 생략하면 기존 배치를 보존합니다. 팀 양식과 보고본 설정 사본에도 배치를 포함합니다. 전체 XLSX·CSV 반출의 열 순서도 이 배치를 따르며, 현재 보기 반출은 요청한 `keys` 순서를 유지합니다. JSON은 팀 설정에 배치 정보를 포함합니다. `frozenColumns`는 표시 중인 `beforeWeeks` 속성에만 적용합니다.

XLSX·CSV 반출에는 속성 표시명과 값 이름을 사용하며, JSON에는 ID와 정의를 함께 반출합니다. XLSX 재이관 시 먼저 같은 팀에 속성과 값을 등록해야 합니다. 이름이 일치하는 속성 열을 종류에 맞게 해석하고, Option 값과 Member 사용자 매핑을 검증합니다.

팀 설정의 `weekHeader: {color?, backgroundColor?}`는 날짜 열 머리글의 글자색·배경색(`#RRGGBB`)입니다. 이번 주와 선택한 열의 강조색이 우선합니다. 생략하면 이전 설정을 보존하고 빈 객체는 기본 색으로 되돌립니다. 팀 양식·보고본·JSON에 포함하며 XLSX는 반출하는 주차 머리글에 적용합니다. 이전 버전의 `weekBorders`는 읽지도 저장하지도 않으며, 구 클라이언트가 보내도 무시합니다. DB 스키마 변경은 없습니다.

## 팀 스페이스 테마

팀 설정의 `theme`는 `mint`·`sky`·`lavender`·`rose`·`sand` 중 하나입니다. 필드가 없는 기존 팀은 민트로 표시하며 DB 스키마 변경은 없습니다. 팔레트는 `shared/themes.js`에서 관리하고, 현재 팀의 테마를 메뉴·버튼·선택 강조·팝업에 적용합니다. 셀의 저장된 색상과 속성 옵션·사용자 아바타 색상은 변경하지 않습니다.

시스템 관리자는 팀 생성 API에서, 시스템 관리자와 팀장은 `PATCH /api/teams/:id`에서 `theme`를 보낼 수 있습니다. 수정 요청의 `settingsRevision`은 동시 설정 변경을 검사하며, 테마를 바꾸면 설정 `revision`도 증가합니다. 속성·기본 서식 저장은 테마를 보존하고, `theme`가 없는 구 설정 요청도 현재 테마를 유지합니다. 지원하지 않는 테마 ID는 서버에서 거절합니다.

## 주요 API

모든 업무 API는 HTTP-only 세션 쿠키를 요구합니다. 쓰기 요청은 `X-Requested-With: WeeklyPlan`을 포함합니다. 브라우저 외부 출처는 허용하지 않습니다.

| 경로 | 용도 |
|---|---|
| `GET /api/bootstrap` | 현재 사용자·소속 팀·담당자·연도 |
| `GET /api/tasks?teamId=…&year=…` | 연간 업무. ETag 조건부 조회 지원 |
| `POST /api/tasks` | 업무 생성·복제·기준 행의 앞/뒤에 삽입 |
| `POST /api/tasks/reorder` | 한 행 또는 여러 행을 기준 업무의 앞/뒤로 함께 이동, 묶음 경계·권한·업무 버전 검사 |
| `POST /api/cells/batch` | 값 변경 최대 2,000셀, 서식만 변경하면 최대 50,000셀 |
| `PATCH /api/tasks/:id` | 순서·연도 변경 |
| `DELETE /api/tasks/:id` | 휴지통 이동 |
| `POST /api/tasks/:id/restore` | 관리자 복구 또는 해당 업무 편집자의 삭제 취소 |
| `GET/PUT /api/views` | 개인 보기 |
| `GET/POST /api/reports` | 보고본 목록·생성 |
| `GET /api/reports/:id` | 읽기 전용 보고본 |
| `GET /api/audit` | 수행자·시각·전후 값 |
| `POST /api/audit/:id/restore` | 이력 복원도 새 변경으로 기록 |
| `POST /api/import/preview` | XLSX 사전 분석, multipart 파일 |
| `POST /api/import/:id/apply` | 확인한 시트 적용 |
| `POST /api/import/:id/exceptions` | 전체 이관 예외 JSON 다운로드 |
| `POST /api/export` | XLSX·CSV·JSON 반출 |
| `GET/POST /api/admin/users` | 전체 사용자·팀 목록 / 사용자 생성 (`systemRole`, `memberships: [{teamId, role}]`) |
| `PATCH /api/admin/users/:id` | 사용자 정보·시스템 권한, 선택적으로 팀별 권한 전체 교체 |
| `POST /api/admin/teams` | 팀 생성, 선택적인 `members: [{userId, role}]` |
| `PATCH /api/teams/:id` | 팀 이름·테마 저장 (시스템 관리자·팀장) |
| `GET/PUT /api/teams/:id/members` | 팀 구성원과 팀 내 권한 조회·전체 교체, 추가할 사용자 목록 (시스템 관리자·팀장) |
| `DELETE /api/admin/teams/:id` | 확인한 팀의 전 연도 데이터 영구 삭제 |
| `PATCH /api/teams/:id/settings` | 속성 이름·값·순서·표시 모양 저장 |

정확한 입력 검증은 `server/validation.mjs`, 동작 계약은 `tests/api.test.mjs`를 참고합니다. API를 바꾸거나 직접 DB를 수정하는 도구를 만들 때 충돌 버전, 감사 기록, 팀 접근 검사를 함께 유지해야 합니다.

업무 생성의 선택적인 `insertAt: {taskId, updatedAt, placement}`는 같은 팀·연도의 기준 행 앞(`before`) 또는 뒤(`after`)에 새 업무를 삽입합니다. 기준 행의 접근 권한·버전을 검사하며 버전 충돌은 409입니다. 순서 간격이 부족하면 생성 트랜잭션 안에서 순서를 재배정하므로, 생성 실패 시 순서 변경도 함께 취소됩니다. 행 붙여넣기는 `copiedRow: {cells: {[key]: {value, style}}, defaultStyle}`를 보내며 속성값·서식을 검증합니다. 일반 팀원의 담당자는 본인으로, 지원자는 빈 목록으로 생성하며 열람자는 생성할 수 없습니다. 기존 `sourceId` 복제도 유지하고 `copiedRow`와 동시에 보낼 수 없습니다. 관련 계약은 `tests/row-menu.test.mjs`에서도 검증합니다.

행 이동은 `tasks: [{id, updatedAt}]`(최대 20,000행), `targetId`, `targetUpdatedAt`, `year`, `placement`(`before`·`after`), 선택적인 `groupBy`를 받습니다. 기존 단일 행 요청의 `taskId`·`updatedAt`도 지원합니다. 이동할 행은 현재 수동 순서를 유지하며 한 트랜잭션으로 저장하고, 하나라도 권한·버전·팀·연도·묶음 검사를 통과하지 못하면 모두 취소합니다. 기준 행은 이동 대상에 포함할 수 없습니다. 응답의 `tasks`는 이동한 모든 업무이며, 단일 행 클라이언트를 위한 `task`도 유지합니다.

### XLSX 분석 범위

`POST /api/import/preview`의 multipart 항목은 `file`, `teamId`, `year`, 선택적인 JSON 문자열 `sheetOptions`입니다. `sheetOptions`는 시트 이름별 설정으로, `headerRow`(1~20), `startRow`·`endRow`(1~20,000), `columns`(속성 ID → 1부터 시작하는 원본 열 번호)를 받습니다. 행 범위는 양 끝을 포함하며 시작 행은 헤더 뒤여야 합니다. 예를 들어 `{"연간 업무":{"headerRow":3,"startRow":5,"endRow":400,"columns":{"type":2}}}`는 제목 없는 B열을 유형으로 연결하고 아래쪽 참고 표를 업무에서 제외합니다. 이 설정은 API로 제공하며 일반 가져오기 화면에는 별도 범위 입력 UI가 없습니다. 범위 밖의 표는 자동 이관되지 않으므로 따로 보존해야 합니다.

기본 분석은 위쪽 헤더 영역의 진척도·목표일도 연결합니다. 연도가 없는 월/일 주차 헤더는 마지막 날짜를 선택 연도에 맞추고, 오른쪽에서 왼쪽으로 12월→1월 경계를 따라 이전 연도를 계산합니다. 명시된 연도는 유지합니다. 날짜가 역순이거나 여러 해가 불규칙하게 섞인 원본은 연도까지 포함한 헤더로 정리한 뒤 이관하는 것이 안전합니다. 동일 주에 속한 열이 여러 개면 경고하고 첫 열을 보존하므로, 나머지 열은 `columns`로 별도의 Text 속성에 연결하여 보존해야 합니다.

담당자 없는 행은 미지정으로 유지하고 로그인한 관리자로 대체하지 않습니다. 수식은 저장된 계산 결과를 가져오며 재계산하지 않습니다. 부분 글자 서식, 대각선 테두리, 조건부 서식 등 지원 범위 밖의 표현은 원본 파일과 예외 목록을 함께 확인해야 합니다.

상단 상태 통계는 `status` 속성의 활성 옵션 ID에 셀 값을 연결해 이름·점 색상·순서를 따릅니다. 기본 상태 셀은 기존 호환을 위해 라벨을 저장하고 이름 변경 시 서버가 셀·필터와 버전을 함께 갱신합니다. 미지정과 예전 값도 별도 집계해 합계가 전체 업무 수와 같도록 합니다. 필터·숨김과 무관하게 선택 팀·연도의 업무 목록을 기준으로 계산합니다.

서식 메뉴의 재선택은 값 변경 여부와 관계없이 선택 범위의 `/cells/batch` 서식 변경을 요청합니다. 글꼴·크기·세로 정렬·텍스트 표시가 대상이며 내용은 보존하고 기존 원자적 저장·버전 검사·실행취소를 사용합니다.

팀 영구 삭제는 시스템 관리자만 `DELETE /api/admin/teams/:id`에 `{confirmed: true}`로 요청한다. 확인 누락은 400, 권한 부족은 403, 이미 없는 팀은 404이다. 시스템 관리자는 팀 소속 없이도 모든 팀에 접근하므로 소속 팀이 없어지는 삭제도 허용한다. `tasks`(모든 연도·휴지통 포함)·`cells`·`views`·`reports`·`imports`·`audit`·`memberships`·`team_revisions`·팀 설정과 해당 변경/가져오기 작업의 재시도 캐시를 하나의 트랜잭션으로 제거한다. 공용 사용자·세션과 다른 팀의 독립적인 작업 기록은 유지한다. 삭제 내용 없이 `team_id: null`, `action: team-delete`, `target: 삭제한 팀 ID`인 관리자 이벤트를 남긴다. 별도 저장된 백업 파일은 변경하지 않는다.
