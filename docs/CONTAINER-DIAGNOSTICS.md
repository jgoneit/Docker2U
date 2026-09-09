# 컨테이너 진단·접속 정보와 작업 결과

> 2026-09-09 재개: Computer Use와 Chromium 접근에 성공했다. 브라우저 198개는
> 통과했고, 네이티브 진단·접속 화면을 확인했다. 후속 테스트 동기화 수정으로
> 실시간 pause·재개·유실 안내·검색 검사가 2회 통과했다. 전체 native smoke의
> 나머지 필수 probe는 미완료다. 아래 이전 기록은 당시 결과로 유지한다.
> 이후 설치 앱도 새 production 빌드로 교체했고, 실제 앱에서 상태·CPU·메모리
> 셀 클릭에 따른 행 선택과 상세 전환을 확인했다. 기존 앱은 백업했다.
> [새 화면 검증 결과](SCREEN-VALIDATION-2026-09-09.md)

2026-09-08 구현. 기준은 `ce6931e09203e8c0e676aa8b2e80edcf9a7c9793`,
작업 브랜치는 `codex/container-diagnostics`다.

## 화면과 동작

- 컨테이너 이름뿐 아니라 상태·CPU·메모리·행 여백을 클릭해도 상세 대상을 선택한다.
  이름 버튼으로 포커스를 연결해 방향키 탐색을 이어가며, 체크박스의 작업 대상
  선택과 포트 버튼의 접속 정보 열기는 각각 독립적으로 처리한다.
- 기존 복구 도구막대 왼쪽에 **로그 / 상태 진단 / 접속 정보** 탭을 두고,
  시작·중지·재시작 버튼은 오른쪽에 유지한다. 목록의 포트 버튼은 해당 컨테이너의
  접속 정보로 이동하며 작업 대상 체크 선택을 바꾸지 않는다.
- 최초 탭은 로그다. 다른 컨테이너를 선택해도 탭은 유지하지만 이전 상세 응답은
  즉시 숨긴다. 로그 컴포넌트는 탭 전환 중에도 유지되어 수신·검색·일시정지·스크롤을
  보존하고, 숨겨진 로그는 검색 단축키를 가로채지 않는다.
- 진행과 결과 요약은 기존 44px 하단 상태바에 표시한다. 확정 성공이고 후속 목록
  확인까지 성공한 결과만 그 시점부터 5초 뒤 숨긴다. 실패·결과 불명·제외·미실행·
  후속 확인 실패가 있으면 X로 닫을 때까지 유지한다.
- **최근 작업**은 마지막 결과를 앱 세션 동안 보관한다. 상세는 요청했을 때만 열고,
  이름·전체 ID·Engine/context/endpoint·결과 확인 시각을 유지한다. 상세 X 또는 Escape로
  닫으면 최근 작업 버튼으로 초점을 돌린다. 확대 로그에서도 같은 요약을 공유하며,
  상세를 요청할 때만 확대 화면을 닫는다.
- 복사·비우기 피드백은 별도 영역을 쓴다. 결과별 식별자와 절대 만료 시각으로 이전
  타이머, 언어·테마 변경, 후속 복사가 작업 결과와 차단 상태를 변경하지 않게 한다.

## 조회 계약

`getContainerDetails(sessionId, generation, handle)`은 Rust Core의
`get_container_details` typed IPC에 대응한다. 선택한 opaque handle을 현재 목록의
정확한 full ID로 해석하고, 고정된 Engine을 검증한 뒤 제한된 inspect format으로
하나만 조회한다. 전체 inspect, 환경변수, 전체 라벨, Health 명령은 반환하지 않는다.

두 상세 탭은 하나의 지연 조회 결과를 공유한다. 목록 전체 상세 조회나 주기적 폴링은
없다. Refresh·복구 작업 경계에서 무효화하며 열린 상세 탭만 다시 조회한다. 세션,
목록 generation, handle, full ID, 조회 시각을 검사해 늦은 응답을 버린다.
상세 조회는 mutation 허용 권한과 별개이며 현재 연결의 무효화 오류는 기존 차단
상태에 전달한다. 알림 닫기는 이 차단을 해제하지 않는다.

진단은 관측 상태·종료 코드·시각·OOM 보고·재시작 횟수와 Health를 표시한다.
`healthConfigured`는 설정의 검사 종류만 판별한 boolean/null이고,
`healthAvailable` 및 실제 Health 기록과 독립이다. 미설정, 설정했지만 결과 없음,
조회 불가를 구분한다. 종료 코드 137만으로 OOM을 단정하지 않는다.
최근 보관된 Health 실패는 최대 3건, IPC 출력은 건당 4 KiB이며 UTF-8과
제어 문자를 처리한다. 잘린 출력은 표시하고 기본적으로 접는다. CLI 원시 수신에는
기존 8 MiB 제한이 적용되며 전체 검사 이력을 수집하지 않는다.

접속 정보는 호스트에서의 후보와 같은 Docker 네트워크 안의 별칭·내부 주소를
분리한다. IPv6 괄호, 다중 바인딩, TCP/UDP/SCTP, 미게시 포트, 여러 네트워크와
host/none/container 네트워크 모드를 처리한다. Engine/VM 바인딩은 실제 Mac
도달 여부를 보장하지 않는다. wildcard는 복사하지 않고 일반 포트 매핑의 loopback
후보만 미검증으로 표시한다. HTTP URL·DB 문자열 추정이나 실제 접속 검사는 없다.

## 검증 기록

| 구분 | 결과 |
| --- | --- |
| 프런트엔드 전체 회귀 | Vitest 32개 파일, 532개 테스트 통과 |
| 타입·프로덕션 빌드 | TypeScript, Vite, production fixture isolation 통과 |
| Rust | 전체 offline suite 87개 통과, 실패 0; 기존 live opt-in 4개 제외. 새 read-only opt-in 1개 별도 통과; format 통과 |
| inspect 템플릿 | 실제 Go text/template 합성 20건 통과 |
| 네이티브 빌드 | production `Docker2U.app`와 별도 Native Smoke 검증 번들 빌드 성공; 검증 번들은 실행하지 않음 |
| Python native fixture | 새 상세 fixture/probe 검증을 포함해 부모 실행 환경에서 25개 모두 통과 |
| Rust socket integration | 권한 변경 후 상세 integration 7개를 포함한 전체 suite 통과 |
| 실제 Engine | 현재 context를 고정한 production Core로 기존 컨테이너 한 건의 상세 조회 통과: session/generation/full ID, 시각, Health, 포트·네트워크 구조 확인 |
| 브라우저 합성 화면 | 권한 변경 후 Vite 서버 시작 성공. Chromium은 macOS MachPortRendezvousServer permission denied(1100)로 실행 준비 실패; 앱 검사·스크린샷 미실행 |
| 실제 WKWebView 화면 | 권한 변경 후에도 Computer Use가 Docker2U 접근 미승인을 반환해 미수행 |

네이티브 빌드에는 준비된 Rust 도구의 `rust-objcopy`가 `libLLVM.dylib`를 찾지 못하는
debug-info stripping 경고가 있었다. 빌드와 번들은 성공했지만 서명·설치·실행·배포
검증을 의미하지 않는다. 생성 파일은 checkout의 `src-tauri/target/release/bundle/macos/`
아래에만 있다. 설치된 앱 교체나 실제 컨테이너 변경은 수행하지 않았다.

브라우저 크기·언어·테마 매트릭스와 실제 WKWebView 시각 검증은 별도 게이트다.
1024×680 / 1280×800, 한국어 / 영어, 밝은 / 어두운 테마의 긴 주소·오류 출력·
키보드 접근·하단 바는 현재 테스트 시나리오에 포함되지만 실행 환경 제한으로 확인하지 못했다.
새 브라우저 시나리오 3개는 기존 9개 조합에서 27개 사례가 된다. 화면 검증 완료로
간주하지 않는다.

## 재현

프런트엔드: `pnpm test`, `pnpm build`.
브라우저 합성 화면: `pnpm test:browser`.
현재 nested checkout에서는 준비된 toolchain을 명시할 수 있다:

```sh
env CARGO_HOME=/Users/jgoneit/project/.docker2u-tools/cargo \
  RUSTUP_HOME=/Users/jgoneit/project/.docker2u-tools/rustup \
  PATH="/Users/jgoneit/project/.docker2u-tools/rustup/toolchains/1.98.1-aarch64-apple-darwin/bin:$PATH" \
  cargo test --manifest-path src-tauri/Cargo.toml --locked --offline docker::details::parser_tests
```

Rust integration과 실제 Engine 읽기 전용 조회는 권한 변경 후 통과했다. 새 opt-in
`real_container_details_probe`는 `DOCKER2U_REAL_DETAILS_PROBE=1`일 때 한 기존
컨테이너만 읽으며 기본 suite에서는 제외된다. 현재 제외 대상은 이 테스트를 포함해
5개다. Chromium 실행과 Computer Use의 Docker2U 접근이 허용되는 환경에서
화면 검증을 이어갈 수 있다. 기존 컨테이너 변경·
설치된 앱 교체·배포는 별도 범위다.

## 권한 변경 후 재개

같은 작업 소스와 브랜치를 유지했다. 부모 실행 환경에서 임시 파일 생성·삭제,
localhost bind, Unix socket bind를 확인한 후 막혔던 검사를 다시 실행했다.
실제 상세 조회 시각은 `2026-09-08T13:41:51.265209+00:00`이며 production Core의
연결 → 목록 → 상세 경로를 사용했다. 기존 목록 4개 중 한 컨테이너에서 running,
Health 설정됨, 포트 1개, 네트워크 1개를 관찰했다. Health 출력 제한 검사는
반환된 기록에 대한 조건 검사이며, 실제 OOM·Health 실패를 발생시킨 실험은 아니다.
컨테이너 시작·중지·삭제·exec 등 실제 workload 변경은 하지 않았다.

Chromium은 첫 실행 단계의 동일한 권한 오류가 반복되어 중단했다. 예정 198개 중
39개 준비 실패, 1개 중단, 158개 미실행이며 화면 assertion은 실행되지 않았다.
파일·소켓 권한 회복과 GUI 도구·macOS 브라우저 프로세스 접근 권한은 별개로 기록한다.

네이티브 fixture에는 새 상세 inspect의 정확한 허용 목록과 합성 응답, 세 탭 전환
후 로그 보존 probe를 추가했다. inspect 실행 PID·full ID·종료 결과와 기존 로그
스트림을 대조하며, mutation 명령 차단은 유지한다. 해당 probe는 실제 WKWebView에서
아직 실행하지 않았다. 부모 실행 환경의 Python fixture 25개와 프런트엔드 532개는
모두 통과했고, 별도 식별자·경로의 incognito 검증 앱 빌드도 성공했다.

이번 재개 로그는 checkout의 `.cache/diagnostics-full-access-*.log`에 보관했다.
`native-fixture-parent.log`가 최종 Python 실행 결과이며 자식 세션의 이전 권한
실패와 구분한다. 설치된 앱이나 실제 컨테이너는 변경하지 않았다.

화면 접근을 허용한다는 후속 지시 후 Computer Use를 다시 호출했으나,
별도 `Docker2U Native Smoke`와 설치된 `Docker2U` 모두
`Computer Use was not approved to use ...` 응답으로 접근이 거절됐다.
검증 fixture run `d2u-smoke-0be3d6330f`는 stopped 상태이며 임시 fixture 경로의
삭제를 확인했다. 이 시도에서 화면을 읽거나 시각 검증을 수행하지 못했다.
