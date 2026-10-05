# Docker2U 설치 안내

[제품 소개](https://jgoneit.github.io/Docker2U/?lang=ko) · [README](../README.md) · [English](#english)

## 준비할 것

| 항목 | 요구 사항 |
| --- | --- |
| Mac | Apple Silicon, macOS 14 이상 |
| Docker | 이미 설치된 Docker CLI와 실행 중인 로컬 Linux Engine |
| Compose 기능 | Docker Compose 플러그인 |
| 설치 파일 | `Docker2U_0.1.0-alpha.2_aarch64.dmg` |

Docker2U는 Docker CLI나 런타임을 설치·시작하지 않습니다. 사용하는 런타임을 먼저 시작하세요.
현재 CLI context가 로컬 Unix socket을 가리켜야 하며, 원격 TCP·SSH endpoint는 지원하지 않습니다.
Windows·Intel Mac용 배포물과 자동 업데이트는 제공하지 않습니다.

## 다운로드와 설치

1. [alpha.2 릴리스](https://github.com/jgoneit/Docker2U/releases/tag/v0.1.0-alpha.2)에서 변경 내용과 알려진 제약을 확인합니다.
2. [Apple Silicon용 DMG](https://github.com/jgoneit/Docker2U/releases/download/v0.1.0-alpha.2/Docker2U_0.1.0-alpha.2_aarch64.dmg)를 다운로드합니다.
3. DMG를 열고 **Docker2U**를 **Applications**로 드래그합니다.
4. DMG를 꺼내고 **응용 프로그램 → Docker2U**에서 실행합니다.

다운로드 파일의 무결성을 확인하려면 아래 명령의 결과와 릴리스에 제공한 해당 DMG의 SHA-256 값을 비교하세요.
체크섬 일치는 Apple의 서명·공증을 뜻하지 않습니다.

```sh
shasum -a 256 ~/Downloads/Docker2U_0.1.0-alpha.2_aarch64.dmg
```

## 처음 실행하기

현재 배포물은 **로컬 ad-hoc 서명이며 Apple 공증을 받지 않은 프리릴리스**입니다.
인터넷에서 내려받은 앱은 macOS가 개발자를 확인하지 못해 실행을 차단할 수 있습니다.

다운로드 출처와 체크섬을 확인하고 실행하기로 결정한 경우,
한 번 실행을 시도한 뒤 **시스템 설정 → 개인정보 보호 및 보안**에 표시되는 앱별
**확인 없이 열기 / Open Anyway** 안내를 따르세요. 환경이나 관리 정책에 따라 허용되지 않을 수 있습니다.
악성 소프트웨어 탐지 경고가 나타나거나 조직 정책상 설치가 허용되지 않으면 실행을 중단하세요.
[Apple의 Mac 앱 안전하게 열기 안내](https://support.apple.com/102445)에서 자세한 조건을 확인할 수 있습니다.

시스템 전체 Gatekeeper를 끄거나 보안 정책을 바꾸는 과정은 필요하지 않습니다.
Developer ID 서명·공증 또는 깨끗한 Mac에서의 설치 검증을 완료한 배포로 보시면 안 됩니다.
이번 배포물에서 실제로 수행한 검사는 릴리스 노트에 따로 기록합니다.

## Docker 연결하기

앱은 시작하거나 **Reconnect**를 누를 때 Docker CLI가 선택한 context를 읽고,
로컬 Unix socket과 Linux Engine 응답을 확인합니다. 연결한 뒤에는 같은 Engine을 유지합니다.
터미널에서 context를 바꿨다면 앱에서도 Reconnect를 눌러야 반영됩니다.

연결에 실패하면 다음을 확인하세요.

1. 사용하는 로컬 런타임이 실행 중인지 확인합니다.
2. 다음 읽기 전용 명령으로 CLI·context·Engine 상태를 확인합니다.
3. 앱 진단의 Docker CLI 경로와 endpoint가 의도한 환경인지 확인한 뒤 Reconnect합니다.

```sh
docker version
docker context show
docker context inspect
```

Docker CLI가 기본 위치에 없다면
`~/Library/Application Support/io.github.jgoneit.docker2u/runtime.json`의 `dockerPath`에
이미 설치한 CLI의 절대 경로를 지정할 수 있습니다. 경로는 사용 환경에 맞게 확인하세요.

```json
{ "dockerPath": "/absolute/path/to/docker" }
```

설정에서 현재 적용하는 키는 `dockerPath`입니다. Docker 설정은 앱 프로세스의
`DOCKER_CONFIG` 또는 기본 `~/.docker`를 사용합니다. Finder에서 실행한 앱은 별도
터미널에서 나중에 설정한 환경변수를 받지 않습니다. 앱 실행 환경을 변경한 뒤에는 앱을 다시 시작하세요.
앱은 전역 context를 변경하거나 실패 시 다른 Engine으로 전환하지 않습니다.

## 처음 둘러보기

- 왼쪽에서 **프로젝트** 또는 **독립 컨테이너**를 선택하면 통합 로그를 확인할 수 있습니다.
- 개별 컨테이너를 선택해 로그·진단·접속·저장소를 확인합니다.
- **이력**에서 사건을 고르면 전후 로그와 자원 기록을 확인하고 현재 점검 화면으로 이동할 수 있습니다.
- **터미널 → 연결**로 컨테이너 셸을 시작합니다. 탭만 열면 명령을 실행하지 않습니다.
- 설정에서 **한국어 / English**와 **시스템 / 라이트 / 다크**를 선택합니다.

로그·자원·이력은 보관 한도가 있는 앱 세션 메모리에만 남습니다. 종료·재연결 전에 필요한 내용을
확인하세요. 터미널에서 실행 중인 명령을 끝내려면 셸에서 중단하거나 종료해야 합니다.
연결 끊기는 명령 종료를 보장하지 않습니다.

## 업데이트하기

자동 업데이트는 아직 없습니다. 새 릴리스의 DMG를 다운로드하고 Docker2U를 종료한 뒤,
새 앱을 Applications에 복사해 기존 앱을 교체합니다. 설치한 앱을 다시 실행해 버전과 연결을 확인하세요.
기존 앱과 새 앱을 동시에 실행하지 마세요. 앱을 종료하면 현재 로그·이력·터미널 세션은 유지되지 않습니다.

## 문제 제보하기

[GitHub Issues](https://github.com/jgoneit/Docker2U/issues)에 앱 버전, macOS 버전, 런타임 종류,
재현 순서와 기대한 결과를 적어주세요. 로그·진단 자료의 토큰, 비밀번호, 내부 주소는 제거해 주세요.

---

## English

### Requirements

- An Apple Silicon Mac running macOS 14 or later.
- Docker CLI and an already running local Linux Engine; a Docker Compose plugin for Compose features.
- A CLI context that uses a local Unix socket. Remote TCP/SSH endpoints, Windows, and Intel Macs are unsupported.

Docker2U does not install or start your runtime. Start it separately before opening the app.

### Install and launch

1. Read the [alpha.2 release notes](https://github.com/jgoneit/Docker2U/releases/tag/v0.1.0-alpha.2).
2. Download [Docker2U_0.1.0-alpha.2_aarch64.dmg](https://github.com/jgoneit/Docker2U/releases/download/v0.1.0-alpha.2/Docker2U_0.1.0-alpha.2_aarch64.dmg).
3. Open the DMG and drag **Docker2U** to **Applications**. Eject the DMG, then launch the installed app.
4. Optionally run `shasum -a 256 ~/Downloads/Docker2U_0.1.0-alpha.2_aarch64.dmg` and compare it with the DMG checksum supplied in the release. A matching checksum is not Apple notarization.

This prerelease is **ad-hoc signed and not notarized by Apple**. macOS may block its first launch.
After verifying the source and deciding to run it, attempt to open the app, then follow its app-specific
**System Settings → Privacy & Security → Open Anyway** prompt if available. Your organization's policy may prohibit this.
Do not proceed past a malware detection warning or a policy restriction. See [Apple's guidance](https://support.apple.com/102445).
Do not disable Gatekeeper system-wide. Validation actually performed on this release is recorded in its release notes.

### Connect to Docker

At startup and on **Reconnect**, the app reads the context selected by Docker CLI and validates its local Unix socket
and Linux Engine. It stays with that Engine until you reconnect, even if the CLI context changes.
The app never changes the global context or silently falls back to another Engine.

If connection fails, start your runtime, run the read-only commands `docker version`, `docker context show`, and
`docker context inspect`, and compare the CLI path and endpoint with app diagnostics. Then reconnect.

For a nonstandard CLI location, set `dockerPath` to the absolute path of your installed Docker CLI in
`~/Library/Application Support/io.github.jgoneit.docker2u/runtime.json`:

```json
{ "dockerPath": "/absolute/path/to/docker" }
```

Only `dockerPath` is applied from this file. Docker configuration uses the app process's `DOCKER_CONFIG` or `~/.docker`.
Finder-launched apps do not inherit environment variables exported later in a separate terminal. Restart the app after changing its launch environment.

### Explore the app

Select a project or the standalone group for combined logs, or choose a container for its logs, diagnostics,
connections, and storage. Select an event in **History** to inspect surrounding records and move to the current
container, then return to the incident. **Terminal → Connect** starts a shell; visiting the tab alone does not.
Settings include Korean and English and system, light, and dark themes.

Records use bounded session memory and are cleared on quit or Engine reconnect. There is no persistent monitoring history.
Disconnecting a terminal does not guarantee its command has stopped; interrupt or exit inside the shell when needed.

### Update or get help

There is no automatic updater. Download the new DMG, quit Docker2U, replace the app in Applications, and relaunch it.
Check its version and connection. Do not run both copies together; logs, history, and terminal sessions do not survive quitting.

Report problems in [GitHub Issues](https://github.com/jgoneit/Docker2U/issues) with the app and macOS versions, runtime,
and reproduction steps. Remove tokens, passwords, and private addresses before sharing diagnostic material.
