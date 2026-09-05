# Docker2U macOS 로컬 알파

사용자 문제 검증은 완료되었다. 현재 목표는 Apple Silicon Mac에서 개발 전용
Colima Container를 조회하고 복구할 수 있는 `Docker2U.app`을 만드는 것이다.
이 문서는 [개발 정의서](DEVELOPMENT-DEFINITION.md)의 현재 단계별 적용 기준이다.

## 구현 범위

| 항목 | 로컬 알파 결정 |
| --- | --- |
| Stack | React + TypeScript strict + Tauri 2 + Rust |
| Host 검증 대상 | 현재 macOS 26.5.2 / Apple Silicon |
| Runtime | Colima `docker2u` 개발 프로파일, Docker runtime |
| VM 기본값 | ARM64, VZ, CPU 2개, 메모리 4 GiB, `--activate=false` |
| 대상 context | Core가 지정한 `colima-docker2u` |
| 대상 endpoint | 해당 context와 Colima 상태를 대조한 local Unix socket |
| UI | 제공된 React 패널의 어두운 테마, 검색·필터, 왼쪽 목록·오른쪽 상세 |
| 창 | 기본 1280×800, 최소 1024×680 |
| 기능 | 환경 진단, 목록·Health, 최근 로그, Refresh, Start·Stop·Restart |
| 로그 | 최근 300줄 요청, stdout/stderr 합계 마지막 2 MiB 표시 |
| 산출물 | 로컬 `.app`, 소스, 자동 검사·실환경 검증 결과 |

전역 Docker 기본 context를 바꾸거나 자동으로 따라가지 않는다. 같은 이름의
context가 없으면 환경 진단을 반환하고 다른 Engine으로 fallback하지 않는다.
Docker Desktop의 기존 Container·Volume과 Runtime은 이동하거나 수정하지 않는다.
Colima 설치·시작은 개발 환경 준비이며 앱에서 Runtime을 관리하지 않는다.

전체 초기화, Delete/Prune, 전체 중지, Terminal/Exec, Compose 실행, 호스트 Port
Inspector, 자동 갱신, 실시간 로그, 환경 변수 표시와 Local-only 해제 설정은
제외한다. Windows·Intel Mac·macOS 14+ 전체 범위, 외부 서명·notarization,
DMG·공개 GitHub Release는 후속 검증이다.

## 준비와 작업 경계

2026-09-05 재개 요청에 따라 Seal과 Ward를 사용하지 않는다. 초기 도구 준비부터
기능 구현·자동 검사·실환경 확인까지 직접 수행한다. 개발 환경에 필요한 Rust는 공식
custom-home 설치와 task-local toolchain wrapper를 사용할 수 있다. 이 개발용
경로를 앱의 Docker CLI 기본 경로나 배포 의존성으로 넣지 않는다.

저장소의 `scripts/with-toolchain.mjs`가 준비한 Rust 도구체인을 선택한다.
로컬 앱 개발 명령은 `pnpm native:dev`, native build는 `pnpm native:build`다.
이 개발 장비의 별도 도구 디렉터리는 `../.docker2u-tools`이며 제품 배포물과
분리한다. 명령 제공 여부와 실제 실행·검증 결과는 구분해 기록한다.

Rust toolchain 및 Cargo/frontend lockfile을 고정한다. 최초 설치와 빌드 캐시를
준비한 후 TypeScript 검사, React 테스트, Rust 테스트, frontend/native 빌드를
실제 실행한다. 설치 완료나 캐시 준비를 검사 통과로 대신하지 않는다.
각 기능 단위는 관련 자동 검사와 실제 Mac 검증으로 확인한다.

1. 환경 진단·실행 계층: CLI 탐색, 고정 context의 local endpoint 검증,
   실제 Colima·CLI·Engine 버전 수집, typed `get_environment()`와 화면 연결.
2. 목록·로그: batch inspect로 State·Health 확인, 원자적 Refresh, 검색·필터,
   최근 로그 한도·정규화·잘림 표시, Stale·빈 결과·연결 오류 화면.
3. 복구·재조회: Start → Stop → Restart, 확인창, 정확한 대상 재검증,
   중복 조작 차단, 실행 후 Refresh와 `ResultUnknown` reconciliation.

## 동작과 검증 계약

Rust가 CLI 절대경로·endpoint·session·handle→full ID mapping을 소유한다.
UI는 typed IPC로 session ID와 opaque handle만 전달한다. Shell을 사용하지
않으며 모든 Engine 명령에 검증된 `--host`를 명시하고 대상·TLS·API 환경
변수 override를 정리한다. stdout/stderr를 동시에 소비하고 한도, timeout,
프로세스 종료·정리를 적용한다.

실제 Colima 상태·버전, context socket, Engine ID·OS·architecture·Server/API
버전을 대조해 현재 profile을 고정한다. 다른 환경은 진단만 허용한다. 목록은
전체 조회 성공 시에만 새 generation으로 교체하고 실패하면 마지막 목록을
Stale로 표시한다. 이전 session·generation의 결과가 최신 상태를 덮지 않는다.

Mutation 직전에 full ID, session, generation, endpoint, profile, Engine
fingerprint를 확인한다. Stop·Restart는 대상과 연결 환경의 확인창을 표시한다.
Timeout·연결 단절 등으로 결과가 불확실하면 `ResultUnknown`을 그대로 남기고
자동 재시도하지 않는다. exact full ID 상태를 재조회하고 실패하면 추가 mutation을
차단한다. 재조회 성공도 원래 Outcome을 성공으로 바꾸지 않는다.

UI는 State·Health·최근 갱신·로그를 우선한다. 상세 영역에 복구 버튼을 모으고
CLI 없음, 미지원·연결 실패, 빈 목록, 검색 결과 없음, Stale, Busy, 실패,
`ResultUnknown`, 재조회 실패를 구분한다. 목록 키보드 선택, 확인창 focus
이동·복원과 Escape를 검증한다. UX 시뮬레이터·mock은 개발·테스트 전용이다.
외부 폰트 요청과 사용하지 않는 서버·AI SDK 의존성은 포함하지 않는다.

## 완료 체크리스트

각 항목은 실제로 확인한 범위만 체크한다. 서명·Windows 검증은 현재 로컬 알파의
완료 조건이 아니다. 화면 검증은 자동 테스트·프로세스 기동과 구분한다.

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

키는 `dockerPath`, `colimaPath`, `colimaHome`, `limaHome`, `dockerConfig`이며
각 값은 이미 준비된 도구·디렉터리의 절대경로다. WebView에서 이 경로나 raw Docker
인자를 전달하는 IPC는 제공하지 않는다. 설정이 없으면 표준 설치 경로를 탐색한다.

현재 개발 장비에서는 `../.docker2u-tools/bin/{docker,colima}`와 같은 도구
디렉터리의 `colima`, `lima`, `docker-config`를 지정했다. 이 설정은 저장소 밖에
0600 mode로 작성했으며 앱 bundle에는 포함하지 않는다. Docker private config는
개발용 `colima-docker2u` context를 갖고, 사용자의 기본 Docker config는 보존한다.
Colima VM은 앱이 아닌 개발 준비 단계에서 시작한다.

현재 프로파일은 `docker2u`, ARM64, VZ, CPU 2개, 메모리 4 GiB,
`autoActivate: false`다. 기존 실패로 생성된 프로파일을 정상 stop/start하여
준비를 마쳤으며 새로운 VM backend나 Docker Desktop 자원으로 전환하지 않았다.

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

실환경 smoke는 아래 명령으로 명시적으로 실행한다. 준비한 `docker2u` Engine에
테스트 label이 붙은 BusyBox Container 하나를 만들며, 검사가 만든 정확한 대상만
정리한다. 제품 IPC에는 생성·삭제 기능이 없다.

```sh
DOCKER2U_REAL_SMOKE=1 node scripts/with-toolchain.mjs cargo test --manifest-path src-tauri/Cargo.toml --locked real_runtime_smoke -- --ignored --nocapture
DOCKER2U_REAL_PROBE=1 node scripts/with-toolchain.mjs cargo test --manifest-path src-tauri/Cargo.toml --locked real_environment_probe -- --ignored --nocapture
```

## 이전 중단과 재개

이전 작업에서는 `workspace-write` 실행 환경에서 Rust의 임시 디렉터리 제거가
`Operation not permitted`로 실패했고, Colima는 VZ 초기화와 network 파일 정리
오류로 중단됐다. 당시 기능 구현과 native/runtime 검증은 수행하지 못했다.

현재 재개 작업은 전체 접근 실행 환경이며 같은 의존성·Rust target·Colima
프로파일을 재사용한다. Seal·Ward 설정이나 lifecycle 작업은 수행하지 않는다.
이전 중단 기록을 현재의 검증 성공으로 취급하지 않는다.

Windows 실환경, Apple Developer ID 서명, notarization·stapling, DMG,
clean-machine 설치와 외부 Pilot은 후속 단계다.
