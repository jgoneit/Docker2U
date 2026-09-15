# Compose 선택 서비스 변경 반영 v1 검증

이 문서는 최초 권한 제한 환경의 결과를 보존한다. 전체 액세스에서 재개한 수정과
최종 검증은 [후속 검증 기록](COMPOSE-APPLY-RESUME-AUDIT.md)을 참고한다.

검증일: 2026-09-13 (KST)\
기준: PR #11이 병합된 원격 `main`, `6f13a3fd4b2a9ba99071c151c7625bd2e9275589`\
브랜치: `codex/compose-apply-v1`\
작업본: `/Users/jgoneit/project/Docker2U/.worktrees/compose-apply-v1`

## 구현과 검토

등록 프로젝트에서 명시적인 서비스별 준비 방법을 고르고, Engine·대상 복제본을
확인한 뒤 pull → build → 선택 서비스 재생성 → 상태 재조회를 진행한다.
고정 argv, 구성·연결 재검증, 단계별 실패·취소 결과와 정확한 requestId 복구를
기존 Compose 예약·출력·관측 체계에 연결했다.

검토에서 보완한 경계는 비활성 profile 표시, `__proto__` 서비스 선택,
준비 생략 서비스의 공유 이미지 안내, 명령 결과와 별도인 상태 재조회 표시,
worker 시작 실패·비정상 종료 시 단계 정리다. 외부 provider 서비스는 로컬 이미지
재생성 계약에 맞지 않아 선택을 차단했다. 같은 digest에서 무시되는 태그를 제거하는
Docker 이름 정규화도 적용했다. 기능 범위는 [기능 문서](COMPOSE-APPLY.md)에 정의한다.

## 최종 후보 검사

| 검사 | 결과 | 입증 범위 |
| --- | --- | --- |
| `pnpm test` | 48개 파일, 784건 통과 | React·hook·IPC 단위 및 통합 검사 |
| `pnpm build` | 통과 | TypeScript, Vite, production fixture 격리 5파일 |
| Apply 계획 순수 Rust 검사 | 16건 통과 | 준비 조합, profile, 의존성, 태그 정규화·충돌, image mount·provider 차단 |
| Apply 실행 순수 Rust 검사 | 7건 통과 | 고정 argv, 실패·취소·deadline, worker 실패와 단계 결과 보존 |
| `pnpm rust:test` | 116건 통과, 121건 실패, 6건 ignored | 실패는 모두 fixture Unix socket 생성 EPERM |
| `cargo fmt --check` | 통과 | Rust 형식 |
| `test_fixture.py` | 39건 통과 | 합성 CLI·선택 재생성·이미지 준비·증거 메타데이터 |
| `pnpm test:native-fixture` | 50건 중 44건 통과, 6건 오류 | HTTP fixture의 Unix socket 생성 EPERM |
| Playwright 수집 | 전체 495건, Compose 90건 등록 확인 | 테스트 정의 로딩만 확인, 화면 실행 아님 |
| Chromium 실행 | 미검증 | Vite `listen EPERM 127.0.0.1:1422`, 화면 검사 진입 전 중단 |
| Native fixture 앱 빌드 | 통과 | Apple Silicon용 서명하지 않은 테스트 앱 컴파일·패키징 |
| Native 화면 직접 조작 | 미검증 | fixture Engine socket을 만들 수 없는 현재 권한 환경 |
| 실제 Docker Engine | 미검증 | 고정 Engine의 Unix socket 접근 거부 |
| `git diff --check` | 통과 | 공백 오류 검사 |

Rust 실패 121건은 기존 fixture 초기화의 `UnixListener::bind`에서 발생했다.
신규 Apply fake CLI 통합 검사 7건도 같은 지점에서 중단되어 프로덕션 실행 흐름의
단정까지 도달하지 못했다. 통과한 순수 검사로 이 통합 검사들을 대신 판정하지 않는다.
기존 테스트·필수 검사 catalog·timeout·권한 정책을 완화하거나 실패 검사를 제외하지 않았다.

개발 장비의 기존 동일 lockfile 의존성과 Rust 도구체인을 격리 작업본의 ignored
캐시에 복사해 사용했다. 패키지·lockfile은 바꾸지 않았다. pnpm은
`pnpm_config_verify_deps_before_run=error`로 의존성 검증 실패 시 설치를 시작하지 않게
실행했다. Rust는 이 작업본의 `.cache/toolchain`을 `CARGO_HOME`, `RUSTUP_HOME`,
`PATH`로 지정했다.

## 화면 및 fixture 회귀 범위

React 검사는 초기 미선택·준비 방식 명시, 지원하지 않는 선택 차단, profile,
Engine·각 복제본 확인, 준비 실패·취소 후 단계 결과, 명령 성공과 unhealthy 동시
표시, 상태 재조회 성공·실패·생략을 포함한다. 시작 응답 유실과 이미 종료된 동일
requestId 복구, 다른 요청의 오인 거부, 재연결·닫기 이후 늦은 응답도 검사한다.

통합 App 검사에서는 변경 반영 창을 닫고도 로그 검색·일시정지·스크롤·구독을 유지하고,
진단으로 이동할 때 해당 탭에 포커스를 전달한다. DOM 테스트는 실제 WKWebView의
레이아웃·대비·native select popup을 입증하지 않는다.

Chromium 회귀 3개를 기존 한국어·영어, 라이트·다크, 최소 1024×680을 포함한
9개 프로젝트에 추가했다. 혼합 준비와 창 닫기·최근 작업, 준비 생략으로 선택
서비스만 새 ID로 재생성, 비선택 db ID 보존, pull 성공·build 실패 후 재생성 미실행을
확인하도록 정의했다. 실제 실행은 서버 시작 단계에서 중단되어 27개 신규 화면
조합이나 기존 브라우저 검사를 통과했다고 표시하지 않는다.

Native CLI fixture는 pull/build에서 컨테이너를 변경하지 않고, Dockerfile digest를
합성 이미지 메타데이터에 남긴다. 재생성은 선택 서비스만 새 ID로 교체하고 로컬
이미지가 없으면 실패한다. profile 직접 선택·공유 준비 정책과 별개로 실제 BuildKit,
이미지 다운로드·Engine의 복제본 동작을 재현한다고 주장하지 않는다.
`apply`·`cancelled` IPC 메타데이터를 보고서에서 허용하되 `composeUiVerified=false`를
유지하며 원시 출력·환경값을 메타데이터에 추가하면 거부한다.

최종 Native fixture bundle ID: `99bf36789f0d47569e911a591226dc56`\
실행 파일 SHA-256: `76de9218bef91833f4935265007863385f4db206f983240c1692577810dfc611`\
경로: `.cache/native-smoke/bundles/99bf36789f0d47569e911a591226dc56/Docker2U Native Smoke.app`

프로덕션 CSP와 같은 Rust IPC 경로를 사용한 별도 테스트 번들이다. 설치된 앱을
교체하거나 이 빌드를 실제 화면·서명·notarization 통과 증거로 사용하지 않았다.

## 실제 Engine과 남은 검증

Docker CLI의 현재 context는 `desktop-linux`, endpoint는
`unix:///Users/jgoneit/.docker/run/docker.sock`이었다. 해당 endpoint를 명시한 읽기
전용 Engine ID 조회가 `permission denied`로 실패했다. 전역 context를 변경하거나
Runtime을 시작하지 않았고 실제 검증용 자원도 만들지 않았다. 기존 프로젝트에는
변경 명령을 실행하지 않았다.

권한이 허용된 동일 작업본에서 남은 검증을 진행해야 한다.

1. 필수 Rust suite와 Native fixture 전체를 실행한다. 소켓 오류가 사라진 뒤에만
   fake CLI 통합·관측 병행·세션 경계의 실행 결과를 판정한다.
2. Chromium 전체와 Native fixture를 한국어·영어, 라이트·다크, 1024×680 이상에서
   직접 조작한다. 긴 경로·Tab 순환·최근 작업·로그 상태·새 ID 이동을 확인한다.
   Native 실패 모드는 `compose-pull-fail`, `compose-build-fail`,
   `compose-recreate-fail`, `compose-quiet`로 지정할 수 있다.
3. 고유 프로젝트 이름과 label을 가진 실제 Compose fixture를 등록한다. pull,
   Dockerfile 변경 후 build, Compose 설정 변경 후 none 재생성, 혼합 준비를 수행한다.
   선택하지 않은 서비스 ID가 그대로인지, 선택 서비스의 새 ID·State·Health와 공유
   bind/volume 연결이 갱신되는지 확인한다. 기존 프로젝트에 변경 명령을 보내지 않는다.
4. 테스트가 만든 정확한 프로젝트·컨테이너·볼륨·이미지만 식별해 정리한다. 앱의
   변경 반영 동작 자체에는 이미지 정리나 rollback이 없다.
5. 허용된 환경에서 새 완료 후보를 검증할 때 이전 실패 Evidence를 보존하고,
   해당 후보에서 반환된 정확한 Run ID로 Seal Completion을 요청한다.

## Seal과 작업본 보존

CLI: `/Users/jgoneit/.local/bin/seal`, `0.3.0-rc.4`\
플러그인: `0.3.0-rc.4+codex.20260826154345`\
Basic Task: `docker2u-compose-apply-v1-workspace-20260913`

기존 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`를 모두 필수로
사용한다. 이 후보의 최종 `verify` Run ID와 `complete` 결과는 작업 최종 응답에
기록한다. 필수 Rust 검사가 실패한 상태를 Accepted Completion으로 표시하지 않는다.
브라우저·Native·실제 Engine은 Seal의 기계적 검사와 별도 증거다.

최초 `/private/tmp/docker2u-compose-apply-v1-20260913` 작업본은 파일 수정 도구의
프로젝트 밖 쓰기 거부 뒤 보존했다. 허용된 프로젝트 하위로 옮긴 작업본에는 이번
기능에 속한 변경만 복사했고 별도 Task ID를 생성했다. 최초 Apply Task와 이전
PR #11 작업의 실패 Evidence를 덮어쓰지 않았다.

원래 `/Users/jgoneit/project/Docker2U`의 추적 파일과 HEAD `d25e86c`는 유지했다.
`.local-apps/`, 이전 PR #11 작업본, 최초 Apply 작업본을 보존했다.
이번 범위에서는 커밋·푸시·PR 생성·병합·설치 앱 교체를 수행하지 않았다.
