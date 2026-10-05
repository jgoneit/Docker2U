<p align="center">
  <a href="https://jgoneit.github.io/Docker2U/?lang=ko"><img src="assets/app-icon.png" width="112" height="112" alt="Docker2U 앱 아이콘" /></a>
</p>

<h1 align="center">Docker2U</h1>
<p align="center"><strong>컨테이너 작업, 한 화면에서.</strong><br />내 Mac의 Docker를 위한 데스크톱 컨트롤 패널</p>
<p align="center">macOS 14+ · Apple Silicon · 한국어 / English · 시스템 / 라이트 / 다크</p>
<p align="center">
  <a href="https://github.com/jgoneit/Docker2U/releases/download/v0.1.0-alpha.2/Docker2U_0.1.0-alpha.2_aarch64.dmg"><strong>alpha.2 DMG 다운로드</strong></a> ·
  <a href="https://jgoneit.github.io/Docker2U/?lang=ko">제품 소개</a> ·
  <a href="docs/INSTALL.md">설치 안내</a> ·
  <a href="https://github.com/jgoneit/Docker2U/releases/tag/v0.1.0-alpha.2">릴리스 노트</a>
</p>
<p align="center"><strong>한국어</strong> · <a href="README.en.md">English</a></p>

---

어느 컨테이너가 멈췄는지, 어떤 로그가 남았는지, 지금 무엇을 확인해야 하는지.
Docker2U에서 프로젝트와 컨테이너를 고르고 **로그 → 사건 확인 → 현재 진단 → 터미널**로 이어가세요.
이미 사용하는 Docker CLI와 로컬 Linux Engine에 연결합니다. 런타임은 별도로 준비해야 합니다.

## 이런 일을 할 수 있어요

| 하고 싶은 일 | Docker2U에서 |
| --- | --- |
| 프로젝트 상태 한눈에 보기 | Compose 프로젝트·독립 컨테이너를 트리로 탐색하고 상태·Health·CPU·메모리 확인 |
| 여러 컨테이너 로그 함께 읽기 | 프로젝트·독립 그룹의 통합 로그를 검색하고, 화면을 오가도 필터와 읽던 위치 유지 |
| 멈춘 시점부터 점검하기 | 사건 전후 로그·자원을 확인하고 현재 진단·접속·저장소·터미널로 이동한 뒤 사건으로 복귀 |
| 필요한 컨테이너만 조작하기 | 단건·다중 Start / Stop / Restart, 대상 확인 후 실행 |
| Compose 변경 반영하기 | 로컬 Compose 파일을 등록해 실행·중지하고, 서비스별 이미지 다운로드·빌드·현재 이미지 사용을 선택해 재생성 |
| 컨테이너 안에서 확인하기 | 실행 중인 컨테이너에 `/bin/sh` 또는 `/bin/bash`로 연결하고 다른 화면에서도 세션 유지 |
| 이미지 가져가기 | 컨테이너가 사용하는 이미지를 `.tar`로 저장. 볼륨 데이터와 실행 후 파일 변경은 제외 |

## 시작하기

1. **환경을 준비합니다.** macOS 14 이상인 Apple Silicon Mac에 Docker CLI와 실행 중인 로컬 Linux Engine이 필요합니다. Compose 기능에는 Docker Compose 플러그인도 필요합니다.
2. **앱을 설치합니다.** [DMG](https://github.com/jgoneit/Docker2U/releases/download/v0.1.0-alpha.2/Docker2U_0.1.0-alpha.2_aarch64.dmg)를 열어 `Docker2U.app`을 Applications로 옮긴 뒤 실행합니다. 현재는 **ad-hoc 서명·미공증 알파**입니다. [첫 실행 안내](docs/INSTALL.md#처음-실행하기)를 확인하세요.
3. **연결을 확인합니다.** 시작할 때 Docker CLI가 선택한 context의 로컬 Unix socket과 Linux Engine을 확인합니다. 연결되지 않으면 앱 진단에서 CLI·context·endpoint를 확인하세요.
4. **대상을 고릅니다.** 왼쪽에서 프로젝트나 컨테이너를 선택해 로그·상태를 확인합니다. 터미널은 탭을 연 뒤 **연결**을 눌러야 셸을 시작합니다.

사용 중 CLI의 context를 바꿨다면 **Reconnect**로 새 대상을 연결하세요. 그 전까지 앱은 기존 Engine을 사용합니다.
앱은 전역 context를 변경하거나 런타임을 설치·시작하지 않습니다.

## alpha.2에서 달라진 점

- 프로젝트·독립 컨테이너의 **통합 로그, CPU·메모리, 상태 이력**을 함께 확인합니다.
- 사건 당시의 기록에서 현재 진단과 터미널로 이동하고, 원래 사건과 읽던 위치로 돌아옵니다.
- **Compose 실행·중지와 선택 서비스 변경 반영**, 저장소 조회, 이미지 내보내기를 제공합니다.
- 컨테이너별 터미널 세션을 유지하며, 한국어·영어와 시스템·라이트·다크 테마를 선택할 수 있습니다.

구체적인 변경과 이번 배포물의 검증 범위는 [릴리스 노트](https://github.com/jgoneit/Docker2U/releases/tag/v0.1.0-alpha.2)를 참고하세요.

## 사용 전에 알아두세요

- **지원 범위:** macOS 14+ / Apple Silicon의 로컬 Linux Engine. Windows·Intel Mac·원격 Docker endpoint는 지원하지 않습니다.
- **알파 배포:** Developer ID 서명과 Apple 공증이 없습니다. 사용 환경에 따라 첫 실행이 차단될 수 있습니다. 자동 업데이트도 없어 새 DMG로 직접 교체합니다.
- **기록은 세션 안에서:** 로그·자원·이력은 제한된 메모리에 보관합니다. 앱 종료·Engine 재연결 시 기록이 초기화되며 영구 기록이나 모니터링 알림을 제공하지 않습니다. 수집하지 못한 구간은 복원되지 않습니다. [보관 범위](docs/PROJECT-OBSERVATION.md#core-수집과-보관)
- **터미널은 실제 명령 실행:** 컨테이너의 사용자·네트워크·마운트 권한을 따릅니다. 최대 8개 세션과 세션당 2,000줄을 보관합니다. 연결 끊기는 실행 중인 명령의 종료를 보장하지 않습니다.
- **조작 후 상태 확인:** 컨테이너·Compose 작업은 실제 환경을 변경합니다. 명령 종료와 서비스의 준비 완료는 다르며, 실패·취소 시 이미 적용된 변경을 자동으로 되돌리지 않습니다.
- **제공하지 않는 기능:** 런타임 설치, 호스트 범용 셸, Delete / Prune, Compose 파일 편집.

## 도움말과 피드백

- [설치·업데이트·연결 문제](docs/INSTALL.md)
- [통합 로그와 보관 범위](docs/PROJECT-OBSERVATION.md) · [독립 컨테이너와 사건](docs/STANDALONE-INCIDENTS.md)
- [사건 확인](docs/INCIDENT-REVIEW.md) · [컨테이너 터미널](docs/CONTAINER-TERMINAL.md)
- [Compose 실행·중지](docs/COMPOSE-PROJECT-CONTROLS.md) · [선택 서비스 변경 반영](docs/COMPOSE-APPLY.md)
- [저장소 탐색](docs/COMPOSE-STORAGE.md) · [이미지 내보내기](docs/IMAGE-EXPORT.md)
- [문제 제보·기능 제안](https://github.com/jgoneit/Docker2U/issues)

문제를 제보할 때 앱 버전, macOS 버전, 런타임 종류와 재현 순서를 함께 알려주세요.
로그·진단 정보에 비밀번호, 토큰, 내부 주소가 포함돼 있지 않은지 확인한 뒤 공유해 주세요.

## 개발에 참여하기

Rust + Tauri 2 + React + TypeScript로 구현합니다. 저장소에 고정한 Node·pnpm·Rust 도구체인을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm rust:fmt
pnpm rust:test
pnpm native:dev
```

Apple Silicon 앱과 DMG를 빌드하려면:

```sh
pnpm native:build:dmg --ci -- --locked
```

아이콘은 `assets/app-icon.png`에서 생성합니다. Docker CLI와 Engine은 앱 번들에 포함하지 않습니다.
실제 Engine 조작·네이티브 앱 확인·배포물 검증은 자동 테스트와 별도로 수행합니다.

- [제품·기술 기준](docs/DEVELOPMENT-DEFINITION.md)
- [로컬 개발과 알파 검증 기록](docs/MACOS-ALPHA.md)
- [DMG 빌드·서명·배포 검증](docs/releases/MACOS-DMG.md)
- [CI](.github/workflows/ci.yml) · [변경 내역](https://github.com/jgoneit/Docker2U/releases)

소개 사이트는 `site/`의 독립적인 정적 페이지입니다. Docker Engine에 연결하지 않습니다.
