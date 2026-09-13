# Docker2U

> **Docker CLI, without the CLI friction.**

Docker2U는 Windows와 macOS에서 이미 설치된 조직 승인 로컬 컨테이너
런타임을 비전문 개발자가 안전하게 조회하고 복구할 수 있도록 돕는 경량
데스크톱 컨트롤 패널이다.

## 현재 상태

```text
사용자 문제 검증 완료
macOS 로컬 알파: Docker CLI가 선택한 로컬 Engine에 연결
목록·로그·단건 및 다중 Start·Stop·Restart
연결 정책 변경의 검증 결과는 알파 검증 기록에 별도 기록
```

현재 구현 대상은 macOS 14 이상 / Apple Silicon의 `Docker2U.app`이다.
앱 시작과 Reconnect에서 Docker CLI가 선택한 context를 읽고 실제 로컬 Unix
socket과 Linux Engine의 응답을 확인한다. CLI·Engine의 정확한 버전이나 Colima
프로파일·VM 설정·Engine 이름은 허용 조건이 아니다. Windows·Intel Mac과 외부
배포용 서명·notarization은 후속 단계이며, 지원 범위의 모든 조합을 검증했다는 뜻은 아니다.

연결 후에는 canonical socket과 Engine identity를 세션에 고정한다. 외부에서
Docker context를 변경해도 Refresh·로그·복구 작업은 기존 세션의 Engine을 사용하며,
새 선택은 Reconnect에서만 반영한다. 앱이 전역 context를 바꾸거나 Runtime을
설치·시작하지 않는다. 원격 endpoint 또는 연결 실패에는 다른 Engine으로 fallback하지 않는다.

## 이전 알파 검증 이력

아래는 2026-09-05의 고정 `colima-docker2u` 연결 정책에서 수행한 기록이다.
Rust 27개·React/IPC 44개 통과와 초기 실제 Colima 검사 2개·Finder GUI 확인은
그 당시 코드의 증거이며, 현재 연결 정책 변경의 검증 결과와 구분한다.

환경 진단, Container 목록·Health·최근 로그, 수동 Refresh와 Start·Stop·Restart를
구현했다. 테스트가 생성한 Container는 정확한 ID와 label을 확인해 정리했고,
기존 전역 Docker context는 `desktop-linux`로 유지했다.

빌드한 앱은 `src-tauri/target/release/bundle/macos/Docker2U.app`이다.
Computer Use 권한 허용 후 Finder에서 재빌드한 앱을 실행해 실제 Colima 연결,
목록·Health·로그·검색·필터, Start·Stop·Restart와 확인창을 조작했다.
상세 스크롤 중 전역 제어가 가려지는 문제와 확인창 종료 후 버튼 focus 복원을
수정하고 재빌드한 앱에서 확인했다. 정상 GUI Quit과 검증용 CLI wrapper가 실행
중인 상태의 Quit에서 앱·자식 프로세스 정리를 확인했다.

## 기준 문서

- [Docker2U 개발 정의서](docs/DEVELOPMENT-DEFINITION.md)
- [macOS 로컬 알파 구현·검증 기준](docs/MACOS-ALPHA.md)
- [프로젝트 통합 로그·자원 및 상태 이력](docs/PROJECT-OBSERVATION.md)
- [컨테이너 이미지 내보내기](docs/IMAGE-EXPORT.md)

개발 정의서는 다음 내용을 하나의 기준으로 관리한다.

- 제품 문제, 대상 사용자와 성공·중단 기준
- Windows/macOS 및 Runtime 지원 matrix
- Rust + Tauri 2 기반 기술 방향
- v0.1 기능과 명시적 제외 범위
- Local-only endpoint와 typed IPC 보안 경계
- 테스트, 서명 배포, Acceptance Criteria와 Release Blocker

## 확정된 핵심 방향

- Docker2U는 Docker Desktop 대체품이나 Runtime 설치 도구가 아니다.
- 조직이 제공한 Docker CLI와 로컬 Docker/Moby Runtime을 그대로 사용하는
  BYOR(Bring Your Own Runtime) 제품이다.
- macOS 알파는 Container·Compose 프로젝트 조회, 실시간 로그, 현재 CPU·메모리, Start·Stop·Restart를 제공한다. [범위와 검증 경계](docs/MACOS-LIVE-INSIGHTS.md)를 참고한다.
- 로컬 Compose 파일 등록과 프로젝트 실행·중지를 추가한다. [Compose 프로젝트 실행 범위](docs/COMPOSE-PROJECT-CONTROLS.md)를 따른다.
- 명령 종료와 현재 서비스 State·Health를 구분하고, 프로젝트·컨테이너의 실제 마운트와 공유 관계를 읽기 전용으로 조회한다. [상태 표시와 저장소 탐색](docs/COMPOSE-STORAGE.md)을 참고한다.
- 등록 프로젝트에서 서비스마다 이미지 다운로드·빌드·준비 생략을 선택하고 해당 서비스만 재생성한다. [선택 서비스 변경 반영](docs/COMPOSE-APPLY.md)과 [검증 경계](docs/COMPOSE-APPLY-AUDIT.md)를 참고한다.
- 실행·중지 컨테이너가 사용하는 실제 이미지를 `.tar`로 저장한다. 볼륨 데이터와 실행 후 변경한 파일은 포함하지 않는다. [이미지 내보내기](docs/IMAGE-EXPORT.md)를 참고한다.
- 원격 endpoint, 범용 shell, Terminal/Exec, Delete/Prune, Compose 파일 편집은 제외한다.
- 기술 스택은 Rust + Tauri 2 + React + TypeScript strict로 정의한다.
- 사용자가 제공한 React 패널의 어두운 테마, 검색·필터, 목록·상세 분할을 유지한다.
- 로컬 알파는 시작·Reconnect에서 인자 없는 `docker context inspect`로 선택을
  확인한다. 이후 모든 Engine 명령은 세션에 고정된 Unix socket을 사용한다.

초기 알파는 Seal과 Ward 없이 검증했다. PR #1 리뷰 수정에는 사용자 요청으로
Seal Basic Acceptance와 기존 검사 catalog를 추가하며 Ward는 사용하지 않는다.
Rust·React 자동 검사, 실제 Colima 연동과 네이티브 앱 실행은 각각 검증한다.
빌드나 mock 성공은 실제 Docker 조작 또는 Finder에서의 화면 확인을 대신하지 않는다.

## 로컬 개발

`.seal/checks.json`은 기존 `pnpm test`, `pnpm build`, `pnpm rust:fmt`,
`pnpm rust:test`를 필수 검사로 등록한다. 앞의 세 검사는 각각 120초, Rust 테스트는
300초 제한이다. Seal Task와 Evidence는 로컬 ignored 상태이며 PR에 포함하지 않는다.
Native 앱 빌드와 실제 Engine·GUI 검사는 별도로 기록한다.

PR과 `main` push는 [CI](.github/workflows/ci.yml)에서 React/IPC 테스트·TypeScript·
frontend build와 macOS ARM64 Rust 검사·앱 빌드를 실행한다. 성공한 실행은 서명하지
않은 앱 ZIP과 SHA-256 checksum을 7일간 보관한다. 실제 Engine 조작과 Finder GUI
검증은 준비된 Mac에서 별도로 수행한다.

저장소에서 `pnpm install --frozen-lockfile`로 의존성 설치를 완료한 후 다음
명령을 사용한다. macOS 알파는 사용자가 이미 준비한 Docker CLI와 로컬 Linux
Engine을 사용한다.

```sh
pnpm native:dev
pnpm native:build
```

native 명령은 승인된 `assets/app-icon.png`에서 ignored `src-tauri/gen/icons` 아래에
앱 아이콘을 생성한다. 검사·재개 명령과 현재 제한은
[알파 검증 기록](docs/MACOS-ALPHA.md)을 참고한다.

Apple Silicon용 `.app`과 `.dmg`는 `pnpm native:build:dmg --ci -- --locked`로
생성한다. 이 명령은 `aarch64-apple-darwin`을 지정하며 서명·공증 자격 증명을
설정하지 않는다. 테스트용 ad-hoc 서명과 배포 검증 절차는
[macOS DMG 패키징](docs/releases/MACOS-DMG.md)을 참고한다.

두 명령의 Rust 실행은 [toolchain wrapper](scripts/with-toolchain.mjs)를 통해
준비한 도구체인을 사용한다. 현재 개발 장비의 별도 도구 디렉터리는
`../.docker2u-tools`이며 앱 배포물에는 포함하지 않는다.

Docker 설정 디렉터리는 앱 프로세스의 `DOCKER_CONFIG` 또는 기본 `$HOME/.docker`다.
native `runtime.json`에서는 `dockerPath`만 적용한다. 이전의 `dockerConfig`,
`colimaPath`, `colimaHome`, `limaHome`은 무시하고 설정 파일을 자동 수정하지 않는다.
Finder에서 실행한 앱은 별도 터미널에서 나중에 `export`한 환경을 받지 않는다.
Docker CLI 환경변수를 사용하려면 앱 실행 환경에 설정하고 앱을 다시 시작해야 한다.
설정 경로와 실제 context·endpoint는 앱 진단에서 확인한다.

이전 Colima·GUI 검사와 새 연결 정책의 검증 범위는
[알파 검증 기록](docs/MACOS-ALPHA.md)을 확인한다.
