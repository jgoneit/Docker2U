# Compose 변경 반영 후속 수정 및 검증

날짜: 2026-09-13 (KST)

이전 작업의 `codex/compose-apply-v1` 작업본과 Seal Task
`docker2u-compose-apply-v1-workspace-20260913`을 이어서 사용했다.
기준 HEAD는 `6f13a3fd4b2a9ba99071c151c7625bd2e9275589`이며,
미커밋 변경은 승인된 Compose 선택 서비스 변경 반영 범위에 속한다.
최초 실패 Run `6cefd0825d10487686bb494020a62b5f`와
[이전 검증 기록](COMPOSE-APPLY-AUDIT.md)을 보존한다.

## 발견한 문제

- Native WKWebView에서 이미지 준비 select에 기본 macOS 외관이 적용되어 기존
  입력 컨트롤과 높이·테두리가 달랐다. HTML select와 native popup을 유지하면서
  앱의 기존 select 스타일을 적용했다.
- 1024×680의 긴 Compose 경로 확인 화면에서 서비스 목록이 flex 축소로 높이 0까지
  눌렸다. 작업이 둘 이상인 진행 화면의 최근 작업 목록도 같은 현상을 보였다.
  해당 목록의 높이를 유지하고 대화상자 스크롤로 접근하도록 수정했다.
- 취소 요청이 대기하는 사이 polling이 완료 상태를 받으면, 늦은 취소 응답의
  실행 중 snapshot이 완료 상태를 다시 덮어쓸 수 있었다. 완료 결과를 유지하는
  경계를 추가했다. 지연 응답 회귀는 수정 전 실패와 수정 후 통과를 확인했다.

## Native 실제 조작 기록

첫 실행 `d2u-smoke-9b185ac274`는 이전 후보 바이너리
`76de9218bef91833f4935265007863385f4db206f983240c1692577810dfc611`를 사용했다.
Computer Use에서 exact 앱 경로를 선택한 뒤 공식 fixture launcher로 실행했다.
화면의 context `native-smoke-local`, Engine `native-smoke-engine`,
endpoint `/private/tmp/d2u-smoke-9b185ac274/engine.sock`과 로그의 launch binding을
확인했다. 실제 Docker Engine을 이 Native fixture로 제어하지 않았다.

- 공백·한글이 있는 Compose 파일과 폴더를 등록하고 초기 미선택 상태를 확인했다.
- api는 다운로드 가능·빌드 불가, worker는 다운로드 불가·빌드 가능임을 native
  popup에서 확인했다. 키보드로 준비 방법을 선택하고 Engine·서비스·새 생성 안내를
  확인한 뒤 pull → build → recreate → 상태 재조회를 실행했다.
- 모든 단계 종료 코드 0과 새 api/worker ID, Running 상태, api Healthy 및 worker
  Health 미설정, 실제 fixture 출력을 확인했다. 재생성 후 통합 로그 4행이 보였다.
- 로그 키워드 `NATIVE_PROJECT_LOG`와 화면 일시정지 상태가 영어·다크 전환 후
  유지됐다. 준비 생략으로 api만 선택했을 때 실제 기존 복제본을 확인했다.
- `compose-quiet`에서 진행 창 닫기·최근 작업 재열기 후 명령이 계속 실행 중이었다.
  취소 시 `ResultUnknown` 및 상태 재조회 완료, 선택 api의 Running/Healthy가 표시됐다.
  로그 검색·일시정지와 worker ID는 유지됐다.
- 이 첫 실행에서 select 외관과 최근 작업 목록 축소를 발견했다. 공식 `report`의
  `rejectedCommands`는 빈 목록이었다. 직접 조작 기록은 자동 probe 전체 통과나
  `composeUiVerified=true`를 뜻하지 않는다. 실행은 공식 `stop`으로 종료했다.

## 최종 Native 후보

수정 후 새로 빌드한 bundle은 `9ef33df92e294f72a78fedd220c1c147`, 실행은
`d2u-smoke-af4c220a83`이다. 실행 바이너리 SHA-256은
`4be349eabd04469b7d05c2c0a2c82d7de53469b0c6ea228fa858450ada529ad5`다.
공식 launcher의 독립 fixture Engine 연결과 로그의 launch binding을 다시 확인했다.

- 창을 최소 1024×680으로 줄여 한국어·영어 × 라이트·다크 네 조합의 선택 화면을
  직접 확인했다. select 높이와 배경·텍스트가 앱 스타일로 표시됐다. 지원하지 않는
  메뉴 항목은 native popup에서 비활성이고 지원하는 항목은 키보드로 선택됐다.
- 긴 영문·한글 경로를 가진 fixture를 등록했다. 한국어 라이트와 영어 다크 확인 창에서
  경로 아래의 서비스·준비 방법·복제본·실행 버튼이 스크롤로 실제 표시됐다.
- api=pull, worker=build의 세 명령과 상태 재조회가 모두 성공했다. 각 단계 출력과
  종료 코드 0, api/worker의 컨테이너 상태 및 로그를 확인했다.
- worker=build에 `compose-build-fail`을 주입했다. build만 종료 코드 1로 실패하고
  recreate는 미실행, 상태 재조회는 완료됐다. 선택 worker만 상태 영역에 표시됐다.
- 최근 작업 두 버튼이 얇은 선으로 눌리지 않고 온전한 높이로 표시됐다. 이전 완료
  작업을 선택하자 세 명령 성공 결과와 원래 출력이 복원됐다. 닫기 버튼 사이
  Shift+Tab/Tab 순환도 실제 키보드로 확인했다.

화면 증거는 현재 작업의 Computer Use 스크린샷·AX 기록이며, fixture CLI trace는
`.cache/native-smoke/runs/d2u-smoke-af4c220a83/`에 보존했다. 최종 report는
`.cache/compose-apply-resume-native-report.json`이다. 실행은 공식 `stop`으로 종료했다.
선택·긴 경로·혼합 성공·빌드 실패·최근 결과 복원은 위 최종 바이너리에서 확인했고,
취소·로그 검색/일시정지 보존은 앞선 바이너리의 직접 조작과 최종 회귀 검사로 구분한다.

## 회귀 검사 결과

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| 권한 복구 후 `pnpm rust:test` | 237 passed, 0 failed, 6 ignored | 기존 121건 socket 실패 해소, Apply fake CLI 7건 포함 |
| `pnpm test:native-fixture` | 50/50 통과 | 합성 CLI/socket 및 evidence validator |
| 수정 후 hook/Apply UI 집중 검사 | 45/45 통과 | 늦은 취소 응답, 서비스 선택·확인·진행 |
| 수정 후 최소 화면 Compose 집중 검사 | 22/22 통과 | 한국어 라이트·영어 다크, 긴 경로와 최근 작업 버튼 |
| 최종 `pnpm test:browser` | 504/504 통과, 7.3분 | Compose 99건, 9개 언어·테마·창 크기 설정 |
| 실제 Engine opt-in 검사 | 1/1 통과, 52.56초 | Core Apply 5회, 비선택 ID·공유 데이터·Healthy 확인 |
| 최종 Native bundle 빌드 | 통과 | 위 SHA-256의 unsigned 테스트 앱 |
| `git diff --check` | 통과 | 공백 오류 검사 |

새 실제 Engine 검사는 명시적 환경변수와 `--ignored`로만 실행한다. 일반 Rust
suite에서 ignored 수가 6개에서 7개로 증가하는 이유이며, 이 검사는 위 표처럼
별도로 실제 실행했다. 다른 기존 ignored 검사의 실행을 의미하지 않는다.

최초 브라우저 전체 실행은 475/495 통과, 20건 실패였다. 18건은 disabled option에
대한 Playwright 단정이 DOM의 실제 비활성 속성과 맞지 않았고, 2건은 가상 로그의
화면 밖 overscan 행 전체를 비교했다. option의 실제 disabled property와 키보드
선택 제한을 검사하고, 로그는 실제 보이는 행·scrollTop·검색어·일시정지·구독을
검사하도록 바로잡았다. UI 결함은 별도 실제 화면 검사로 발견하고 위 세 항목을
수정했다. 최초 실패 보고서는 `.cache/compose-apply-browser/initial-playwright-report/`,
수정 전 화면은 같은 폴더의 `before-ui-fixes/`에 보존했다.

최종 브라우저 로그는 `.cache/compose-apply-browser/final-playwright.log`,
HTML 결과는 `playwright-report/index.html`, 네 가지 최소 화면의 수치·이미지는
`.cache/compose-apply-browser/summary.json`과 PNG 파일들이다.
긴 경로의 확인 목록 높이는 한국어 182px, 영어 176px였으며 스크롤과 Tab으로
모든 항목·실행 버튼에 접근했다. 전체 색상의 정량 대비 감사를 수행한 결과는 아니다.

Seal은 기존 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`를
그대로 사용한다. 위 기록까지 포함한 완료 후보에 `verify`를 실행하고 반환된 정확한
Run ID로 `complete`한다. 그 최종 CLI 출력은
`.cache/compose-apply-resume-seal.log`와 작업 최종 응답에 기록하며, 이전 실패 Run을
덮어쓰지 않는다. 문서에서 검사 정의·timeout·필수 여부를 변경하지 않았다.

## 증거 구분

Rust·React 회귀는 Core와 UI 상태 계약을, Chromium과 Native는 각각의 렌더러를
검증한다. 실제 Docker 변경 반영은 별도 [Engine 검증 기록](COMPOSE-APPLY-REAL-ENGINE-AUDIT.md)에
정리한다. Seal은 기존 네 가지 필수 검사의 기계적 Acceptance이며, 실제 Engine이나
Native 화면 결과를 대신하지 않는다. 서명·notarization·Gatekeeper 및 설치 앱 교체는
이 작업 범위에 포함하지 않는다.

원본 main 작업본의 추적 파일과 `.local-apps/`, 이전 작업본을 보존한다.
커밋·푸시·PR 생성·병합·설치 앱 교체는 수행하지 않는다.
