# 네이티브 화면 감사 — 2026-09-12

초기 감사에서 Computer Use로 macOS Native Smoke 앱을 직접 조작해 기본 통합
로그 본문 공백과 초기 로그 구독 오류를 재현했다. 아래 초기 감사 기록은 당시의
결과를 보존한다. 승인된 수정과 후속 검증은 문서 끝의 별도 기록에서 다룬다.

## 초기 감사 대상과 검증 범위

- checkout: `/Users/jgoneit/project/Docker2U/.cache/project-observation`
- branch / HEAD: `codex/project-observation` / `4b1ee02aeb4fc97f5d8c89ac1dcc97304b26d2c8`
- 감사 대상은 해당 HEAD 위에 있는 기존 미커밋 관찰 기능 구현이다.
- 번들: `.cache/native-smoke/bundles/0dee7010422b45d0a42328ed886836c1/Docker2U Native Smoke.app`
- 실행 바이너리 SHA-256: `0d9aa1dd00e1a38cd06bc20dd3ad90039829b70b2fa0fd92ecf6806e478ad07d`
- 주요 fixture 실행: `d2u-smoke-9bae3ff531`

처음 정확한 앱 경로를 Computer Use로 열었을 때는 일반 실행 환경을 상속하여
실제 `desktop-linux` Engine에 연결되었다. 초기 로그 오류를 관찰한 뒤 종료하고,
공식 fixture launcher로 다시 실행했다. 이후 화면 검사는 `native-smoke-local`,
`native-smoke-engine`, `native-smoke-project`의 격리된 합성 데이터로 진행했다.
테스트 페이지의 제목만으로 격리를 판정하지 않았다.

초기 감사에서는 실제 컨테이너에 Start/Stop/Restart/exec를 실행하지 않았다. 기존 설치 앱을
교체하지 않았으며 production 코드 변경이나 커밋은 수행하지 않았다. 네이티브
UI probe와 공식 report 검증은 실행했고, 기존 전체 회귀 테스트는 재실행하지 않았다.
이번 결과는 실제 WKWebView에서 합성 Engine 응답을 표시한 증거이며, 운영
컨테이너의 Health 변화나 서명·공증·Gatekeeper 검증을 의미하지 않는다.

## 초기 감사 발견 사항

### P1 — 기본 통합 로그 창에서 수집된 본문이 보이지 않음

프로젝트를 선택해 통합 로그를 열면 두 소스가 수집 중이고 보관 행 수가 1,248행
이상인데도 시각·서비스·컨테이너·본문 헤더 아래가 비어 있었다. 복사 버튼은
활성화되어 있었으며 **최신 위치**를 눌러도 본문이 나타나지 않았다.

**확대**를 누르자 실제 로그 행이 즉시 나타났다. Dark/English 상태에서도
표시되었고, 선택한 `api` 서비스와 대소문자를 섞어 입력한 키워드 필터도
유지되었다. 따라서 수집 데이터 부재보다는 기본 창의 배치·스크롤 문제가
유력하다. 임시 사용 방법은 통합 로그 확대다.

소스에서 확인한 관련 지점:

- `src/ProjectLogs.tsx:103–107`: 전체 행 높이와 viewport 높이로 최신 위치 계산.
- `src/ProjectLogs.tsx:152`: 실제 행 창을 `offset × 26px` 위치에 절대 배치.
- `src/observation.css:20–22`: viewport의 `flex: 1`, spacer와 절대 배치 창.
- `src/detailTabs.css:7`: 부모 패널의 `flex: 1 0 auto`.

기본 패널에서 viewport 높이가 보이는 영역보다 커지거나 가상 행 위치와 실제
스크롤 기준이 어긋나는 경로를 확인해야 한다. 확대 전후의 관찰은 배치 문제를
뒷받침하지만, DOM 치수와 원인 수정은 이번 감사에서 확인하지 않았다.

증거:

- [기본 통합 로그 본문 공백](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/integrated-logs-blank.png)
- [확대 후 실제 로그 표시](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/integrated-logs-expanded-dark.png)

### P2 — 앱 연결 직후 로그 구독이 StaleHandle로 실패

실제 Engine과 격리 fixture의 초기 화면 모두에서 아래 오류를 관찰했다.

```text
StaleHandle
Log subscription was superseded during validation
```

소스에는 이 오류를 설명하는 경합 경로가 있다. `start_log_stream`은
`src-tauri/src/docker_stream.rs:166`에서 `stream_starting`을 설정하고 Engine을
검증한다. 자동 목록 수집의 작업 충돌 검사
(`src-tauri/src/docker_observation.rs:632–638`)와 조회 진입 검사
(`src-tauri/src/docker.rs:1155–1158`)에는 이 플래그가 없다. 따라서 구독 검증
도중 목록 갱신이 시작되거나 generation/handle이 교체될 수 있다. 구독은
`src-tauri/src/docker_stream.rs:185–189`에서 관찰한 문구로 실패한다.

첫 fixture `d2u-smoke-d08f7a5bf0`의 trace에서는 첫 목록 완료
`1789172129292` 이후 검증 작업이 겹쳤고 두 번째 목록이
`1789172129521`에 완료되었다. 그 사이 `container logs --follow` 실행은
없었다. UI 문구와 소스 경로는 일치하며, 명시적으로 동기화한 경합 테스트는
이번에 실행하지 않았다.

`src/liveLogController.ts:137`에서 시작 요청 전에 `wanted`가 해제되고,
실패 후 `error` 상태가 된다. 같은 full ID의 새 generation만 받아서는
재시작하지 않으며 `update`의 Refresh 재시작 처리는 `ended`/`following`만
다룬다 (`src/liveLogController.ts:58–89`). 이 때문에 자동 갱신만으로 초기
로그 오류가 복구되지 않을 수 있다. 구독 시작과 자동 갱신을 조정하고,
최신 목록이 도착한 뒤 일시적인 구독 충돌을 복구하는 경로가 필요하다.
generation/handle 검증 자체는 유지해야 한다.

- [초기 StaleHandle 화면](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/startup-stale-handle.png)

### 경미한 일관성 사항 — English 화면의 시각에 한국어 오전 표시

English로 전환해도 이력의 시각에는 `오전`이 남았다. 이력의 시각 표시는
앱 언어를 전달하지 않는 `toLocaleTimeString()`을 사용한다
(`src/ObservationHistory.tsx:35`, `62`, `74`). 현재 OS/runtime locale을 따르는
동작으로 보이며 수집 또는 시각 값 오류로 판단하지 않았다. 앱 언어와 OS
시각 형식 중 어느 정책을 따를지 정하면 된다.

## 화면에서 확인한 정상 동작

| 조작·항목 | 관찰 결과 |
| --- | --- |
| 프로젝트 이력과 서비스 펼치기 | 컨테이너별 CPU·메모리 그래프 표시 |
| CPU 100% 초과 | 표본 125.5%, 그래프 축 상한 126% 표시 |
| 메모리 | 64 MiB 표본과 그래프 표시 |
| Health 이벤트 | 합성 healthy/unhealthy 변화가 이력에 표시 |
| 분할 영역 크기 조정 | 분할 값 300 → 443.75 변경 후 화면 확인 |
| Light/Korean → Dark/English | 프로젝트·이력 펼침 상태 유지 |
| 서비스·키워드 필터 | 선택한 서비스와 키워드 상태가 테마·언어 전환 및 확대 후 유지 |
| 로그 확대 | 기본 창에서 보이지 않던 본문 표시 |

전체 색 조합의 정량 대비 검사나 모든 창 크기 검사는 수행하지 않았다.

- [Light/Korean 이력](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/history-light-ko.png)
- [Dark/English 이력](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/history-dark-en.png)

## 최소화 중 수집과 복귀 검증

세 번째 실행 `d2u-smoke-2ed46f435e`에서 실제 WebView hidden 구간의 Core 수집과
복귀 검사가 통과했고 공식 report validator가 수락했다. 앞선 두 실행은
실패 기록으로 보존하며 성공으로 집계하지 않는다.

| 실행 | 결과 |
| --- | --- |
| `d2u-smoke-d08f7a5bf0` | 첫 시도에서 필요한 WebView hidden 구간 증거를 확보하지 못함 |
| `d2u-smoke-9bae3ff531` | baseline 통과. 복귀 검사에서 hidden 구간 로그 조건 실패 |
| `d2u-smoke-2ed46f435e` | baseline·restore 통과, `accepted: true`, `observationCoverageComplete: true` |

세 번째 실행의 확인 값:

| 항목 | 증거 |
| --- | --- |
| WebView hidden 구간 | `1789172587555` → `1789172627446`, 39.891초 |
| hidden 구간 자원 수신 표본 | 28개 |
| hidden 구간 로그 수신 표본 | 160행 |
| hidden 구간 Health 수신 표본 | 106개 |
| 목록 generation | 7 → 23 |
| 로그 sequence | 4 → 228 |
| Engine 세션 | 동일 세션 유지 |
| 복귀 후 DOM 행 수 | 160행 |
| 공식 report 수락 시 CLI trace | 884건, 거절 명령 0건 |
| 정리 후 최종 CLI trace | 949건, 거절 명령 0건 |

위 수신 개수는 probe가 읽어 검증한 표본 수다. 특히 로그는 최신 160행 조회
상한이 있으므로 hidden 구간 전체 출력량으로 해석하지 않는다. `renderedRows`도
DOM 행 개수이며 실제 viewport 안에서 행이 보인다는 검사와 다르다. 따라서
최소화 검증 통과가 앞서 확인한 기본 로그 창의 본문 공백을 해소하지 않는다.

전체 기존 smoke coverage인 `requiredCoverageComplete`는 `false`다. 이번에
실행하지 않은 별도 legacy probe가 포함되기 때문이며, 관찰 기능의 baseline과
restore 검증은 모두 수락되었다.

검증 후 owned fixture를 종료했다. 최종 report는 `status: stopped`이며
`observationCoverageComplete: true`를 유지하고, 임시 fixture root가 제거된 것을
확인했다. Finder는 기존 Downloads 위치로 복구했다.

- [세 번째 실행의 공식 report](../.cache/native-smoke/runs/d2u-smoke-2ed46f435e/report.json)
- [세 번째 실행의 전체 UI 증거](../.cache/native-smoke/runs/d2u-smoke-2ed46f435e/ui-observation.json)

두 번째 실행의 baseline은 `1789172259469`, 복귀 검사 시작은
`1789172400522`였다. 실패 문구는 아래와 같다.

```text
No project logs were collected inside the hidden interval; enable fixture live-on
```

이 결과만으로 백그라운드 로그 수집이 중단되었다고 판정할 수 없다.
해당 구간 trace에는 API 로그 출력 1,110건, Health 출력 555건, 자원 payload
63회가 있다. probe는 자원 수신 조건을 통과한 뒤 로그 조건에서 실패했다.
출력 trace는 fixture가 데이터를 보낸 증거이며 그 자체로 Core 수신을 증명하지는
않는다.

`src/test/native-smoke/observationProbes.ts:19`는 최신 160행만 조회한다.
fixture가 약 8행/초를 생성하므로 WebView가 visible 상태가 된 뒤 검사 버튼을
누르기까지 약 20초 이상 걸리면 hidden 구간 로그가 조회 페이지에서 빠질 수
있다. 따라서 이번 실패는 probe의 조회 범위로 인한 오탐 가능성이 있다.

세 번째 실행에서는 baseline 후 실제 최소화하고, 충분히 기다린 다음 숨김 상태에서
합성 출력만 `live-off`로 멈췄다. Finder에서 같은 정확한 앱 번들을 열어 복귀한 뒤
검증했다. hidden 수신 행이 최신 페이지에서 밀려나는 변수를 제거했으며
production 코드나 probe는 변경하지 않았다.

- [두 번째 실행의 실패 JSON](../.cache/native-smoke/runs/d2u-smoke-9bae3ff531/ui-observation-failed.json)

## 권장 수정·재검증 순서

1. 기본 통합 로그 viewport를 보이는 패널 안에 제한하고 실제 행이 보이는지
   WKWebView에서 확인한다. 기본/확대, 큰 보관 행 수, 최신 위치와 이전 행 탐색을
   함께 확인한다.
2. 자동 목록 수집과 로그 구독 시작의 경합 및 최신 목록 도착 후 복구를 검사한다.
3. 최소화 probe는 숨김 구간을 포함하는 조회 범위를 확보하고 실패 시에도
   visibility 시각과 조회 범위를 남기도록 보완한다.

위 초기 감사 단계에는 수정 구현·전체 회귀 테스트·릴리스 검증이 포함되지 않았다.

## 승인된 수정 — 2026-09-12 후속 검증

기존 `codex/project-observation` 작업본에서 미커밋 구현을 보존하고 두 결함을
수정했다. 변경 전 파일과 패치는 `.cache/log-fix-baseline-20260912`에 보존했다.
아래 설명의 변경 범위는 Git HEAD가 아니라 이 수정 직전 작업본과의 차이다.

### 구현과 경계

- 프로젝트 통합 로그와 프로젝트 수집을 재사용하는 개별 로그의 부모에 전용
  높이 제한을 적용했다. 가상 spacer가 부모의 고유 높이를 늘리지 않으며,
  내부 viewport가 스크롤한다. 로그 영역은 최소 80px이고 작은 분할에서는
  외부 패널을 스크롤해 도구 모음과 탭에 접근할 수 있다.
- 최신 위치와 과거 행 ID·행 내부 오프셋을 복원한다. ResizeObserver가 표시
  높이에 맞춰 조회 범위를 조정하며, 일시정지 중에는 고정 sequence 이내만
  조회한다. 확대 시 브라우저가 제한한 scrollTop은 원래 위치를 덮어쓰지 않는다.
  확대 상태에서 사용자가 직접 이동한 위치는 새 위치로 보존한다.
- Core 자동 수집기의 사전 검사와 mutex 내부 목록 조회 진입 검사에
  `stream_starting`을 포함했다. 목록 갱신이 먼저 진입했을 때의 Busy 및
  generation/handle 검증은 유지했다.
- 개별 로그의 구독 시작이 Busy/StaleHandle로 거절된 경우에만 최신 목록으로
  자동 복구한다. 동일 세션·전체 컨테이너 ID, 더 새로운 유효 generation이
  필요하며 최신 handle로 최대 2회 재시도한다. 목록의 선행/후행 도착을 모두
  처리한다. 명시적 로그 재조회는 한도를 초기화하며 Clear·선택 변경·재연결은
  대기 중 재시도를 폐기한다. 연결 후 읽기 오류나 정상 종료에는 추가 자동
  재시도를 적용하지 않는다.
- 공개 IPC, 응답 타입, 저장 형식은 이번 수정에서 변경하지 않았다.

### 회귀 검사에서 보완한 항목

브라우저 검사는 3,000행 이상의 가상 로그에 대해 창과 모든 clipping 부모의
교차 영역 안에 행이 있는지 확인한다. 기본/확대, 프로젝트와 재사용 개별 로그,
최신 위치, 과거 행과 7px 오프셋, 서비스·키워드 필터, 일시정지, 창·분할 크기,
테마·언어 전환을 포함한다. DOM 행 개수만으로 통과시키지 않았다.

독립 검토에서 일시정지한 최신 위치를 확대·축소할 때 scrollTop이
`77892 → 77390 → 77390`으로 바뀌는 결함을 추가 재현했다. 최종 수정은
`77892 → 77390 → 77892`로 복원하며, 확대 중 사용자가 한 행(26px) 위로
이동한 경우에는 그 새 위치를 보존한다. 두 경로를 브라우저 회귀에 추가했다.

첫 전체 브라우저 실행은 234개 통과, 9개 실패였다. 실패는 모두 기존 키보드
탭 테스트가 End 키의 도착점을 ‘접속 정보’로 가정한 데서 발생했다. 수정 전
작업본에도 마지막 ‘이력’ 탭이 이미 존재했다. 제품 탭 동작을 바꾸지 않고
End → 이력, ArrowLeft → 접속 정보로 테스트 기대값을 정정했다.

한 차례 고병렬 프런트엔드 실행에서는 기존 연결 테스트의 `raw logs` 대기가
1초 내 끝나지 않았다(579/580 통과). 해당 파일 단독 26개와 병렬도 4로 제한한
전체 580개가 통과했다. 이 대기 시간 실패를 숨기기 위한 테스트 변경은 하지 않았다.

Rust fixture는 Engine 검증과 inspect 진입을 파일 gate로 제어해 두 순서를
재현했다. 구독 시작이 먼저면 자동 목록 갱신이 기다리고, 갱신이 먼저면
기존 요청을 거절한 뒤 새 목록의 handle로 시작할 수 있음을 확인했다.

Native Smoke 복귀 probe도 DOM 행 수만 세던 방식에서 실제 viewport와 모든
clipping 부모 안에 온전히 보이는 행을 검사하도록 보완했다. 공식 report
validator는 `visibleLogRows`가 양의 정수이며 DOM 행 수 이하인 경우만 수락한다.

중간 번들 실행 `d2u-smoke-1b5b1ddda6`에서는 초기 UI의 Busy와 목록 시각이
정지해 보였다. trace상 Core 목록·자원 수집은 계속됐고, Finder로 정확한
실행 번들을 활성화하자 UI가 갱신됐다. 이는 hidden 상태에서 표시 조회를
멈추는 경로와 부합하지만 당시 visibility 증거가 없어 확정 원인으로 쓰지
않는다. 이 실행의 기본 통합 로그 830행 중 실제 본문은 보였으나 최종 검증으로
집계하지 않는다. 최종 소스 확정 전에 종료했고 fixture root 제거를 확인했다.

### 최종 검증 결과

| 검증 | 결과 |
| --- | --- |
| 프런트엔드 전체 (`vitest run --maxWorkers=4`) | 35파일, 580개 통과 |
| Rust 전체 (`cargo test --locked -- --test-threads=4`) | 127개 통과, 실제 Engine opt-in 6개 미실행 |
| Python Native Smoke fixture 전체 | 33개 통과 |
| 최종 브라우저 전체, 9개 테마·언어·창 조합 | 250개 통과, 새 테스트의 입력 전달 경합 2개 실패 |
| 입력 전달을 기다리도록 보완한 해당 브라우저 케이스 | 9개 조합 모두 통과 |
| TypeScript, 웹 production build | 통과 |
| production fixture 혼입 검사 | 5개 산출물 검사 통과 |
| Native Smoke release app build | 통과, unsigned test-only 번들 |
| Rust format, `git diff --check` | 통과 |

최종 전체 브라우저 실행의 두 실패는 새 paused-tail 테스트가 scrollTop을 바꾼 뒤
약 6ms 만에 Escape를 보내 scroll 이벤트가 전달되기 전에 portal을 닫은 경합이다.
실제 scroll 이벤트와 다음 animation frame을 기다리도록 테스트만 보완한 뒤
해당 케이스를 9개 조합 모두 재검사했다. 나머지 250개 결과와 이 9개 재검사
결과를 구분하며, 최종 전체 252개가 한 번에 통과했다고 주장하지 않는다.
이 테스트 보완 이후 제품 코드는 바뀌지 않았다.

브라우저 실행은 기본 설정의 project matrix를 그대로 사용하고, 기존 설치된
Vite를 직접 실행하도록 임시 설정 `.cache/log-layout.playwright.config.ts`만
사용했다. 전체 결과는 `.cache/log-layout-test-results`, 해당 재검사는
`.cache/log-layout-tail-test-results`에 보존했다.

### 최종 Native Smoke — 실제 화면과 최소화 복귀

- 번들: `.cache/native-smoke/bundles/1d0f1da5e3424a29989d2b59fbed8a13/Docker2U Native Smoke.app`
- 바이너리 SHA-256: `48f56c1c77f1124ebd3ae953c160514b6c38470252144586834185809777649b`
- 실행: `d2u-smoke-15c7d36490`
- 공식 launcher로 격리 fixture를 먼저 시작한 뒤 Finder에서 정확한 실행 번들을
  열어 창을 활성화했다. `native-smoke-local` 및 owned socket 경로를 확인했다.

초기 개별 로그가 수동 로그 재조회 없이 **실시간 수집 중**으로 표시됐으며,
합성 2 MiB 로그 본문과 `NATIVE_SMOKE_END`가 기본 패널 안에 보였다.
관찰 baseline을 잡기 전 stream evidence는 starts 1, 최대 동시 읽기 1이었다.
GUI 실행에서 경합의 모든 순서를 강제로 재현한 것은 아니며, 시작 순서의 보장은
앞서 설명한 제어 가능한 Rust 및 프런트엔드 검사로 확인했다.

프로젝트 baseline 후 실제 Command-M으로 최소화했다. 숨김 중 합성 출력을
멈춘 다음 Finder에서 같은 실행 번들을 복원해 숨김 표본이 최신 160행 밖으로
밀려나는 변수를 제거했다. Core 세션은 유지됐다.

| 항목 | 확인 값 |
| --- | --- |
| WebView hidden 구간 | `1789183289350` → `1789183333662`, 44.312초 |
| hidden 구간 자원 수신 표본 | 34개 |
| hidden 구간 로그 수신 표본 | 160행 |
| hidden 구간 Health 수신 표본 | 129개 |
| 목록 generation | 51 → 72 |
| 로그 sequence | 4 → 314 |
| 복귀 후 DOM 행 / 실제 viewport 안의 완전한 행 | 40행 / 3행 |
| 기본 분할 높이 | 300 |
| 공식 report | `accepted: true`, `observationCoverageComplete: true` |
| 정리 후 상태 | `stopped`, fixture root 제거, CLI trace 3,070건, 거절 명령 0건 |

기본 통합 로그 314행의 실제 본문을 화면에서 확인했고, 일시정지 → 확대 → Escape
복귀 후에도 일시정지와 314행 보관 상태가 유지됐다. 3,000행 이상 검사는
브라우저 fixture에서 수행했으며 이 네이티브 실행의 보관 행 수로 대신하지 않는다.
수신 개수는 검증한 표본 수이며 hidden 구간의 전체 출력량은 아니다.

전체 legacy smoke probe는 이번 범위에 포함하지 않았으므로
`requiredCoverageComplete: false`다. 관찰 baseline·restore는 모두 공식
validator가 수락했다. 검증 후 owned 앱과 fixture를 종료하고 Finder를
기존 다운로드 위치로 복원했다.

- [초기 개별 로그 실제 표시](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/initial-individual.png)
- [기본 통합 로그 복귀 화면](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/integrated-logs-restored.png)
- [일시정지 상태 확대 화면](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/integrated-logs-expanded-paused.png)
- [축소 후 일시정지 화면](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/integrated-logs-collapsed-paused.png)
- [공식 report](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/report.json)
- [전체 UI 수신·visibility 증거](../.cache/native-smoke/runs/d2u-smoke-15c7d36490/ui-observation.json)

위 수정·합성 검증 단계에서 두 결함 수정과 회귀·네이티브 검증을 마쳤다.
그 단계에서는 실제 컨테이너 조작, 설치 앱 교체, 커밋·푸시·PR 생성,
영어 시각 형식 변경을 수행하지 않았다.
실제 Engine 동작, 공증·Gatekeeper 및 배포 설치 검증은 이 합성 fixture 결과와
별개이며 이번 완료 범위에 포함하지 않는다.

## 추가 승인에 따른 설치 앱 교체 — 2026-09-12

사용자가 설치 앱 교체와 커밋·푸시를 추가로 승인했다. Native Smoke가 아닌
정식 `Docker2U.app`를 locked production 설정으로 새로 빌드했다. TypeScript,
Vite production 및 fixture 혼입 검사가 통과했고 ARM64 앱 번들 생성이 성공했다.
배포용 인증서 없이 로컬 ad-hoc 서명을 적용하고 `codesign --verify --deep --strict`
및 ARM64 아키텍처 검사를 통과했다. 공증·Gatekeeper 검증을 의미하지 않는다.

| 항목 | 확인 값 |
| --- | --- |
| 설치 경로 | `/Applications/Docker2U.app` |
| Bundle ID / 버전 | `io.github.jgoneit.docker2u` / `0.1.0-alpha.1` |
| 교체 전 바이너리 SHA-256 | `e69b41d08b265481b71571e6f3d2ebe35fbca1607bd73e30f8acc1a2e23f178d` |
| 교체 후 바이너리 SHA-256 | `913c27096be496b4582b604dce2a09f817db422c88f2930e55911e13db2e151b` |
| 백업 | `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-131323-7695b092/Docker2U.app` |

교체 전 모든 번들 파일의 digest를 백업과 대조했다. 새 번들을 별도 staging 경로에
준비한 뒤 기존 앱을 Command-Q로 정상 종료하고 교체했다. 설치 경로의 모든 파일이
서명된 새 빌드와 일치함을 확인했다. 같은 백업 디렉터리의 `installation.json`에
이전·새 파일 digest와 교체 상태를 보존했다.

Computer Use로 정확한 설치 경로를 재실행했다. `desktop-linux`가 연결되고 기존
컨테이너 4개와 자원 값, 목록 시각이 자동 갱신됐다. 첫 개별 로그는 수동 재조회 없이
‘실시간 수집 중’으로 표시됐다. 프로젝트 선택 후 4개 로그 소스가 모두 ‘수집 중’이며,
이력의 Redis 서비스를 펼쳐 실제 CPU·메모리 그래프가 보이는 것을 확인했다.

실제 Engine의 프로젝트 최근 로그는 0행이고 새 상태 이벤트도 없었다. 로그나
이벤트를 만들기 위한 Start/Stop/Restart/exec를 실행하지 않았다. 실제 설치 검사는
연결·수집 상태·자원 그래프의 증거이고, 로그 본문 표시는 앞선 합성 fixture 검사로
확인했다. 교체한 앱은 실행 상태로 남겼다.

- [설치 앱 프로젝트 로그 상태](../.cache/installed-app-validation-20260912/project-logs.png)
- [설치 앱 CPU·메모리 그래프](../.cache/installed-app-validation-20260912/project-history-expanded.png)

설치 롤백은 Docker2U를 종료한 뒤 위 백업의 `Docker2U.app`를 설치 경로로 복원하고,
교체 전 SHA-256 및 코드 서명을 대조한 다음 다시 실행한다. 이번에는 GitHub 브랜치
푸시까지 진행하며 PR·Release 생성과 main 병합은 포함하지 않는다.
