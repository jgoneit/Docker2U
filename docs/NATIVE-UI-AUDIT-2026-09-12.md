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

## 설정·관찰 컨트롤 스타일 후속 수정 — 2026-09-12

설치 화면에서 설정의 테마·언어 선택 상자에 브라우저 기본 외형이 남아 있었고,
이력 행·그래프와 통합 로그 조작부에 밝은 테두리가 반복됐다. 기존 프로젝트 선택기와
같은 색상 토큰과 둥근 모서리를 적용하고, 상시 외곽선을 배경색 구분으로 대체했다.
키보드로 조작할 때의 포커스 표시는 유지한다.

- 설정: 네이티브 `select`와 레이블을 유지하고 40px 높이, 10px 모서리, 선택 아이콘을 적용했다.
- 통합 로그: 검색·서비스 필터에 34px 컨트롤과 선택 상태 색상을 적용하고 버튼·구분선의 대비를 조정했다.
- 이력: 서비스 행에 펼침 아이콘과 선택 배경을 적용하고 그래프를 낮은 대비의 배경으로 구분했다.
- 수집·재시도·스크롤 로직, 공개 IPC·응답 타입과 저장 형식은 변경하지 않았다.

### 검증

| 검사 | 결과 |
| --- | --- |
| `observation`, `App.observation`, `preferences`, `App.preferences` Vitest | 4개 파일, 63개 통과 |
| 기존 `tests/browser/observation.spec.ts` | 9개 테마·언어·화면 크기 조합, 54개 통과, 재시도 없음 |
| TypeScript·Vite production·fixture 혼입 검사 | 통과 |
| locked production ARM64 앱 빌드 | 통과 |
| 번들 ad-hoc 서명·`codesign --verify --deep --strict`·ARM64 검사 | 통과 |

브라우저 검사는 3,000행 이상 로그가 실제 viewport 안에 있는지, 필터·일시정지,
테마·언어 전환, 최소 분할 높이와 과거 위치·부분 행 스크롤 보존을 확인한다.
이번 스타일 변경에서는 Rust 소스를 변경하지 않았고 Rust 전체 검사를 다시 실행하지 않았다.
앞선 전체 회귀 결과와 이번 집중 검사 결과를 구분한다.

Computer Use로 교체한 `/Applications/Docker2U.app`를 실행해 다크·라이트 설정의
선택 상자와 포커스 표시를 직접 확인했다. 네이티브 메뉴에서 키보드로 영어를 선택해
문구 전환을 확인한 뒤 한국어와 시스템 테마로 복원했다. 서비스 필터를 펼쳐
체크박스·메뉴 외형을 확인하고, 프로젝트 이력에서 Redis를 펼쳐 CPU·메모리 그래프와
선택 행이 실제 화면에 보이는지 확인했다. 검사 후 기존 memcached-1 개별 이력과
220px 분할 높이로 복원했다.

실제 Engine은 `desktop-linux`, 기존 컨테이너 4개가 연결되고 로그 소스 4개가 수집 중이다.
최근 로그는 0행이었다. 실제 컨테이너를 변경하거나 합성 출력을 생성하지 않았다.
이번 검사는 설치 앱의 외형·선택 동작·자원 그래프 검증이며, 로그 본문은 브라우저
fixture와 앞선 Native Smoke 검증으로 구분한다.

- [수정 전 설정](../.cache/control-polish-20260912/settings-before.png)
- [수정 후 다크 설정](../.cache/control-polish-20260912/settings-dark-rest.png)
- [수정 후 라이트 설정](../.cache/control-polish-20260912/settings-light-rest.png)
- [키보드 포커스 표시](../.cache/control-polish-20260912/settings-light.png)
- [통합 로그 조작부](../.cache/control-polish-20260912/project-toolbar-dark.png)
- [서비스 필터 펼침](../.cache/control-polish-20260912/service-filter-dark.png)
- [이력 선택 행과 그래프](../.cache/control-polish-20260912/history-dark.png)

### 설치 교체와 복구

| 항목 | 확인 값 |
| --- | --- |
| 교체 전 바이너리 SHA-256 | `913c27096be496b4582b604dce2a09f817db422c88f2930e55911e13db2e151b` |
| 교체 후 바이너리 SHA-256 | `95a42296a4bbab05652588b87b8034201d3b1a45b5d4168574600d47f7b45a25` |
| 복구용 백업 | `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-133041-b0924ba8/Docker2U.app` |
| 설치 경로·Bundle ID·버전 | `/Applications/Docker2U.app` · `io.github.jgoneit.docker2u` · `0.1.0-alpha.1` |

기존 앱을 정상 종료한 뒤 staging 번들로 교체했다. 백업은 교체 전 전체 파일 digest와,
설치 앱은 서명된 새 빌드의 전체 파일 digest와 일치한다. 같은 백업 디렉터리의
`installation.json`에 대조 결과와 설치 상태를 보존했다. 롤백은 앱을 종료하고
이 백업을 설치 경로로 복원한 다음 이전 digest와 코드 서명을 확인해 실행한다.
앱은 로컬 ad-hoc 서명이며 공증·Gatekeeper 검증은 수행하지 않았다.


## 기존 로그 표시와 테마 라디오 카드 — 2026-09-12

사용자가 여전히 빈 로그 화면을 지적했다. 앞선 설치 검증은 `--since 30m` 결과와만
비교하여, Docker에 남은 과거 로그가 제외되는 문제를 놓쳤다. 같은 `desktop-linux`의
컨테이너를 변경하지 않고 `--tail 300`과 `--since 30m --tail 300`을 비교했다.

| 컨테이너 서비스 | 최신 최대 300행 | 최근 30분 | 마지막 출력 시각 UTC |
| --- | --- | --- | --- |
| PostgreSQL | 128행 | 0행 | 2026-09-07 15:12:26 |
| Redis | 300행 | 0행 | 2026-09-08 13:00:54 |
| Memcached 1·2 | 각각 0행 | 각각 0행 | 없음 |

### 수정

초기 Engine 로그 요청에서 30분 조건을 제거하고 최근 최대 300행을 가져온 뒤 새 출력을
계속 수신한다. 로그 보관은 소스별 최신 **수신** 300행을 시간 제한과 별도로 보호하며,
그 밖의 추가 기록에는 30분 보관을 적용한다. 기존 소스별 1 MiB, 전체 32 MiB·100,000행
상한이 우선하므로 긴 행이나 전체 용량에 따라 300행보다 적게 남을 수 있다.

원본 timestamp 정렬과 재연결 중복 제거는 유지한다. 만료·용량 퇴출 시 보조 인덱스도
정리하고, 소스별 수신 순번으로 최근 300행의 경계를 유지한다. 제거된 소스와 이전
프로젝트도 같은 전역 한도 안에서 보관하고 새 세션에서는 해제한다. 시계 역행·미래
timestamp가 추가 기록의 보관 시간을 부풀리지 않도록 수신 시각도 만료에 반영한다.

화면은 연결 중·수집 대상 없음·수신한 출력 없음·필터 결과 없음·오류를 구분한다.
필터 초기화 버튼과 날짜를 포함한 보관 구간을 표시하며, 개별 컨테이너의 오류·선택
개수는 해당 컨테이너를 기준으로 표시한다. 공개 IPC·응답 타입·저장 형식은 바뀌지 않았다.

설정의 테마 선택기는 시스템·라이트·다크 SVG 미리보기 라디오 카드로 변경했다.
시스템 미리보기는 밝은 화면과 어두운 화면을 반씩 보여준다. 네이티브 radio의 방향키,
단일 선택, Tab 이동과 저장·재열기 시 포커스를 유지하며 언어는 기존 선택기를 사용한다.
색상은 기존 테마 토큰 규칙을 따른다.

### 검증 결과

| 검사 | 결과 |
| --- | --- |
| 전체 Vitest | 35개 파일, 588개 통과 |
| 전체 Rust | 133개 통과, opt-in 6개 제외 |
| 로그 집중 Rust | 17개 통과, 전체 검사에 포함 |
| 실제 Engine 읽기 전용 Rust | 별도 1개 통과: API·CLI 각각 로그 428행, 수집 소스 4개, 소스 오류 0개 |
| 관찰·기존 UI Playwright | 99개 중 98개 통과; 아래 시간 초과 1건 별도 재검사 |
| 동일 브라우저 실패 케이스 재검사 | 3회 모두 통과 |
| 테마 카드 브라우저 화면·키보드 | 한국어·영어 × 라이트·다크 4조합 통과 |
| TypeScript·Rust format·diff check | 통과 |
| production 웹·fixture 혼입 검사·locked ARM64 앱 빌드 | 통과 |

HTTP fixture는 초기 요청이 `tail=300&follow=1`이고 `since`가 없음을 검사한다.
5일 지난 300행을 실제 HTTP 스트림으로 받은 뒤 제어 가능한 새 출력을 추가해
최신 300행 보호를 확인했다. 조용한 소스, 추가 이력 만료, 순서가 뒤바뀐 수신,
미래 timestamp, 시계 역행, 용량 퇴출, 제거된 소스와 세션 해제 검사도 포함한다.

첫 전체 Vitest 실행에서는 새 미리보기의 직접 색상 값이 기존 테마 규칙 검사에
걸렸다. 동일 색상을 테마 토큰으로 옮긴 뒤 전체 588개 재실행이 통과했다.
브라우저의 dark-en 1280 조합에서 기존 자동 수집 주기 검사 1건이 5초 대기 내
예상 읽기 횟수에 도달하지 못했다. 테마 조작 전의 실패이며 타임아웃이나 제품 코드를
바꾸지 않고 같은 케이스를 3회 재실행해 모두 통과했다. 원본 trace는
`.cache/theme-radio-cards-20260912/browser-cadence-first-failure/`에 보존했다.

실 Engine 검사도 보완했다. 구조화 출력용 `checked_output`의 `Output.logs`는 비어 있으므로
이 필드를 읽으면 CLI 로그를 0행으로 잘못 기록했다. 실제 로그 캡처 모드로 두 출력을
합쳐 세고 종료 상태를 검사하도록 바꿨다. 최종 재실행은 API와 CLI 모두 428행이며
[본문을 포함하지 않는 검사 결과](../.cache/log-tail-theme-20260912/real-engine.log)에 보존했다.
이 보완은 테스트 파일만 변경했고 설치한 production 동작에는 영향이 없다.

### 설치 앱의 실제 화면

Computer Use로 정확한 설치 경로를 열고 `django-docker-box` 프로젝트를 선택했다.
기본 300px 분할 화면에서 **428행**과 Redis의 기존 로그 본문이 실제로 보였다.
PostgreSQL 개별 로그는 **128행**이었다. 임의의 불일치 키워드를 넣으면 필터 결과 없음이
표시되고 **필터 초기화** 후 428행으로 복구됐다. Memcached 개별 로그는 0행이며
‘아직 수신한 로그가 없습니다. 컨테이너가 새 로그를 출력하면 여기에 표시됩니다.’라고 안내했다.

설정 카드를 클릭해 라이트를 선택하고 오른쪽 방향키로 다크를 선택했다.
선택된 radio가 하나임을 확인했으며 Tab 한 번으로 언어 선택기로 이동했다.
다크·라이트의 카드 그림과 대비를 화면에서 확인하고 시스템 테마·한국어로 복원했다.
로그를 만들기 위한 Start/Stop/Restart/exec나 실제 Docker 설정 변경은 하지 않았다.
이 실행에서는 Native Smoke를 다시 실행하지 않았고 실제 Engine·설치 화면으로 검증했다.

- [Docker CLI 로그 개수와 시각](../.cache/log-tail-theme-20260912/cli-log-metadata.json)
- [수정 전 통합 로그](../.cache/log-tail-theme-20260912/before-project-empty.png)
- [설치 앱 기본 통합 로그](../.cache/log-tail-theme-20260912/installed-combined-logs.png)
- [PostgreSQL 개별 로그](../.cache/log-tail-theme-20260912/installed-postgresql.png)
- [출력 없는 Memcached 안내](../.cache/log-tail-theme-20260912/installed-quiet-container.png)
- [다크 테마 카드](../.cache/log-tail-theme-20260912/installed-theme-cards-dark.png)
- [라이트 테마 카드](../.cache/log-tail-theme-20260912/installed-theme-cards-light.png)

### 설치와 롤백

| 항목 | 확인 값 |
| --- | --- |
| 교체 전 바이너리 SHA-256 | `95a42296a4bbab05652588b87b8034201d3b1a45b5d4168574600d47f7b45a25` |
| 교체 후 바이너리 SHA-256 | `3e7221bef897015ec2d277a7073a2980241501ca1970fdf5be56687e3fc661ae` |
| 백업 | `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-135302-0a0073c0/Docker2U.app` |
| 설치 | `/Applications/Docker2U.app`, `io.github.jgoneit.docker2u`, `0.1.0-alpha.1` |

교체 전 백업과 전체 파일 digest를 대조하고 새 빌드를 staging 경로에 준비했다.
기존 앱을 정상 종료한 뒤 교체했으며 설치 전체 파일 digest가 새 빌드와 일치한다.
로컬 ad-hoc 코드 서명과 ARM64 검사는 통과했다. 공증·Gatekeeper 검증은 수행하지 않았다.
같은 백업 디렉터리의 `installation.json`에 교체·검증 상태를 보존했다.
롤백은 앱을 종료하고 위 백업을 설치 경로로 복원한 뒤 이전 digest·서명을 확인해 실행한다.

## 탐색 트리와 로그 상태 복구 — 2026-09-12

이번 변경의 기준은 같은 작업본의 `1951d6ec69195faa0061d015833a747d3b3999ee`다.
위·아래 분할을 왼쪽 프로젝트·컨테이너 트리와 오른쪽 상세로 바꾸고, 프로젝트
드롭다운과 별도의 프로젝트 복귀 버튼을 제거했다. 프로젝트 이름은 통합 로그·이력,
하위 행은 해당 전체 ID의 상세를 선택한다. 트리에는 상태·CPU·메모리를 유지한다.

탐색 너비는 기본 320px이며 280–440px 범위 안에서 오른쪽 최소 600px에 맞춰
제한된다. 포인터, 좌우 방향키, Home/End, 더블클릭 복원을 제공한다. 선택과
키보드 포커스, 접기, 작업 체크, 검색·상태 필터를 분리했다. 검색에 가려진 상세는
안내와 함께 유지하고 삭제된 컨테이너는 원래 프로젝트로 이동한다. 같은 이름의
새 전체 ID를 이전 대상으로 취급하지 않는다. 자원 수집은 전체 트리를 대상으로
유지하며 이력 표시만 선택한 프로젝트·ID로 필터링한다.

Compose 통합·개별 화면은 같은 수집을 재사용한다. 대상별 마지막 탭과 검색,
서비스 필터, 일시정지, 기준 행, 마지막 성공 페이지를 세션 동안 유지한다.
프로젝트 없는 컨테이너도 기존 개별 수집 경로에서 검색·일시정지·스크롤과 마지막
표시를 복원한다. 재연결에서는 두 화면 캐시와 대기 요청을 폐기한다.

초기 configure의 `0행/starting`은 현재 조회 결과와 분리했다. 조회 순서와 세션·
프로젝트를 검증하고 10초 넘게 응답하지 않으면 기존 본문과 명시적 재조회 동작을
남긴다. 오래된 응답과 중복 자동 조회는 폐기한다. configure/stop은 순서대로
실행하며 적용에 실패한 수집 대상 편집은 열린 상태와 선택을 유지한다.

Core는 수집 시작 예약 token과 등록된 reader를 구분한다. recoverable manager
오류를 해제한 뒤 명시적 재개가 정체된 시작을 취소·재등록하도록 수정했다.
시작 실패·재개·같은 프로젝트 configure, 시작 취소와 reader 등록 경합은
제어 가능한 Rust fixture로 검사한다. 조용한 연결에는 무출력 timeout을 넣지
않았다. 기존 generation·전체 ID·최신 handle 검증과 시작 오류의 제한된 재시도는
유지한다. 공개 IPC·응답 타입·저장 형식은 변경하지 않았다.

### 최종 소스의 회귀 검사

| 검사 | 결과와 근거 |
| --- | --- |
| 전체 프런트엔드 | 37개 파일, 622개 통과 — `.cache/standalone-frontend-full.log` |
| Rust 형식·전체 테스트 | 형식 검사 통과, 139개 통과·opt-in 6개 제외 — `.cache/navigation-rust-regression.log` |
| 전체 브라우저 회귀 | 테마·언어·창 크기 9개 구성에서 270개 통과 — `.cache/navigation-browser-accepted.log` |
| Native Smoke Python fixture | 33개 통과 — `.cache/navigation-native-fixtures-final.log` |
| TypeScript·웹 production·fixture 격리·locked ARM64 빌드 | 통과, production fixture 격리는 5개 파일 검사 — `.cache/navigation-production-build.log` |
| diff 공백 검사 | 통과 |

프로젝트와 하위 행 선택, 키보드 이동·접기, 선택 강조, 검색으로 가려진 상세,
삭제·재생성, 작업 체크와 최신 handle 연결을 검사했다. 통합·개별 왕복과 다른
프로젝트 왕복, 검색·서비스 필터·일시정지·과거 위치, 폭 조절·확대·테마·언어
전환도 회귀 범위에 포함한다. 초기 `0행/starting` 뒤 정상 응답, 재진입, 미완료
조회와 늦은 응답 폐기를 제어 가능한 fixture로 재현했다.

3,000행 이상의 로그는 최소 1024×680 및 기본·큰 창에서 viewport와 조상 clipping
영역을 교차 계산해 실제 보이는 본문을 검사한다. DOM 행 개수만으로 통과시키지
않는다. 일시정지 안내가 생길 때 viewport 밖 overscan 행 하나가 달라지는 검사는
화면에 보이는 행을 기준으로 고쳤으며 제품 동작을 우회하지 않았다.

프로젝트 없는 컨테이너의 캐시를 추가한 첫 전체 프런트엔드 검사에서는 기존
회귀 11개가 실패했다. Clear·명시적 재조회·정상 빈 응답의 기존 의미를 보존하고,
같은 전체 ID에서 갱신 전 handle로 도착한 첫 프레임을 처리하도록 제품 코드를
보완했다. 기존 검증 조건을 약화하지 않고 집중 검사 257개와 최종 전체 622개를
통과했다. 최초 실패 기록은 `.cache/navigation-frontend-final.log`, 집중 검사는
`.cache/standalone-regressions.log`에 남겼다.

### 최종 Native Smoke 번들의 화면 검증

Computer Use로 다음 번들을 조작했다. 합성 Engine·로그는 fixture 전용 소켓과
프로세스에서 생성했으며 실제 Docker 컨테이너 Start·Stop·Restart는 하지 않았다.

| 항목 | 값 |
| --- | --- |
| Native Smoke Run | `d2u-smoke-22f689b4da` |
| 번들 | `.cache/native-smoke/bundles/2dac858b42334d0c970d5ed57a566e29/Docker2U Native Smoke.app` |
| 바이너리 SHA-256 | `2f9b6054cf423446be0a07140db97f64720104c4ccd7efafb6914fd204d1969e` |
| 정상 Worker 보고서 | `.cache/native-smoke/runs/d2u-smoke-22f689b4da/ui-navigation-worker.json` |
| 검증기 결과 | `.cache/navigation-native-worker-report.log`의 제출 보고서 `accepted: true`, `observationCoverageComplete: true` |

정상 Worker에서는 전체 트리의 자원 관찰, 프로젝트 없는 컨테이너 탐색, 2 MiB
밀집 로그 검색, 상세 탭 왕복, 실제 stdout·stderr 수신 중 일시정지·재개,
키보드 너비 320→340→320px 변경과 목록 갱신 중 동일 스트림 유지가 통과했다.
밀집 검색은 2,096,983개 일치 항목과 마지막 일치 본문이 실제 viewport 안에
있는지 확인했다. 폭 변경 중 표시 상태를 유지했고 최대 동시 read는 1이었다.

Worker 생성 실패와 ready 신호 억제를 각각 주입한 검색 복구도 통과했다.
각 보고서는 `ui-constructor-fail.json`, `ui-never-ready.json`이며 검증 결과는
`.cache/navigation-native-constructor-report.log`,
`.cache/navigation-native-timeout-report.log`에 보존했다. 두 제출 보고서 모두
`accepted: true`이며 명시적으로 주입한 실패 뒤 fallback 검색 화면을 확인했다.

최소화 검증은 숨김 상태에서 합성 출력을 생성한 뒤 **복원 전에 출력을 멈췄다**.
따라서 복원 후 새 출력만 보고 숨김 구간이 보존됐다고 판단하지 않았다.

| 최소화·복원 관찰 | 결과 |
| --- | --- |
| 숨김 구간 | 47.464초 (`1789194049905` → `1789194097369` ms) |
| 숨김 중 보존 자원 표본 | 54개 |
| 숨김 중 보존 로그 | 160행 |
| 숨김 중 보존 이벤트 | 145개 |
| 목록 generation | 49 → 76 |
| 로그 sequence | 12 → 431 |
| 복원 후 본문 | DOM 43행 중 실제 viewport 안에 완전히 보이는 18행 |

[복원 화면](../.cache/native-smoke/runs/d2u-smoke-22f689b4da/navigation-restored.png)과
보고서의 수신 시각·전체 ID·sequence를 함께 확인했다.

실패한 시도도 보존했다. 같은 최종 바이너리의 앞선 Run
`d2u-smoke-2ad19292cc`에서는 pane-resize 검사가 시간 초과했다. 해당 보고서는
그 Run의 `ui-failed-resize.json`이다. 이후 전경 앱에서 합성 출력 구간을 충분히
확보하고 실행 중 접근성 상태 조회를 하지 않는 절차로 같은 바이너리를 재검사해
통과했다. 원인은 확정하지 않았으며, 시간 초과 뒤 수집한
`.cache/navigation-webkit-sample.txt`만으로 실행 중 병목을 단정하지 않는다.

현재 Run에서도 Clear로 수집을 중단한 뒤 명시적 로그 조회 없이 검색·live 검사를
이어 실행한 시도는 필요한 2 MiB 입력이 없어 시간 초과했다. 그 원본은
`ui-sequence-failed.json`에 보존했다. 새 화면에서 입력을 준비한 뒤 위의 정상·
장애 주입 검사를 실행했다. 실패 보고서를 성공 보고서로 바꾸거나 집계하지 않았다.

### Production 번들과 Seal 검사 범위

최종 production 번들은 `src-tauri/target/release/bundle/macos/Docker2U.app`이다.
ARM64 바이너리 SHA-256은
`44cd7e57a88fcf23a12790863fe5ca7acc6000e54050712f5325fad8a752abd7`이다.
로컬 ad-hoc 재서명 뒤 strict·deep 코드 서명 검사를 통과했다. 이 결과는
Apple 공증이나 Gatekeeper 허용 여부를 증명하지 않는다. 설치 경로에서의 확인은
아래 설치 기록과 구분한다.

구현 전에 Seal Basic Task를 만들었다. Native Smoke 검증 스크립트를 범위에
포함하도록 최초 Task를 대체한 현재 Task는
`docker2u-navigation-log-recovery-20260912-v2`다. 필수 검사로 프런트엔드 테스트,
프런트엔드 빌드, Rust 형식, Rust 테스트를 선택했다. 이 감사 본문은 완료 후보의
입력이므로 정확한 Run 검증·Completion 전에 작성했다. 브라우저·네이티브·설치
확인은 위의 독립 증거로 기록하며 Seal의 기계적 검사 결과와 혼동하지 않는다.

### 설치 앱 교체와 실환경 Computer Use

기존 `/Applications/Docker2U.app`를 정상 종료한 뒤 다음 백업을 만들고 새 번들로
교체했다. 백업·스테이징의 전체 파일 해시와 심볼릭 링크를 원본에 비교했으며,
설치 후 바이너리 해시와 strict·deep 서명을 다시 확인했다.

- 백업: `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-152617-navigation/Docker2U.app`
- 이전 바이너리 SHA-256: `3e7221bef897015ec2d277a7073a2980241501ca1970fdf5be56687e3fc661ae`
- 설치 바이너리 SHA-256: `44cd7e57a88fcf23a12790863fe5ca7acc6000e54050712f5325fad8a752abd7`
- 실행 확인: PID `3339`, `/Applications/Docker2U.app/Contents/MacOS/docker2u`
- 교체 기록: `.cache/navigation-installation.json`

실제 설치 앱의 `desktop-linux` Engine에서 프로젝트 통합 로그 428행과
PostgreSQL 개별 로그 128행을 확인했다. 스크린샷에서 로그 본문이 오른쪽
viewport 안에 표시된다. 프로젝트에 `Ready` 필터와 일시정지를 설정한 뒤
PostgreSQL로 이동했다가 돌아오면 필터와 일시정지, 13행 조회 구간이 유지됐다.
프로젝트 없는 신규 통합 수집이나 실제 컨테이너 작업은 수행하지 않았다.

화면 증거는 `.cache/navigation-installed-20260912/project-combined.png`,
`postgresql.png`, `project-return.txt`에 보존했다. 롤백은 실행 앱을 정상 종료하고
위 백업을 `/Applications/Docker2U.app`로 복원한 뒤 재실행하는 단위다.

memcached-2는 0행이어도 `수집 중` 상태와 새 로그 대기 설명을 유지했다.
최소화·복원 뒤에도 같은 대상과 수집 상태를 확인했고, 프로젝트에 돌아왔을 때
`Ready`·일시정지도 유지됐다. 마지막에는 검사 필터와 일시정지를 해제하여
428행 통합 화면으로 복원했다. `quiet-before.txt`, `quiet-restored.txt`,
`quiet-memcached.png`, `restored-project.png`에 기록했다. 실환경 컨테이너는
새 로그를 주입하지 않았으며, 숨김 구간의 신규 표본 보존 증거는 앞의 합성
Native Smoke Run으로 한정한다.

### Native 복구 하네스 계약 보완

추가 지연 오류 검사에서 자동 조회가 주입된 다음 `info` 오류를 먼저 소비한
시도는 `ui-fault-consumed-by-refresh.json`,
`ui-fault-consumed-before-probe.json`으로 보존했다. 오류 주입·클릭을 같은
예약 시각에 맞춘 시도에서는 `held-info` → Clear → 오류 응답 순서를 실제
trace로 확인했고 Clear 뒤 연결 경고와 작업 차단을 유지했다.

이후 기존 복구 하네스가 오류 뒤 Refresh의 성공 목록을 요구해 실패했다.
실제 Core 계약은 세션 검증 실패 뒤 `NeedsValidation`을 반환하고 이전 정상
목록을 보존하며 명시적 Reconnect를 요구한다. 제품 코드는 바꾸지 않고,
하네스가 실제 목록 IPC 거절·동일 세션·기존 목록 보존·로그 시작 없음과
Reconnect 뒤 새 세션·새 로그 스트림을 검증하도록 수정했다. trace 검증기도
거절된 Refresh 구간의 CLI 목록·follow 시작을 거부한다. Python fixture
33개(복구 부정 조건 22개 subcase 포함), readiness 9개, TypeScript 검사를
통과했다. 원래 계약 불일치 보고서는 `ui-recovery-contract-mismatch.json`에
보존했다. 빠른 Worker 모드 전환 중 연결 Busy가 난 별도 시도도
`ui-mode-reset-busy.json`으로 보존했으며 연결 완료 후 다시 실행했다.

보완된 하네스로 별도 번들을 다시 빌드하고 전체 네이티브 회귀를 통과했다.
이 추가 변경은 검증 전용이며 설치한 production 제품 소스는 동일하다.

| 최종 Native Smoke | 결과 |
| --- | --- |
| Run | `d2u-smoke-9cc8d9c780` |
| 번들 경로 | `.cache/native-smoke/bundles/9ed04f0eeb8e4a27853695c68bc3e073/Docker2U Native Smoke.app` |
| 바이너리 SHA-256 | `a2366f769be25a33635c327720c02e95d87d84293cc5d1d5babefb5683b4e3bc` |
| 필수 네이티브 회귀 | `requiredCoverageComplete: true` |
| 프로젝트 관찰 회귀 | `observationCoverageComplete: true` |
| 제출 보고서 | 생성 실패·준비 신호 지연·정상 Worker 모두 `accepted: true` |
| 허용되지 않은 fixture 명령 | 0개 |
| 숨김 구간 | 47.154초 |
| 숨김 중 보존 표본 | 자원 54개·로그 160행·이벤트 125개 |
| 복원 목록 generation | 5 → 30 |
| 복원 로그 sequence | 8 → 258 |
| 복원 본문 | DOM 43행 중 실제 viewport 안에 완전히 보이는 18행 |

정상 Worker의 프로젝트·자원, 검색, 상세 탭, 고정 스트림 Refresh, 실시간 표시,
폭 변경, Clear/Engine 오류 순서, NeedsValidation/재연결, SocketMissing/재연결,
Clear 후 갱신, 최소화 표본·복원을 검증했다. 생성 실패와 준비 신호 지연에서의
검색 fallback도 별도로 통과했다. 이번에도 합성 출력은 **복원 전에 중단**했다.

검증기 결과는 `.cache/navigation-native-recovery-final-report.log`, 원본은
`.cache/native-smoke/runs/d2u-smoke-9cc8d9c780/ui-worker-final.json`, 화면은
같은 폴더의 `navigation-restored.png`다. fixture 실행을 정상 종료하고 trace를
보관했다. 이 최종 통과가 앞서 기록한 실패 시도를 삭제하거나 성공으로 바꾸지는 않는다.


## 콘솔형 로그와 하단바 복사 효과 복원 — 2026-09-12

탐색 트리 개편에서 Compose 개별 로그를 `ProjectLogs`로 통일하면서 기존
`LogPanel`의 콘솔 표현과 App 하단바 복사 피드백 연결이 빠졌다. 이 경로는
클립보드를 직접 호출하고 본문 위에 자체 결과 문구를 넣어, 원래의 하단바
그라데이션과 지연 응답 순서 보호를 사용하지 않았다.

- 기존 로그 패널과 같은 테마별 inset 배경, 12px 고정폭 글꼴, 얕은 테두리를 적용했다.
- 표 형태의 열 머리글을 제거하고 통합 로그 출처를 각 행 앞에 간결하게 표시한다.
- 개별 로그에는 반복되는 서비스·컨테이너 열을 숨겨 시간과 본문을 넓게 보여 준다.
- 26px 가상 행 높이와 수집·조회·대상별 탐색 상태는 유지한다. 복사되는 구간과 출처 데이터 형식도 유지한다.
- 프로젝트·Compose 개별 복사를 App의 공통 복사 경로에 연결했다. 성공·실패 강조는 2초 뒤 사라지고 마지막 결과 문구는 남는다. 반복 복사는 강조를 다시 시작하며, 늦은 이전 응답은 새 결과를 덮어쓰지 못한다.
- 확대 로그에도 같은 CopyFeedback 하단바를 배치해 기존 강조 만료 시각을 공유한다.
- 통합 로그에 화면 비우기 기능을 추가하지 않았다. 명령을 입력하는 컨테이너 터미널은 기존 콘솔형 로그 화면 복원과 별개 기능으로 구분한다.

구현 전 Seal Basic Task `docker2u-log-console-feedback-20260912`를 생성하고
프런트엔드 테스트·빌드를 필수 검사로 선택했다. Rust·공개 IPC·저장 형식은
변경하지 않았다.

### 후속 집중 검사와 설치 앱 검증

- 집중 프런트엔드 검사: `observation.test.tsx`와 `App.projectCopyFeedback.test.tsx` **51개 통과**. 공통 복사 경로, 성공·실패, 반복 강조, 늦은 응답, 확대 시 만료 시각 유지, 탐색 및 재연결을 검사했다.
- 새 브라우저 사례: 테마·언어·창 크기 9개 조합 **9개 통과**. 3,000행 이상에서 실제 viewport와 보이는 행의 교차 영역, 고정폭 글꼴·26px 행 높이, 통합/개별 출처 표현, 복사 데이터 및 확대 하단바를 검사했다.
- 전체 브라우저 회귀: `pnpm test:browser` **279개 통과** (4.7분). 결과는 `.cache/log-console-browser-full.log`에 보관했다.
- `tsc --noEmit`과 `pnpm native:build --ci -- --locked` 통과. 프로덕션 번들은 ad-hoc 서명 후 `codesign --verify --deep --strict`로 검증했다.
- 실제 `/Applications/Docker2U.app` 프로세스 PID **87790**을 확인했다. Computer Use로 `desktop-linux`의 프로젝트 통합 **428행**, PostgreSQL **128행**, Redis **300행**을 열어 콘솔 본문이 실제 화면 안에 표시되는 것을 확인했다.
- 개별·통합·확대 화면에서 복사 후 하단바 강조를 확인했다. 강조가 끝난 뒤에도 완료 문구와 로그 본문이 남았고, 확대 닫기와 다른 대상 이동에서도 결과 문구가 유지됐다.
- 출력 없는 memcached는 **0행 / 수집 중 1개**와 새 출력 대기 안내를 표시했다. 컨테이너 제어 명령은 실행하지 않았다. 검증 후 설치 앱은 필터·일시정지 없이 Redis 로그 화면으로 복원했다.

| 설치 확인 | 값 |
| --- | --- |
| 교체 전 바이너리 SHA-256 | `44cd7e57a88fcf23a12790863fe5ca7acc6000e54050712f5325fad8a752abd7` |
| 교체 후 바이너리 SHA-256 | `63a77d3556c302f6fa22896164971372a66e021f0bfeed216223e9368bb90fce` |
| 롤백 백업 | `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-180117-console-feedback/Docker2U.app` |
| 파일·심볼릭 링크 비교 | 기존 설치 ↔ 백업, 빌드 번들 ↔ 설치 준비본 일치 |
| 설치 바이너리·서명 | 새 빌드와 해시 일치, strict 검증 통과 |

검사 로그는 `.cache/log-console-focused-tests.log`,
`.cache/log-console-browser-focused.log`, `.cache/log-console-typecheck.log`,
`.cache/log-console-production-build.log`에 있다. 설치 메타데이터는
`.cache/log-console-installation.json`, 실제 화면은
`.cache/log-console-installed/`의 `individual-copy-glow.png`,
`individual-copy-settled.png`, `project-copy-glow.png`,
`expanded-copy-glow.png`, `expanded-copy-settled.png`, `quiet-stream.png`,
`redis-console-final.png`에 보관했다.

이번 후속 변경에서는 Rust 전체 검사와 합성 Native Smoke를 다시 실행하지
않았다. 앞선 탐색 트리 검증과 이번 실제 설치 앱 검증을 구분하며, notarization
또는 명령 입력용 컨테이너 터미널의 구현·검증을 의미하지 않는다.

## 진단 표시·접속 선택상자·이력 아코디언 — 2026-09-12

실행 중 컨테이너에서도 종료 코드·종료 시각과 OOM false 항목을 항상 표시해,
정상 상태가 문제처럼 보였다. 프로젝트 이력에서는 컨테이너 행을 선택해도
자원 차트가 전체 목록 맨 아래에 나타나 선택 대상과 상세의 관계가 불분명했다.

- 종료 코드·종료 시각과 코드 137 설명은 `exited/dead` 상태에서만 표시한다. 종료 상태의 누락값은 정보 없음으로 구분한다.
- OOM은 Engine이 `true`를 보고한 경우에만 표시한다. false/null은 항목을 추가하지 않으며, 실제 OOM 기록과 상태 검사 실패 기록의 종료 시각·출력은 보존한다.
- 내부 주소 포트 선택은 기존 `setting-select-control`의 배경·10px 모서리·화살표·포커스를 재사용한다. 네이티브 select를 유지하고 높이는 34px로 맞췄다.
- 프로젝트 이력의 자원 차트는 선택한 행 바로 다음에 아코디언으로 열린다. 다른 항목을 열면 이전 차트가 접히며 같은 항목을 다시 누르면 닫힌다.
- 버튼과 상세 region을 고유 ID로 연결한다. 최신 handle 갱신은 펼침 상태를 유지하고 동일 이름의 새 전체 ID에는 이전 차트를 연결하지 않는다. 개별 컨테이너 이력의 직접 차트와 기존 이벤트 범위는 유지한다.

구현 전 Seal Basic Task `docker2u-diagnostics-history-polish-20260912`를
생성했으며 프런트엔드 테스트·빌드를 필수 검사로 선택했다. 공개 IPC·Rust·저장
형식은 변경하지 않았다.

### 검증 결과

- 진단·접속 집중 검사 `ContainerInsights.test.tsx`, `App.insights.test.tsx`: **38개 통과**.
- 이력 및 기존 관찰 집중 검사 `observation.test.tsx`: **46개 통과**. 최초 추가 테스트 2개는 접근성 이름의 공백을 가정해 실패했고, 실제 이름과 상위 이력 region을 구분하도록 테스트를 수정한 후 통과했다. 제품 동작 변경으로 덮지 않았다.
- 새 브라우저 회귀 **27개 통과**: 9개 테마·언어·창 크기에서 실제 차트 SVG 전체가 viewport에 보이고 선택 행과 다음 행 사이에 배치되는지, Enter/Space 접기·펼치기, 개별 차트, 진단 표시, 선택상자의 키보드 접근과 테마·언어 변경 후 값 유지를 검사했다.
- 전체 브라우저 회귀 `pnpm test:browser`: **306개 통과** (5.2분), `.cache/diagnostics-history-browser-full.log`에 보관했다.
- headless Chromium의 팝업 방향키 시도는 선택값이 변하지 않아 검증 근거로 삼지 않았다. 실제 HTML select의 선택값 변경은 브라우저에서, 실제 팝업 방향키 조작은 아래 설치 앱에서 따로 검증했다.
- `pnpm native:build --ci -- --locked` 통과. 기존 설치 앱을 백업한 뒤 새 프로덕션 번들을 ad-hoc 서명·strict 검증하고 교체했다.
- 실제 설치 프로세스 **PID 12366**, `desktop-linux`, 컨테이너 4개를 확인했다. 실행 중 memcached 진단에는 상태·시작 시각·재시작 횟수가 표시되고 종료 시각·코드·OOM false 항목은 없었다.
- Computer Use로 내부 포트 팝업을 열고 **↓ → Enter**로 `11211/TCP`를 선택했다. 별칭 및 IPv4 후보에 `:11211`이 붙었으며, 라이트 테마 전환 후에도 값이 유지됐다. **↑ → Enter**로 주소만 복사로 복원하고 원래 시스템 테마·한국어를 유지했다.
- 실제 프로젝트 이력에서 첫 번째 memcached 행 바로 아래 CPU·메모리 차트가 보였다. 두 번째 행을 열자 첫 차트가 접혔고 두 번째 행 바로 아래로 이동했다. 재선택 시 접힘도 확인했다. 검증 후 앱은 첫 행이 열린 프로젝트 이력 화면에 두었다.

| 설치 확인 | 값 |
| --- | --- |
| 이전 바이너리 SHA-256 | `63a77d3556c302f6fa22896164971372a66e021f0bfeed216223e9368bb90fce` |
| 새 설치 바이너리 SHA-256 | `86c932f247d3750d8c1b12ce225f028b3960494505dc848aaf9ca0a8eadbc534` |
| 백업 | `/Users/jgoneit/project/Docker2U/.local-apps/backups/20260912-181819-diagnostics-history/Docker2U.app` |
| 파일·심볼릭 링크 및 서명 | 기존 설치 ↔ 백업, 새 빌드 ↔ 준비본 일치; 설치 바이너리 해시·strict 서명 검증 통과 |

검사 로그: `.cache/diagnostics-history-focused-history.log`(최초 실패),
`.cache/diagnostics-history-focused-history-final.log`,
`.cache/diagnostics-history-browser-focused.log`,
`.cache/diagnostics-port-keyboard.log`,
`.cache/diagnostics-history-production-build.log`.
설치 기록: `.cache/diagnostics-history-installation.json`.
화면 증거: `.cache/diagnostics-history-installed/`의 `history-before.png`,
`diagnostics-running.png`, `connectivity-select.png`,
`connectivity-keyboard-selected.png`, `connectivity-light.png`,
`history-first-expanded.png`, `history-second-expanded.png`.

실제 컨테이너의 종료·OOM 발생을 유도하지 않았다. 해당 분기는 fixture 검사로
검증했으며 Rust 전체 검사·합성 Native Smoke는 이번 UI 후속 변경에서 재실행하지
않았다. 설치 앱 확인은 notarization 또는 실제 접속 성공의 근거가 아니다.
