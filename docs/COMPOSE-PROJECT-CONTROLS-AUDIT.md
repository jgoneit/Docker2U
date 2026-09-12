# Compose 프로젝트 등록·실행 v1 검증

작업 브랜치: `codex/compose-project-controls`  
기준 커밋: `93c96d17284126c10f32951d2bfb61eadbb2814c`  
검증일: 2026-09-13 (KST)

## 변경 범위

- 단일 최상위 Compose 파일·작업 폴더·환경 파일 등록과 Core 소유 원자 저장.
- 기존 프로젝트 이름을 선택 식별자로 유지하는 빈 프로젝트·발견 프로젝트 통합.
- 현재 Engine과 기본 builder를 명시한 `up --detach`·`stop`, 실행 전 검토,
  중복 방지, 취소·기한·출력 재조회 및 최근 작업.
- 등록 저장은 Engine 세션과 독립적으로 반영하고, 과거 연결의 보관된 작업 출력은
  읽기 전용으로 제공한다. 과거 작업은 현재 Engine의 실행·취소·상태 조회에 사용하지 않는다.

등록 파일에는 `version`, `projects`와 각 프로젝트의 `id`, `revision`, `name`,
`composeFile`, `workingDirectory`, `envFile`만 기록한다. 구성의 해석 결과·환경변수
값·세션·컨테이너 handle·작업 출력은 저장하지 않는다.

## 자동 검사

| 검사 | 결과 | 검증 경계 |
| --- | --- | --- |
| 프런트엔드 전체 | 692건 통과, 42개 파일 | React 단위·통합 검사 |
| Rust 전체 | 194건 통과, 6건 ignored | 실제 Engine opt-in 검사 6건 제외 |
| 브라우저 전체 | 378건 통과 | Chromium, light/dark, ko/en, 1024×680·1280×800, 추가 1600×1000 |
| 마지막 Compose 브라우저 회귀 | 36건 통과 | 등록·실행·중지, quiet 취소, 기존 프로젝트 로그 상태 보존 |
| Native fixture | 43건 통과 | 가짜 CLI·Unix socket·프로세스·증거 분류 |
| 프로덕션 프런트엔드 | 통과 | TypeScript, Vite, fixture 격리 검사 |
| Rust format | 통과 | 형식 검사 |
| macOS 프로덕션 번들 | 통과 | 서명하지 않은 Apple Silicon 빌드 |

집중 검사는 이름·환경 파일 제안/명시 해제, 손상·외부 변경 파일 보존, 같은 파일의
다른 프로젝트 이름, 변경된 해석 구성, 출처 불일치, Desktop 버전 접미사,
기본 builder 핀, 시작 전/실행 중 취소, 세션 무효화, 조용한 연결, 결과와 실제
상태의 구분, cursor 재조회와 보관 상한을 포함한다.

독립 리뷰 후 수정한 경계는 로그 reader의 직접 세션 무효화 시 취소 전달,
저장된 원격 builder 선택의 배제, 정식 Desktop Compose 버전 허용,
재연결 중 로컬 저장 완료 반영, 이전 연결의 작업 출력 복원이다.

병렬 빌드·브라우저 실행과 겹친 첫 프런트엔드 전체 검사에서는 기존 65개 소스 선택
검사 한 건이 5초 제한에 도달했다. 단독 전체 재실행은 686건 모두 통과했다.
구현 중 Vite HMR과 겹친 브라우저 실행은 최종 결과로 사용하지 않고, 코드 동결 후
관련 회귀를 다시 실행했다.

동시 빌드 중 Rust 전체 검사에서는 부모 종료 후 자손 정리 검사의 전체 소요 시간
3초 단정이 한 번 실패했다. 동일 바이너리의 개별 20회, 프로세스 검사 23건,
부하 종료 후 전체 194건은 모두 통과했다. 자손 제거도 확인했으며 소스와 시간
기준을 변경하지 않았다. 최초 지연 원인은 로그로 특정할 수 없어 부하에 민감한
검사 한계로 남긴다.

## Native Smoke 직접 조작

최종 번들: `96e0baa7dc9949c5a98255770a332a46`  
바이너리 SHA-256: `71601169d5d215385fedac26dd63195b29cc82394c582b94d27fae6ff6cf2ab5`  
Compose 흐름 실행: `d2u-smoke-bc8bc753f2` (`startedAtMs=1789227973276`).

Computer Use로 다음 화면을 직접 조작하고 AX 상태와 스크린샷을 확인했다.

- 실제 macOS 파일 선택기로 공백·한글 폴더의 `invalid.yaml`을 선택했다.
  `ComposeValidationFailed` 후 입력이 유지됐으며 파일명만 수정해 다시 검증했다.
- `compose.yaml` 검증에서 `native-compose`, 서비스 `api`·`worker`, 작업 폴더와
  `.env` 제안이 표시됐다. 환경 파일을 명시적으로 해제하고 재검증해도 빈 선택이 유지됐다.
- 등록 직후 미실행 프로젝트가 컨테이너 0개로 표시됐다. 실행 검토에 격리 Engine과
  두 서비스, 재생성 가능성이 표시됐고 실행 후 같은 부모 아래 실제 fixture 컨테이너
  두 개가 나타났다. 통합·개별 로그와 포트·네트워크 접속 정보를 확인했다.
- 실행 중 진행 창을 닫은 뒤 하단바로 다시 열어 완료 출력과 서비스 상태를 확인했다.
  Clear로 기존 행을 숨긴 뒤 `live-on`의 새 로그가 실제 viewport에 표시됐다.
- 중지 후 두 컨테이너가 삭제되지 않고 `exited`로 남았다.
- 부분 실패에서 `api`만 running, `worker`는 컨테이너 확인 대기로 표시됐다.
  `NATIVE_COMPOSE_PARTIAL_FAILURE` 출력과 `CommandFailed` 안내가 남았으며
  새 api의 전체 ID는 이전 컨테이너와 달랐다.
- quiet 작업은 수 분 동안 시작 출력 이후 추가 출력 없이 계속 처리 중이었다.
  창 닫기·다른 프로젝트 탐색·최소화 후에도 유지됐으며 명시적 취소 후
  `ResultUnknown`과 상태 재조회 결과를 표시했다.
- 재연결 후 최근 작업에서 이전 성공 작업의 출력을 다시 읽을 수 있었다.
  이전 연결 안내가 표시되고 이전 작업의 취소나 현재 서비스 상태는 표시되지 않았다.
- 라이트·한국어에서 다크·영어로 전환하고 최소 1024×680 창에서 로그 본문,
  진행 출력과 닫기 버튼에 접근할 수 있음을 확인했다.

첫 최소화 시도는 WebView의 10초 숨김 구간이 성립하지 않아 실패로 보존했다.
같은 실행에서 키보드 최소화 후 재검증은 40.677초의 실제 숨김 구간을 확인했다.
그 구간의 자원 표본 56개·로그 160행·이벤트 96개와 복원 viewport의 로그 15행을
확인했다. 합성 출력은 복원 전에 중단했다. 초기 실패가 원본 보고서에 남으므로
이 실행 전체를 자동 Native Smoke 통과로 표기하지 않는다.
원본 보고서는 `.cache/native-smoke/runs/d2u-smoke-bc8bc753f2/ui-results.json`에
보존했고, 별도의 깨끗한 최소화 실행 결과를 아래에 기록한다.

독립 관찰 실행 `d2u-smoke-dcd1f1d981` (`startedAtMs=1789229447179`)에서는
같은 바이너리를 Finder에서 먼저 활성화한 뒤 기준 수집 → 키보드 최소화 →
합성 출력 → 출력 중단 → 복원을 수행했다. 실제 숨김 구간 38.874초 동안
자원 표본 42개·로그 160행·Health 이벤트 103개를 수집했으며 복원 viewport에서
로그 15행이 보였다. 목록 generation은 3→18, 로그 sequence는 4→210이었다.
원본 `ui-results.json`의 실패 목록은 비어 있으며 controller의 `report --ui-results`
검증도 종료 코드 0, `observationCoverageComplete=true`로 통과했다.
증거는 `.cache/native-smoke/runs/d2u-smoke-dcd1f1d981/`에 보존했다.
중간 실행 `d2u-smoke-b70ff85578`은 활성화 전에 최소화 단축키를 보내 숨김 구간이
성립하지 않았으므로 통과 증거로 사용하지 않는다.

Compose 사용 흐름은 앞 실행의 직접 화면 확인 증거다. controller가 분류하는
`composeUiVerified`는 false로 유지하며 IPC 메타데이터로 직접 화면 검증을 대신하지
않는다. 독립 관찰 실행은 기존 모든 Legacy probe를 다시 실행한 결과가 아니므로
`requiredCoverageComplete=false`도 그대로 유지한다.

검증용 번들은 고유 bundle identifier, 격리 HOME·Docker 설정과 합성 Engine만
사용한다. 네이티브 파일 선택기는 실제 macOS 선택기이며 등록 저장과 Compose
명령 실행은 실제 Rust IPC를 통과한다. Compose 출력과 컨테이너 변화는 fixture가
합성한다. IPC 메타데이터 기록 자체는 UI 통과 판정으로 사용하지 않는다.
실행 중 확인한 등록 파일은 fixture HOME의 앱 설정 폴더에만 있었고 위 메타데이터
키만 포함했다. fixture 환경변수 비밀 sentinel은 저장 파일에 없었다.

## Acceptance와 보존

Seal Basic Task: `docker2u-compose-project-controls-20260913`.
필수 검사는 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`이다.
브라우저·Native Smoke 결과는 위의 별도 증거로 기록한다. 완료 후보의 정확한
Seal Run과 Completion 결과는 작업의 최종 응답에 기록한다.

원래 `main` 작업본의 HEAD `93c96d1`과 미추적 `.local-apps/`가 유지됨을 확인했다.
`git diff --check`도 통과했다. 이 기능 작업에서는 설치 앱 교체,
커밋·푸시·PR 생성·병합을 수행하지 않는다.

## 확인하지 않은 범위

- 실제 사용 중인 Docker Engine에서 Compose 생성·재생성·빌드·중지를 실행하지 않았다.
- 실제 이미지 다운로드, BuildKit 빌드 및 서비스 자체의 준비 완료는 fixture 결과로
  입증되지 않는다. 명령 성공과 서비스 Health는 구분해야 한다.
- Dockerfile·build context 전체를 실행 직전 스냅샷으로 고정하지 않는다.
- 코드 서명·notarization·Gatekeeper 배포 승인은 이번 검증에 포함하지 않는다.
