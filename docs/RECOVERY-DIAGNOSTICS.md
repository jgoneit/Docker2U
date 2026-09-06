# 복구 안내·진단·목록 확인 시각

PR #4가 병합된 `6bcb63b53be12ab97946e7096d929287cd612a23`을 기준으로
`codex/recovery-diagnostics`에서 작업한다. 설치 앱과 버전 구분, Docker IPC,
Rust의 조작·timeout·연결 계약은 변경하지 않는다.

## 화면의 복구 상태

단일·일괄 중지/재시작 확인창이 열린 동안 현재 세션의 연결이 무효화되면,
확인창 내부에 재연결 안내를 표시하고 실행 버튼을 비활성화한다. 실행 버튼에
있던 포커스는 취소로 이동한다. 취소와 Escape로 닫으면 다시 연결 버튼에
포커스를 돌린다. 기존 동기 실행 가드도 유지한다. 자동 재연결이나 작업 재실행은 없다.

진단 복사는 연결 시점의 환경 정보와 현재 `frontendSession`을 구분한다.
후자에는 연결 표시 상태, 작업 차단 여부, 재연결 필요 여부, 마지막 목록의
stale 여부와 수락된 갱신 시각, 문제 한 건을 담는다. 환경 조회 응답을 받지
못한 경우에도 현재 프런트엔드 상태를 복사할 수 있다.

문제의 발생 단계·출처·실제 오류 코드·수락 시각·복구 필요 여부를 보존한다.
코드가 없는 작업 결과에는 임의의 오류 코드를 만들지 않는다. 원문 메시지,
명령, stderr, 로그와 opaque 세션/컨테이너 handle은 새 메타데이터에 넣지 않는다.
네이티브 환경 정보의 기존 허용 목록은 유지한다.

현재 세션의 연결 무효화 오류는 로그 표시 요청이 비워진 뒤에도 기록한다.
이전 세션의 응답은 무시하고, 일반 조회 오류나 성공으로 재연결 원인을
덮어쓰지 않는다. 재연결 중에는 이전 세션의 문제로 표시하고, 실패하면 새
연결 시도의 문제로 교체한다. 유효한 새 세션을 얻었을 때 이전 원인을 해제한다.

목록 확인 시각은 선택과 관계없이 목록 상단에 표시한다. 실패한 갱신은 마지막
정상 시각을 유지하며, 최초 조회 전에는 목록 미조회를 표시한다. 전용 컴포넌트가
분 단위와 화면 복귀 시에만 현재 시각을 보정한다. 날짜가 바뀌면 날짜를 함께
표시하고, 툴팁과 접근 가능한 설명에는 초·시간대까지 제공한다. 시계와 언어
변경은 Docker를 호출하거나 작업 허용 여부를 바꾸지 않는다.

## 검증 실행

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:native-fixture
pnpm build
pnpm test:browser
pnpm rust:fmt
pnpm rust:test
pnpm native:build
```

Chromium은 Playwright가 `127.0.0.1:1422`에 전용 서버를 시작·종료한다.
기존 서버를 재사용하지 않는다. 라이트/다크 × 한국어/영어 × 1024×680/1280×800과
1600×1000의 9개 조합을 유지하며, 로그 위치·포커스·검색·복사·작업 색상과
새 차단 안내·목록 시각을 검사한다. 화면 클릭에 따른 자동 스크롤 전에 로그
영역의 경계를 측정한다.

## 격리된 macOS 네이티브 검증

`pnpm native:smoke`는 사용 가능한 하위 명령을 표시한다. `build`는 별도 Vite
진입점으로 검증 번들을 만들고, `launch`는 실제 App과 Rust IPC를 임시 HOME,
DOCKER_CONFIG, Unix 소켓, 읽기 전용 가짜 CLI에 연결한다. 환경 변수는 자식
프로세스에만 전달하며 사용자 설정·Docker context·설치 앱을 바꾸지 않는다.
가짜 CLI는 정해진 조회 명령만 허용하고, 조작 명령은 기록 후 거부한다.

검증 번들은 별도 식별자, 빌드별 고유 경로와 비영구 WebView 저장소를 사용한다. 배포 CSP와
네이티브 timeout은 유지한다. 프런트엔드 API 응답을 대체하지 않고 실제 UI
버튼으로 시나리오를 실행한다. Worker wrapper는 실제 응답을 기록하며,
생성 실패와 초기 응답 미도착을 별도 모드로 제공한다.

`arm-engine-change`는 다음 info 응답을 지연시켜 Engine ID 변경을 재현한다.
`socket-off`와 `socket-on`은 fixture 소켓만 제거·복구한다. `report`는 UI와
호출 기록을 함께 확인하는 용도다. `stop` 또는 앱 종료 시 자신이 만든
프로세스와 임시 파일만 정리하고 호출 기록을 보관한다.

일반 `pnpm build`에는 검증 진입점·Worker wrapper·합성 데이터가 들어가지
않도록 배포 출력 표식을 검사한다. CI에서는 fixture 검사와 배포 격리 검사,
Chromium, Rust 및 일반 앱 빌드를 수행한다. 검증용 WKWebView의 화면 실행은
로컬 Computer Use 증거이며 CI 화면 실행과 구분한다.

## 검증 경계와 롤백

일반 앱의 실제 연결/로그 확인, 검증 번들의 장애 주입/Worker 실행, 합성
Chromium 검사는 서로 다른 증거다. Windows 앱 실행과 실제 컨테이너
시작·중지·재시작은 이 작업에 포함하지 않는다. 앱 설치나 PR merge도 수행하지 않는다.

화면 동작은 프런트엔드 기능 커밋을 되돌려 복원할 수 있다. 검증 도구와 CI
fixture 단계는 별도 커밋으로 되돌릴 수 있으며, 네이티브 조작 계약이나 사용자
설정 마이그레이션은 필요 없다.

## 2026-09-06 로컬 검증 기록

기준 호스트는 macOS 26.6.2 (25G83), ARM64다. 기존 체크아웃과 설치된
`/Applications/Docker2U.app`은 보존했다. 개발 도구체인을 사용하는 이 장비의
중첩 체크아웃에서는 Cargo/Rustup 경로를 명시했다.

| 검사 | 실제 결과 |
| --- | --- |
| Vitest | 19개 파일, 344건 통과 |
| 네이티브 fixture 검사 | Python 14건 통과 |
| TypeScript + 배포 frontend build | 통과, 배포 출력 4개 파일의 fixture 표식 없음 |
| Chromium | 9개 화면 조합, 117건 통과 |
| Rust formatting | 통과 |
| Rust unit/fake CLI | 50건 통과, 실제 Engine 검증 3건 ignored |
| 일반 macOS 앱 빌드 | unsigned ARM64 release 번들 생성 |

처음 전체 Chromium 실행의 1건은 실행 도중 App/components의 Vite hot update가
추가 로그 호출을 발생시켜 실패했다. trace에서 해당 갱신을 확인했고 제품 소스를
동결한 후 117건 모두 통과했다. 테스트 기대값이나 Docker 호출 검사를 완화하지 않았다.

일반 앱은 이 체크아웃의 `src-tauri/target/release/bundle/macos/Docker2U.app`을
직접 열어 Computer Use로 확인했다. `desktop-linux`의 실제 Unix 소켓에 연결해
컨테이너 4개와 PostgreSQL 로그를 조회했다. `checkpoint` 검색 18건, ⌘F,
검색 X, 확대·Escape 및 포커스 복원, 1024×680 창의 검색줄·로그 하단을 확인했다.
목록 확인 시각은 동일한 갱신 시각을 유지한 채 방금에서 1분 전으로 바뀌었다.

진단 복사 JSON을 읽어 현재 세션의 connected, effectiveMutationBlocked=false,
reconnectRequired=false, inventoryStale=false, issue=null이 화면과 일치하는지
검사했다. 일반 앱에서는 장애를 주입하거나 컨테이너 조작 버튼을 실행하지 않았다.

일반 앱 실행 파일 SHA-256:
`976e23fc22b7a8f622487ce065fdb1ae3a1c48e62cb032344de96885a3654f7b`.
설치된 앱의 실행 파일 SHA-256은 작업 전후
`d077fc47e9f9c8d43131679017837f1bce67e7d2c5320b9f635452552934e7a9`로 유지됐다.

명령 실행 로그와 실제 앱 진단은 `.cache/recovery-validation/`에 보관한다.
이 로컬 디렉터리의 실제 환경 진단 원문은 PR에 게시하지 않는다.

### 실제 WKWebView의 격리 검증

전체 시나리오를 수락한 실행은 `d2u-smoke-6ebef12a9f`다. 검증 번들의 실행 파일
SHA-256은 `85fbb8a83bcf2d9da1cbde1a89bf146698ec71ef7a07ef6ec889408af93825ea`다.
동일 실행에서 UI JSON 3개를 제출했고 `requiredCoverageComplete=true`, 거부된
조작 명령 0건, CLI/제어 이벤트 183건을 기록했다. 실제 Docker CLI를 사용하지 않았다.

| WKWebView 시나리오 | 확인한 결과 |
| --- | --- |
| 실제 Worker | ready/result/located 응답, 2 MiB 원문의 대소문자 무시 a 검색 2,096,987건 |
| 마지막 일치·빠른 검색어 변경 | 마지막 ordinal 2,096,986으로 이동, 최신 NATIVE_SMOKE_END만 1건 강조 |
| Worker 생성 실패 주입 | 생성 예외 기록 후 동일 건수·마지막 일치·최신 검색 결과 |
| 초기 응답 미도착 주입 | 실제 ready 전달 억제, 약 2초 후 Worker 종료, 대체 검색의 동일 결과 |
| Engine 변경 | 조회 시작 후 비우기, 같은 info PID의 지연된 Engine ID 변경 오류 이후 경고·차단 유지 |
| SocketMissing | fixture 소켓 제거 후 실제 네이티브 파일 검사 오류 |
| 복구 2회 | 새 목록과 새 로그가 모두 수락된 뒤에도 경고 유지, 명시적 재연결에서 해제 |

전체 건수에는 실제 IPC 로그 첫 줄의 실행 식별 메타데이터도 포함한다. fixture가
별도로 계산한 건수와 Worker/대체 경로의 결과를 대조했다. 이번 단일 실행의 검색
완료까지는 Worker 815ms, 생성 실패 대체 경로 1,153ms, 초기 응답 제한 포함
대체 경로 3,093ms였다. 반복 성능 벤치마크나 다른 장비의 응답 시간을 뜻하지 않는다.

마지막 일치와 최신 검색 문자열의 세로 좌표는 로그 표시 영역 448–719px 안의
690–705px였다. Chromium의 가로·세로 경계 검사와 별도로 실제 WKWebView에서
확인한 좌표다. Clear 경합은 네이티브 PID 46320의 호출 기록과 UI 기록을 결합했다.
요청 시각 1788692414425ms, 비우기 1788692414818ms, 오류 응답 1788692417498ms이며,
같은 PID의 지연 시작도 요청과 비우기 사이에 있었다.

종료 후 보고서 3개와 순서 검증 결과가 보존됐고 fixture 루트가 제거됐으며,
소유한 앱·controller PID가 종료됐음을 확인했다. 기록은
`.cache/native-smoke/runs/d2u-smoke-6ebef12a9f/`의 report.json, trace.json,
ui-results에 남아 있다. 다른 실행·바이너리·시각, 순서 불일치, 실패·미완료 UI
결과는 검증기가 수락하지 않는다.

도구 개발 중 첫 실행은 재연결 전환 중 패널이 없는 상태를 대기하지 못해
실패했다. 기존 본문을 새 조회 완료로 오인하지 않도록 목록·로그 수락 시각을
동시에 검사하게 수정했고 전환 회귀 4건을 추가했다. 그 실패 UI JSON과 호출
기록은 별도로 보존했다. 또한 macOS가 같은 경로의 예전 bundle ID를 캐시하는
상황을 확인해, 이후 빌드는 `.cache/native-smoke/bundles/<build ID>/`에 보존한다.
최종 runner의 build와 기본 launch를 다시 실행하여 고유 경로의 앱이 새 fixture에
연결하고 로그를 수신하는 것까지 확인했다. 이 실행의 ID는 `d2u-smoke-8e511586c4`이며
기본 실행 경로 확인용이다. 전체 장애·Worker 시나리오의 증거는 앞선
`d2u-smoke-6ebef12a9f` 보고서이고, 두 실행을 합쳐 전체 통과로 판단하지 않는다.

### Seal과 게시 경계

Seal CLI와 선택된 Plugin의 공개 버전은 `0.3.0-rc.4`로 일치했다. Basic Task는
`docker2u-recovery-diagnostics-20260906`, risk=medium, verifier.required=false이며
기존 frontend-tests/frontend-build만 필수 검사로 선택했다. 기존 Task/Run은
보존한다. 소스·이 문서가 확정된 후보에서 verify 후 반환된 정확한 Run ID로
complete한다. 반환된 Completion과 최신 커밋의 CI 결과는 PR 설명과 최종 응답에
기록하며, 별도 브라우저·Rust·실제 앱 검증을 Seal 자체 검증으로 표현하지 않는다.
