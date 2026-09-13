# Compose 상태 표시·저장소 탐색 검증 기록

날짜: 2026-09-13

기준: 원격 main과 일치한 `d25e86c6691c8a4ed2af7ab8d2c027b0b461a0c1`

구현 브랜치: `codex/compose-storage-v1`

구현 위치: `/private/tmp/docker2u-compose-storage-v1-20260913`

## 변경과 경계

Compose 명령 종료와 현재 서비스 상태를 분리하고, actual container full ID를 사용하는
로그·진단 이동을 추가했다. `healthConfigured: boolean | null`로 미설정과 확인 불가를
구분한다. 저장소는 별도 typed IPC·전용 hook·세션 캐시로 조회하며 actual mounts만
프로젝트와 컨테이너 화면에 표시한다. 자세한 계약은 [기능 문서](COMPOSE-STORAGE.md)에 있다.

기존 체크아웃에 `.local-apps/`가 있어 격리 복제본에서 구현했다. 원본 제품 파일과
기존 설치 앱을 변경하지 않았다. 의존성 manifest·lockfile·Seal 검사 카탈로그는 유지했다.

## 수행한 검증

| 검증 | 결과 | 범위 |
| --- | --- | --- |
| 프런트 전체 검사 | 46파일·753건 통과 (17.71초) | Compose, Storage, 기존 로그·관찰·복사·선택 회귀 |
| 프런트 production build | 통과 | TypeScript, Vite, production fixture 격리 검사 5파일 |
| Rust 컴파일·format | 통과 | 신규 IPC·Core·process 옵션 포함 |
| mount parser 집중 검사 | 3건 통과 | bind/volume/tmpfs, nullable fields, malformed/foreign/duplicate IDs |
| process 캡처 집중 검사 | 3건 통과 | 신규 공통 출력 예산 2건과 기존 기본 캡처 회귀 |
| typed capability 검사 | 1건 통과 | 신규 명령의 선언·등록 계약 |
| Rust 전체 검사 | 93건 통과·114건 실패·기존 opt-in 6건 제외 | 실패 114건 모두 fixture Unix socket 생성의 EPERM |
| mount integration 집중 검사 | 8건 실패 | 기존 fixture의 UnixListener::bind에서 EPERM, 테스트 본문 진입 전 |
| Native Python fixture | 44건 중 38건 통과·6건 오류 | 신규 마운트 metadata 회귀 포함. 6건 모두 socket bind EPERM |
| macOS native:build | 통과 | release 바이너리와 Docker2U.app bundle 생성 |
| 브라우저 회귀 | 테스트 본문 미실행 | 준비된 Compose 7건·Storage 7건의 첫 실행은 webServer 시작 실패 |
| 네이티브 화면 | 미검증 | Engine fixture socket 생성 불가로 새 화면을 구동하지 못함 |
| 실제 Engine | 미검증 | desktop-linux context 확인 후 고정 socket의 info 접근에서 permission denied |

브라우저 첫 실행의 report는 `total=0`, `files=[]`, `webServer exit code 1`이었다.
독립 Vite 시작에서도 `listen EPERM 127.0.0.1:1423`을 확인했다. 따라서 한국어/영어,
라이트/다크, 1024×680·긴 경로의 실제 렌더링을 통과했다고 주장하지 않는다.
네이티브 앱 생성은 화면 조작·서명·공증·설치 앱 교체의 증거가 아니다.
생성 앱: `src-tauri/target/release/bundle/macos/Docker2U.app`.
해당 실행 파일 SHA-256: `a85083da34463e16d6bbecc484aad1d2d9067dd8eae67e36dccd17abd4267559`.

새 프런트 회귀는 Health 미설정·불명확·복제본·정상 종료·오래된 목록·이전 세션,
로그/진단 이동, 프로젝트 간 공유, stopped consumer, 부분 실패, ID 변경·재연결,
늦은 응답 폐기, 중복 수집 방지와 탭 포커스를 다룬다. App 통합 검사는 저장소 왕복 후
로그 필터·일시정지·위치·구독 유지와 실제 대상 탭 이동을 확인한다. jsdom 결과는
브라우저/WebView의 배치·대비·스크롤 경험을 대신하지 않는다.

## Seal

- CLI: `0.3.0-rc.4`, Plugin: `0.3.0-rc.4+codex.20260826154345`.
- 구현 전 생성한 Basic Task: `docker2u-compose-storage-v1-20260913`.
- 필수 검사: 기존 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`.
- 별도 브라우저·Native fixture·native build·실제 Engine 근거를 필수 검사 통과로 대체하지 않는다.
- 구현 후보 Run: `ef643429ed4b4e1ba575f50898c820b0`.
- `frontend-tests`, `frontend-build`, `rust-format` 통과, `rust-tests`는 exit 101로 실패했다.
- 해당 정확한 Run으로 complete를 요청했으며 필수 검사 실패로 exit 5 거절됐다.
  source stable과 scope 검사는 통과했지만 Basic Completion은 생성되지 않았다.
- 이후 게시 준비에서 이 결과를 문서에 반영했다. 게시 커밋에 대한 새로운 Acceptance를
  주장하지 않으며, 실패를 숨기기 위한 skip·카탈로그 완화는 하지 않았다.

## 남은 실제 환경 검증

socket 사용이 가능한 같은 작업본에서 Rust 전체 검사와 브라우저 행렬을 실행해야 한다.
새 Native fixture에서 프로젝트·컨테이너 저장소와 Compose 진행 창을 직접 확인해야 한다.
실제 Engine 검증은 고유 이름의 격리 프로젝트만 사용해 이미지 준비·빌드·실행·중지,
Health 전환, 복제본과 정상 종료 서비스, RO/RW·bind/volume/tmpfs 및 프로젝트 간 공유를
확인한다. 검증 전에 고유 프로젝트 이름과 생성 리소스를 기록하고, 종료 후 그 목록에
해당하는 검증 자원만 제거한다. 이번 실행은 실제 검증 자원을 만들지 않았고 기존
프로젝트에 변경 명령을 실행하지 않았다.

소켓 권한이 제공되면 이 작업본에서 남은 검증과 Seal Acceptance를 이어갈 수 있다.
기계적 검사·브라우저·네이티브·실제 Engine 결과는 각각 기록해야 한다.
또한 대규모 inventory에서 저장소 그룹 렌더링의 화면 반응성은 측정하지 않았다.
