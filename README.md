# Docker2U

> **Docker CLI, without the CLI friction.**

Docker2U는 Windows와 macOS에서 이미 설치된 조직 승인 로컬 컨테이너
런타임을 비전문 개발자가 안전하게 조회하고 복구할 수 있도록 돕는 경량
데스크톱 컨트롤 패널이다.

## 현재 상태

```text
사용자 문제 검증 완료
macOS 로컬 알파 기능 구현 및 Docker2U.app 빌드 완료
Rust 27개 · React/IPC 44개 통과
초기 알파의 실제 Colima 검사 2개 · Finder GUI 검증 완료
Finder 실행 · 실제 GUI 조회·복구·정상 Quit 확인
```

현재 구현 목표는 Apple Silicon Mac에서 개발 전용 Colima 환경에 연결되는
`Docker2U.app`이다. Windows와 외부 배포용 서명·notarization은 후속 단계이며,
이 로컬 알파를 두 플랫폼의 공식 지원 또는 외부 배포 완료로 표현하지 않는다.
현재 조작 허용 Host는 macOS `26.5.2` / ARM64로 제한한다. Core가 실제 Host
버전을 확인하며, 다른 버전 또는 확인 실패 시 세션과 조작 권한을 발급하지 않는다.

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
- v0.1은 Container 조회, 최근 로그, Start, Stop, Restart에 집중한다.
- 원격 endpoint, 범용 shell, Terminal/Exec, Delete/Prune, Compose는 제외한다.
- 기술 스택은 Rust + Tauri 2 + React + TypeScript strict로 정의한다.
- 사용자가 제공한 React 패널의 어두운 테마, 검색·필터, 목록·상세 분할을 유지한다.
- 로컬 알파는 Rust Core가 `colima-docker2u` context의 검증된 Unix socket에
  대상을 고정한다. 전역 Docker 기본 context를 변경하거나 따라가지 않는다.

초기 알파는 Seal과 Ward 없이 검증했다. PR #1 리뷰 수정에는 사용자 요청으로
Seal Basic Acceptance와 기존 검사 catalog를 추가하며 Ward는 사용하지 않는다.
Rust·React 자동 검사, 실제 Colima 연동과 네이티브 앱 실행은 각각 검증한다.
빌드나 mock 성공은 실제 Docker 조작 또는 Finder에서의 화면 확인을 대신하지 않는다.

## 로컬 개발

`.seal/checks.json`은 기존 `pnpm test`, `pnpm build`, `pnpm rust:fmt`,
`pnpm rust:test`를 필수 검사로 등록한다. 앞의 세 검사는 각각 120초, Rust 테스트는
300초 제한이다. Seal Task와 Evidence는 로컬 ignored 상태이며 PR에 포함하지 않는다.
Native 앱 빌드와 실제 Colima 검사는 별도로 실행한다.

PR과 `main` push는 [CI](.github/workflows/ci.yml)에서 React/IPC 테스트·TypeScript·
frontend build와 macOS ARM64 Rust 검사·앱 빌드를 실행한다. 성공한 실행은 서명하지
않은 앱 ZIP과 SHA-256 checksum을 7일간 보관한다. 실제 Colima 조작과 Finder GUI
검증은 준비된 Mac에서 별도로 수행한다.

저장소에서 `pnpm install --frozen-lockfile`로 의존성 설치를 완료한 후 다음
명령을 사용한다. macOS 알파는 사전에 준비된 Colima `docker2u` 프로파일이
필요하며 앱이 Runtime을 설치하거나 시작하지 않는다.

```sh
pnpm native:dev
pnpm native:build
```

native 명령은 `assets/app-icon.svg`에서 ignored `src-tauri/gen/icons` 아래에
앱 아이콘을 생성한다. 검사·재개 명령과 현재 제한은
[알파 검증 기록](docs/MACOS-ALPHA.md)을 참고한다.

두 명령의 Rust 실행은 [toolchain wrapper](scripts/with-toolchain.mjs)를 통해
준비한 도구체인을 사용한다. 현재 개발 장비의 별도 도구 디렉터리는
`../.docker2u-tools`이며 앱 배포물에는 포함하지 않는다. Rust 1.98.1,
Colima 0.10.3, Lima 2.2.0, 독립 Docker CLI 29.8.0을 준비했다.
이 장비에서 Colima VM 기동과 실제 Container 연동, Finder 실행과 GUI 조작을
확인했다. 실행 중인 자식 프로세스의 GUI 종료 검증 방법과 남은 한계는 아래 기록에
정리했다. 최소 창 크기 실측은 아직 수행하지 않았다.
실환경 완료 여부는 [알파 검증 기록](docs/MACOS-ALPHA.md#실환경-기록)을 확인한다.
