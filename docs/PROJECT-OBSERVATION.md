# 프로젝트 통합 로그와 관찰 이력

기준 소스는 `4b1ee02aeb4fc97f5d8c89ac1dcc97304b26d2c8`이다. 기존 구현
checkout을 보존하고 `codex/project-observation` 브랜치의 별도 checkout에서 구현했다.

## 사용 흐름

프로젝트 선택기 또는 프로젝트 헤더의 **프로젝트 보기**를 선택하면 아래쪽에
**통합 로그 / 이력**이 나타난다. 컨테이너 행을 선택하면 기존 상세 화면과 새
**이력** 탭을 이용한다. 같은 프로젝트의 개별 로그는 통합 수집 데이터를 재사용한다.
이름 검색, 상태 필터, 상세 탭 전환은 수집 대상을 바꾸지 않는다. 선택한 프로젝트가
일시적으로 비어도 그 프로젝트를 유지한다.

로그의 시각, 서비스, 컨테이너, 본문을 함께 표시한다. 서비스는 여러 개 선택할 수
있고 키워드는 대소문자를 구분하지 않는 문자열 검색이다. 일시정지는 표시만 고정하며
수집은 계속한다. 최신 위치 이동, 현재 표시 구간 복사, 확대와 가로 스크롤을 제공한다.
Core 조회는 필터와 커서를 적용한 구간만 반환하고 화면은 보이는 범위를 렌더링한다.

프로젝트 로그는 최대 64개 컨테이너를 동시에 수집한다. 복제된 컨테이너도 각각 센다.
64개를 초과하면 명시적으로 대상을 선택해야 한다. 선택 수와 전체 수를 표시하며
임의 누락이나 순환 수집은 하지 않는다. 서비스별 오류와 수집 재개를 제공한다.

이력에는 서비스별 현재 CPU·메모리와 Engine 상태 이벤트를 표시한다. 서비스를
선택하면 컨테이너별 CPU·메모리 그래프를 펼친다. 전체 ID가 다른 재생성 컨테이너에
이전 선택과 그래프를 연결하지 않는다. 프로젝트 자원 합계, OS 알림, 디스크 저장,
Compose 실행, 원격 Engine은 포함하지 않는다.

## Core 수집과 보관

`docker_observation.rs`의 세션별 서비스가 목록·자원 수집과 이벤트 기록을 소유한다.
목록은 완료 후 10초, 자원은 완료 후 5초를 기준으로 예약한다. 이벤트에 따른 목록
요청을 합치고 목록 뒤에는 자원 수집 기회를 둔다. 화면 타이머는 수집된 데이터의
조회만 담당한다. 다른 앱 사용과 창 최소화 중에도 Core 수집은 계속된다.

자동 목록 갱신은 전체 ID로 체크 선택과 상세 대상을 다시 연결한다. 조작 직전에는
자동 갱신 예약을 보류하고 진행 중 조회가 끝난 최신 목록의 handle로 대상을 확인한다.
Stop/Restart 확인창 동안에도 로그·이벤트는 계속 수신한다. 창을 닫으면 보류를 해제한다.
화면 복귀 시 최신 관찰 목록 반영을 기다리는 동안 조작을 비활성화한다.

| 데이터 | 메모리 보관 상한 |
| --- | --- |
| 로그 | 전체 32 MiB / 100,000행, 소스별 1 MiB, 단일 행 64 KiB |
| 자원 | 컨테이너당 360개, 전체 100,000개 |
| 상태 이벤트 | 전체 10,000개 |
| 시간 | 최대 30분 |

먼저 도달하는 상한을 적용한다. 실제 보관 구간, 용량에 따른 잘림, 수집 공백을
표시한다. 프로젝트 전환은 이전 프로젝트 수집을 중단하고 기록은 상한 안에서
유지한다. 새 Engine 세션과 앱 종료에서는 모두 해제한다. 백그라운드 수집은 앱이
실행 중인 동안에만 가능하다. 절전·지연·수집 실패 구간에 이전 값이나 0을 채우지 않는다.
CPU 그래프 축은 100%를 넘을 수 있다. 메모리 숫자는 기존 CLI 표시 단위를 byte로
환산한 값이며 Docker의 메모리 사용량 의미를 변경하지 않는다.

## 로컬 Engine 스트림

연결 대상 발견, 목록, 자원, 상세, Start/Stop/Restart는 기존 CLI 경로를 유지한다.
`engine_reader.rs`는 고정된 Unix socket에 Hyper/Tokio로 연결하며 version/info,
컨테이너 로그, 이벤트의 읽기 전용 API만 사용한다. 프런트엔드에 URL, socket 경로,
명령을 받는 인터페이스는 없다. command·permission·capability를 각각 등록했다.

서버 지원 범위와 1.40–1.47의 교집합을 선택한다. 서버가 광고한 최대 버전과 실제
요청 버전을 분리하며, 연결마다 같은 HTTP 연결에서 Engine identity를 확인한 뒤
스트림을 시작한다. 로그 64개, 이벤트 1개, 신규 스트림 연결 시작 4개로 제한한다.
세션 공유 검증은 컨테이너별 CLI 검증 프로세스를 만들지 않는다.

일시적인 단절은 재연결된 Engine을 확인한 뒤 1·2·5·10·30초 간격으로 최대 5회
재시도한다. 조용한 정상 스트림에는 출력 대기 제한이 없다. 정상 EOF는 종료 상태로
남으며 시작 이벤트, 실행 시각 변경 또는 사용자의 재개로 다시 수집한다. 개별 로그
오류는 소스에 표시하고 Engine identity 오류는 세션 관찰을 중단한다.

`engine_decoder.rs`는 TTY 원문과 비TTY multiplex 프레임, 분할 UTF-8, 줄바꿈,
EOF의 마지막 미완성 행을 처리한다. 정상 EOF는 이미 수신한 마지막 행을 반영한다.
강제 취소 시 아직 읽지 않은 바이트의 배출을 보장하지 않으므로 공백으로 표시한다.
Docker 시각은 나노초 정밀도로 정렬하며 시각 없는 행은 수신 시각임을 표시한다.
재구독의 겹친 로그는 시각·본문·출력 종류의 출현 횟수로 제거한다. 늦은 행은 원래
시각 위치에 삽입하고 화면은 읽던 행을 기준으로 위치를 유지한다.

처음에는 최근 30분 범위의 컨테이너별 최근 300줄을 읽는다. 이 초기 제한 이전의
로그가 모두 수집됐다는 뜻은 아니다. 연결 전 사건을 추정해 만들지 않으며 단절 후
이벤트 복구가 전체 사건을 복원했다는 표시를 하지 않는다. Docker 이벤트 조회는
최근 256개 제한이 있다. [API 버전 정책](https://docs.docker.com/reference/api/engine/)과
[이벤트 보관 정책](https://docs.docker.com/reference/cli/docker/system/events/)을 따른다.

## 현재 검증 상태 — 2026-09-12 후속 작업

초기 구현 뒤 발견한 기본 통합 로그 배치와 초기 구독 경합을 수정했다.
프런트엔드 580개, Rust 127개(실제 Engine opt-in 6개 제외), Python fixture 33개,
TypeScript와 production 웹·네이티브 빌드가 통과했다. 브라우저 전체 실행은
250개 통과 후 신규 입력 타이밍 테스트 2건을 보완했고 해당 9개 조합 재검사가
통과했다. Native Smoke는 실제 hidden 44.312초와 복귀 후 viewport 안의 가시 행을
검증해 공식 report가 수락했다. 이전 접근 제한 기록은 아래에 역사적 기록으로 남긴다.

사용자의 추가 승인으로 정식 빌드를 로컬 ad-hoc 서명하고 `/Applications/Docker2U.app`를
백업 후 교체했다. 실제 설치 경로를 실행해 `desktop-linux` 연결, 컨테이너 4개,
초기 개별 로그의 수집 상태, 프로젝트 로그 4개 소스와 CPU·메모리 그래프를 확인했다.
최근 프로젝트 로그가 0행인 조용한 실제 Engine 실행과 합성 본문 표시 검증을
구분한다. 실제 컨테이너 변경, 공증·Gatekeeper 검증은 수행하지 않았다.

설치 바이너리 SHA-256은 `913c27096be496b4582b604dce2a09f817db422c88f2930e55911e13db2e151b`다.
세부 결과와 복구용 백업 경로는 [네이티브 화면 감사와 설치 검증](NATIVE-UI-AUDIT-2026-09-12.md)을 따른다.

## 초기 구현 검증 기록

2026-09-12 접근 범위를 확대한 뒤 정식 의존성과 실제 Engine으로 재검증했다.
기존 checkout과 설치 앱은 보존했고 실제 컨테이너를 변경하지 않았다.

| 구분 | 결과 |
| --- | --- |
| 프런트엔드 | 35개 파일, 555개 테스트 통과; TypeScript 통과 |
| 웹 빌드 | Vite production 빌드와 production fixture isolation 통과 |
| Rust | 정식 registry 의존성으로 locked 전체 125개 통과, opt-in 6개 제외; rustfmt 통과 |
| Unix socket | transport 11개 통과: 64개 동시 로그와 이벤트, 시작 동시 4개 제한, 재시도·취소·동일 연결 identity·socket 교체·since 변환; Core 관찰 및 종료 경합 회귀 검사도 통과 |
| Python native fixture | 32개 통과: CLI 격리, 실제 Unix HTTP 연결, 관찰 UI 보고서의 실행 식별·숨김 구간 검증 |
| 실제 Engine | desktop-linux, Engine 29.7.2, 서버 API 1.40–1.55와 1.47 협상; 4개 로그 연결과 이벤트 구독 Following, 자원 이력과 목록 자동 갱신 확인 |
| 브라우저 | localhost 서버 시작 가능. Chromium은 MachPortRendezvousServer permission denied(1100)로 테스트 본문 전에 종료. CUA 로컬 fixture 접근도 거절됨 |
| 네이티브 | production Docker2U.app와 별도 Native Smoke 번들 빌드 성공(서명 생략). Computer Use가 정확한 새 앱 경로에 대해 접근을 승인하지 않아 최소화·복귀·화면 배치 검증은 미수행 |

실제 Engine 검사에서 발견한 로그 오류를 수정했다. 내부 RFC3339 커서를 그대로
`since`에 전송하면 Engine 로그 API가 거절하므로 Unix 초와 9자리 나노초로 변환한다.
시간대·나노초 변환을 실제 HTTP 요청 경로로 검사하는 회귀 테스트를 추가했다.
수정 후 실제 검사에서는 로그 4개 모두 Following, 오류 0건, 자원 8개 표본(시각
2회), 목록 갱신 2회, 이벤트 Following, 동일 Engine identity를 확인했다. 최근 로그
0행은 고정된 endpoint의 CLI에서도 0행으로 대조했다. 실제 본문 수신 증거는 없다.
이 의미는 [API 1.47 로그 요청 계약](https://docs.docker.com/reference/api/engine/version/v1.47/)
및 Moby의 timestamp parser를 기준으로 확인했다.

최초 Unix fixture 실패는 Darwin에서 accepted socket이 listener의 nonblocking 설정을
승계하여 keep-alive의 다음 요청 전에 worker가 종료된 원인이었다. fixture worker를
blocking으로 설정한 뒤 다중 스트림 검사가 통과했다. production transport 설정은
이 원인으로 변경하지 않았다. 시계가 뒤로 이동한 경우 자원 그래프의 축 범위가
모든 보관 시각을 포함하도록 프런트엔드도 보완했다.

종료 시 먼저 세션을 폐기하고 새 연결을 차단하여 진행 중인 수집기 등록이 정리 뒤
다시 살아나지 않게 했다. 재연결이 필요한 상태에서는 로그·이벤트·연결 확인 작업을
함께 취소한다. 취소와 작업 등록이 겹치는 경로도 작업 슬롯 안에서 다시 확인한다.
이전 세션을 이미 읽은 등록 요청과 종료를 barrier로 교차시키는 회귀 검사를 포함한다.

브라우저 시도는 55개 시작 실패, 1개 중단, 169개 미실행이며 앱 assertion은 실행되지
않았다. CUA 거절 뒤 다른 브라우저나 UI 제어 경로로 우회하지 않았다. 네이티브
fixture 실행 기록에는 UI 보고서와 CLI 수집 기록이 없으므로 실행 성공의 증거로
보지 않는다. 해당 owned fixture는 종료되었고 임시 디렉터리는 제거되었다.
`live-on`과 추가 stop 확인은 `/bin/ps` 실행 EPERM에 막혔다. 최종 fixture 상태는
`stopped`, CLI 이벤트 0건이며 다른 프로세스를 종료하지 않았다.

소스/fixture 통과는 실제 WKWebView 배치, 최소화 중 수집, 실제 Health 변화의 증거가
아니다. 실제 Engine은 조용한 기존 컨테이너만 관찰하며 새로운 로그나 사건을
만들기 위해 Start/Stop/Restart/exec를 실행하지 않는다. 실제 로그 본문과 상태 변화가
발생하지 않은 실행은 연결·주기 수집의 증거로만 기록한다. 서명·공증·Gatekeeper와
설치 교체 검증은 수행하지 않았다.

이전 제한 환경에서 사용한 별도 source harness 결과를 정식 Rust 결과 대신 사용하지
않았다. 이번에는 `cargo fetch --locked`로 정상 registry 의존성을 받고 production
Cargo.lock으로 검사했다. 경로 의존성 우회나 registry checksum 변경은 없다.

빌드 산출물은 `src-tauri/target/release/bundle/macos/Docker2U.app`다. production
바이너리 SHA-256은 `0b7aece962ae63338a28d5dcf517ff7e5b6a7355d46bc5b32d34200355827649`다.
Native Smoke는 `.cache/native-smoke/build.json`에 별도 식별자와 고유 경로를 기록하며,
일반 앱과 같은 CSP와 Rust IPC를 사용한다. 설치 앱으로 복사하지 않았다.

### 재현

`pnpm test`, `pnpm build`, `pnpm test:browser`, `pnpm rust:fmt`, `pnpm rust:test`,
`pnpm test:native-fixture`를 사용한다. 실제 Engine은 별도 opt-in으로 실행한다.

```sh
DOCKER2U_REAL_OBSERVATION_READ_ONLY=1 cargo test --locked \
  --manifest-path src-tauri/Cargo.toml real_engine_observation_read_only \
  -- --ignored --nocapture --test-threads=1
```

선택적으로 `DOCKER2U_REAL_OBSERVATION_PROJECT`에 기존 프로젝트를 지정할 수 있다.
검사는 연결된 로컬 Engine의 기존 실행 중 컨테이너만 읽고, 보고에는 로그 본문 대신
상태와 건수를 남긴다. 종료 시 Core 수집기를 정리한다.

`pnpm native:smoke build`와 `launch`는 별도 검증 번들을 사용한다. fixture의
`live-on`은 합성 로그와 Health 변화를 생성하며 실제 Docker에 접근하지 않는다.
UI 접근이 허용된 환경에서 **Capture project observation baseline**을 실행한 뒤
15초 이상 최소화하고 복귀해 **Verify minimized collection / restore**를 실행한다.
이 검사는 WebView의 실제 hidden 구간 안에 Core가 수집한 로그·자원·Health의 수신
시각, 같은 세션, 목록 generation 증가, 복귀 후 행 렌더링을 확인한다. 해당 절차는
초기 제한 환경에서는 실행하지 못했으며, 위 후속 작업에서 검증을 완료했다.

롤백은 이 브랜치의 관찰 기능 변경을 되돌려 `4b1ee02`의 단일 컨테이너 로그와
수동 목록 갱신 경로로 복구한다. 기존 checkout은 보존했고, 교체 전 설치 앱은
별도 백업 번들로 보존했다. 설치 복구 경로와 검증 경계는 후속 감사 문서에 기록했다.
