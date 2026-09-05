# Docker2U

> **Docker CLI, without the CLI friction.**

Docker2U는 Windows와 macOS에서 이미 설치된 조직 승인 로컬 컨테이너
런타임을 비전문 개발자가 안전하게 조회하고 복구할 수 있도록 돕는 경량
데스크톱 컨트롤 패널이다.

## 현재 상태

```text
사용자 문제 검증 완료
macOS 로컬 알파 기능 구현 및 Docker2U.app 빌드 완료
Rust 22개 · React/IPC 41개 · 실제 Colima 검사 2개 통과
Finder 실행 · 실제 GUI 조회·복구·정상 Quit 확인
```

현재 구현 목표는 Apple Silicon Mac에서 개발 전용 Colima 환경에 연결되는
`Docker2U.app`이다. Windows와 외부 배포용 서명·notarization은 후속 단계이며,
이 로컬 알파를 두 플랫폼의 공식 지원 또는 외부 배포 완료로 표현하지 않는다.

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

현재 알파는 Seal과 Ward를 사용하지 않는다. Rust·React 자동 검사, 실제
Colima 연동과 네이티브 앱 실행을 각각 검증한다. 빌드나 mock 성공은
실제 Docker 조작 또는 Finder에서의 화면 확인을 대신하지 않는다.

## 로컬 개발

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
