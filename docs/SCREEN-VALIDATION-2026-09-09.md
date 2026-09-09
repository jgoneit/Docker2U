# 2026-09-09 화면 테스트 재개 결과

연결된 작업: `Docker CLI 핵심 기능 제안` (`01a08114-1f20-7462-b4a6-1bc4f5ebffc8`).
검증 checkout은 `codex/container-diagnostics`, 구현 기준 HEAD는
`ce6931e09203e8c0e676aa8b2e80edcf9a7c9793`이며 기존 미커밋 구현을 포함한다.

후속 요청으로 native harness의 화면 동기화를 수정했다. 이전에 실패했던
live-display probe는 실제 WKWebView에서 2회 통과했다. 아래 초기 실패 기록은
당시 결과로 보존하며, 후속 검증 결과는 마지막 절에 기록한다.

검증 산출물은 로컬 `.cache/screen-verification-20260909/`에 보관하며 Git에는
포함하지 않는다. 아래 캐시 경로는 이 작업 checkout에서만 열 수 있다.

## Computer Use 접근 진단

- 이 작업에서는 앱 목록, 설치된 `/Applications/Docker2U.app`의 접근성 트리와 스크린샷, 별도 Native Smoke 앱 조작에 성공했다.
- 이전 작업의 `Computer Use was not approved to use ...`는 재현되지 않았다. 이전 거절의 원인은 현재 증거로 확정하지 못했다. 사용자가 권한을 주지 않았거나 설치가 없었다고 결론 내릴 근거는 없다.
- `io.github.jgoneit.docker2u`는 여러 앱 번들에 중복 등록되어 identifier만 쓰면 ambiguous 오류가 발생했다. 설치 경로와 검증 앱의 고유 전체 경로를 지정해 접근했다. 이 모호성은 이전의 not-approved 오류와 별개다.
- 기존 Chromium의 MachPortRendezvousServer permission denied(1100)도 재현되지 않았다.
- 실시간 로그 출력 중 CUA에서 elementHasNoFrame, 상태 변경 경고, 화면 읽기 120초 timeout을 관찰했다. fixture의 live-off 후 화면 읽기가 복구됐다. 처음 실행 불가와 달리 일부 동적 화면 조작의 불안정성은 남아 있다.
- macOS 화면 기록·손쉬운 사용, 앱 접근 승인, 작업 shell 권한은 별도 계층이다. [공식 Computer Use 안내](https://learn.chatgpt.com/docs/computer-use#permissions-and-approvals).

## 브라우저 검사

`pnpm build`와 기존 전체 `pnpm test:browser`를 실행했다.
Chromium **198/198 통과**, 실패·건너뜀·flaky 0, 213.237초.
22개 시나리오를 9개 프로젝트에서 실행했다.

| 크기 | 언어 | 테마 | 결과 |
| --- | --- | --- | --- |
| 1024×680 | ko, en | light, dark | 네 조합 모두 통과 |
| 1280×800 | ko, en | light, dark | 네 조합 모두 통과 |
| 1600×1000 | en | light | 추가 기준 조합 통과 |

진단·접속 manual keyboard tab 이동, 지연 상세 조회, 로그 검색·pause·scroll 보존,
긴 IPv6와 24번째 게시 포트까지 접근 및 복사, 결과 알림과 상세의 독립 닫기,
성공 5초 만료, 후속 복사 피드백, 상태바 배치와 대비 검사를 포함한다.

45개 스크린샷을 보관했다. 필수 8조합의 접속·상태바·탭 왕복 후 로그 화면 24장을
직접 확인했으며, 해당 캡처에서 수정할 시각적 결함은 찾지 못했다. 일부 상세 내용은
본문 스크롤로 접근하도록 되어 있다. 진단 패널 자체는 기존 브라우저 시나리오에
스크린샷 저장이 없어 아래 네이티브 육안 확인으로 별도 보완했다.

- HTML 리포트: `.cache/screen-verification-20260909/browser/html/index.html`
- 결과 JSON: `.cache/screen-verification-20260909/browser/results.json`
- 스크린샷 목록: `.cache/screen-verification-20260909/browser/screenshots/`

브라우저 검사는 합성 Docker API·클립보드를 사용한다. 실제 Engine mutation이나
네이티브 시스템 클립보드에 대한 증거로 해석하지 않는다. 브라우저 검사는 아래
test-only harness 한 줄 수정 전에 실행했으며, 해당 파일은 브라우저 visual fixture와
별도인 native smoke 엔트리다.

## 실제 WKWebView 검사

기존 준비된 별도 앱과 새로 빌드한 별도 앱을 각각 격리 fixture로 실행했다.
실제 Rust IPC, 가짜 Docker CLI·Unix socket을 사용한다. 실제 Docker workload의
시작·중지·재시작·삭제는 수행하지 않았다.

| 항목 | 결과와 한계 |
| --- | --- |
| 진단·접속 탭 | 두 빌드에서 통과. 종료 137/OOM 구분, Health 원문, IPv4·IPv6 후보, 별칭·미게시 UDP 확인 |
| 탭 전환 시 로그 보존 | 같은 DOM·stream, pause·검색·scroll 유지, 공유 상세 조회 1회 확인 |
| 프로젝트·stats | 첫 빌드 probe 통과. Compose 그룹·standalone filter·CPU/메모리 샘플 확인 |
| 2MiB 검색 | 첫 빌드 probe 통과. 실제 Worker count·끝 일치·최신 query 대체 확인 |
| 실제 화면 | ko/light 진단과 원문, ko/dark 원문, en/dark 접속·네트워크 화면 확인. 언어·테마 변경 후 선택 탭과 펼친 원문 유지 |
| 주소 복사 | 실제 네이티브 IPv6 후보 복사 버튼 후 하단 `Connection address copied` 표시 확인. 클립보드 내용의 독립 재읽기는 미수행 |
| 실시간 pause | 수정한 빌드에서 표시 고정 중 stdout/stderr 수신 증가 확인 |
| 재개 후 유실 안내 | 초기 실패 후 테스트 동기화 수정. 후속 live-display 2회 통과. 마지막 절 참조 |
| 전체 native smoke | **완료 아님**. worker fallback, socket·Engine 교체 등 전체 필수 probe를 이번에 모두 실행하지 않았으며 requiredCoverageComplete=false |
| 네이티브 8조합 | 정확한 두 창 크기×한영×밝음/어두움 전체 행렬은 미수행. 위 브라우저 8조합과 구분 |

진단·프로젝트의 실패 이전 passed snapshot은 기존 `validate_ui`로 동일 실행의
binary hash, run ID, timestamp, CLI trace와 대조했고 accepted=true였다.
이 부분 검증은 이후 실패한 native run 전체의 Acceptance가 아니다.

- 진단·프로젝트 trace 대조: `.cache/screen-verification-20260909/native-detail-project-verification.json`
- 네이티브 진단 스크린샷: `.cache/screen-verification-20260909/native-screenshots/ko-light-diagnostics.jpg`
- 어두운 테마 Health 원문: `.cache/screen-verification-20260909/native-screenshots/ko-dark-health-output.jpg`
- 영문 IPv6·네트워크 화면: `.cache/screen-verification-20260909/native-screenshots/en-dark-ipv6-and-network.jpg`

## 초기 검사에서 발견한 테스트 보조 코드 문제와 변경

첫 live-display probe는 `Button missing: 재개`로 즉시 실패했지만 이어진 CUA
화면에는 재개 toggle이 on 상태로 표시됐다.
`src/test/native-smoke/main.tsx`의 pause 대기 조건이 React 반영 전에
assertive button helper를 호출하고, helper의 throw가 기다리기를 즉시 중단했다.

이 작업에서 변경한 제품 동작은 없다. native harness 대기 조건 한 줄을
`panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'true'`
로 바꿨다. 기존 미커밋 변경은 유지했다.

`pnpm typecheck`와 새 native smoke bundle build가 통과했다.
재실행에서 이 대기 조건은 통과했고, pause 상태에서 추가 stdout/stderr를 확인했다.
그 다음 `Resuming after ring eviction did not show the loss notice` assertion은
실패했다. 이를 통과로 간주하거나 실패 기록에서 제거하지 않았다.

코드 검토상 tick 카운터가 React 화면 반영보다 먼저 증가하므로, Resume 전에
pending loss notice를 확인하지 않는 harness의 동기화 문제가 의심된다.
제품 결함 여부는 미확정이다. 후속 검증은 pending loss notice의 실제 화면 반영을
먼저 기다린 뒤 Resume과 유실 안내를 확인해야 한다. 이번에는 제품 로직을 바꾸거나
추가 가설 수정을 하지 않았다.

- 최초 실패 원본: `.cache/screen-verification-20260909/d2u-smoke-9895d29282-failed.json`
- 수정 후 실패 원본: `.cache/screen-verification-20260909/d2u-smoke-7f7f4389b9-failed.json`
- 타입 검사·새 빌드 로그: `.cache/screen-verification-20260909/native-rebuild.log`

## 실행 식별과 정리

첫 run: `d2u-smoke-9895d29282`,
binary SHA-256 `635f4ba656c943d6cf073e3f8ad2dd0e231213448b034ad190d0f2f44a71bc61`.
수정 후 run: `d2u-smoke-7f7f4389b9`,
binary SHA-256 `716c2e35640d1e128b5e398cb397a3615c0a60cddfd0a2e89e9592ab38b2ca84`.

두 run 모두 stopped 및 fixtureRoot 삭제를 확인했다. CLI trace는 각각 1967/1349개,
rejectedCommands는 모두 0이다. 원본 trace와 보고서는
`.cache/native-smoke/runs/<runId>/`에 남겼다.
브라우저 보고서는 임시 경로에서 checkout 보관 경로로 복사한 뒤 93파일의 SHA-256
일치를 확인했다. 네이티브 스크린샷·JSON은 이 작업에서 CUA로 읽은 tool output을
그대로 추출·보관했다.

설치 앱 교체, 기존 Docker workload 변경, 커밋·푸시·배포는 수행하지 않았다.
Rust와 실제 Engine 상세 probe는 이전 작업의 결과이며 이번에 다시 실행하지 않았다.
새 native build는 성공했으나 기존 rust-objcopy의 libLLVM 경고가 남았고,
서명·공증·설치 검증을 의미하지 않는다.

## 후속 검사: 테스트 동기화 수정과 재실행

IPC wrapper의 tick 카운터는 프레임이 LiveLogController와 React 화면에 반영되기
전에 증가한다. tick 증가만 확인하고 Resume을 누르면 버퍼 유실이 아직 화면
상태에 반영되지 않을 수 있었다. `src/test/native-smoke/main.tsx`의
`liveDisplayProbe()`가 실제 화면 상태를 기다리도록 변경했다.

- 시작할 때 검색 닫힘, 수신 재개 상태, stdout/stderr 본문 표시를 확인한다.
- pause와 검색 중에는 추가 IPC 수신과 함께 pending loss 안내의 화면 반영을 기다린다.
- 재개 뒤에는 pause 해제, 본문 갱신, 유실 안내 표시를 함께 기다린다.
- 검색창은 DOM에 남아 숨겨지는 구조이므로 `hidden`과 `aria-expanded`로 열림·닫힘을 확인한다. 검색 결과가 표시된 뒤 고정 상태를 기록한다.
- 일반 잘림 안내와 유실 안내가 공존할 수 있으므로 모든 status 안내 중 목표 문구를 찾는다.

고정 지연 시간을 추가하지 않았다. 화면 고정, stdout/stderr 증가, 유실 안내,
동일 stream 유지, 중복 read IPC 없음에 대한 검증 조건을 유지했다.
이번 후속 수정의 코드 범위는 native 테스트 harness뿐이다.

| 검증 | 결과 |
| --- | --- |
| 관련 회귀 | `pnpm exec vitest run src/LogPanel.test.tsx src/test/native-smoke/readiness.test.ts`: 2파일, 50개 통과 |
| 타입·네이티브 빌드 | `pnpm typecheck`, `pnpm native:smoke build` 통과 |
| 실제 WKWebView 진단·접속 | detail-tabs probe 통과 |
| 실제 WKWebView live-display 1회차 | detail-tabs가 남긴 검색·pause 상태에서 시작. 표시 고정, 재개 후 유실 안내, 검색 고정·해제 통과 |
| 실제 WKWebView live-display 2회차 | 정상 수신 상태에서 재실행해 동일 항목 통과 |
| 실행 증거 대조 | 기존 runner로 run ID, binary hash, 시각, CLI trace 대조: accepted=true, failures=[] |

두 live-display 실행 모두 stream ID가 같고 starts=1, stops=0,
maximumActiveReads=1이었다. pause 중 추가 stdout/stderr tick 3개 이상을 확인했다.
전체 native smoke의 다른 필수 probe는 이번 후속 검사에서 실행하지 않아
requiredCoverageComplete=false다. 동일 앱 실행에서 2회 통과한 결과이며,
새 인스턴스 반복 또는 통계적인 불안정성 해소의 증거로 확대하지 않는다.

- 이번 수정 diff: `.cache/screen-verification-20260909/native-sync-change.patch`
- 관련 회귀 로그: `.cache/screen-verification-20260909/sync-regression.log`
- 타입 검사·빌드 로그: `.cache/screen-verification-20260909/native-sync-build-final.log`
- 1회차 CUA 원본: `.cache/screen-verification-20260909/native-sync-pass-1.json`
- 2회차까지 누적 CUA 원본: `.cache/screen-verification-20260909/native-sync-pass-2.json`
- CLI trace 대조 및 종료 보고서: `.cache/screen-verification-20260909/native-sync-verified-report.json`

run ID는 `d2u-smoke-9789c7e82c`, binary SHA-256은
`f2358ac55f052145e300f275561a9bf699a3cd835f342d89610f982d7a670d75`다.
고유 경로의 새 검증 번들을 사용했으며, 종료 후 status=stopped와 fixtureRoot
삭제를 확인했다. CLI trace 1102개, rejectedCommands 0이다.

## 후속 UI 수정: 컨테이너 행 전체 선택

이름 버튼에만 연결되어 있던 상세 선택을 행의 일반 셀과 여백에도 연결했다.
`ContainerTable.tsx`에서 내부 button/input 클릭은 행 처리에서 제외하며, 일반
영역 클릭은 이름 버튼에 포커스를 주고 해당 컨테이너를 선택한다.
`containerTable.css`에는 행 전체의 pointer cursor를 적용했다.

Computer Use의 in-app browser에서 합성 fixture로 직접 확인했다.
상태·CPU·메모리·빈 포트 셀 클릭 후 선택 표시와 이름 버튼의 포커스가 이동했고,
선택한 worker의 상세 제목도 확인했다. 다른 행의 체크박스는 상세 선택을 바꾸지
않았고, 포트 버튼은 해당 컨테이너의 접속 탭을 열었다. 일반 셀 선택 후 방향키로
다음 행을 선택할 수 있었다.

기존 `ContainerTable`, `App.containerDetails`, `App`, `App.preferences` 테스트
4파일 140개와 `pnpm build`의 타입 검사·Vite·production fixture isolation이
통과했다. 회귀 로그: `.cache/screen-verification-20260909/row-selection-regression.log`.
이번 행 선택 변경은 브라우저에서 검증했으며, 설치된 네이티브 앱은 교체하지 않았다.

## 설치 앱 교체와 실제 행 선택 확인

사용자의 설치 앱 교체 요청에 따라 `pnpm native:build`로 production 앱을 새로
빌드하고 `/Applications/Docker2U.app`을 교체했다. 이전 앱은 정상 종료 후
`/Users/jgoneit/project/Docker2U/.local-apps/backups/20260909-195117-0af82658/Docker2U.app`
에 보관했다. 새 번들 전체 파일과 설치본의 해시 일치를 확인하고, ad-hoc 서명 후
`codesign --verify --deep --strict`가 통과했다. 배포용 공증 검증은 아니다.

새 설치본을 정확한 경로로 실행해 기존 `desktop-linux` 연결과 4개 컨테이너를
확인했다. Computer Use로 CPU 셀은 memcached-2, 메모리 셀은 postgresql-db,
상태 셀은 redis 행을 각각 클릭했다. 세 경우 모두 해당 컨테이너의 상세 제목으로
바뀌고 이름 버튼으로 포커스가 이동했다. 새 진단·접속 탭도 설치 화면에 표시됐다.
앱을 실행한 상태로 두었으며 컨테이너 mutation은 수행하지 않았다.

설치 binary SHA-256:
`e69b41d08b265481b71571e6f3d2ebe35fbca1607bd73e30f8acc1a2e23f178d`.
버전은 기존과 같은 `0.1.0-alpha.1`이며 위 해시로 빌드를 구분한다.

- production 빌드 로그: `.cache/screen-verification-20260909/installed-app-build.log`
- 설치·백업·행 선택 검증 기록: `.cache/screen-verification-20260909/installed-app-update.json`

복구가 필요하면 앱을 종료하고 위 백업을 `/Applications/Docker2U.app`으로
되돌릴 수 있다. 빌드에는 기존 rust-objcopy의 libLLVM 경고가 남았지만 타입 검사,
production fixture isolation, release build와 bundle 생성은 통과했다.

## PR 게시 전 회귀 검사

최종 코드에서 `pnpm test`는 32파일 532개, `pnpm test:native-fixture`는 25개가
통과했고 `pnpm rust:fmt`도 통과했다. `pnpm rust:test`의 기본 병렬 실행에서는
수정하지 않은 `parent_exit_does_not_leave_descendant_holding_pipes_open`이
3초 경과 조건을 넘겨 86개 통과·1개 실패·5개 opt-in 제외였다.

실패한 테스트를 단독으로 실행하자 통과했고, 이어 `cargo test --manifest-path
src-tauri/Cargo.toml --locked --offline -- --test-threads=4` 전체 실행도
87개 통과·5개 제외였다. 이 재실행만으로 최초 시간 제한 실패의 원인을 확정하지
않으며, 실패한 최초 로그도 보관한다. 테스트 시간 제한이나 제품 코드는 바꾸지 않았다.

로컬 로그: `.cache/screen-verification-20260909/pr-preflight.log`,
`.cache/screen-verification-20260909/pr-rust-recheck.log`.
이전 브라우저 198개 결과와 설치 후 네이티브 행 선택 결과는 위 절의 검증 범위다.
