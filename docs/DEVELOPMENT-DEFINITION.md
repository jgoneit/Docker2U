# Docker2U 개발 정의서

> **Docker CLI, without the CLI friction.**

| 항목 | 내용 |
| --- | --- |
| 문서 상태 | Draft |
| 문서 버전 | 1.0 |
| 작성일 | 2026-09-01 |
| 제품 목표 버전 | Docker2U v0.1 |
| 대상 플랫폼 | Windows, macOS |
| 기술 방향 | Rust + Tauri 2 + TypeScript + Svelte |
| 구현 상태 | 미착수 — 본 문서는 개발 정의만 다룬다 |

---

## 1. 문서 목적

이 문서는 Docker2U의 제품 목적, 사용자, 지원 환경, 기능 범위, 안전 경계,
기술 구조, 배포 방식, 테스트 및 완료 기준을 하나의 기준으로 고정한다.

Docker2U v0.1의 개발과 리뷰는 이 문서를 기준으로 수행한다. 문서에 없는
기능은 기본적으로 v0.1 범위가 아니다.

이 문서는 애플리케이션 구현을 포함하지 않는다.

---

## 2. 한 문장 정의

> Docker2U는 Windows와 macOS에서 이미 설치된 조직 승인 로컬 컨테이너
> 런타임을 비전문 개발자가 안전하게 조회하고 복구할 수 있도록 돕는
> 경량 데스크톱 컨트롤 패널이다.

Docker2U가 최적화하는 핵심 작업은 다음과 같다.

```text
로컬 개발 의존 서비스에 문제가 발생함
        ↓
Docker2U 실행
        ↓
Engine / Context / Container 상태 확인
        ↓
최근 로그 확인
        ↓
Start / Stop / Restart
        ↓
최신 상태를 다시 확인
```

목표는 사용자가 Docker 명령어를 검색하지 않고 1분 안에 이 흐름을
완료하도록 돕는 것이다.

---

## 3. 배경과 문제 정의

### 3.1 배경

일부 기업은 조직 규모, 비용, 보안 또는 구매 정책으로 인해 Docker Desktop
유료 구독을 도입하지 않는다. 대신 별도로 승인된 Docker/Moby 기반 런타임,
가상 머신 또는 호환 환경과 Docker CLI를 제공할 수 있다.

이 환경에서도 Docker CLI를 자주 사용하지 않는 개발자는 다음 명령을
반복적으로 검색한다.

```bash
docker ps -a
docker start
docker stop
docker restart
docker logs
```

명령 자체는 단순하지만 다음 마찰이 반복된다.

- 어떤 컨테이너가 중지되었는지 바로 알기 어렵다.
- 현재 Docker context가 어느 Engine을 가리키는지 놓치기 쉽다.
- 명령 문법과 옵션을 반복해서 검색한다.
- 실패한 명령의 원인과 다음 행동을 이해하기 어렵다.
- Docker 전문가가 아닌 사용자는 잘못된 대상을 조작할까 불안해한다.

### 3.2 반드시 분리할 두 문제

| 문제 | Docker2U의 책임 |
| --- | --- |
| 로컬 컨테이너 런타임이 설치되어 있지 않다 | 해결하지 않는다 |
| 런타임은 있지만 CLI 조작이 어렵다 | 해결한다 |

Docker2U는 Docker Engine, Linux VM 또는 Docker Desktop을 제공하지 않는다.
Docker CLI만 설치되어 있고 연결 가능한 Engine이 없다면 Docker2U도
컨테이너를 실행할 수 없다.

### 3.3 제품 가설

다음 조건이 존재하면 Docker2U는 반복적인 개발환경 복구 비용을 줄일 수 있다.

- 조직이 Windows 또는 macOS 개발자에게 로컬 컨테이너 런타임을 제공한다.
- 사용자는 이미 만들어진 컨테이너를 반복적으로 조회·재시작한다.
- 사용자는 Docker CLI를 매일 사용하지 않는다.
- 기존 런타임 UI가 없거나, 있어도 일상 작업에 비해 복잡하다.
- 조직은 서버·계정 없이 로컬에서만 동작하는 작은 도구를 선호한다.

---

## 4. 제품 포지셔닝

Docker2U는 다음 제품이 아니다.

```text
Docker Desktop replacement
Container runtime installer
Container runtime manager
Docker license provider
Portainer replacement
Podman Desktop replacement
Rancher Desktop replacement
Container monitoring platform
Docker IDE
Kubernetes management tool
Remote production operations tool
```

Docker2U의 위치는 다음과 같다.

```text
┌──────────────────────────────┐
│          Docker2U            │
│   Safe local recovery UI     │
└──────────────┬───────────────┘
               │ typed IPC
               ▼
┌──────────────────────────────┐
│        Rust Core             │
│ policy / process / parsing   │
└──────────────┬───────────────┘
               │ fixed commands
               ▼
┌──────────────────────────────┐
│       Docker CLI             │
│ organization-provided       │
└──────────────┬───────────────┘
               │ pinned local endpoint
               ▼
┌──────────────────────────────┐
│ Approved local Engine / VM   │
└──────────────────────────────┘
```

### 4.1 가치 제안

- 기존 승인 런타임과 Docker CLI를 그대로 사용한다.
- 서버, 계정, 로그인, 중앙 저장소가 없다.
- 상태 확인, 최근 로그, 기본 복구 작업에만 집중한다.
- 실행 명령과 오류를 숨기지 않는다.
- 삭제·Prune·생성·설정 변경 기능을 제공하지 않는다.
- 현재 context와 endpoint를 명확히 보여준다.
- Windows와 macOS에서 같은 제품 경험을 제공한다.

### 4.2 Lightweight의 의미

Docker2U에서 Lightweight는 단순히 바이너리 크기가 작다는 뜻이 아니다.

```text
작은 인지 표면
+
작은 기능 표면
+
작은 권한 표면
+
작은 운영 부담
```

기능 수를 경쟁력으로 삼지 않는다.

---

## 5. 사용자 정의

### 5.1 Primary User

- Windows 또는 macOS를 사용하는 사내 개발자
- 로컬 DB, Redis, 메시지 브로커, 사내 서비스 등을 컨테이너로 사용하는 사람
- Docker CLI를 가끔 사용하며 명령을 반복적으로 검색하는 사람
- 이미 만들어진 컨테이너의 상태 확인과 복구가 주 작업인 사람
- Docker 또는 Container Runtime 전문가가 아닌 사람

### 5.2 Buyer / Approver

Docker2U는 최종 사용자 외에 다음 이해관계자의 승인을 받아야 한다.

- 개발환경을 표준화하고 배포하는 플랫폼팀
- 소프트웨어 설치·보안·라이선스를 검토하는 IT팀
- 개발자 온보딩과 지원 문의를 줄이려는 개발 리드

### 5.3 Non-Target

- 로컬 컨테이너 런타임이 없는 사용자
- Docker Desktop 수준의 VM·네트워크·파일 공유 관리가 필요한 사용자
- Docker CLI 숙련자
- Kubernetes 운영자
- 원격 또는 운영 Engine 관리자
- 이미지 빌드와 레지스트리 관리가 주요 작업인 사용자
- 복잡한 Docker Compose 프로젝트 운영이 주요 작업인 사용자
- Container 생성·삭제·볼륨·네트워크 관리가 필요한 사용자

### 5.4 사용 전제

Docker2U를 사용하려면 다음 조건이 충족되어야 한다.

```text
[필수] 조직이 승인한 로컬 컨테이너 런타임이 설치되어 있다.
[필수] 런타임이 실행 중이거나 사용자가 별도로 실행할 수 있다.
[필수] Docker CLI가 호스트 OS에서 실행 가능하다.
[필수] Docker CLI가 명시적인 local context를 통해 Engine에 연결된다.
[필수] 사용자는 해당 Engine을 조작할 권한을 이미 가지고 있다.
```

Docker2U는 권한을 추가로 부여하거나 우회하지 않는다.

---

## 6. 제품 원칙

### 6.1 Docker를 숨기지 않는다

```text
Docker를 감춘다                 ❌
Docker를 더 쉽게 사용하게 한다 ✅
```

사용자는 실행한 작업과 그에 대응하는 Docker 명령을 확인하고 복사할 수 있다.

### 6.2 Recovery First

화면과 기능은 `상태 확인 → 로그 확인 → 복구 → 결과 확인` 흐름에 맞춘다.

### 6.3 Local Only

v0.1은 검증된 로컬 endpoint만 허용한다. Remote Engine은 기능 부족이 아니라
의도적으로 차단하는 안전 경계다.

### 6.4 Explicit Target

사용자는 항상 다음 정보를 확인할 수 있어야 한다.

- 현재 Docker context
- endpoint 유형
- Engine provider와 Server 버전
- 선택한 Container Name
- 실제 명령 대상인 full Container ID

### 6.5 Safe by Small Surface

범용 shell, 자유 형식 명령, 임의 인자 입력을 제공하지 않는다. 사용자는 제품이
미리 정의한 작업만 실행할 수 있다.

### 6.6 No Silent Magic

Docker2U는 자동으로 다음 작업을 수행하지 않는다.

- Docker context 변경
- Engine 또는 VM 실행
- Docker CLI 설치
- Container 생성·삭제
- 설정 파일 변경
- 원격 endpoint 연결
- 관리자 권한 상승

### 6.7 Engine이 Source of Truth다

Docker Engine의 실제 상태가 Container 상태의 유일한 기준이다. Docker CLI는
Engine과 통신하기 위한 실행 adapter이고, UI 목록은 마지막 조회 시점의 snapshot이다.

- 버튼 활성화 여부만으로 실행 가능성을 단정하지 않는다.
- CLI exit code만으로 현재 Container 상태를 추정하지 않는다.
- 모든 mutation 후 Engine 상태를 다시 조회한다.
- 조회에 실패하면 이전 목록을 최신 상태처럼 표시하지 않고 `Stale`로 표시한다.

---

## 7. 런타임 및 플랫폼 지원 정책

### 7.1 BYOR 원칙

Docker2U는 BYOR(Bring Your Own Runtime) 방식으로 동작한다.

> 조직이 설치·승인·업데이트하는 Runtime을 Docker2U가 조작한다.

Docker2U 배포물에는 다음 항목을 포함하지 않는다.

- Docker Desktop
- Docker Engine / dockerd
- Docker CLI
- Linux VM
- Podman Machine
- Colima
- Rancher Desktop
- Docker Compose

### 7.2 v0.1 검증 기준 플랫폼

| SupportedRuntimeProfileId | 플랫폼 | 초기 검증 Runtime | Endpoint |
| --- | --- | --- | --- |
| `win11-x64-rd-moby-v0_1` | Windows 11 x64 | Rancher Desktop `dockerd (moby)` | local named pipe (`npipe://`) |
| `mac14-arm64-colima-v0_1` | macOS 14+ Apple Silicon | Colima Docker runtime | local Unix socket (`unix://`) |

두 조합을 v0.1 초기 인증 기준선으로 삼는다. 대상 조직이 별도 Docker/Moby
provider를 표준으로 사용한다면 Phase 0에서 같은 contract suite를 통과시킨 뒤
그 조합으로 교체하거나 호환 대상으로 추가한다. 테스트하지 않은 provider를
공식 지원 대상으로 표현하지 않는다.

각 profile은 다음 값을 release 전에 고정한다.

```text
SupportedRuntimeProfileId
Host OS와 architecture 범위
EngineKind
Runtime 제품·version 범위
Docker CLI source·version 범위
Server/API version 범위
허용 endpoint pattern
판별에 사용하는 복수의 진단 signal
Contract suite revision과 마지막 통과일
```

초기 exact version 범위는 Phase 0의 실환경 조사와 contract test에서 확정한다.
범위가 채워지지 않은 profile로 구현 Phase 1에 진입하지 않는다. Profile catalog는
앱 release에 read-only로 포함하고 사용자가 임의로 추가하거나 수정할 수 없게 한다.

### 7.3 Provider 정책

| Provider | v0.1 정책 |
| --- | --- |
| Windows Rancher Desktop `dockerd (moby)` | 초기 인증 조합, mutation 허용 |
| macOS Colima Docker runtime | 초기 인증 조합, mutation 허용 |
| 조직 자체 Docker/Moby Engine | contract suite 통과 후 support profile에 등록된 조합만 허용 |
| 적법하게 사용 중인 Docker Desktop | 호환성 참고 대상, v0.1 제품 전제·공식 지원 아님 |
| Podman Docker compatibility | 실험 또는 향후 후보, v0.1 공식 지원 아님 |
| Finch docker compatibility | v0.1 공식 지원 아님 |
| containerd / nerdctl | 지원하지 않음 |
| Remote Docker Engine | 차단 |
| Unknown provider | 진단 정보만 표시하고 mutation 차단 |

Podman을 Docker Engine으로 표현하지 않는다. 호환 provider는 공급자 이름과
지원 수준을 정확히 표시한다.

`docker info`의 OperatingSystem·version 문자열이나 generic `Docker/Moby` 이름만으로
provider를 신뢰하거나 mutation을 허용하지 않는다. Mutation 허용은 local endpoint
검증과 Phase 0에서 승인한 `SupportedRuntimeProfileId` 및 contract suite 결과를 함께 기준으로
한다. Provider 문자열은 사용자 진단 정보이며 remote 여부를 증명하는 값이 아니다.

내부 모델에서 protocol 계열인 `EngineKind`와 검증된 제품 조합인
`SupportedRuntimeProfileId`를 분리한다. 미검증 local Moby, Docker Desktop,
provider 판별 signal 일부만 일치하는 환경은 read-only 진단만 허용한다.

```text
EngineKind = DockerEngine | Moby | DockerCompatible | Unknown
```

### 7.4 Local endpoint 정책

v0.1 기본 허용:

```text
unix://...
npipe://...
```

v0.1 기본 차단:

```text
tcp://...
ssh://...
http://...
https://...
```

Loopback TCP를 포함한 TCP endpoint는 v0.1에서 예외 허용하지 않는다.

허용 여부는 문자열 prefix가 아니라 구조화된 endpoint parser로 판단한다.

- macOS에서는 authority가 없고 절대경로를 가진 `unix://` endpoint만 허용한다.
- socket이 존재하면 실제 Unix socket인지 확인한다.
- Windows에서는 local machine의 `\\.\pipe\...`에 대응하는 `npipe://`만 허용한다.
- `fd://`와 변형·percent encoding으로 위 규칙을 우회하는 endpoint도 차단한다.

이 정책은 Docker2U가 원격 endpoint에 직접 연결하는 것을 차단한다. 로컬 socket
뒤의 별도 프로세스가 원격 Engine을 proxy하는지까지 판별하거나 보증하지는 않는다.

### 7.5 지원하지 않는 환경의 처리

Docker2U는 지원하지 않는 환경을 임의로 고치지 않는다.

```text
Runtime unavailable

승인된 로컬 컨테이너 런타임에 연결할 수 없습니다.
조직의 개발환경 또는 IT 담당자에게 문의하세요.

[Retry] [Copy diagnostics]
```

Docker Desktop 설치를 자동 제안하거나 사용권이 무료라고 추정하지 않는다.

---

## 8. v0.1 기능 범위

### 8.1 환경 진단

앱 시작 시 다음 순서로 환경을 확인한다.

```text
Docker CLI 탐색
        ↓
CLI 절대경로와 Client 버전 확인
        ↓
Docker context 확인
        ↓
실제 endpoint와 scheme 확인
        ↓
Local-only 정책 적용
        ↓
검증된 endpoint를 environment session에 고정
        ↓
Engine 연결 확인
        ↓
Provider / Server Version / OSType 확인
```

Target resolver는 Docker CLI의 선택 우선순위를 해석한다. `DOCKER_CONTEXT`가
지정되면 `DOCKER_HOST`와 기본 context보다 우선하고, 그렇지 않으면 명시된 host와
기본 context를 구분해 실제 endpoint를 확인한다. 프런트엔드는 context 이름이나
endpoint 문자열을 직접 지정할 수 없다. 허용된 endpoint는 새로운
`EnvironmentSessionId`와 함께 고정한다.

같은 socket 또는 named pipe 뒤의 Engine instance가 교체되는 상황을 구분하기 위해
session 생성 시 `EngineFingerprint`도 고정한다.

```text
EngineFingerprint
- canonical endpoint
- Engine ID
- OSType와 architecture
- Server version과 API version
- SupportedRuntimeProfileId
```

초기 인증 profile은 non-empty Engine ID를 필수 signal로 요구한다. Mutation 직전
최소 `docker info` 조회로 fingerprint를 다시 계산하며, 하나라도 달라지면 기존
session과 handle을 폐기하고 mutation을 실행하지 않는다. 사용자는 Reconnect로
새 Engine을 명시적으로 검증해야 한다. CLI 두 호출 사이 Engine이 바뀌는 잔여
TOCTOU 위험은 제거할 수 없으므로 full ID 사용과 post-action reconciliation을
함께 유지한다.

진단 결과는 다음 상태를 구분한다.

| 상태 | 의미 |
| --- | --- |
| Ready | 지원되는 로컬 Engine에 연결됨 |
| CliNotFound | Docker CLI를 찾지 못함 |
| CliInvalid | 선택한 파일이 유효한 Docker CLI가 아님 |
| ContextMissing | 사용할 수 있는 명시적 context가 없음 |
| RemoteBlocked | endpoint가 local-only 정책을 위반함 |
| EngineUnavailable | CLI는 있으나 Engine에 연결할 수 없음 |
| PermissionDenied | 현재 사용자 권한으로 Engine을 조작할 수 없음 |
| RuntimeProfileUnsupported | 연결됐으나 승인된 v0.1 Runtime profile과 일치하지 않음 |
| VersionUnsupported | 지원 범위 밖의 CLI 또는 Server 버전 |
| UnknownFailure | 분류되지 않은 실패 |

UI 상단에는 항상 다음을 표시한다.

```text
Engine ● Connected
Runtime: Colima (Supported)
Engine: Moby
Context: colima
Endpoint: Local Unix Socket
```

원본 endpoint 전체 경로는 상세 진단 화면에서 확인한다.

### 8.2 Container 목록

모든 Container를 조회한다.

내부 조회 원칙:

```text
docker --host <pinned-local-endpoint>
       container ls
       --all
       --no-trunc
       --format json
```

문자열 표를 공백 기준으로 분리하지 않는다. Docker CLI가 제공하는 구조화된
JSON Lines를 파싱한다.

한 번의 Refresh 결과는 원자적으로 처리한다. 모든 line을 임시 결과로 파싱한 뒤
필수 field가 누락되거나 line 하나라도 malformed이면 일부 Container만 조용히
표시하지 않는다. 마지막 성공 목록을 `Stale`로 유지하고 Refresh 실패를 알린다.
알 수 없는 추가 field는 허용한다.

Container State와 Health의 authoritative source는 구조화된 batch inspect다.
목록에서 얻은 full ID를 최대 100개씩 나눠 다음 명령을 추가 실행한다.

```text
docker --host <pinned-local-endpoint>
       container inspect
       --format <rust-owned-state-health-json-template>
       <full-id-1> ... <full-id-N>
```

Template은 full ID, `State.Status`, 존재하는 경우 `State.Health.Status`만 JSON
Lines로 출력하며 프런트엔드 입력을 포함하지 않는다. Health object가 없으면
`none`, 알 수 없는 값은 `unknown`으로 보존한다. 행마다 process를 만들지 않는다.
List와 모든 inspect chunk가 완전히 성공하고 ID가 일대일로 대응할 때만 새
generation을 commit한다.

내부 모델은 다음 정보를 가진다.

- Full Container ID
- Short Container ID
- Name
- Image
- State
- Status
- Health
- Ports

목록 화면 기본 표시:

| 표시 | 기본 노출 |
| --- | --- |
| Name | O |
| 사용자용 상태 | O |
| Health | O |
| Image | O |
| Ports | O |
| Status 상세 | 선택 시 표시 |
| Short ID | 선택 시 표시 |
| Full ID | 상세 정보에서 복사 가능 |

Full ID는 실제 작업 식별자이고 Name은 표시용이다.

Health 내부 값은 `none | starting | healthy | unhealthy | unknown`으로 정규화한다.

### 8.3 사용자용 상태 모델

Docker의 원본 State는 내부에 그대로 보존한다.

| Docker State | 사용자 표시 | 분류 |
| --- | --- | --- |
| created | Created | 정지 상태 |
| running | Running | 실행 상태 |
| paused | Paused | 특수 상태 |
| restarting | Restarting | 진행 상태 |
| removing | Removing | 진행 상태 |
| exited | Stopped | 정지 상태 |
| dead | Error | 오류 상태 |
| 그 외 | Unknown | 알 수 없음 |

`Status` 문자열은 사용자 표시용이며 Action 허용 판단에 사용하지 않는다.
Action 정책은 정규화한 `State` enum을 사용한다.

### 8.4 Action 정책

| State | Start | Stop | Restart | Recent Logs |
| --- | ---: | ---: | ---: | ---: |
| created | O | X | X | O |
| running | X | O | O | O |
| paused | X | X | X | O |
| restarting | X | X | X | O |
| removing | X | X | X | X |
| exited | O | X | X | O |
| dead | X | X | X | O |
| unknown | X | X | X | X |

UI Action 정책은 실수를 줄이는 1차 방어선이다. Docker Engine의 실제 응답이
최종 결과이며, 상태 경쟁으로 명령이 실패할 수 있음을 정상적으로 처리한다.

### 8.5 Start

`created` 또는 `exited` Container를 시작한다.

```text
docker --host <pinned-local-endpoint> container start <full-id>
```

Start는 별도 확인창 없이 실행한다. 실행 중 해당 Container의 모든 mutation
버튼을 잠그고 완료 후 전체 상태를 다시 조회한다.

### 8.6 Stop

`running` Container를 중지한다.

```text
docker --host <pinned-local-endpoint> container stop <full-id>
```

Stop은 서비스 중단과 강제 종료 가능성이 있으므로 다음 확인창을 표시한다.

```text
Stop backend?

Context: colima
Container: backend
ID: a1b2c3d4e5f6

[Cancel] [Stop]
```

### 8.7 Restart

`running` Container를 재시작한다.

```text
docker --host <pinned-local-endpoint> container restart <full-id>
```

Restart도 대상과 context를 표시하는 확인창을 사용한다.

### 8.8 Mutation 공통 규칙

Start, Stop, Restart 직전 다음 항목을 다시 확인한다.

- 요청의 environment session이 Rust Core가 소유한 active session과 동일하다.
- session에 고정된 endpoint가 여전히 local-only 규칙을 만족한다.
- SupportedRuntimeProfileId가 mutation 허용 대상이다.
- EngineFingerprint가 session 생성 시 고정한 값과 일치한다.
- Container handle이 현재 session의 마지막 정상 조회 결과에 존재한다.
- Rust Core가 handle을 유효한 full Container ID로 변환할 수 있다.
- 동일 Container에 다른 mutation이 실행 중이지 않다.

명령 종료 후 성공·실패와 관계없이 Container 목록을 다시 조회한다.
외부에서 active context가 바뀌어도 현재 session target을 자동으로 따라가지 않는다.
사용자가 `Reconnect`를 실행할 때만 target을 다시 해석하고 고정한다.

### 8.9 최근 로그

v0.1은 실시간 Follow가 아니라 최근 로그 snapshot만 제공한다. Docker CLI에는 최대
300줄을 요청하되, 표시와 Copy 대상은 byte 상한 적용 후 남은 마지막 2 MiB다.

```text
docker --host <pinned-local-endpoint>
       container logs
       --tail 300
       --timestamps
       <full-id>
```

로그 규칙:

- stdout과 stderr를 동시에 소비한다.
- UI 표시 buffer는 최대 2 MiB로 제한한다.
- 한도를 넘으면 앞부분을 버리고 truncation 상태를 표시한다.
- exit code가 0이면 stdout과 stderr를 모두 Container 로그 콘텐츠로 취급한다.
- exit code가 0이 아닐 때 stderr를 Docker CLI 진단으로 분류한다.
- 잘못된 UTF-8 byte는 replacement character로 대체한다.
- ANSI escape와 위험한 control character를 제거하고 plain text node로만 렌더링한다.
- 로그 표시에는 HTML 실행 경로를 사용하지 않는다.
- 로그를 디스크에 자동 저장하지 않는다.
- Clear는 UI buffer만 지우며 Container 로그를 삭제하지 않는다.
- Copy는 화면에 남은 마지막 2 MiB만 복사하며 truncation 안내를 함께 유지한다.
- logging driver가 로그 읽기를 지원하지 않는 경우 정상적인 비지원 상태로 표시한다.
- Container 로그에는 민감정보가 포함될 수 있음을 사용자에게 알린다.

### 8.10 Manual Refresh

Manual Refresh는 항상 제공한다.

Refresh 규칙:

- 실행 중에는 중복 Refresh를 합치거나 이전 Refresh를 취소한다.
- 오래된 결과가 최신 결과를 덮어쓰지 않도록 generation을 구분한다.
- 마지막 성공 갱신 시각을 표시한다.
- mutation 직후에는 자동으로 한 번 Refresh한다.

주기적인 Auto Refresh는 v0.1 범위가 아니다.

### 8.11 Command Visibility

사용자가 실행한 작업에는 다음 정보를 제공한다.

- 사용자용 결과 요약
- 실행 대상 Container
- 고정된 context
- 실행한 Docker subcommand와 arguments
- Exit code
- 상한이 적용된 stderr
- 경과 시간
- Copy equivalent command

실제 프로세스 호출은 argument array로 이루어지므로, 복사용 문자열은
`Equivalent command`로 명시한다.

### 8.12 Error Handling

작업 결과는 다음 Outcome 중 하나다.

| Outcome | 의미 |
| --- | --- |
| Succeeded | 명령이 정상 종료되고 exit code가 0임 |
| Failed | 명령이 종료됐고 non-zero exit code를 반환함 |
| StartFailed | CLI 프로세스를 시작하지 못함 |
| TimedOut | 제한 시간 내 CLI 프로세스가 종료되지 않음 |
| Cancelled | 읽기 작업 또는 화면 작업을 사용자가 취소함 |
| ResultUnknown | mutation이 Engine에 전달됐을 수 있으나 최종 결과를 확정할 수 없음 |
| MalformedOutput | 구조화된 CLI 응답을 완전하게 해석할 수 없음 |
| OutputLimitExceeded | 구조화된 응답이 정해진 byte 상한을 초과함 |

위 Outcome은 CLI 실행 결과이고, 화면의 현재 Container 상태는 별도 Engine 조회
결과다. exit code 0만으로 화면 상태를 임의 변경하지 않는다.

Start/Stop/Restart 프로세스가 timeout, cancellation, 강제 종료 또는 응답 중단된
경우 단순 `Failed`로 단정하지 않는다. Engine 작업이 이미 시작되었을 수 있으므로
`ResultUnknown`을 표시하고 같은 full ID의 상태를 즉시 다시 조회한다.

`ResultUnknown` 작업을 자동 재시도하지 않는다. 재조회가 실패하면 Outcome을
그대로 유지하고 이전 목록을 `Stale`로 표시하며, environment가 다시 검증될 때까지
추가 mutation을 차단한다. 완전한 non-zero 응답은 `Failed`로 분류하되 실제 상태는
마찬가지로 다시 조회한다.

Reconciliation으로 현재 상태를 확인해도 원래 CLI Outcome인 `ResultUnknown`은
`Succeeded`나 `Failed`로 변경하지 않는다. `ReconciliationStatus`와
`ObservedContainerState`를 별도로 표시한다. 특히 Restart 전후가 모두 `running`일 수
있으므로 현재 상태만으로 명령 성공을 역추정하지 않는다.

오류 UI 순서:

```text
사용자용 설명
        ↓
권장 다음 행동
        ↓
Command / Exit Code / stderr 상세
```

Docker 버전별 stderr 문자열에 강하게 의존하는 세밀한 오류 분류는 피한다.

---

## 9. UI 정의

### 9.1 Main Window

```text
┌───────────────────────────────────────────────────────────────────┐
│ Docker2U                 Colima/Moby ● Connected                  │
│ Context: colima          Local Unix Socket        [Diagnostics]  │
├───────────────────────────────────────────────────────────────────┤
│ Containers                                   Updated 14:03 [Refresh]│
│                                                                   │
│ NAME       STATE       HEALTH      IMAGE             PORTS        │
│ backend    Running     Healthy     company-api       8080:8080    │
│ redis      Running     —           redis:7           6379:6379    │
│ oracle     Stopped     —           oracle:19c        —            │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│ Selected: backend                                                 │
│ Image: company-api                                                │
│ ID: a1b2c3d4e5f6                            [Copy full ID]        │
│                                                                   │
│ [Start] [Stop] [Restart] [Recent Logs]                            │
└───────────────────────────────────────────────────────────────────┘
```

### 9.2 UI 원칙

- 한 번에 한 Container를 명시적으로 선택한다.
- 행별 모호한 아이콘 버튼과 하단 버튼을 중복 제공하지 않는다.
- Action은 텍스트 레이블과 접근 가능한 이름을 가진다.
- 색상만으로 상태를 표현하지 않는다.
- Disabled 상태에는 이유를 확인할 수 있어야 한다.
- Loading, Empty, Disconnected, Busy, Error 상태를 기능과 함께 구현한다.
- 목록 선택이 바뀌어도 이미 시작된 작업의 대상은 full ID로 고정한다.
- 키보드 탐색과 스크린 리더용 레이블을 제공한다.

### 9.3 Empty State

Engine 연결에는 성공했지만 Container가 없는 상태를 Engine 연결 실패와
구분한다.

```text
No containers found

현재 Engine에 생성된 Container가 없습니다.
Docker2U는 Container 생성 기능을 제공하지 않습니다.
```

### 9.4 Diagnostics 화면

다음 정보를 표시하고 복사할 수 있다.

- Docker2U version
- OS와 architecture
- Docker CLI 절대경로
- Docker Client version
- Context name
- Endpoint scheme과 상세 경로
- EngineKind와 Provider 진단 문자열
- SupportedRuntimeProfileId
- Server version
- Server OSType
- Engine fingerprint 요약
- 최근 진단 Outcome

환경 변수 전체, Docker config 내용, credential, Container 로그는 진단 복사에
포함하지 않는다.

---

## 10. 기술 스택

```text
Desktop Framework   Tauri 2
Backend             Rust stable + Tokio
Frontend            TypeScript strict + Svelte
Bundler             Vite
Package Manager     pnpm
Serialization       Serde-compatible typed payloads
Process Layer       Rust async process management
```

Rust toolchain과 Rust·frontend dependency는 저장소의 toolchain 및 lockfile로
고정한다. 플랫폼은 하나의 source tree를 공유하지만 산출물은 각 native OS에서
별도로 build한다.

### 10.1 선택 이유

- Windows와 macOS를 하나의 코드베이스로 지원할 수 있다.
- 운영체제 WebView를 사용하므로 Chromium을 번들하지 않는다.
- Process lifecycle과 입력 검증을 Rust Core에 집중할 수 있다.
- Tauri capability와 typed IPC로 프런트엔드 권한을 최소화할 수 있다.
- 플랫폼별 서명 설치물을 생성할 수 있다.

### 10.2 WebView 차이

Windows는 WebView2, macOS는 WKWebView를 사용한다. 같은 HTML/CSS라도 렌더링,
키보드, 스크롤, 폰트 동작에 차이가 있을 수 있으므로 두 플랫폼의 실제 장비에서
UI 검증을 수행한다.

### 10.3 Rust + Tauri 결정

Docker2U v0.1은 `.NET` 계열 데스크톱 stack 대신 Rust + Tauri 2를 채택한다.
이는 `.NET`의 일반적 우열 판단이 아니라 현재 제품 경계에 대한 선택이다.

- 하나의 UI source와 Rust Core로 Windows·macOS를 함께 지원한다.
- Docker CLI process lifecycle, endpoint policy, parser를 Rust 신뢰 경계에 둔다.
- 프런트엔드에는 typed IPC와 제한된 capability만 노출한다.
- OS WebView를 사용해 별도 Chromium runtime을 제품에 포함하지 않는다.

다음 상황이 확인되면 구현 전에 결정을 다시 검토한다.

- 제품이 사실상 Windows 전용이 되고 AD·그룹 정책·Windows native UI 통합이
  핵심 요구사항이 됨
- 팀이 Rust/Tauri를 운영·보안 patch할 역량을 확보하지 못함
- WebView2와 WKWebView 차이로 핵심 UX를 동일하게 제공할 수 없음
- Tauri의 서명·패키징·접근성 경로가 대상 기업 배포 요건을 충족하지 못함

---

## 11. 내부 구조

불필요한 레이어를 늘리지 않되 보안 경계는 분리한다.

```text
Docker2U
│
├─ src/                         # Svelte frontend
│  ├─ routes/
│  ├─ components/
│  ├─ stores/
│  ├─ ipc/
│  └─ types/
│
├─ src-tauri/
│  ├─ capabilities/
│  ├─ icons/
│  └─ src/
│     ├─ application/
│     │  ├─ environment_service
│     │  ├─ container_service
│     │  └─ operation_coordinator
│     ├─ docker/
│     │  ├─ cli_locator
│     │  ├─ target_resolver
│     │  ├─ command_spec
│     │  ├─ command_runner
│     │  ├─ container_parser
│     │  └─ provider_detector
│     ├─ domain/
│     │  ├─ environment
│     │  ├─ container
│     │  ├─ action_policy
│     │  └─ operation_result
│     ├─ platform/
│     │  ├─ windows
│     │  └─ macos
│     ├─ ipc/
│     └─ diagnostics/
│
└─ tests/
   ├─ fixtures/
   ├─ fake-docker/
   └─ integration/
```

폴더는 실제 책임이 생겼을 때 만든다. 범용 `utils` 폴더는 두지 않는다.

---

## 12. IPC 보안 경계

### 12.1 허용 IPC

프런트엔드는 의도가 명확한 typed command만 호출할 수 있다.

```text
get_environment()
choose_and_validate_cli()
reconnect_environment()
list_containers(environment_session_id)
start_container(environment_session_id, container_handle)
stop_container(environment_session_id, container_handle)
restart_container(environment_session_id, container_handle)
get_recent_logs(environment_session_id, container_handle)
cancel_read_operation(operation_id)
copy_diagnostics()
```

### 12.2 금지 IPC

다음과 같은 범용 실행 API는 만들지 않는다.

```text
execute(command: string, arguments: string[])
run_shell(script: string)
open_terminal(command: string)
run_docker(raw_args: string[])
```

프런트엔드는 개별 Docker operation에서 다음 값을 결정하지 못한다.

- 실행 파일
- Docker subcommand
- global flags
- context
- endpoint
- timeout 정책
- 환경 변수

`choose_and_validate_cli()`는 path 인자를 받지 않는다. Rust Core가 소유한 native
file picker를 열어 선택 결과를 직접 받고, canonical absolute path, 실행 가능 여부,
Docker Client contract를 고정된 인자로 검증한 뒤에만 새 environment session의
`CliPath`로 고정한다. WebView는 검증 전 executable path를 전달할 수 없다.

프런트엔드는 현재 environment session에 속한 opaque `container_handle`만
전달한다. Rust Core가 handle을 마지막 정상 조회 결과의 full Container ID로
변환하고, Action enum을 고정된 command specification으로 바꾼다. Full ID는
사용자 확인·복사용으로 표시할 수 있지만 mutation IPC의 target으로 받지 않는다.

### 12.3 Tauri capability 원칙

- 필요한 Window와 IPC command만 허용한다.
- 하나의 main WebView만 사용한다.
- custom Tauri command는 `AppManifest::commands`에 허용 IPC만 명시하고 기본 전체
  노출에 의존하지 않는다.
- Tauri shell plugin은 설치하지 않고 프런트엔드에 process spawn 권한을 주지 않는다.
- 파일 선택은 Rust Core가 여는 Docker CLI 전용 native picker로 제한하고 WebView에
  범용 filesystem picker/read capability를 주지 않는다.
- 외부 URL 열기와 임의 파일 읽기를 기본 허용하지 않는다.
- 원격 URL을 WebView 내부에 load하지 않는다.
- Content Security Policy를 명시적으로 설정한다.
- 원격 script, CDN, analytics를 사용하지 않는다.
- 개발용 capability와 devtools를 production build에 포함하지 않는다.

---

## 13. Docker CLI 실행 계층

### 13.1 CLI 탐색 순서

```text
1. 사용자가 이전에 지정하고 검증한 절대경로
2. 앱 프로세스의 PATH
3. 플랫폼별 알려진 설치 후보 경로
4. 사용자가 선택한 파일
```

현재 작업 디렉터리에서 발견한 실행 파일을 우선 실행하지 않는다.

CLI 후보는 파일 존재만으로 신뢰하지 않는다. Docker Client 버전 명령이
정상적으로 동작하는지 확인하고, 선택된 절대경로와 버전을 Diagnostics에
표시한다.

Docker CLI는 조직이 제공하는 외부 신뢰 의존성이다. Docker2U의 검증은 필요한
Docker Client contract가 동작하는지 확인하는 것이며, binary의 공급망·진위·허용
여부를 보증하지 않는다. CLI 배포와 승인은 조직의 IT·플랫폼 정책이 책임진다.

macOS 앱은 Finder에서 실행될 때 interactive shell과 동일한 PATH를 가진다고
가정하지 않는다.

### 13.2 명령 실행 원칙

- shell을 거치지 않는다.
- 검증된 Docker CLI 절대경로를 사용한다.
- executable과 arguments를 분리한다.
- 사용자 입력을 raw command로 결합하지 않는다.
- Container 대상은 full ID를 사용한다.
- bootstrap 진단 이후 Engine에 접속하는 모든 operation은 session에 고정된
  local endpoint를 `--host` global argument로 명시한다.
- 자식 프로세스에서 `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_API_VERSION`,
  `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY` override를 제거한다.
- stdout과 stderr를 동시에 비동기로 소비한다.
- one-shot command의 출력 크기를 제한한다.
- 각 명령은 명시적인 timeout과 cancellation 정책을 가진다.
- 앱을 관리자 또는 root 권한으로 재실행하지 않는다.

### 13.3 Docker target 고정

Environment 진단 시 다음 snapshot을 생성한다.

```text
DockerTarget
- EnvironmentSessionId
- CliPath
- ContextName
- Endpoint
- EndpointScheme
- EngineKind
- SupportedRuntimeProfileId
- Provider
- ClientVersion
- ServerVersion
- ServerOsType
- EngineFingerprint
- VerifiedAt
```

Context name은 target을 처음 선택한 출처를 설명하는 진단 정보다. 실제 명령은
매번 snapshot의 검증된 endpoint를 `--host`로 명시하며 ambient context나 환경
변수에 의존하지 않는다. 현재 session ID, local endpoint 정책, Runtime profile 정책,
Engine fingerprint, handle-to-full-ID mapping을 실행 직전에 다시 검증한다.

### 13.4 Core session과 handle lifecycle

Rust Core만 하나의 active `EnvironmentSession`을 소유한다. WebView가 session이나
handle을 생성·복구·재사용할 수 없다.

```text
EnvironmentSession
- opaque EnvironmentSessionId
- canonical CliPath
- pinned DockerTarget
- SupportedRuntimeProfileId
- State: Active | NeedsValidation | Closing | Invalid
- CurrentListGeneration
- HandleMap
```

Lifecycle 규칙:

- CLI와 target 검증이 모두 끝난 뒤에만 새 session을 `Active`로 발급한다.
- Reconnect, 검증된 CLI 변경, target 재검증·재선택은 기존 session을 원자적으로
  `Invalid`로 만들고 모든 handle과 read operation을 폐기한 뒤 새 session을 만든다.
- mutation 실행 중에는 Reconnect와 CLI 변경을 `Busy`로 거부한다.
- Engine 연결 상실 시 session을 `NeedsValidation`으로 바꾸고 새 mutation을 차단한다.
- 앱 종료나 spawn 이후 연결 단절로 mutation 완료를 관찰하지 못하면 해당
  operation의 의미는 `ResultUnknown`이며 `Failed`로 바꾸지 않는다.
- IPC가 전달한 session 값끼리 서로 일치해도 Core의 active session과 다르면 거부한다.

Container 목록 Refresh는 Core에서 원자적으로 commit한다. 성공할 때마다
`CurrentListGeneration`을 증가시키고, 해당 generation의 full ID마다 새로운 opaque
`ContainerHandle`을 발급해 `HandleMap`을 교체한다. Handle은 session ID, list
generation, full ID에 귀속된다.

- 이전 session 또는 이전 generation의 handle은 항상 거부한다.
- 새 목록에서도 같은 full ID가 존재하면 UI는 새 handle로 선택 상태를 복원할 수 있다.
- Refresh가 실패하면 generation과 map을 교체하지 않고 이전 목록을 `Stale`로
  표시하며, 새 mutation은 다음 정상 Refresh 또는 Reconnect까지 차단한다.
- mutation 직전 Core의 active session, current generation, current handle map을 모두
  검증한다.

### 13.5 Process lifecycle

One-shot command와 지속 스트림을 같은 abstraction으로 처리하지 않는다.

v0.1:

```text
OneShotCommand
- environment diagnostics
- list containers
- start
- stop
- restart
- recent logs
```

향후:

```text
StreamingSession
- follow logs
```

프로세스 종료가 Docker Engine 작업 취소를 뜻한다고 가정하지 않는다.

기본 timeout과 output budget은 다음과 같다.

| 작업 | Timeout | Output budget |
| --- | ---: | ---: |
| CLI path / version | 5초 | stdout 8 MiB, stderr 256 KiB |
| context / Engine 진단 | 10초 | stdout 8 MiB, stderr 256 KiB |
| 목록 / inspect | 15초 | stdout 8 MiB, stderr 256 KiB |
| 최근 로그 | 15초 | stdout·stderr 합계 2 MiB |
| Start / Stop / Restart | 30초 | stdout 8 MiB, stderr 256 KiB |

stdout과 stderr는 시작 즉시 별도 비동기 task로 drain한다. 구조화 출력과 일반
진단 stderr는 처음부터 상한까지 capture하고, 초과 byte는 버리면서 끝까지 drain한다.
구조화 출력이 한도를 넘으면 부분 parse하지 않고 `OutputLimitExceeded`로 처리한다.

최근 로그는 별도의 rolling ring buffer를 사용해 stdout·stderr 합계의 **마지막
2 MiB**를 유지하고 오래된 byte부터 버린다. 따라서 첫 2 MiB를 유지하는 일반
capture 정책과 혼용하지 않는다. 두 정책 모두 truncation 여부를 사용자에게
표시하며 pipe는 끝까지 drain한다. 앱 종료 시 Docker2U가 소유한 child process를
정리한다.

Shutdown 시 read operation은 cancellation으로 종료한다. 이미 spawn된 mutation의
정상 종료를 관찰하지 못하면 먼저 `ResultUnknown`으로 분류하고, 2초의 graceful
종료 후 남은 process를 강제 종료한다. Windows에서는 Job Object, macOS에서는
process group 등 플랫폼 소유권 경계를 사용해 Docker2U가 만든 descendant가 남지
않게 한다. Process 종료가 Engine 작업 취소를 뜻한다고 간주하지 않는다.

---

## 14. 핵심 데이터 모델

### 14.1 EnvironmentSnapshot

```text
- EnvironmentSessionId
- SessionState
- Status
- CliPath
- ClientVersion
- ContextName
- Endpoint
- EndpointScheme
- EngineKind
- SupportedRuntimeProfileId
- Provider
- ServerVersion
- ServerOsType
- EngineFingerprint
- CheckedAt
```

### 14.2 ContainerSummary

```text
- ContainerHandle
- ListGeneration
- FullId
- ShortId
- Name
- Image
- State
- DisplayState
- Status
- Health
- Ports
```

### 14.3 OperationResult

```text
- OperationId
- EnvironmentSessionId
- Action
- TargetFullId
- TargetName
- Outcome
- ExitCode (optional)
- StdOut
- StdErr
- StartedAt
- Duration
- OutputTruncated
- RefreshRequired
- ReconciliationStatus
- ObservedContainerState (optional)
```

`OperationResult.Outcome`은 한 번 terminal이 되면 변경하지 않는다.
`ReconciliationStatus`는 `NotRequired | Pending | Observed | Failed` 중 하나이며,
`ResultUnknown` 이후 별도 조회의 진행과 결과만 표현한다.

### 14.4 LogSnapshot

```text
- TargetFullId
- TargetName
- Content
- CapturedAt
- ByteCount
- Truncated
- Outcome
```

---

## 15. 개인정보와 진단 데이터

Docker2U v0.1은 다음 원칙을 따른다.

- 계정과 로그인 기능이 없다.
- 중앙 서버가 없다.
- 제품 사용 analytics를 전송하지 않는다.
- Container 로그를 외부로 전송하지 않는다.
- Container 로그를 디스크에 자동 저장하지 않는다.
- Rust Core는 Docker config와 credential 파일을 직접 열거나 복사하지 않는다.
- Environment 전체를 진단 데이터에 포함하지 않는다.
- 사용자 명시적 Copy 전에는 진단 정보를 Clipboard에 쓰지 않는다.
- 로컬 제품 로그에는 Container 로그와 credential을 남기지 않는다.

향후 crash reporting 또는 analytics를 추가하려면 별도 개인정보·보안 검토와
명시적 사용자 동의가 필요하다.

조직 제공 Docker CLI가 target 해석과 Engine 통신 과정에서 자체 Docker config를
사용하는 것은 CLI의 정상 동작이다. Docker2U는 그 파일 내용을 IPC, 진단 복사,
제품 로그로 가져오지 않는다.

---

## 16. 비기능 요구사항

### 16.1 Responsiveness

- Docker CLI 실행 중 UI thread를 차단하지 않는다.
- Window 이동, 선택, 취소, 상세 보기 기능은 CLI 응답과 독립적으로 동작한다.
- 같은 Container에 중복 mutation을 실행하지 않는다.
- 오래된 Refresh 결과가 최신 화면 상태를 덮지 않는다.

### 16.2 Bounded Resources

- 구조화 stdout은 최대 8 MiB, 일반 stderr는 최대 256 KiB로 제한한다.
- 로그 화면은 최대 2 MiB buffer를 가진다.
- Container 수가 증가해도 행별 background process를 생성하지 않는다.
- Window 또는 앱 종료 시 Docker2U가 시작한 모든 child process를 정리한다.

### 16.3 Reliability

- Docker CLI가 없거나 Engine이 중지되어도 앱이 crash하지 않는다.
- 명령 파싱 실패는 빈 목록으로 위장하지 않는다.
- 지원하지 않는 Runtime profile을 인증 조합으로 오인하지 않는다.
- Timeout과 cancellation을 성공 또는 확정 실패로 위장하지 않는다.

### 16.4 Accessibility

- 키보드만으로 주요 작업을 수행할 수 있다.
- 상태는 색상 이외의 텍스트와 아이콘으로도 표현한다.
- 모든 Action에는 명확한 accessible name이 있다.
- 오류 상세와 확인창의 focus 순서를 검증한다.

### 16.5 Network

Docker2U 자체는 제품 서버와 통신하지 않는다. Docker CLI가 Engine 또는 Registry와
통신하는 동작은 Docker CLI와 연결된 Runtime의 책임이다.

---

## 17. 배포 정의

Docker2U는 하나의 코드베이스에서 플랫폼별 산출물을 만든다.

### 17.1 Windows

초기 대상:

```text
Windows 11 x64
Signed installer
```

요구사항:

- application executable과 installer의 Authenticode-compatible code signing
- Publisher와 version 정보 표시
- 기본 installer는 per-user 설치이며 앱 실행에 관리자 권한을 요구하지 않음
- 깨끗한 Windows 환경에서 설치·실행·제거 검증
- SmartScreen 또는 조직 정책에 따른 실행 차단 검증
- 조직이 별도 system-wide 배포를 요구하면 v0.1 배포 계약에서 별도 검토

### 17.2 macOS

초기 대상:

```text
macOS 14+ Apple Silicon
Docker2U.app
Signed and notarized DMG
```

요구사항:

- Apple Developer ID 서명
- Hardened Runtime
- Apple notarization
- notarization ticket staple
- Gatekeeper가 활성화된 깨끗한 Mac에서 검증

### 17.3 v0.1 배포 제외

- 자동 업데이트
- Microsoft Store
- Mac App Store
- Windows ARM64
- Intel macOS
- Linux
- Docker CLI 또는 Runtime 번들

### 17.4 Release artifact

각 release에는 다음을 제공한다.

- 플랫폼별 서명 설치물
- SHA-256 checksum
- Version과 changelog
- 지원 OS / architecture / Runtime matrix
- 알려진 제한사항
- Third-party license 목록
- SBOM 또는 동등한 dependency inventory

### 17.5 재현성과 공급망 기준

- `Cargo.lock`과 frontend lockfile을 version control에 포함한다.
- release build는 locked/frozen dependency mode로 실행한다.
- Rust toolchain과 Node/pnpm major version을 build 설정에 고정한다.
- release artifact는 source revision, build workflow, checksum과 연결 가능해야 한다.
- Docker2U 앱에 포함되는 Cargo/npm production dependency의 Critical 또는 High
  취약점은 보안 책임자의 기한 있는 위험 수용과 완화 계획 없이 release할 수 없다.
- 이 gate는 Docker2U가 번들하지 않는 BYOR Docker CLI·Runtime을 앱 dependency로
  간주한다는 뜻이 아니다. 해당 도구의 승인·patch는 배포 조직이 책임진다.
- 서명 key와 notarization credential은 저장소나 앱 bundle에 포함하지 않는다.

---

## 18. 테스트 전략

### 18.1 Unit Test

- Docker JSON Lines parser
- batch inspect JSON과 list ID의 일대일 대응
- Health 없음·starting·healthy·unhealthy·unknown 정규화
- 누락·추가·알 수 없는 field 처리
- 모든 Docker State 정규화
- ContainerActionPolicy
- full ID validator
- local endpoint validator
- EngineKind detector와 Runtime profile matcher
- EngineFingerprint 생성과 비교
- OperationOutcome mapping
- bounded output buffer
- command specification
- diagnostics redaction

### 18.2 Fake CLI Integration Test

테스트 전용 fake Docker executable을 사용하여 다음을 검증한다.

- stdout과 stderr 동시 대량 출력
- non-zero exit
- process start failure
- timeout
- cancellation
- malformed JSON
- 일부 JSON Lines만 유효한 경우
- 매우 긴 로그 한 줄
- 2 MiB 초과 로그
- 8 MiB 구조화 stdout과 256 KiB stderr의 정확한 경계
- 로그가 마지막 2 MiB를 유지하는지 확인
- Engine 응답 후 CLI가 비정상 종료되는 경우
- mutation 결과를 확정할 수 없는 경우
- ResultUnknown 후 exact full ID reconciliation 호출
- reconciliation 성공·실패와 무관하게 원래 Outcome 유지
- reconciliation 실패 후 다음 mutation 거부
- mutation 중 앱 종료와 reconnect 요청

### 18.3 Real Runtime Integration Test

다음 native host 조합에서 동일한 contract suite를 검증한다.

```text
Windows 11 x64 + Rancher Desktop dockerd (moby)
macOS 14+ arm64 + Colima Docker runtime
```

- CLI / context / endpoint 진단
- Container 0개, 1개, 다수
- created, running, paused, restarting, exited, dead 상태 fixture
- Start / Stop / Restart
- mutation 직후 Refresh
- list와 inspect 사이 ID 불일치 시 atomic Refresh 실패
- 이름이 재사용된 Container와 stale row
- logging driver 비지원
- Engine 중지와 재연결
- 외부에서 active context를 바꿔도 현재 session target이 변하지 않음
- 같은 socket/npipe 뒤 Engine ID 교체 시 mutation 차단과 session 폐기
- Reconnect 후에만 새 target을 다시 해석함
- 앱 종료 시 read·mutation을 포함한 Docker2U child process가 남지 않음

### 18.4 Security Test

- remote TCP context 차단
- SSH context 차단
- context 변경 경쟁 차단
- `DOCKER_HOST` / `DOCKER_CONTEXT` 충돌 처리
- 모든 operation에 고정된 `--host`가 들어가고 TLS override가 제거됨
- Container Name에 특수문자가 있어도 명령 구조가 바뀌지 않음
- 프런트엔드에서 raw shell command 호출 불가
- 프런트엔드에서 임의 Docker argument 호출 불가
- WebView가 executable candidate path를 IPC로 전달할 수 없음
- stale environment session과 다른 session의 container handle 거부
- 이전 list generation의 container handle 거부
- 미검증 local Moby와 Docker Desktop에서 mutation 차단
- current working directory의 가짜 `docker` 실행 파일을 우선 사용하지 않음
- 진단 복사에 credential과 환경 변수 전체가 포함되지 않음

### 18.5 UI Test

- Loading / Empty / Disconnected / Busy / Error
- Action enable/disable matrix
- Stop / Restart 확인창
- ResultUnknown 안내
- 로그 truncation 표시
- 로그 ANSI/control character 제거와 HTML 비활성 렌더링
- 키보드 탐색
- Windows WebView2와 macOS WKWebView 시각·동작 smoke

### 18.6 Packaging Test

- Windows 서명 검증
- macOS signature 검증
- macOS notarization 검증
- clean environment 설치·실행·제거
- Docker CLI 미설치 환경에서 정상 실행
- Runtime 미실행 환경에서 정상 진단
- lockfile 고정 build와 SBOM 생성
- Docker2U Cargo/npm production dependency 취약점 gate

---

## 19. 개발 단계

### Phase 0 — 제품·호환성 확정

- 대상 조직 2곳 이상 또는 사용자 8~12명 인터뷰
- Windows와 macOS에서 실제 사용 중인 Runtime 조사
- 개별 Container 작업과 Compose 작업 비율 확인
- 공식 지원 Runtime 조합을 OS별 최소 1개 확정
- 각 SupportedRuntimeProfile의 CLI·Runtime·Server/API version 범위와 판별 signal 확정
- Docker2U 이름의 공개 배포 상표·법무 검토
- 제품 성공/중단 기준 승인

완료 조건:

```text
누가, 어떤 OS/Runtime에서, 어떤 반복 작업 때문에 Docker2U를 쓰는지
한 문장으로 설명할 수 있다.
```

### Phase 1 — Cross-platform 기술 Spike

- Tauri 2 앱 shell 검증
- Windows WebView2 / macOS WKWebView 검증
- Rust에서 Docker CLI 탐색과 실행 검증
- context / endpoint / provider 진단 검증
- stdout / stderr / timeout / cancellation 검증
- Windows 서명과 macOS notarization 조기 검증

완료 조건:

```text
두 플랫폼에서 같은 Rust Core가 read-only Docker 진단을 수행하고,
서명 가능한 배포 경로가 확인된다.
```

### Phase 2 — Read-only Alpha

- Environment 진단
- Local-only gate
- Container 목록
- Manual Refresh
- 최근 로그 최대 300줄 요청과 last-2-MiB 표시
- Command / Error 상세
- Loading / Empty / Disconnected 상태

완료 조건:

```text
mutation 기능 없이도 사용자가 문제 Container를 찾고 최근 로그를 확인할 수 있다.
```

### Phase 3 — Recovery Actions

- Start
- Stop
- Restart
- 확인창
- full ID 고정
- per-container mutation lock
- post-action Refresh
- ResultUnknown 처리

완료 조건:

```text
잘못된 context 또는 stale name으로 다른 Container를 조작하지 않고,
작업 후 실제 최신 상태를 확인할 수 있다.
```

### Phase 4 — Signed Pilot

- Windows 서명 설치물
- macOS notarized DMG
- OS별 공식 지원 Runtime 문서
- 2주 사내 pilot
- 설치·사용·재사용·오조작 지표 수집

### Phase 5 — v0.1 Release Decision

- Acceptance Criteria 검토
- Pilot Go / Revise / Stop 결정
- 지원 matrix와 알려진 제한사항 확정
- v0.1 release 또는 제품 중단

---

## 20. v0.1 Acceptance Criteria

### 20.1 기능

- [ ] Windows와 macOS에서 Docker2U가 실행된다.
- [ ] Docker CLI 존재와 유효성을 확인할 수 있다.
- [ ] CLI 절대경로와 Client 버전을 확인할 수 있다.
- [ ] Context와 실제 endpoint를 확인할 수 있다.
- [ ] EngineKind, SupportedRuntimeProfileId, Server version, OSType을 확인할 수 있다.
- [ ] 두 초기 profile의 CLI·Runtime·Server/API version 범위와 판별 signal이 채워져 있다.
- [ ] 전체 Container 목록을 조회할 수 있다.
- [ ] Name / Image / State / Health / Ports를 확인할 수 있다.
- [ ] created / exited Container를 Start할 수 있다.
- [ ] running Container를 Stop할 수 있다.
- [ ] running Container를 Restart할 수 있다.
- [ ] 최근 로그를 최대 300줄 요청하고 마지막 2 MiB만 표시·복사하며 truncation을 알린다.
- [ ] 사용자가 실행한 equivalent command와 stderr를 확인할 수 있다.
- [ ] Manual Refresh와 mutation 직후 Refresh가 동작한다.

### 20.2 안전

- [ ] tcp / ssh / http / https / fd endpoint에서 Engine operation을 실행하지 않는다.
- [ ] 승인된 SupportedRuntimeProfileId가 아닌 환경에서 mutation을 실행하지 않는다.
- [ ] Action은 Name이나 short ID가 아니라 session handle로 full ID를 해석한다.
- [ ] Engine에 접속하는 모든 명령은 session에 고정된 local endpoint를 `--host`로 명시한다.
- [ ] Mutation 직전 active session, list generation, endpoint 정책, profile, Engine fingerprint, handle mapping을 다시 검증한다.
- [ ] 프런트엔드에서 raw command 또는 raw Docker args를 실행할 수 없다.
- [ ] Docker CLI 수동 선택은 path 인자가 없는 Core-owned native picker로만 수행한다.
- [ ] custom Tauri command는 명시적 application command allowlist만 노출한다.
- [ ] shell을 통해 Docker CLI를 실행하지 않는다.
- [ ] Docker2U가 관리자 또는 root 권한을 요구하지 않는다.
- [ ] Delete / Prune / Create / Image / Volume / Network 기능이 없다.
- [ ] Rust Core가 Docker config와 credential 파일을 직접 열거나 복사하지 않는다.

### 20.3 신뢰성

- [ ] Docker CLI가 없어도 앱이 crash하지 않는다.
- [ ] Runtime이 없어도 앱이 crash하지 않는다.
- [ ] Engine 연결이 끊겨도 Retry할 수 있다.
- [ ] stdout과 stderr 대량 출력으로 deadlock이 발생하지 않는다.
- [ ] 8 MiB stdout, 256 KiB stderr, 2 MiB recent-log 경계를 정확히 적용한다.
- [ ] timeout·cancellation·강제 종료·응답 중단 mutation을 확정 실패로 표시하지 않는다.
- [ ] `ResultUnknown` 후 exact full ID를 즉시 reconciliation한다.
- [ ] Reconciliation 후에도 원래 Outcome을 `ResultUnknown`으로 유지한다.
- [ ] `ResultUnknown` mutation을 자동 재시도하지 않는다.
- [ ] Reconciliation 실패 후 environment 재검증 전까지 추가 mutation을 차단한다.
- [ ] malformed JSON line을 조용히 제외하거나 부분 목록으로 표시하지 않는다.
- [ ] Refresh 실패 시 마지막 정상 목록을 `Stale`로 표시한다.
- [ ] 오래된 session, list generation, Refresh 결과가 최신 상태를 덮지 않는다.
- [ ] 앱 종료 후 Docker2U가 시작한 read·mutation child process가 남지 않는다.
- [ ] 종료 중 미완료 mutation은 `ResultUnknown`을 유지하고 Engine 취소로 오인하지 않는다.

### 20.4 배포

- [ ] Windows 산출물이 유효하게 서명되어 있다.
- [ ] macOS 산출물이 서명·notarize·staple되어 있다.
- [ ] clean Windows와 macOS에서 설치·실행·제거를 검증했다.
- [ ] 각 산출물에 checksum과 지원 matrix가 제공된다.
- [ ] Docker CLI와 Runtime을 번들하지 않는다.
- [ ] lockfile 고정 build와 SBOM 생성이 검증된다.
- [ ] Docker2U Cargo/npm production dependency에 미승인 Critical/High 취약점이 없다.

### 20.5 사용자 성과

Pilot에서 다음 기준을 사용한다. 측정은 관찰·인터뷰 또는 사용자가 명시적으로
제공한 로컬 결과로 수행하며 원격 telemetry를 추가하지 않는다.

- [ ] 대표 작업을 설명 없이 완료한 사용자가 80% 이상이다.
- [ ] 기존 방식 대비 대표 작업 중앙 완료시간이 30% 이상 감소한다.
- [ ] 잘못된 context 또는 Container 조작이 0건이다.
- [ ] 설치 대상 사용자의 설치 성공률이 90% 이상이다.
- [ ] 2주 동안 대표 작업 기회가 2회 이상 있었던 Pilot 사용자 중 60% 이상이 안내 없이 2회 이상 사용한다.
- [ ] 플랫폼/IT 담당자가 지원 범위와 배포 방식을 승인한다.

재사용 지표의 유효 분모는 최소 5명이다. 조건을 만족하는 사용자가 5명 미만이면
성공으로 간주하지 않고 Pilot 기간을 연장한다.

대표 작업:

```text
중지되거나 비정상인 개발 의존 서비스 찾기
        ↓
최근 오류 로그 확인
        ↓
Container 복구
        ↓
최신 상태 확인
```

### 20.6 Release Blocker

다음 중 하나라도 확인되면 Pilot 또는 v0.1 release를 중단한다.

- remote 또는 해석되지 않은 endpoint로 Engine-facing/container operation을 실행할 수 있음
- Name, short ID 또는 stale session 값으로 mutation 대상이 바뀔 수 있음
- 이전 list generation의 handle로 mutation을 실행할 수 있음
- 같은 endpoint 뒤 Engine fingerprint가 바뀌어도 기존 session으로 mutation이 가능함
- WebView에서 raw shell, process spawn 또는 raw Docker args를 호출할 수 있음
- WebView가 executable path를 전달해 Core process 실행을 유도할 수 있음
- 승인되지 않은 SupportedRuntimeProfileId에서 mutation이 가능함
- ResultUnknown mutation을 자동으로 재시도함
- spawn 이후 완료를 관찰하지 못한 mutation을 `Succeeded` 또는 `Failed`로 확정함
- ResultUnknown 후 exact full ID reconciliation을 즉시 수행하지 않음
- Reconciliation 결과로 원래 `ResultUnknown` Outcome을 변경함
- Reconciliation 실패 후 추가 mutation을 허용함
- stdout, stderr 또는 로그가 상한 없이 증가함
- malformed 목록을 부분 성공으로 위장함
- 로그나 CLI 출력을 active HTML로 렌더링함
- Docker2U Cargo/npm production dependency에 미승인 Critical/High 취약점이 존재함
- Windows 서명 또는 macOS 서명·notarization 검증에 실패함

---

## 21. v0.1에서 제외할 기능

### 명시적 제외

- Container Terminal / Exec
- Follow Logs
- Auto Refresh
- Docker Compose
- Container Create / Run Wizard
- Container Delete
- Image Pull / Build / Delete
- Volume 관리
- Network 관리
- Registry 관리
- CPU / Memory / Network monitoring
- File Explorer
- Docker Runtime 설치·실행·업데이트
- Docker Desktop 관리
- Podman / nerdctl / Finch native adapter
- Remote Docker
- Kubernetes
- 계정 시스템
- 중앙 서버
- 원격 telemetry
- 자동 업데이트

### 제외 이유

```text
제품의 핵심은 더 많은 Docker 기능이 아니라
반복되는 로컬 복구 작업을 작은 안전 표면으로 제공하는 것이다.
```

---

## 22. 이후 기능 추가 원칙

기능 요청이 있다는 이유만으로 추가하지 않는다.

다음 조건을 모두 만족할 때만 검토한다.

```text
실제 반복 사용에서 동일한 불편이 발생함
        +
여러 사용자가 같은 요구를 보임
        +
핵심 Recovery 흐름과 부합함
        +
권한·지원·배포 표면 증가가 감당 가능함
        +
Acceptance Criteria를 별도로 정의할 수 있음
```

### 후보 우선순위

P1 후보:

- Bounded Follow Logs
- 로그 검색과 필터
- 마지막 선택 Container 기억

P2 후보:

- Auto Refresh
- 외부 Terminal 연동
- Windows ARM64
- Intel macOS
- 지원 provider 추가

방향 재검토가 필요한 후보:

- Docker Compose
- Runtime 설치
- Remote Engine
- Container 생성

Compose 작업이 실제 사용자 작업의 대부분이라면 단순 기능 추가가 아니라
제품 단위를 `Container recovery`에서 `Development stack recovery`로 다시
정의해야 한다.

---

## 23. 위험 등록부

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| 대상 조직마다 Runtime 구성이 다름 | 지원비용 급증 | OS별 공식 조합을 한 개씩 먼저 고정 |
| Docker Desktop 대체로 오해 | 제품 기대 불일치 | BYOR와 Runtime 미포함을 모든 문서에 명시 |
| Remote context 오조작 | 심각한 서비스 영향 | local endpoint session 고정, mutation 직전 Core 정책 검증 |
| 같은 endpoint 뒤 Engine 교체 | stale handle이 다른 instance에 사용됨 | EngineFingerprint 재검증과 session 폐기 |
| Podman 호환을 Docker와 동일시 | 기능 오동작 | provider 표시, v0.1 mutation 차단 |
| CLI 출력 형식 변화 | 목록 파싱 실패 | JSON format, fixture, unknown field 허용 |
| CLI process 종료와 Engine 작업 취소 혼동 | 잘못된 결과 표시 | ResultUnknown과 post-action Refresh |
| 로그가 메모리를 고갈 | 앱 불안정 | byte 상한과 truncation |
| WebView2/WKWebView 차이 | OS별 UI 결함 | 두 플랫폼 실장비 smoke |
| 서명·notarization을 후반에 발견 | 배포 지연 | Phase 1에서 조기 Spike |
| 기존 무료 GUI로 충분함 | 제품 사용 저조 | Pilot에서 선택 이유와 재사용 검증 |
| Compose가 실제 주요 작업임 | 제품 문제 정의 불일치 | Phase 0에서 작업 비율 조사 |
| Docker2U 이름의 상표 문제 | 공개 배포 차단 가능 | 이름은 유지하되 공개 release 전에 법무·상표 gate 통과 |

---

## 24. Go / Revise / Stop 기준

### Go

- 대상 조직에 승인된 로컬 Runtime이 이미 존재한다.
- 같은 복구 작업을 반복하는 사용자가 여러 명 존재한다.
- 기존 도구보다 작고 안전해서 선택한다는 이유가 확인된다.
- Windows와 macOS의 공식 지원 조합을 운영할 수 있다.
- Pilot Acceptance Criteria를 충족한다.

### Revise

- Compose 단위 작업이 개별 Container 작업보다 많다.
- Runtime provider 차이가 예상보다 크다.
- 사용자는 로그보다 다른 진단 정보가 더 필요하다.
- 설치·서명·IT 배포가 제품 사용의 주요 마찰이다.

### Stop

- 대상 사용자에게 로컬 Runtime이 없다.
- Podman Desktop 또는 Rancher Desktop으로 문제가 충분히 해결된다.
- 명령 검색 문제가 반복 작업이 아니라 최초 온보딩 문제뿐이다.
- README, script 또는 alias로 같은 효과를 더 낮은 비용에 얻는다.
- 원격 Engine 또는 Runtime 설치 없이는 제품 가치를 만들 수 없다.

---

## 25. 명칭과 배포 표기

사용자 결정에 따라 서비스명은 `Docker2U`로 유지한다.

```text
Service Name     Docker2U
Repository       docker2u
Windows App      Docker2U.exe
macOS App        Docker2U.app
Tagline          Docker CLI, without the CLI friction.
```

단, 공개 제품명·도메인·저장소·마케팅에서 `Docker` 표장을 사용하는 문제는
별도 법무·상표 검토 대상이다. 이 검토는 이름을 자동 변경하는 권한이 아니라
공개 release 전 필수 gate다.

Docker2U는 Docker, Inc.와의 제휴·후원·공식 관계를 암시해서는 안 된다.

---

## 26. 최종 경계

Docker2U v0.1이 제공하는 것은 다음뿐이다.

```text
Verify local Docker environment
See containers
Understand state and health
Read recent logs
Start containers
Stop containers
Restart containers
See what command was executed
Confirm the latest state
```

그리고 핵심 원칙은 다음과 같다.

> Docker2U should make approved local container recovery easier,
> not become another container platform.

---

## 27. 참고 자료

- [Docker Desktop license agreement](https://docs.docker.com/subscription/desktop-license/)
- [Docker Engine installation](https://docs.docker.com/engine/install/)
- [Docker Engine binaries on Windows and macOS](https://docs.docker.com/engine/install/binaries/)
- [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)
- [Docker CLI environment variables and options](https://docs.docker.com/reference/cli/docker/)
- [Docker container ls](https://docs.docker.com/reference/cli/docker/container/ls/)
- [Docker container logs](https://docs.docker.com/reference/cli/docker/container/logs/)
- [Docker container stop](https://docs.docker.com/reference/cli/docker/container/stop/)
- [Docker container exec](https://docs.docker.com/reference/cli/docker/container/exec/)
- [Docker trademark guidelines](https://www.docker.com/legal/trademark-guidelines/)
- [Tauri 2 security capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri 2 permissions](https://v2.tauri.app/security/permissions/)
- [Tauri shell plugin security](https://v2.tauri.app/plugin/shell/)
- [Tauri webview versions](https://v2.tauri.app/reference/webview-versions/)
- [Tauri distribution](https://v2.tauri.app/distribute/)
- [Apple Developer ID](https://developer.apple.com/support/developer-id/)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Windows SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Rancher Desktop container engine settings](https://docs.rancherdesktop.io/ui/preferences/container-engine/general/)
- [Rancher Desktop Windows named pipe example](https://docs.rancherdesktop.io/1.24/how-to-guides/using-testcontainers/)
- [Colima FAQ](https://github.com/abiosoft/colima/blob/main/docs/FAQ.md)
