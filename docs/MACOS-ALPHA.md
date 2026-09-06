# Docker2U macOS 로컬 알파

사용자 문제 검증은 완료되었다. 현재 목표는 Apple Silicon Mac에서 Docker CLI가
선택한 로컬 Linux Engine의 Container를 조회하고 복구할 수 있는 `Docker2U.app`이다.
이 문서는 [개발 정의서](DEVELOPMENT-DEFINITION.md)의 현재 단계별 적용 기준이다.
2026-09-06 연결 정책 개정과 2026-09-05의 Colima 고정 알파 검증 이력을 구분한다.

## 구현 범위

| 항목 | 로컬 알파 결정 |
| --- | --- |
| Stack | React + TypeScript strict + Tauri 2 + Rust |
| Host 호환 범위 | macOS 14 이상 / Apple Silicon, Core에서 실제 버전·architecture 검사 |
| Runtime | 사용자가 이미 준비한 로컬 Linux Docker Engine |
| 호환성 판단 | 필요한 CLI·Engine 응답 확인, 정확한 버전·provider·VM 설정·Engine 이름 제한 없음 |
| 대상 context | 시작·Reconnect에서 인자 없는 `docker context inspect`가 반환한 선택 |
| 대상 endpoint | 실제 Unix socket 검증 후 canonical 경로를 세션에 고정 |
| UI | 제공된 React 패널의 어두운 테마, 검색·필터, 왼쪽 목록·오른쪽 상세 |
| 창 | 기본 1280×800, 최소 1024×680 |
| 기능 | 환경 진단, 목록·Health, 최근 로그, Refresh, 단건·다중 Start·Stop·Restart |
| 로그 | 최근 300줄 요청, stdout/stderr 합계 마지막 2 MiB 표시 |
| 산출물 | 로컬 `.app`, 소스, 자동 검사·실환경 검증 결과 |

앱은 전역 Docker 기본 context를 변경하지 않는다. 연결 중 외부 context가 바뀌어도
Refresh·로그·단건 및 다중 복구는 기존 세션의 Engine을 사용한다. Reconnect에서만
CLI의 새 선택을 반영하며, 실패하면 이전 세션과 handle을 사용할 수 없다.
선택을 해석할 수 없거나 endpoint가 미지원·원격이면 진단을 반환하고 다른 Engine으로
fallback하지 않는다. 앱은 Container·Volume을 이동하거나 Runtime을 설치·시작하지 않는다.

전체 초기화, Delete/Prune, 대상 확인 없는 전체 중지, Terminal/Exec, Compose 실행, 호스트 Port
Inspector, 자동 갱신, 실시간 로그, 환경 변수 표시와 Local-only 해제 설정은
제외한다. Windows·Intel Mac, 외부 서명·notarization, DMG·공개 GitHub Release는
후속 검증이다. macOS 14+ 호환성 허용은 모든 OS·CLI·provider 조합의 인증을 뜻하지 않는다.

현재 보이는 목록을 명시적으로 전체 선택한 뒤 확인창을 거치는 Stop은 허용한다.
검색·필터로 숨겨진 Container나 다른 context를 일괄 작업에 포함하지 않는다.

## 준비와 작업 경계

2026-09-05 최초 재개에서는 Seal과 Ward를 사용하지 않았다. 초기 도구 준비부터
기능 구현·자동 검사·실환경 확인까지 직접 수행한다. 개발 환경에 필요한 Rust는 공식
custom-home 설치와 task-local toolchain wrapper를 사용할 수 있다. 이 개발용
경로를 앱의 Docker CLI 기본 경로나 배포 의존성으로 넣지 않는다.

이후 PR #1 리뷰 수정에서는 사용자가 Seal을 명시적으로 선택하고 설정 추가를
승인했다. `.seal/checks.json`에 기존 React 테스트·frontend 빌드·Rust 포맷 검사·
Rust 테스트를 등록하여 Basic Acceptance에 사용한다. Ward는 사용하지 않는다.

저장소의 `scripts/with-toolchain.mjs`가 준비한 Rust 도구체인을 선택한다.
로컬 앱 개발 명령은 `pnpm native:dev`, native build는 `pnpm native:build`다.
이 개발 장비의 별도 도구 디렉터리는 `../.docker2u-tools`이며 제품 배포물과
분리한다. 명령 제공 여부와 실제 실행·검증 결과는 구분해 기록한다.

Rust toolchain 및 Cargo/frontend lockfile을 고정한다. 최초 설치와 빌드 캐시를
준비한 후 TypeScript 검사, React 테스트, Rust 테스트, frontend/native 빌드를
실제 실행한다. 설치 완료나 캐시 준비를 검사 통과로 대신하지 않는다.
각 기능 단위는 관련 자동 검사와 실제 Mac 검증으로 확인한다.

1. 환경 진단·실행 계층: CLI 탐색, CLI의 context 선택과 local endpoint 검증,
   CLI·Engine metadata 수집, typed `get_environment()`와 화면 연결.
2. 목록·로그: batch inspect로 State·Health 확인, 원자적 Refresh, 검색·필터,
   최근 로그 한도·정규화·잘림 표시, Stale·빈 결과·연결 오류 화면.
3. 복구·재조회: Start → Stop → Restart, 확인창, 정확한 대상 재검증,
   중복 조작 차단, 실행 후 Refresh와 `ResultUnknown` reconciliation.
4. 다중 복구: 개별 체크·현재 목록 전체 선택, 실행 가능 대상 표시, 순차 실행,
   대상별 결과와 후속 중단, 전체 작업 종료 후 한 번 Refresh.

## 동작과 검증 계약

Rust가 CLI 절대경로·endpoint·session·handle→full ID mapping을 소유한다.
UI는 typed IPC로 session ID와 opaque handle만 전달한다. Shell을 사용하지
않는다. 시작·Reconnect의 context discovery에는 앱이 상속한 Docker 대상·TLS 설정을
전달하여 CLI 자체의 선택을 확인한다. 이후 모든 Engine 명령에는 검증된 canonical
`--host`를 명시하고 대상·TLS·API 환경변수 override를 제거한다. stdout/stderr를
동시에 소비하고 한도, timeout, 프로세스 종료·정리를 적용한다.

discovery 결과의 local Unix socket이 절대경로이고 실제 socket인지 검증한 뒤
canonical 경로를 저장한다. 세션에는 CLI 경로, Docker config 경로, context 이름과
Engine ID·OS·architecture·Server/API metadata를 기록한다. 후속 작업은 저장된
endpoint와 Engine identity만 확인하며 context 또는 legacy Runtime 설정을 재해석하지 않는다.
목록은 전체 조회 성공 시에만 새 generation으로 교체하고 실패하면 마지막 목록을
Stale로 표시한다. 이전 session·generation의 결과가 최신 상태를 덮지 않는다.

세션을 발급하기 전에 Core가 `/usr/bin/sw_vers -productVersion`을 Shell 없이
기존 실행 계층으로 호출하며 제한 시간은 5초다. macOS 14 이상 / ARM64를
허용하고, 다른 정상 OS·버전·architecture는 `unsupported`, 탐지 실패나 잘못된
출력은 `unavailable`로 반환한다. 두 경우 모두 세션이 없고 `mutationAllowed=false`다.
앱의 `minimumSystemVersion: 14.0`과 Core의 최소 Host 기준을 일치시킨다.
read-only 진단과 목록·inspect 호환성 검사는 개별 Start·Stop·Restart의 권한이나
성공을 보증하지 않는다. 실제 실행 오류와 재조회 결과는 각각 표시한다.

Refresh 중 Reconnect는 UI와 Core에서 차단한다. Core는 기존 세션·epoch·목록
generation을 보존하고 `Busy`를 반환한다. 기존 Refresh가 성공하거나 실패한 뒤
재연결할 수 있으며, UI 함수의 ref 검사로 화면 재렌더링 전 연속 클릭도 차단한다.

Mutation 직전에 full ID, session, generation, endpoint, Engine
fingerprint를 확인한다. 단건·다중 mutation은 Core의 전역 lock을 공유하고
작업 중 다른 mutation·Refresh·Reconnect를 `Busy`로 거부한다.
Stop·Restart는 대상과 연결 환경의 확인창을 표시한다.
Timeout·연결 단절 등으로 결과가 불확실하면 `ResultUnknown`을 그대로 남기고
자동 재시도하지 않는다. exact full ID 상태를 재조회하고 실패하면 추가 mutation을
차단한다. 재조회 성공도 원래 Outcome을 성공으로 바꾸지 않는다.

UI는 State·Health·최근 갱신·로그를 우선한다. 상세 영역에 복구 버튼을 모으고
CLI 없음, 미지원·연결 실패, 빈 목록, 검색 결과 없음, Stale, Busy, 실패,
`ResultUnknown`, 재조회 실패를 구분한다. 목록 키보드 선택, 확인창 focus
이동·복원과 Escape를 검증한다. UX 시뮬레이터·mock은 개발·테스트 전용이다.
외부 폰트 요청과 사용하지 않는 서버·AI SDK 의존성은 포함하지 않는다.

환경 응답은 nullable `contextName`, `dockerConfigPath`, 구조화된 `error`와
기존 CLI·Engine metadata를 제공한다. context 해석 전에 실패하면 이름을 추정해
표시하지 않는다. 진단에서 실제 config 경로와 오류를 확인할 수 있다.

### 다중 선택과 일괄 복구

상세·로그를 보는 행 선택은 하나로 유지하고 복구 대상은 체크박스로 선택한다.
전체 선택은 현재 검색·필터 결과로 보이는 Container만 포함한다. 검색어·상태
필터 변경, Refresh, Reconnect 시 체크를 해제한다. 선택 수와 작업별 실행 가능
수를 표시하며 실행 가능한 대상이 없는 버튼은 비활성화한다.

Start는 바로 실행한다. Stop·Restart는 선택한 대상과 실행·제외 개수, 현재 연결
환경을 한 확인창에서 보여준다. Core는 요청 시점의 session·generation·handle을
검증하여 full ID와 최초 실행 가능 대상을 고정하고 한 개씩 순차 실행한다.
작업 직전 상태가 달라지면 해당 대상을 건너뛰며 새 대상을 추가하거나 대체하지 않는다.

확정된 명령 실패는 상태 확인이 성공하면 다음 대상으로 계속한다. 결과 불명,
Engine identity 변경, 연결 단절 또는 상태 재조회 실패는 후속 실행을 중단한다.
자동 재시도·rollback은 없으며 성공·실패·결과 불명·건너뜀·미실행을 대상별로
보여준다. 대상별 exact full ID 확인과 별도로 전체 목록 Refresh는 일괄 작업
종료 후 한 번 수행한다. Compose 의존성 순서나 전체 작업의 원자성은 보장하지 않는다.

## 완료 체크리스트

이 절은 2026-09-05의 고정 Colima 연결 정책에서 수행한 단건 알파 검증 이력이다.
2026-09-06 CLI 선택 연결 변경의 통과 근거로 재사용하지 않는다.

각 항목은 실제로 확인한 범위만 체크한다. 서명·Windows 검증은 현재 로컬 알파의
완료 조건이 아니다. 화면 검증은 자동 테스트·프로세스 기동과 구분한다.
아래 체크와 실환경 기록은 기존 단건 복구 기능의 검증 이력이다. 다중 복구 변경의
검증 상태는 별도 절에 기록하며 이전 통과 결과를 새 기능의 증거로 사용하지 않는다.

- [x] 실제 Mac의 OS·architecture와 Colima·Docker CLI·Server/API 버전을 기록했다.
- [x] 개발 전용 `docker2u` Colima 프로파일을 확인했고 전역 default context를 보존했다.
- [x] toolchain·lockfile을 고정하고 초기 검사 기반을 실제 실행했다.
- [x] fake CLI로 target 고정, remote 차단, malformed 출력·한도·timeout을 검증했다.
- [x] stale handle, 중복 실행, `ResultUnknown`·재조회 실패를 검증했다.
- [x] React의 검색·선택·버튼 정책·확인창·오류·Stale·로그 잘림·키보드를 검증했다.
- [x] 테스트 label이 붙은 임시 Container로 목록·Health·로그·Start·Stop·Restart를 검증했다.
- [x] 테스트가 생성한 정확한 Container만 정리했다.
- [x] private Docker config의 default context 변경에도 Core 대상이 유지되고 원래 값을 복원했다.
- [x] `pnpm native:build`로 arm64 `Docker2U.app` bundle을 생성했다.
- [x] `pnpm native:dev`의 앱 프로세스 기동을 확인했다.
- [x] Finder에서 `.app`을 열고 실제 화면·조작을 확인했다.
- [x] 재빌드한 앱에서 상세 스크롤 시 전역 헤더·연결 제어가 유지됨을 확인했다.
- [x] 실제 Stop·Restart 확인창의 초기 focus, Tab·Shift+Tab 순환, Escape·취소 후 원래 버튼 focus 복원을 확인했다.
- [x] 최소 환경의 Rust probe로 Finder와 같은 PATH 조건에서 CLI 탐색·고정 대상을 확인했다.
- [x] 실행 계층 테스트에서 shutdown 시 owned child process 정리를 확인했다.
- [x] 정상 GUI Quit으로 앱이 종료되고 남은 child process가 없음을 확인했다.
- [x] 검증용 CLI wrapper가 실행 중인 실제 GUI Quit 경로에서 owned child process group 정리를 확인했다.

빌드, fake CLI, React 테스트, 실제 Colima 연동, Finder 실행은
각각 별도의 증거다. 어느 하나의 성공으로 나머지를 완료 처리하지 않는다.

## 실환경 기록

2026-09-05 초기 단건 알파의 고정 `colima-docker2u` 환경 기록이다.
아래 수치와 GUI 결과는 현재 CLI 선택 연결 변경의 검증 결과가 아니다.

환경 진단·목록·최근 로그·Start·Stop·Restart와 재조회 기능을 구현했다.
아래 결과는 이 Mac에서 확인한 범위이며 다른 OS나 외부 배포를 보증하지 않는다.

| 항목 | 확인한 환경 |
| --- | --- |
| Host | macOS 26.5.2 / arm64 |
| 도구 | Rust 1.98.1, Colima 0.10.3, Lima 2.2.0, 독립 Docker CLI 29.8.0 |
| 의존성 | `pnpm install --frozen-lockfile` 성공 |
| Frontend | TypeScript strict 검사, React/IPC·진단 총 41개 테스트, Vite build 통과 |
| Rust | 자동 검사 22개 통과, 실환경 opt-in 검사 2개는 기본 실행에서 제외 |
| 실제 조작 | `real_runtime_smoke` 1개 통과: 목록·Health·최근 로그·Start·Stop·Restart 및 정확한 대상 정리 |
| 대상 고정 | `real_environment_probe` 1개 통과, private currentContext=`default`에서도 원래 Colima Engine 유지 |
| Native build | `pnpm native:build` 통과, arm64 `Docker2U.app` 생성 |
| 개발 실행 | Vite 1420 및 `target/debug/docker2u` 프로세스 기동 확인 후 검증자가 Ctrl-C로 종료 |
| Bundle 기동 | 최소 HOME/PATH 환경에서 bundle 내부 실행 파일이 34초 이상 유지됨을 확인하고 Ctrl-C 종료 |
| Finder 실행 | Computer Use로 재빌드한 `.app` 실행, `tauri://localhost` WebView에서 지정한 Colima Engine 연결 확인 |
| 실제 GUI 조작 | 빈 목록, label을 붙인 BusyBox fixture의 목록·Health·로그·검색·필터, Start → Stop → Start → Restart 모두 Succeeded 확인 |
| GUI 확인창 | 대상 이름·short ID·context·socket 표시, 초기 취소 focus, Tab·Shift+Tab 순환, Escape·취소 후 정확한 원래 버튼 focus 복원 |
| GUI 종료 | 정상 Quit 및 검증용 CLI wrapper 실행 중 Quit 확인; Quit 후 약 2초에 자식 정리·약 2.1초에 앱 종료, 종료 후 3초 동안 추적한 PID/PGID 잔류 없음 |
| 서명 | 실행 파일 linker ad-hoc signature 확인, Developer ID 서명·notarization 미수행 |
| Engine | Docker 29.5.2 / API 1.54 / linux / arm64 |
| Engine OS | Ubuntu 24.04.4 LTS |
| 기본 context | 준비 전후 `desktop-linux` 유지 |

## 검증 내용과 한계

이 절의 실행·복원·잔류 상태는 2026-09-05 초기 알파 검증 종료 시점의 기록이다.

- Rust 자동 검사: remote endpoint 차단, 고정 `--host`, malformed/batch inspect의
  원자성, stale handle·session·generation, 중복 mutation, Engine 변경,
  timeout·전송 오류의 `ResultUnknown`, 재조회 실패 후 Reconnect 요구를 확인했다.
- 실행 계층: shell 없는 인자 전달, Docker target/TLS/API 환경 변수 제거,
  stdout/stderr 동시 소비, 출력 한도, 마지막 2 MiB 로그, UTF-8·터미널 제어 문자
  정리, timeout·앱 shutdown 시 owned process group 정리를 확인했다.
- React: StrictMode의 단일 연결, 검색·필터·키보드 선택, 상태별 복구 버튼,
  Stop/Restart 확인창의 focus·Escape·복원, Stale, 로그 잘림, 이전 session·generation·
  로그 응답 차단, 불확실 결과 보존과 재조회 실패 차단을 검사했다.
- IPC/복사: 브라우저에서 native 연결을 모방하지 않으며 mutation을 자동 재시도하지
  않는다. Diagnostics 복사는 명시한 연결 정보만 포함하고 raw 진단 출력·로그·
  임의 추가 필드·session ID는 제외한다.
- 실제 Colima 검사는 최소 PATH와 잘못된 `DOCKER_HOST`, `DOCKER_CONTEXT`,
  `DOCKER_API_VERSION`, `DOCKER_CONFIG`를 주입한 프로세스에서도 준비한 native
  설정과 고정 endpoint로 연결됐다. Engine ID는
  `0d0a908d-e177-49ff-8b87-2ace961b117a`였다.
- 첫 실제 검사에서 생성 직후 `.State.Health`가 없는 Docker 응답이 template 오류를
  일으켰다. optional field를 `index`로 조회하도록 수정하고 자동 검사와 실제
  smoke를 다시 통과했다. 실패한 첫 fixture와 통과한 fixture 모두 정확한 ID와
  고유 label 확인 후 제거했다. BusyBox image는 개발 캐시로 남는다.
- Computer Use 권한 허용 후 Finder에서 재빌드한 `.app`을 실행했다.
  `tauri://localhost` 화면의 진단 정보에서 Colima context·socket·CLI 경로·버전과
  지정한 Engine을 확인했다. 빈 목록을 확인한 뒤 검증용 label이 붙은 BusyBox
  fixture를 선택해 Start → Stop → Start → Restart를 실행했고 모두 Succeeded였다.
  Running·Healthy와 중지 상태, 검색 결과 없음, 실행 중·중지 필터를 확인했다.
- 실제 GUI에서 최근 300줄 로그 표시와 복사 완료 피드백, 화면 비우기·다시 조회,
  환경 진단 복사 피드백을 확인했다. 클립보드 원문을 읽어 복사 내용의 일치 여부를
  대조하지는 않았다.
- 최초 화면 조작에서 상세 내용 때문에 문서 전체가 스크롤되며 헤더·연결 제어가
  가려지는 문제를 발견했다. shell을 viewport 높이로 고정하고 목록·상세를 각각
  스크롤하도록 수정했으며 진단 패널 높이도 제한했다. 재빌드한 앱에서 상세
  스크롤 중 전역 헤더·연결 제어가 유지됨을 확인했다. 최소 1024×680 창 크기의
  실제 resize 검증은 아직 수행하지 않았다.
- 실제 Stop·Restart 확인창에서 대상 이름·short ID·context·socket과 초기 취소
  focus, Tab·Shift+Tab 순환을 확인했다. Escape·취소 후 focus 복원 문제를 수정하고
  회귀 검사를 추가했다. 재빌드 후 Stop의 Escape는 정확한 Stop 버튼으로,
  Restart의 취소는 정확한 Restart 버튼으로 focus가 돌아오는 것을 확인했다.
  이 변경 이후 React/IPC·진단 검사 41개와 `pnpm native:build`가 통과했다.
  Rust 코드는 변경하지 않았으며 Rust 22개·실제 Colima 2개의 결과는 앞선 실행 기록이다.

실제 context 변경 검사는 private `docker-config`에서만 수행했다.
`colima-docker2u → default → colima-docker2u`로 전환·복원하는 동안
전역 context는 계속 `desktop-linux`였다. `HOME`과 시스템 `PATH`만 남긴
Rust probe도 같은 Engine ID로 연결했고, 목록은 0개였다. 종료 후 test label
조회에서도 남은 smoke Container가 없음을 확인했다.

개발 앱과 bundle 내부 실행 파일의 정상 기동 후 테스트 실행을 중단했고 해당
프로세스가 남지 않았음을 확인했다. 이후 실제 앱의 정상 GUI Quit에서도 앱 종료와
남은 자식 프로세스가 없음을 확인했다.

활성 자식 정리는 ignored `.cache/gui-validation`의 검증용 Docker wrapper로
확인했다. wrapper는 기존 인자를 그대로 전달하되, opt-in marker가 있을 때만
지정한 endpoint의 정확한 `info --format '{{json .}}'` 요청을 TERM을 무시하는
shell과 20초 sleep으로 지연시켰다. Finder에서 실행한 실제 앱의 Refresh가
`갱신 중…`과 비활성 제어를 표시할 때 Computer Use로 Cmd+Q를 실행했다.
Quit 시각과 같은 기준의 프로세스 기록에서 자식 그룹은 Quit 후 약 2초에,
앱은 약 2.1초에 종료됐다. 이는 조회 timeout 10초보다 이르며, 앱 종료 후 3초 동안
추적한 PID·PGID가 남지 않았다. 최종 증거는 로컬 파일
`.cache/gui-validation/timed-active-child-gui-quit.json`이다.
이 검사는 실제 GUI shutdown과 의도적으로 지연시킨 자식 그룹의 정리 경로를
확인한 것이며, 모든 외부 CLI·런타임의 종료 동작을 검증한 것은 아니다.
앞선 timeout 시도에서는 마지막 목록의 Stale 표시, TimedOut 오류와 mutation
비활성화를 확인했으며, 그 시도를 GUI Quit 정리 증거로 사용하지 않았다.

종료 검증 후 `runtime.json`을 원래 바이트와 0600 권한으로 복원하고 실제 Docker
CLI 경로와 지연 marker 제거를 확인했다. GUI fixture는 full ID·이름·label을
대조한 뒤 해당 ID만 제거했으며, 이후 inspect에서 대상이 없고 검증용 label의
Container 수도 0임을 확인했다. 원래 Engine이 계속 응답했고 전역 context는
`desktop-linux`, private context는 `colima-docker2u`로 유지됐다.
복원 후 Finder에서 최종 앱을 다시 열어 실제 CLI 경로·동일 Engine과 빈 목록을
확인했으며, 검증 종료 시점(2026-09-05)에는 사용자가 확인할 수 있도록 앱을 열어 두었다.

검증 종료 시점(2026-09-05)에는 앱에서 사용할 수 있도록 개발용 Colima VM을 실행 상태로 남겼다.

앱 산출물은 `src-tauri/target/release/bundle/macos/Docker2U.app`이다.
로컬 빌드 산출물이며 배포용 서명·notarization 또는 clean-machine 설치 검증은
포함하지 않는다.

## 로컬 Runtime 설정

앱은 셸 작업 디렉터리와 별개로 다음 native 설정 파일을 읽는다.

`~/Library/Application Support/io.github.jgoneit.docker2u/runtime.json`

현재 적용하는 키는 이미 준비한 Docker CLI 절대경로인 `dockerPath`뿐이다.
설정이 없으면 앱 프로세스의 PATH와 알려진 설치 후보 경로를 탐색한다.
이전 `colimaPath`, `colimaHome`, `limaHome`, `dockerConfig`는 읽어도 무시하고
`runtime.json`을 자동 수정하지 않는다. 특히 이전 private `dockerConfig`는
사용자의 Docker CLI 선택을 덮어쓰지 않는다. WebView에서 이 경로나 raw Docker
인자를 전달하는 IPC는 제공하지 않는다.

Docker config 경로는 앱이 상속한 `DOCKER_CONFIG` 또는 기본 `$HOME/.docker`다.
선택된 CLI가 이 설정과 앱 환경을 해석하며, 앱은 Docker 환경변수 우선순위를
별도 구현하지 않는다. 명령에 context 인자를 넣지 않고 반환된 이름과 endpoint를
같은 discovery 결과에서 가져온다.

Finder 실행은 interactive shell의 PATH·환경과 다를 수 있다. 실행 후 별도
터미널에서 `export DOCKER_HOST=…` 등을 해도 이미 실행 중인 앱에는 반영되지 않는다.
환경변수 변경은 앱의 실행 환경에 설정하고 다시 시작한다. `docker context use`로
Docker 설정의 선택을 바꿨다면 앱의 Reconnect에서 반영한다. 진단에 표시된
context·config 경로·endpoint를 기준으로 연결 대상을 확인한다.

2026-09-05에는 별도 `../.docker2u-tools` 도구와 private config를 사용하고
Colima `docker2u`를 ARM64·VZ·CPU 2개·메모리 4 GiB·`autoActivate: false`로
준비했다. 이는 위 과거 검증의 환경 설명이며 현재 앱의 준비 조건이 아니다.

## 재현 명령

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm rust:fmt
pnpm rust:test
pnpm native:build
pnpm native:dev
```

아래 명령 이름은 기존 opt-in 실환경 검사 진입점이다. 변경을 일으키는 smoke는
현재 연결 정책 변경의 기본 검증에 포함하지 않는다. 별도로 승인된 개발용 Engine과
테스트 대상에서만 실행하고 해당 실행이 만든 정확한 대상만 정리한다.
제품 IPC에는 생성·삭제 기능이 없다.

```sh
DOCKER2U_REAL_SMOKE=1 node scripts/with-toolchain.mjs cargo test --manifest-path src-tauri/Cargo.toml --locked real_runtime_smoke -- --ignored --nocapture
DOCKER2U_REAL_PROBE=1 node scripts/with-toolchain.mjs cargo test --manifest-path src-tauri/Cargo.toml --locked real_environment_probe -- --ignored --nocapture
```

## 지속적 통합

`.github/workflows/ci.yml`은 `main` 대상 PR, `main` push와 수동 실행을 지원한다.
동일 PR의 새 실행이 시작되면 이전 실행을 취소하며, Actions 권한은 `contents: read`로
제한한다. 외부 Action은 전체 commit SHA로 고정한다.

- `Frontend checks`: Ubuntu에서 고정 pnpm·frozen lockfile 설치, React/IPC 테스트,
  TypeScript strict 검사와 frontend build를 실행한다.
- `macOS ARM64 build`: macOS 15 ARM64 runner에서 architecture·Python·Xcode와
  `rust-toolchain.toml`을 확인하고 frontend 생성, Rust format·기본 테스트,
  Cargo `--locked` 앱 빌드를 실행한다. 초기 checkout에 없는 `dist`와 아이콘은
  Rust 컴파일 전에 생성한다.
- Node는 26.5.1, pnpm은 `package.json`, Rust는 `rust-toolchain.toml`의 버전을 사용한다.
  pnpm store와 Cargo 의존성·target을 캐시하며 lockfile 변경 여부를 검사한다.
- 빌드 성공 시 ARM64 실행 파일을 확인하고 `.app`을 `ditto` ZIP으로 묶어 파일 권한과
  bundle 구조를 보존한다. 서명하지 않은 ZIP과 SHA-256 checksum은 해당 실행의
  artifact로 7일간 보관하며 release로 게시하지 않는다.

CI에는 개발 장비의 도구 디렉터리·native runtime 설정·Colima VM·서명 credential이
필요하지 않다. 실제 Engine opt-in 검사는 기본 실행의 ignored 상태를 유지한다.
CI의 macOS 빌드·fake CLI 검사 성공은 실제 Engine 연결, Finder GUI, 서명 배포 또는
macOS 지원 범위 확대의 증거가 아니다. 각 원격 실행 결과는 PR의 checks와 Actions에서
확인하며, workflow 추가 자체를 검사 통과로 기록하지 않는다.

## PR #1 리뷰 회귀 검사

2026-09-05의 정확한 Host 버전·Colima 고정 정책에 대한 과거 검사 기록이다.
현재의 macOS 14+·CLI 선택 연결 정책에 대한 재검증과 구분한다.

- React/IPC 테스트 44건과 TypeScript strict 검사를 통과했다. Refresh 중 목록 유지와
  재연결 차단, 렌더링 전 연속 클릭, 성공·일반 오류·timeout 후 재연결을 검사한다.
- Rust 기본 검사 27건을 통과했다(실제 Colima 검사 2건은 기본 실행에서 ignored).
  Fixture의 inspect를 명시적으로 대기·해제하여 `Busy` 시 세션 보존과 성공·실패 후
  재연결을 검사한다. 승인 Host, 다른 OS·버전·architecture, 탐지 실패·잘못된 출력과
  이전 세션 조작 거절도 포함한다.
- Fake Fixture에서만 Host 결과를 주입한다. 실제 버전 파서·허용 정책은 같은 코드로
  검사하며 `Core::default()`와 두 실제 Colima 검사는 native Host 탐지를 수행한다.
- 현재 macOS `26.5.2`에서 읽기 전용 `real_environment_probe`를 별도로 통과했다.
  실제 Host 검사 후 `ready`, `mutationAllowed=true`, 기존 Colima의 빈 목록과
  generation 1을 확인했다. 이번 리뷰 수정에서는 실제 Container 조작을 재실행하지 않았다.
- `pnpm native:build --ci --no-sign -- --locked`로 TypeScript/frontend 및 unsigned
  ARM64 앱 빌드를 통과했다. 앞선 Finder GUI 검증은 초기 알파 기록이며 이번 변경의
  GUI 수동 재검증으로 간주하지 않는다.

## 다중 복구 변경 검증

2026-09-05 다중 복구 변경에서 실제 실행한 범위만 기록한다. 아래 체크리스트는
전체 접근이 적용된 새 작업에서 수행한 재검증 결과다. 기존 단건 실환경 기록 및
앞선 권한 오류 이력과 구분한다.
이때의 고정 Colima 연결·GUI 결과를 2026-09-06 CLI 선택 연결 변경의 증거로 사용하지 않는다.

- [x] UI: 개별 체크·전체 선택·부분 선택, 검색·필터 변경과 Refresh·Reconnect 후
  체크 해제, 단일 상세 선택 보존, 상태별 실행 가능 개수와 버튼 정책.
- [x] UI: Stop·Restart의 단일 확인창에 대상·실행·제외 개수·연결 환경 표시,
  취소 시 호출 없음, 키보드와 focus 이동·복원, 대상별 결과와 전체 종료 후 한 번 Refresh.
- [x] Core/IPC: 모든 handle·session·generation 사전 검증과 full ID 고정,
  최초 적격 대상 유지, 순차 실행, 단건·다중 공통 lock 및 중복 실행·Refresh·Reconnect 차단.
- [x] Core: 상태 변경 대상 건너뜀, 확정 실패 후 상태 확인에 따른 계속 실행,
  결과 불명·Engine 교체·연결 단절·재조회 실패 후 남은 대상 미실행, 자동 재시도 없음.
- [x] React/IPC 회귀 검사 66건, TypeScript 검사와 frontend build.
- [x] Rust format 검사.
- [x] Rust 회귀 검사와 native build.
- [x] 실제 Colima의 명시적 테스트 대상만 사용한 다중 Start·Stop·Restart.
- [x] 재빌드한 네이티브 앱에서 선택·확인창·대상별 결과 수동 확인.

### 새 작업의 재검증 결과

- `pnpm test`: 3개 파일, 66건 통과. 기본 `pnpm build`도 TypeScript 검사와
  기존 출력 정리를 포함해 통과했다. 출력 보존 옵션을 사용하지 않았다.
- 중첩 복사본에서는 toolchain wrapper의 상대경로가 준비한 Rust를 찾지 못해
  최초 Rust 명령이 `cargo ENOENT`로 끝났다. 기존 개발용 toolchain의
  `CARGO_HOME`, `RUSTUP_HOME`, `PATH`를 프로세스 환경에 지정한 뒤
  `pnpm rust:fmt`, `pnpm rust:test`, `pnpm native:build`를 통과했다.
  도구 설치, 제품 소스·lockfile·runtime 설정 변경은 없었다.
- Rust 기본 검사: 37건 통과, 실패 0건, opt-in 3건 ignored. 새 fake CLI 일괄
  검사 10건을 포함한다. native bundle은 Mach-O arm64로 확인했다.
- `real_environment_probe`: 1건 통과. macOS 26.5.2 / arm64에서 기존
  `colima-docker2u`와 Engine ID `0d0a908d-e177-49ff-8b87-2ace961b117a`,
  `ready`, `mutationAllowed=true`, 초기 빈 목록을 확인했다.
- `real_bulk_runtime_smoke`: 1건 통과. 고유 label의 컨테이너 3개로 혼합 상태
  Start `[skipped, succeeded, succeeded]`, Restart·Stop·Start 각 3건 성공,
  목록 generation 3→6을 확인했다. 정확한 소유 대상 정리와 후속 목록 조회 후
  전체 컨테이너 및 bulk-smoke label의 잔류 대상은 각각 0개였다.
- 재빌드한 `.app`을 Computer Use로 직접 열었다. 실행 프로세스 경로가 이번
  독립 복사본의 release bundle임을 확인했으며 실제 `tauri://localhost`
  WKWebView를 조작했다. 개별·전체·부분 선택, 행 상세와 체크의 독립성,
  방향키·Enter 상세 조회, Tab·Space 체크, 검색·필터·Refresh·Reconnect 후
  체크 해제 및 혼합 상태 작업 개수·제외 사유를 확인했다.
- 실제 Stop·Restart 확인창의 이름·full ID·대상/제외 개수·고정 endpoint,
  초기 취소 focus, Stop의 Tab·Shift+Tab 순환과 Escape 후 focus 복원,
  Restart 취소 후 원래 버튼 focus 복원을 확인했다.
- GUI 전용 label을 붙인 4개 중 이름 검색에 보이는 3개만 전체 선택했다.
  Start 결과는 성공 2개·제외 1개, Restart와 Stop은 각각 성공 3개였다.
  Restart·Stop 실행 중 검색·필터·체크·단건/일괄 버튼·Refresh·Reconnect의
  비활성화와 처리 중 표시를 관찰했다. 완료 후 체크 해제, full ID별 결과,
  상세 변경·Refresh 후 결과 보존, 상세 스크롤 중 전역 제어 유지도 확인했다.
- Docker CLI의 고정 `--host`로 Restart 후 3개 Running, Stop 후 3개 exited를
  별도로 대조했다. 검색에 숨긴 1개는 상태와 StartedAt·FinishedAt가 초기값과
  동일했다. GUI fixture 4개도 정확한 이름·full ID·고유 label을 대조해 정리했고,
  앱 Refresh에서 빈 목록과 이전 일괄 결과의 보존을 확인했다.
- 원시 명령 로그, fixture 상태, 재현 명령은 원본 저장소의
  `.cache/bulk-verification-01a071bc/`에 보관했다. 제품 코드와 기존 staged
  변경은 보존하며 검증 문서만 갱신한다.

이번 실환경 GUI 검사는 정상·제외 경로를 확인했다. 실패·결과 불명·Engine 변경·
응답 유실은 자동 검사로 검증했으며 실제 Engine 장애를 주입한 GUI 검사는 하지
않았다. 의존성의 새 설치, 최소 1024×680 창 resize, 배포용 서명·notarization,
Windows·다른 Host 검증은 이번 다중 복구 검증 범위에 포함하지 않는다.

### 앞선 시도의 검증 방법과 당시 제한

- React/IPC 전체 검사는 `pnpm test`로 3개 파일의 66건을 통과했다. 새 일괄 작업의
  응답 유실, 잘못된 대상·generation·결과 필드도 검사한다.
- TypeScript 검사를 통과했다. 기본 `pnpm build`는 기존 `dist/assets` 삭제에서
  `Operation not permitted`로 중단됐다. `pnpm exec vite build --emptyOutDir false`로
  기존 출력을 삭제하지 않는 frontend build를 통과했다. 이는 기본 build 검사 통과와
  구분하며, 생성물에 이전 파일이 남을 수 있다.
- 독립 작업 복사본에서 기존 의존성 캐시를 사용했다. pnpm의 자동 재설치는
  `node_modules` 하위 디렉터리 삭제 권한 때문에 실행할 수 없어,
  `pnpm_config_verify_deps_before_run=warn`으로 자동 설치를 막았다.
  package manifest·lockfile은 변경하지 않았다. 새 의존성 설치 검증은 하지 못했다.
- Rust에는 fake CLI 기반 일괄 검사 10건과 opt-in 실제 검사 1건을 추가했다.
  `cargo test --lib --locked`는 애플리케이션 컴파일 전에 의존성의 `.temp-archive`
  디렉터리 삭제 권한 오류로 중단됐다. Rust format·정적 리뷰를 실행했지만
  Rust 타입 검사·테스트 통과의 근거로 사용하지 않는다.
- native build와 실제 Colima 일괄 검사는 위 컴파일 제한으로 실행하지 않았다.
  실제 GUI는 Computer Use의 Docker2U 접근이 승인되지 않아 확인하지 못했다.
  이 변경으로 새 native 앱을 빌드하거나 화면 동작을 검증했다고 해석하면 안 된다.
- Rust 검증이 가능한 환경에서는 기본 회귀 검사 후
  `DOCKER2U_REAL_BULK_SMOKE=1 node scripts/with-toolchain.mjs cargo test --manifest-path src-tauri/Cargo.toml --locked real_bulk_runtime_smoke -- --ignored --nocapture`를
  실행한다. 고유 라벨을 붙인 테스트 Container 3개만 조작·정리하며, 마지막 성공한
  목록 조회로 해당 full ID가 남지 않았는지 확인한다.

권한 변경 후 검증 재개(2026-09-05):

- writable root가 `/`로 표시된 주 실행 명령에서도 `cargo test --locked`가
  의존성 임시 디렉터리 삭제의 `Operation not permitted`로 중단됐다.
  애플리케이션 컴파일 전 실패이며 이번 실행의 테스트 수는 0건이다.
- 주 실행 명령이 직접 만든 임시 디렉터리의 삭제도 같은 오류로 거절됐다.
  소스의 파일 권한 변경이나 다른 실행 도구로 이 제한을 우회하지 않았다.
- Offline frozen 의존성 설치는 완료되지 않아 중단했다. 기본 frontend/native
  build와 실제 Colima 검사는 이번 재개에서도 완료하지 못했다.
  앞선 UI/IPC 66건 통과 기록은 이번 재실행 결과와 구분한다.
- Docker2U의 Computer Use 접근이 다시 승인되지 않아 GUI 검사를 수행하지 않았다.
- 실제 검사 준비 코드에서 `create`가 Engine에 전달된 뒤 응답이 유실되면
  cleanup 목록에 full ID가 등록되지 않는 경로를 발견했다. 생성 전에 고유 이름을
  기록하고, 실패 시 고정 Engine에서 해당 실행의 정확한 라벨과 이름으로 ID를
  회수한 뒤 기존 라벨 검증을 거쳐 정리하도록 보완했다. 조회 자체가 실패하면
  정리 미확정을 출력하고 이미 알고 있는 ID의 정리는 계속 시도한다.
  이 보완은 Rust format과 독립 정적 검토만 수행했으며 컴파일·실환경은 미검증이다.
- 기존 Seal Task는 정확한 ID로 조회했다. 이전 Evidence 게시 실패는 미확정으로
  보존했으며, 실행 제한이 남아 있는 이번 재개에서는 verify/complete를 반복하지 않았다.

## 이전 중단과 재개

이전 작업에서는 `workspace-write` 실행 환경에서 Rust의 임시 디렉터리 제거가
`Operation not permitted`로 실패했고, Colima는 VZ 초기화와 network 파일 정리
오류로 중단됐다. 당시 기능 구현과 native/runtime 검증은 수행하지 못했다.

초기 재개 작업은 전체 접근 실행 환경에서 같은 의존성·Rust target·Colima
프로파일을 재사용했고 Seal·Ward 설정이나 lifecycle 작업은 수행하지 않았다.
이후 Seal 사용 결정은 위 PR 리뷰 수정 범위에 별도로 기록한다.
이전 중단 기록을 현재의 검증 성공으로 취급하지 않는다.

Windows 실환경, Apple Developer ID 서명, notarization·stapling, DMG,
clean-machine 설치와 외부 Pilot은 후속 단계다.

## 2026-09-06 Docker CLI 연결 전환 검증

이번 변경은 기존 다중 선택 구현을 보존한 별도 `codex/docker-cli-context` 작업공간에서
검증했다. 실행 환경은 macOS 26.6.2 / ARM64이며, native `dockerPath`의 Docker CLI
29.8.0이 사용자 `~/.docker`의 `desktop-linux`를 선택했다. Docker Desktop Engine은
29.7.2 / API 1.55, Linux aarch64였다. 이는 macOS 14+ 전체 조합의 실검증을 의미하지 않는다.

| 검사 | 이번 변경 결과 |
| --- | --- |
| Frontend / IPC | 3개 파일, 91개 테스트 통과 |
| Rust 포맷 및 전체 테스트 | 포맷 통과, 50개 통과, opt-in 실환경 3개는 기본 실행에서 ignored |
| Frontend / native build | TypeScript·Vite 통과, ARM64 `.app` 생성 |
| 실제 환경 probe | 별도 실행 1개 통과, CLI와 Core의 전체 container full ID 집합 일치 |
| 실제 단건 smoke | 별도 실행 1개 통과, 목록·Health·최근 로그·Start·Stop·Restart 및 정확한 ID 정리 |
| 실제 일괄 smoke | 별도 실행 1개 통과, 혼합 Start의 skipped와 순차 Restart·Stop·Start 및 정리 |
| 실제 native GUI | 새 빌드 경로의 `tauri://localhost`에서 소켓 없음 안내, Reconnect, Desktop 연결·목록 4개·진단 정보 확인 |
| 원본과 환경 보존 | 원본 42개 파일·index·unstaged diff 보존, native/Docker 설정 해시·mode 유지, 기존 컨테이너 4개의 ID·이름·상태·StartedAt·FinishedAt 유지 |

새 자동 회귀 검사는 discovery 입력 전달과 실행 환경 차단, context A→B 전환과
기존 session 고정, 잘못된 설정·소켓, CLI/Engine 변경을 포함한다. Refresh 또는
로그 검증에서 연결 이상을 감지한 경우 소켓 복구와 성공한 Refresh만으로 조작을
다시 허용하지 않고 Reconnect까지 차단하는 Core/UI 경로도 검사했다.

중첩 작업공간에서는 기존 `CARGO_HOME`·`RUSTUP_HOME`·PATH를 명시했다.
기존 node_modules를 재사용하면서 pnpm의 경로 metadata 자동 재설치를 피하려고
`pnpm_config_verify_deps_before_run=false`를 사용했다. 새 의존성 설치는 하지 않았다.

처음에는 Desktop 소켓이 없었고, 이후 소켓과 Engine이 응답하는 것을 확인한 뒤
실환경 검사를 진행했다. Agent가 Docker Desktop이나 Colima를 시작하지 않았다.
검증용 컨테이너는 모두 제거됐으며 smoke에 사용한 `busybox:1.37.0` 이미지는 남을 수 있다.
실제 GUI 버튼을 통한 컨테이너 조작·장애 주입·서로 다른 Engine 사이 전환은 이번에
수행하지 않았다. 해당 동작은 자동 Core/IPC/UI 검사와 별도 실제 Core smoke의 증거로
구분한다. Colima는 미실행 상태여서 새 연결 정책의 Colima 실환경 검증은 미수행이다.
서명·notarization·외부 배포·커밋·push는 수행하지 않았다.

## 2026-09-06 로그 레이아웃·테마·언어 개선 검증

기준은 `1eeed94ebe9ea953fe207fe195726b877c023a07`이며 별도 `codex/ui-appearance`
체크아웃에서 작업했다. 원본과 다른 미완료 체크아웃은 수정하지 않았다.

### 변경 동작

- 로그 최소 높이를 260px / 높이 800px 이상 320px로 늘리고 남는 공간을 사용한다.
  왼쪽 목록은 280–360px 범위이며 작은 창에서는 상세 패널 스크롤로 하단에 접근한다.
- 로그 확대창은 조회·복사·비우기와 스크롤·포커스 복원을 지원한다. 조회 중 비우기는
  늦게 도착하는 응답을 무시한다. 복사 결과는 확대창 안에서도 알린다.
- 설정에서 시스템·라이트·다크와 한국어·영어를 즉시 적용한다.
  `docker2u.preferences.v1`에는 테마·언어만 저장한다. 로그와 Docker 연결 상태는 저장하지 않는다.
- 모든 화면 색상을 의미별 토큰으로 정리하고 비활성 제어도 전용 색상을 사용한다.
  코드·컨테이너 ID·원문 로그·네이티브 진단 원문은 번역하지 않는다.

### 수행한 자동 검사

- 기존 App 회귀 97개를 유지했다. 한국어 액션과 필터의 동일 레이블은 해당 영역으로
  구분하여 검사하고, 접힌 원문·실행 상세는 열어서 기존 대상 정보 보존을 확인한다.
- 전체 Vitest 검사 167개 통과(8개 파일). 테마·언어 전환 중 조회·새로고침·조작의
  API 호출 횟수 및 상태 보존, 저장 실패, OS 테마 변경, 대화상자 포커스, 로그 확대·
  비우기·복사, 번역 사전 매개변수 일치, 실제 CSS 색상 조합의 대비를 포함한다.
- TypeScript 검사 통과. 초기 기본 `pnpm build`는 통과했다. 이후 기본 빌드는 기존
  `dist/assets` 삭제가 `Operation not permitted`로 거절됐다.
- 변경을 반영한 프런트엔드는 새 출력 경로를 지정한
  `pnpm build --outDir .cache/frontend-reviewed-20260906`에서 빌드했다. 새 출력 폴더 빌드와
  기존 `dist`를 정리해야 하는 기본 빌드의 결과를 동일하게 취급하지 않는다.
- 기존 잠금 파일과 연결된 의존성을 사용했다. pnpm 11의 자동 재설치·purge를 막기 위해
  `pnpm_config_verify_deps_before_run=warn`을 사용했으며, 새 의존성 설치 검증은 수행하지 않았다.

### 수행하지 못한 검증

- 기본 네이티브 빌드는 기존 프런트엔드 출력 삭제 단계에서 실패했다. 출력 경로만
  바꾼 임시 Tauri 설정으로 프런트엔드 빌드까지 진행했지만 `src-tauri/target` 생성이
  `Operation not permitted`로 거절됐다. 새 네이티브 앱과 Rust 실행 결과는 없다.
- Computer Use의 Docker2U 접근이 승인되지 않았다. 합성 데이터 페이지에 대한
  `http://127.0.0.1:1421` 접근도 브라우저 보안 정책에서 사용자의 권한 거절로 차단됐다.
  다른 브라우저·CDP·화면 캡처 수단으로 우회하지 않았다.
- 따라서 테마 × 언어 × 1280×800 / 1024×680의 8개 GUI 조합, 큰 창의 실제 배치,
  네이티브 OS 테마 전환과 재실행 복원, 첫 화면 테마 표시 및 CSP 동작은 미확인이다.
- 숫자로 계산한 CSS 대비와 jsdom 동작 검사는 실제 WebView 가독성·스크롤 배치의 증명이 아니다.
  Seal 결과 역시 이 기록의 GUI 증거를 대신하지 않으며 별도로 보고한다.

### 재개할 GUI 확인

개발 서버의 `/src/test/visual.html`은 실제 App 컴포넌트를 사용한다. `normal`,
`empty-logs`, `loading-logs`, `log-error`, `truncated`, `empty-inventory`,
`connection-error`, `failed-result`, `unknown-result` 시나리오를 선택할 수 있다.
`?scenario=normal&toolbar=hidden`은 도구 모음 없이 전체 화면 크기를 사용한다.
300줄 로그의 마지막 줄은 `LAST_LINE_300`으로 확인한다.

이 진입점은 DEV 조건에서만 렌더링하고 API 전체를 합성 응답으로 교체한다. 실제
Docker에 접근하지 않으며 배포 main에서 import하지 않는다. GUI 권한이 허용되면
테마·언어·크기 조합, 긴 이름·포트·로그, 마지막 줄, 확대/복귀, 설정 및 확인창의
글자·포커스·키보드 조작을 확인한다. 네이티브 앱은 빌드 가능한 환경에서 별도로
빌드한 뒤 연결·조회·로그·설정과 재실행 복원을 확인한다.

롤백은 이 UI 변경을 되돌리고 로컬 표시 설정을 사용하지 않는 이전 버전으로 복귀한다.
Docker IPC, Core 조작 정책, 기존 1280×800 / 1024×680 창 설정은 변경하지 않았다.

### 2026-09-06 전체 접근 권한으로 재개한 검증

위의 권한 제한 기록은 최초 구현 시점의 결과다. 같은 체크아웃과 기존 Seal Task를
이어받아 다음 항목을 다시 수행했다. 별도 설치나 잠금 파일 변경은 하지 않았다.

실제 브라우저 배치에서 300줄 로그가 본문 높이를 약 5,848px까지 늘리는 문제를 발견했다.
`.log-content`와 `.log-error`에 명시적인 `flex-basis: 0px`을 적용해 로그 내용의
고유 높이가 부모를 늘리지 않도록 수정했다. 최소 높이를 보장하면서 긴 로그는 본문
안에서 스크롤하고, 작은 창에서 부족한 공간은 상세 패널 스크롤로 접근한다.

#### 자동 검사와 최종 앱 빌드

- `pnpm test`: 8개 파일, 167개 통과.
- `pnpm build`: 기본 `dist` 정리를 포함한 TypeScript / Vite 빌드 통과.
- `pnpm rust:fmt`: 통과.
- `pnpm rust:test`: 50개 통과, 실제 Docker 접근 검사 3개 ignored.
- 스타일 수정 후 `pnpm test src/theme.test.ts`: 대비 관련 7개 통과.
- 스타일 수정 후 `pnpm native:build`: release arm64 앱 빌드 통과.
- `git diff --check`: 통과. 최종 `dist`에서 합성 데이터 표식
  `LAST_LINE_300`, `visual-fixture-local`, `fixture.invalid`, `SIMULATED ONLY` 미검출.

명령마다 `pnpm_config_verify_deps_before_run=warn`을 사용했다. 최초 native 명령은
Cargo가 PATH에 없어 실패했으며, 기존 도구체인 환경을 지정해 해결했다.

```sh
CARGO_HOME=/Users/jgoneit/project/.docker2u-tools/cargo \
RUSTUP_HOME=/Users/jgoneit/project/.docker2u-tools/rustup \
PATH=/Users/jgoneit/project/.docker2u-tools/cargo/bin:$PATH \
pnpm_config_verify_deps_before_run=warn pnpm native:build
```

최종 앱은 `src-tauri/target/release/bundle/macos/Docker2U.app`이며, 실행 파일
SHA-256은 `56095ecf1f0374d3785e3a7d7ad5b8b02fc890cece8f9889d1385da0def5d097`이다.

#### Computer Use: 합성 데이터 브라우저 화면

- 라이트/다크 × 한국어/영어 × 1280×800/1024×680의 8개 조합에서 배치와 가독성을 확인했다.
  긴 이름·이미지·포트·로그가 화면 너비를 넘지 않았다.
- 로그 본문 실측 높이는 1024×680에서 260px, 1280×800에서 320px,
  1600×1000에서 484px였다. 큰 창은 상세 패널 추가 스크롤 없이 남는 높이를 사용했다.
- 최소 창에서 상세 패널과 로그 본문을 스크롤하여 `LAST_LINE_300`이 실제로 보이는 것을 확인했다.
- 최소 창의 로그 스크롤 위치 5,626px에서 확대 후 스크롤하지 않고 Escape로 닫았을 때
  동일한 위치와 확대 버튼 포커스가 복원됐다. 확대창에서도 마지막 줄까지 접근했다.
- 확대창의 복사 완료 안내, 비우기 후 빈 화면, 다시 조회와 Escape 복귀를 확인했다.
  실제 클립보드 바이트 일치는 브라우저 GUI 증거에 포함하지 않는다.
- 빈 로그, 조회 중, 조회 오류, 잘림 안내 및 합성 실패 결과의 요약/접힌 상세를 확인했다.
- 영어 라이트 중지 확인창과 한국어 다크 재시작 확인창의 문구·대상·취소 포커스를 확인했다.
- 설정의 Tab 순환과 닫은 뒤 포커스 복원, 페이지 재로딩 후 테마·언어 유지를 확인했다.

#### Computer Use: 최종 네이티브 앱

빌드한 정확한 `.app`을 실행하고 프로세스 경로도 확인했다. 실제 Docker 연결과
컨테이너 4개의 목록, 빈 로그와 PostgreSQL 로그 조회, 새로고침, 로그 확대/복귀가
동작했다. 라이트/영어로 바꿔도 선택한 컨테이너와 로그가 보존됐다. 앱 종료 후 다시
실행했을 때 Settings에 Light/English가 선택된 것을 확인했다. 검증 후 최초의
시스템 테마/한국어 설정으로 복원했다.

실제 컨테이너의 시작·중지·재시작은 수행하지 않았다. 해당 경로는 기존 자동 테스트로
검증했다. 8개 크기/테마/언어 조합은 브라우저 합성 데이터 결과이며 네이티브 8개 조합을
별도로 반복한 결과는 아니다. OS 자체의 테마를 실행 중 바꾸는 검사와 첫 페인트의
프레임 단위 깜박임 측정은 수행하지 않았다. 시스템 테마 변경 이벤트는 단위 테스트로 확인했다.
Seal Acceptance는 위 GUI·빌드 증거와 별도로 CLI의 정확한 Run ID를 사용해 처리한다.

### 2026-09-06 조작 명확성·로그 탐색·화면 회귀 개선

앞선 외관 구현의 미커밋 변경을 보존하고 같은 `codex/ui-appearance` 체크아웃에서
이어서 구현했다. 기존 Seal Task/Run은 보존했다. 확장된 범위는 새 Basic Task
`docker2u-ui-usability-20260906`에 등록했으며 CLI/Plugin은 `0.3.0-rc.4`로 일치했다.
위험은 medium, verifier.required는 false, 필수 검사는 기존 frontend-tests와
frontend-build다. 브라우저 검사·네이티브 빌드·실제 앱 검증은 별도 완료 조건이다.

#### 변경과 검증 중 발견한 오류

- 연결 재확인 경고를 읽기 전용 조작 차단과 분리했다. 경고는 성공한 목록·로그
  조회로 지워지지 않으며 유효한 세션을 얻은 명시적 재연결에서만 해제된다.
  상단/하단의 연결 상태는 동일하고 복사 안내는 별도 영역에 표시한다.
- 공통 검색 조건에 전체 ID를 포함했다. 검색·필터·새 목록으로 보이지 않게 된
  상세 선택은 로그·확대와 함께 해제하고 이전 로그 응답을 무효화한다. 검색을
  지우거나 다시 새로고침해도 자동 선택하지 않으며 새 연결의 최초 목록에서만
  첫 번째 보이는 항목을 선택한다. 검색/필터 포커스와 실행 직전 대상 일치를 검사한다.
- 프런트엔드 LogSnapshot에 응답 수락 시각을 추가했다. 로그 원문을 유지하는
  대소문자 무시 일반 문자열 검색, 현재 한 곳 강조, 이전/다음·Enter/Shift+Enter,
  검색 지우기·맨 아래로 이동을 인라인과 확대에 제공한다. 복사는 원문 전체다.
- 단일/일괄 결과는 상세 선택 밖의 최근 결과 한 개로 통합했다. 확정 결과는
  요약과 펼치기 버튼을 제공하며 불확실·재연결 필요 안내는 항상 표시한다.
  재연결 뒤에도 과거 결과를 성공으로 바꾸지 않고 과거 작업 시점의 안내로 표현한다.
- 조작·상태·안내·기술 상세의 글자는 최소 12px로 조정하고 검색 강조색을
  테마별 대비 검사에 포함했다.
- Chromium 검사에서 접힌 진단 상세 안의 포커스 가능한 pre가 확대창의 Tab 순환을
  막는 오류를 발견했다. 닫힌 details의 숨겨진 내용을 순환 대상에서 제외했다.
- 실제 WKWebView에서 버튼 클릭 후 문서로 포커스가 빠지면 Escape가 확대창을 닫지
  못하는 경우를 발견했다. 확대 중 문서 포커스의 Escape/Tab도 처리하도록 보강했다.

#### 최종 자동 검사

- `pnpm test`: 10개 파일, 198개 통과. 연결 경고·읽기 전용·선택/응답 경합·전체 ID,
  로그 조회 완료 시각·검색 이동/초기화·원문 복사·최신 결과 유지·키보드 회귀 포함.
- `pnpm build`: TypeScript/Vite와 배포 합성 데이터 격리 검사 통과.
- `pnpm test:browser`: Chromium 45개 통과 (39.4초, 로컬 retry 없음).
  라이트/다크 × 한국어/영어 × 1024×680/1280×800 8개 조합과 1600×1000을 검사했다.
- 로그 본문 높이는 최소 창 260px, 기본 창 320px, 큰 창 423px였다. 가로 넘침,
  큰 창의 높이 증가, 12px 글자, 결과 제어 접근성, 확대/복귀 포커스를 검사했다.
- 마지막 로그 줄·검색된 문자열·긴 오류/표준오류 끝줄은 DOM Range 좌표와 모든
  스크롤 조상/뷰포트의 교집합 안에 들어오는지 검사했다. 픽셀 스냅샷 비교는 없다.
- 테마·언어·로그 검색·맨 아래로·확대 전환에 추가 Docker API 호출이 없음을 검사했다.
- Playwright는 `@playwright/test` 1.63.0으로 고정했다. 전용 webServer는
  `127.0.0.1:1422` strict port/reuseExistingServer=false이며 시작·종료는 Playwright가
  관리한다. 개발 합성 화면만 사용하고 외부 요청은 브라우저 검사에서 거부한다.
- 이 체크아웃의 node_modules 심볼릭 링크만 해제하고 독립 설치했다. 형제 체크아웃의
  원래 의존성 폴더는 보존했다. pnpm-lock.yaml 변경은 Playwright 의존성 추가다.
- Ubuntu 프런트엔드 CI에 Chromium 설치/검사와 실패 시 screenshot/trace/report
  보존을 추가했다. push/PR 범위가 아니므로 GitHub의 Ubuntu 실행 자체는 수행하지 않았다.
- 배포 dist에서 `LAST_LINE_300`, `visual-fixture-local`, `fixture.invalid`,
  `SIMULATED ONLY`를 자동으로 검사하여 미검출을 확인했다.

브라우저 보고서는 로컬 `playwright-report/index.html`에 있다. 실패 진단과 보고서는
Git에서 제외하며 CI 보존 기간은 7일이다. Docker IPC와 Rust 소스 변경은 없다.

#### 최종 네이티브 앱과 Computer Use

- 마지막 키보드 수정 후 `pnpm native:build`가 arm64 release 앱을 생성했다.
  위에 기록한 CARGO_HOME/RUSTUP_HOME/PATH의 기존 도구체인을 사용했다.
- 최종 앱 경로는 `src-tauri/target/release/bundle/macos/Docker2U.app`이다.
  실행 중인 프로세스도 이 경로임을 확인했다. 실행 파일 SHA-256:
  `f8c62e92ad8b5d98a5007c2f8cae72703868072e67b7bc6b86d0a8f5fec7ba4b`.
- 실제 로컬 Docker 연결과 4개 컨테이너 목록, PostgreSQL 로그 수락 시각을 확인했다.
  `database` 검색에서 20건과 Enter로 두 번째 일치 이동을 확인했다.
- Light/English 설정은 앱 종료·재실행 뒤에도 복원됐다. 테마/언어 전환 시 선택과
  검색어/현재 일치가 유지됐다. 검증 후 원래 시스템 테마/한국어와 기본 창 크기로 복원했다.
- 네이티브 창을 최소 1024×680으로 줄여 검색·선택 해제, 로그 탐색 제어, 강조된
  문자열, 확대·맨 아래로 이동과 마지막 줄 표시를 확인했다.
- 확대창에서 맨 아래로 버튼을 클릭해 포커스가 문서로 이동한 상태에서도 Escape로
  닫히고 확대 버튼에 포커스가 복원되는 것을 최종 빌드에서 재확인했다.
- 실제 컨테이너의 시작·중지·재시작은 실행하지 않았다. 해당 버튼을 사용하는
  브라우저 회귀 검사는 합성 API만 사용한다. 실제 클립보드 바이트 비교는 수행하지
  않았으며 전체 원문 복사 호출은 Vitest로 검증했다.
- `git diff --check` 통과, `src/api.ts`/`src-tauri` diff 없음, Playwright 종료 후
  1422 포트 리스너가 남지 않음을 확인했다. 커밋·push·PR·merge는 수행하지 않았다.

Rust 단위 검사는 이번 UI 후속 변경에서 재실행하지 않았다. 앞선 50개 통과 기록은
이전 검증 시점의 결과이며 이번 네이티브 빌드 결과와 구분한다. OS 테마 자체 전환과
첫 페인트의 프레임 단위 깜박임은 이번 실제 앱 검증에 포함하지 않았다.
Seal Evidence/Completion은 이 최종 문서와 소스에서 CLI로 수행하며 별도 보고한다.

### 2026-09-06 검색 접근성·로그 공간·작업 버튼 후속 개선

앞선 미커밋 변경과 완료된 Task/Run을 보존하고 같은 체크아웃에서 이어서 구현했다.
CLI `0.3.0-rc.4`와 설치 Plugin의 같은 공개 버전을 대조한 뒤 새 Basic Task
`docker2u-ui-search-layout-20260906`을 생성했다. 누적 UI·테스트·CI·의존성·문서를
Scope에 포함했으며 risk=medium, verifier.required=false, 필수 검사는 기존
frontend-tests/frontend-build다. 브라우저·네이티브 검증은 별도 완료 조건이다.

#### 변경 내용

- 컨테이너 검색 입력의 X는 검색어만 초기화한다. 필터와 입력 포커스를 유지하고
  이미 해제된 상세 선택을 자동 복원하지 않는다.
- 로그 검색줄은 처음에는 닫혀 있다. 돋보기 또는 macOS ⌘F/Windows Ctrl+F로 열어
  입력 전체를 선택한다. 설정·확인창이 열려 있거나 로그 패널이 없으면 처리하지 않는다.
  검색줄을 닫으면 강조만 숨기며 다시 열면 검색어와 현재 일치를 복원한다.
- 인라인 Escape는 검색줄을 닫고 돋보기로 포커스를 돌린다. 확대 Escape는 확대창을
  닫고 확대 버튼에 포커스를 복원한다. 검색 입력 안의 X는 검색어만 지운다.
  컨테이너 변경·선택 해제·로그 비우기는 검색 상태와 열림 상태를 초기화한다.
- 맨 아래로는 항상 기본 도구 모음에 둔다. 로그 제목·조회 시각·제한 안내를 짧은 행으로
  구성하고 상세의 중복 제목과 여백을 줄였다. 본문 글자는 12px/줄 간격 1.6이다.
- 고정 최소 높이를 제거하고 상세와 로그가 창 안에서 줄어드는 flex 구조를 적용했다.
  긴 이름·포트·최근 결과는 최대 40% 상단 정보 영역에서 스크롤한다. 복구 버튼과
  로그 하단은 유지하며 검색줄을 열면 약 40px만큼 로그 본문만 줄어든다.
- 검증 중 긴 정보와 환경 진단을 함께 열면 로그에 텍스트 공간이 남지 않는 경우를
  발견했다. 진단을 최대 20vh/160px로 제한하고 진단이 열렸을 때 상단 정보는 최대
  25%로 줄였다. 결과 불명·재연결 경고는 해당 정보 영역 안에서 계속 접근할 수 있다.
- 시작·중지·재시작은 초록·빨강·주황 채움형으로 단일·일괄·확인창에 적용했다.
  취소와 비활성 버튼은 중립색이며 보조 도구의 테두리·hover를 강화했다.

#### 자동 검사

- `pnpm test`: 10개 파일, 212개 통과(14.15초). 검색 X·필터·포커스, OS 단축키,
  대화상자 충돌 방지, 검색 열기/닫기/복원, Escape 우선순위를 추가했다. 표시 조작의
  추가 Docker API 호출 없음과 원문 전체 복사 검사를 유지했다.
- `pnpm build`: TypeScript/Vite와 배포 합성 데이터 격리 검사 통과.
  네이티브 빌드의 beforeBuildCommand에서도 같은 명령이 통과했다.
- `pnpm test:browser`: Chromium 81개 통과(36.5초, 로컬 retry 없음).
  기존 9개 크기·테마·언어 조합 각각에 9개 시나리오를 적용했다.
- 클릭·포커스·자동 스크롤 전에 본문 전체가 상세 영역/뷰포트/푸터 사이에 들어오는지
  좌표로 검사했다. 검색·결과 펼침·긴 메타데이터·진단·크기 변경 후에도 로그 하단,
  상세 바깥 scrollTop=0, 문서 scrollTop=0을 확인했다.
- 검색을 연 정상 화면의 본문 높이와 읽을 수 있는 줄 수:

  | 창 크기 | 한국어 | 영어 |
  | --- | --- | --- |
  | 1024×680 | 172px / 7.71줄 | 152px / 6.67줄 |
  | 1280×800 | 296px / 14.17줄 | 303px / 14.53줄 |
  | 1600×1000 | 별도 조합 없음 | 503px / 24.95줄 |

  줄 수는 본문의 위·아래 padding을 제외하고 줄 간격으로 나눈 값이다. 라이트/다크는
  같은 배치를 사용한다. 긴 정보와 진단까지 연 최소 창에서도 2.66–2.92줄이 남았다.
- 현재 일치·마지막 줄의 DOM Range 좌표, 검색 상태와 확대 포커스, 실제 계산된
  단일/일괄/확인 버튼 색상·hover·중립 비활성·취소·키보드 포커스를 검사했다.
  테마 토큰의 글자 4.5:1, 주요 경계·포커스 3:1 대비 검사도 통과했다.
- 브라우저 보고서는 `playwright-report/index.html`이다. 서버는 Playwright가 관리하며
  종료 후 1422 포트 리스너가 남지 않았다. 배포 합성 데이터 표식은 미검출이었다.

#### 최종 macOS 앱과 Computer Use

- `pnpm native:build`로 arm64 release 앱을 생성했다. 앱 경로는
  `src-tauri/target/release/bundle/macos/Docker2U.app`이며 실행 중인 프로세스의 정확한
  경로를 확인했다. 실행 파일 SHA-256:
  `a98680c1863c6f5befb2bbc7677807e19c0fee81d3164961eafbca167041f65d`.
- 최종 앱에서 로컬 Docker 연결·컨테이너 4개와 PostgreSQL 로그를 조회했다.
  ⌘F로 검색 입력에 포커스, `database` 20건 중 Enter로 두 번째 이동을 확인했다.
  인라인 Escape로 닫은 뒤 돋보기로 열었을 때 두 번째 일치와 선택된 입력이 복원됐다.
- 확대 후 ⌘F가 확대 검색을 대상으로 했고 Escape로 확대창이 닫히며 확대 버튼에
  포커스가 돌아왔다. 검색어와 현재 일치는 유지됐다. 설정창에서는 ⌘F가 배경 검색을
  열거나 포커스를 빼앗지 않았다.
- 최소 1024×680에서 열린 검색줄·로그 본문 하단·푸터가 보이는 것을 확인했다.
  입력 안 X는 검색줄을 유지한 채 검색어만 지우고 입력 포커스를 유지했다.
  맨 아래로 이동한 뒤 마지막 로그 줄이 실제 표시 영역 안에 보였다.
- 컨테이너 검색으로 선택을 해제한 뒤 X를 누르면 검색창 포커스와 실행 중 필터가
  유지됐으며 상세는 자동 선택되지 않았다. 다시 대상을 선택하면 로그 검색은 초기화됐다.
- 실제 화면에서 중지/재시작의 빨강/주황과 비활성 시작의 중립색을 확인했다.
  라이트·영어로 바꿔도 검색어와 두 번째 일치를 유지했다. 종료·재실행 후 Light/English
  저장값을 확인하고 시스템 테마/한국어로 복원했다. 최종 앱은 기본 크기로 실행 중이다.

실제 컨테이너 시작·중지·재시작은 수행하지 않았다. 색상 검사의 활성 시작과 확인창은
합성 브라우저 데이터로 검증했다. Windows Ctrl+F는 자동 검사 결과이며 실제 Windows
앱은 실행하지 않았다. GitHub Ubuntu CI는 push/PR 범위가 아니므로 실행하지 않았다.
실제 클립보드 바이트 비교와 Rust 단위 검사는 재실행하지 않았으며, 원문 복사 자동
검사와 네이티브 빌드 결과를 별도로 기록했다. `src/api.ts`와 `src-tauri` diff는 없다.
`git diff --check`가 통과했고 커밋·push·PR·merge는 수행하지 않았다.

Seal Evidence/Completion은 이 최종 소스·문서 후보에서 실행하며 정확한 Run ID와
Completion 결과는 작업 응답에 별도로 기록한다.

### 2026-09-06 PR #4 추가 리뷰 4건 보완

기준 커밋 `ace5907`의 깨끗한 `codex/ui-appearance` 체크아웃에서 작업했다. 기존
Task/Run과 조회 불가 상태 로그 제거 수정을 보존했다. CLI와 Plugin의 공개 버전은
모두 `0.3.0-rc.4`다. 새 Seal Basic Task는 `docker2u-pr4-review-four-20260906`이며
risk=medium, verifier.required=false, 필수 검사는 frontend-tests/frontend-build다.
브라우저·네이티브 빌드·실제 앱 증거는 Seal 기계 검사와 별도로 기록한다.

#### 변경과 자동 검사

- 로그 검색을 렌더링 중 전체 위치 배열 생성에서 Worker의 희소 인덱스로 옮겼다.
  정확한 전체 건수와 모든 결과 이동을 유지한다. 512건마다 UTF-16 위치를 저장하므로
  2 MiB ASCII 밀집 로그의 2,097,152건도 체크포인트 4,096개·16 KiB로 처리한다.
  이 수치는 위치 인덱스 크기이며 원문·Worker 런타임을 포함한 전체 메모리는 아니다.
- Unicode 대소문자 무시·일반 문자열·비중첩 의미를 유지한다. 계산은 최대
  16,384회 또는 약 4ms 단위로 양보한다. 4ms는 협력적 예산이며 개별 정규식 실행을
  중간에 선점하지는 않는다. Worker 실패/초기 응답 2초 초과 시 같은 코어를 메인
  스레드에서 작업 단위로 나눠 실행한다. CSP와 의존성을 변경하지 않았다.
- 검색 지우기는 원문 캐시를 유지하고 대상/로그 교체·전체 비우기는 이전 계산을
  무효화한다. 오래된 검색/이동 응답을 거부하고 연속 이동과 fallback의 위치를 보존한다.
- 로그 표시 로딩과 실제 IPC 슬롯을 분리했다. 비우기는 즉시 화면을 지우지만 요청이
  끝날 때까지 중복 조회를 막는다. 선택이 바뀌면 최신 대상 한 개만 대기시키며 실행
  직전에 선택·세션·generation·handle·조회 가능 상태를 다시 검사한다.
- 복사 버튼과 실행 함수는 현재 표시 중인 비어 있지 않은 원문만 허용한다.
  로딩/오류에 가려진 이전 로그는 복사하지 않고, 실패한 목록 갱신 후 화면에 남아
  있는 마지막 정상 로그는 복사할 수 있다.
- 프런트엔드 오류 5종에 내부 출처·메시지 키를 보관해 렌더링 시 번역한다.
  단일 작업 결과에도 출처를 유지한다. 네이티브 오류·명령·stderr와 일반 예외의
  원문은 번역하지 않는다. Docker IPC와 Rust 구현/타입 계약은 유지한다.
- `pnpm test`: 15개 파일, 274개 통과(17.47초). 기존 223개에서 51개 늘었다.
  희소 인덱스/Worker/fallback, 로그 요청 경합, 원문 복사, 오류 번역과 표시 조작의
  추가 API 호출 없음 검사를 포함한다.
- `pnpm build`: TypeScript/Vite와 배포 fixture 격리 검사 통과. 배포물은 4개 파일이며
  검색 Worker가 별도 JS 파일로 포함되고 합성 데이터 표식은 검출되지 않았다.
- `pnpm test:browser`: Chromium 99개 통과(53.8초, 로컬 retry 없음). 기존 9개
  크기·테마·언어 조합의 81개 검사에 밀집 로그/실제 Worker/원문 복사 9개와
  배포 Worker를 변경 없는 앱 CSP 아래에서 실행하는 9개 검사를 추가했다.
  CSP 검사는 로컬 HTTP origin의 배포 Worker이며 macOS 자산 프로토콜과 구분한다.
- 브라우저 검사는 빌드된 Worker를 읽으므로 `pnpm build` 이후 실행한다. 기존 CI도
  이 순서다. 보고서는 `playwright-report/index.html`이며 서버는 Playwright가 관리한다.

#### 네이티브 빌드와 실제 앱

초기 빌드는 중첩 체크아웃에서 Cargo 경로를 찾지 못했다. 저장소 변경 없이 기존
`/Users/jgoneit/project/.docker2u-tools`의 CARGO_HOME/RUSTUP_HOME/PATH를 프로세스에
지정한 뒤 `pnpm native:build`가 통과했다. Rust 단위 검사는 로컬에서 재실행하지 않았다.

최종 앱: `src-tauri/target/release/bundle/macos/Docker2U.app` (arm64).
실행 파일 SHA-256:
`38c6c0117c75ee4b603cfbad716ef6fc14c024008e0b2b4633fbe89cfa719efa`.
실제 실행 프로세스가 이 체크아웃의 앱 경로를 사용하는 것을 확인했다.

Computer Use로 다음을 확인했다.

- 기존 로컬 Docker 연결과 컨테이너 4개, PostgreSQL 로그 조회.
- ⌘F 검색 포커스, `database` 20건과 Enter의 두 번째 일치 이동.
- 인라인 Escape→돋보기로 재열기, 확대/⌘F에서도 검색어와 두 번째 일치 유지.
  확대 Escape는 창을 닫고 확대 버튼으로 포커스를 복원했다.
- 1024×680에서 검색줄과 로그 하단/푸터 표시. X는 검색어만 지우고 0건·비활성
  이동 버튼·입력 포커스를 유지했다. 라이트/영어 전환 뒤에도 검색어·결과를 유지했다.
- 앱 종료/재실행 후 Light/English 저장값을 확인하고 시스템 테마/한국어로 복원했다.
  최종 앱은 기본 창 크기로 실행 중이다.

실제 앱에서는 검색 기능을 확인했지만 Worker와 호환성 fallback 중 실행 경로를
별도로 계측하지 않았다. 실제 Worker 실행과 배포 CSP 검증은 Chromium 증거다.
실제 컨테이너 시작·중지·재시작, 강제 지연/실패 주입, Windows 앱 실행은 하지 않았다.
해당 경합/실패와 Windows Ctrl+F는 자동 검사로 확인했다. 실제 클립보드 바이트 비교는
하지 않았으며 원문 전체 복사는 단위 및 합성 Chromium 검사로 확인했다.

Seal은 이 최종 소스·문서 후보에서 verify/complete하며, 정확한 Run ID·Completion과
최신 커밋의 원격 CI 결과는 PR 및 작업 응답에 별도로 기록한다. PR #4에 push하되
merge는 하지 않는다.

### 2026-09-06 무효화된 로그 요청의 연결 오류 반영

PR #4의 [추가 리뷰](https://github.com/jgoneit/Docker2U/pull/4#discussion_r3943298486)를
기준 커밋 `361fdf5`의 깨끗한 `codex/ui-appearance` 체크아웃에서 보완했다.
Seal CLI/Plugin 공개 버전은 `0.3.0-rc.4`로 일치했다. 새 Basic Task는
`docker2u-log-session-invalidation-20260906`이며 risk=medium,
verifier.required=false, 필수 검사는 frontend-tests/frontend-build다.
기존 Task/Run은 보존하며 브라우저·네이티브·실제 앱 검증은 별도 완료 조건으로 기록한다.

#### 동작과 회귀 검사

이전 요청의 로그 표시를 폐기하는 조건과 연결 세션 오류를 반영하는 조건을 분리했다.
로그 요청의 catch에서 오류를 정규화한 뒤 epoch/sessionId가 현재 연결과 같을 때만
연결 무효화 코드 7종을 반영한다. 이 경우 비우기·선택/필터·generation 변경이나
목록 갱신 중이어도 재확인 경고와 작업 차단을 설정한다. `blocked.current`를 먼저
설정하므로 React가 버튼 상태를 갱신하기 전 실행도 막는다.

로그 오류는 기존 최신 요청 및 canReadLogs 조건을 통과할 때만 표시한다. 오래된
본문·조회 시각·오류를 되살리지 않으며 이전 세션 오류와 일반 로그 오류는 계속
폐기한다. 실제 IPC 슬롯과 최신 대기 대상 한 개 정책을 유지한다. 경고 이후에도
읽기는 허용하며 목록/로그 조회 성공은 경고를 해제하지 않는다. 유효한 새 세션을
얻는 명시적 재연결에서만 해제한다. Docker IPC·Rust 구현과 공개 타입은 변경하지 않았다.

- `pnpm test`: 15개 파일, 303개 통과(10.48초). 이전 274개에서 29개 증가했다.
  연결 무효화 7종과 일반 오류 7종, 선택 해제·조회 불가·세대 변경·갱신 진행 중
  지연 응답, 이미 열린 단일/일괄 확인창의 같은 이벤트 순서 실행 차단을 검사했다.
  재연결 중 session=null, 재연결 실패/거부, 새 세션 이후의 이전 오류 무시와
  정상 재연결의 경고 해제도 포함한다. 실제 동시 로그 요청 최대 1개와 비우기 후
  자동 재조회 금지를 유지한다. 지연·실패 경합은 합성 API 증거다.
- `pnpm build`: TypeScript/Vite 및 배포 fixture 격리 검사 통과(배포 파일 4개).
- `pnpm test:browser`: 기존 Chromium 9개 화면 조합, 99개 통과(51.5초, retry 없음).
  로그 표시 경계·현재 일치/마지막 줄 좌표·포커스·Worker/CSP 검사를 유지했다.
  브라우저 검사는 위 프런트엔드 빌드 이후 실행했다.
- `pnpm native:build`: 기존 `.docker2u-tools`의 CARGO_HOME/RUSTUP_HOME/PATH를
  프로세스에 지정해 arm64 앱 빌드 통과. Rust 소스는 변경하지 않았으며 로컬 Rust
  단위 검사는 재실행하지 않았다.

#### 최종 실행 앱과 실제 확인

앱: `src-tauri/target/release/bundle/macos/Docker2U.app` (arm64).
실행 파일 SHA-256:
`d077fc47e9f9c8d43131679017837f1bce67e7d2c5320b9f635452552934e7a9`.
이전 앱을 종료하고 새 빌드를 실행했으며 프로세스가 이 체크아웃의 앱 경로를
사용하는 것을 확인했다.

Computer Use로 desktop-linux 로컬 연결·컨테이너 4개, PostgreSQL 로그 조회,
⌘F의 `database` 검색 20건, 로그 비우기 후 본문/조회 시각 제거·복사 비활성화,
수동 재조회, 정상 목록 갱신과 명시적 재연결을 확인했다. 최종 앱은 시스템 테마/
한국어, PostgreSQL 로그 검색 화면으로 실행 중이다.

실제 컨테이너 시작·중지·재시작과 강제 연결 실패/지연 주입은 하지 않았다.
실제 Windows 앱 검증, 네이티브 Worker/fallback 경로 계측, 클립보드 바이트 비교도
이번에 수행하지 않았다. 이 항목들을 정상 연결의 macOS UI 증거와 구분한다.

로컬 명령 기록은 `.cache/log-session-invalidation-20260906/`의 tests.log,
build.log, browser.log, native-build.log에 보관했다. 최종 소스·문서 후보에서
Seal verify 후 반환된 정확한 Run ID로 complete하며, Completion과 최신 커밋의
CI 결과는 PR 및 작업 응답에 별도로 기록한다. 수정/테스트/문서는 목적별로 커밋해
PR #4에 push하며 merge는 하지 않는다.
