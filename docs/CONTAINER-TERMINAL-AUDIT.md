# 컨테이너 터미널 v1 검증

검증일: 2026-09-16. 기준은 PR #13 후속 페이지 이동 수정 위의
`codex/container-terminal-v1` 변경이다. 독립 컨테이너 통합 수집은 다음 변경이다.

## 자동 검사

- 프런트 전체 57개 파일·874개 검사: 통과. 터미널 API·registry·화면 27개 포함.
- Rust 전체 277개 검사: 통과, 선택 실행 9개 제외. 터미널 신규 14개 포함.
- 터미널·사건 브라우저 63개: 통과. 9개 화면 구성에서 명시적 연결, Unicode
  붙여넣기, Ctrl+C, 정상 종료, 셸 부재, 세션 유지와 사건 복귀를 확인했다.
- Python 네이티브 fixture·검증기 69개: 통과. 가짜 exec의 create/upgrade/resize/
  interrupt/exit 기록과 화면 report의 실행·세션·전체 ID를 대조한다.
- 종료된 슬롯 포함 8개 제한, 16 KiB 청크, 256 KiB 출력 한도, 늦은 응답 폐기,
  동일 이름 재생성, 출력 포화 중 입력·닫기, 느린 resize 중 입력은 자동 검사다.
- 필수 전체 검사 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`의
  완료 후보 결과와 Seal Run/Completion은 해당 PR의 검증 결과에 기록한다.

## 실제 네이티브 fixture

테스트 전용 WKWebView 앱에서 실제 Rust IPC와 xterm을 사용했다. Docker 응답과
셸 명령은 Python fixture이며 실제 Engine 명령 실행으로 계산하지 않는다.

- 실행 `d2u-smoke-39e7ce7bab`
- 앱 바이너리 SHA-256:
  `be895729e3d6fa12017f3bd886624228e090746964e4d53a822474cc2fc1aa58`
- `terminal-roundtrip` 통과, 검증기 `terminalCoverageComplete: true`.
- Unicode echo, Ctrl+C, 113×37 resize와 `stty size`, 다른 컨테이너의 로그 탭 이동
  중 출력 수신, 동일 xterm·terminal ID 복원, exit 7과 출력 보관을 확인했다.
- 1024×680 창에서 한국어·영어 × 라이트·다크를 직접 확인했다. 영문 툴바는
  줄바꿈하며 하단 보관 세션은 상세 영역 스크롤로 접근한다. 언어·테마 변경 후
  원래 출력과 선택 터미널이 유지되었다.
- 다크 기본 ANSI 녹색의 낮은 대비를 보고 명시적 팔레트로 수정했다. 기본
  배경 대비 유색 ANSI 12색은 다크 6.85 이상, 라이트 4.98 이상이다. 셸이 직접
  지정한 true-color와 반전·배경색의 모든 조합까지 보장하지 않는다.

최종 팔레트·한국어 종료 문구를 반영한 재빌드에서도 동일 probe와 검증기가
통과했다. 실행은 `d2u-smoke-2ba6f8f599`, 바이너리 SHA-256은
`5e833cac276e291fa8854b5b6cc68b212590ece02579c76fe4868c78bde9190f`이다.
실제 UI 붙여넣기 후 Return으로 `UI_한글_붙여넣기` echo 출력도 확인했다.
Computer Use의 paste 호출은 완료 확인 시간 초과를 반환했지만, 이어서 화면에서
삽입된 문자열과 명령 출력을 각각 확인했다. 도구의 키별 Unicode 입력은 한글을
전달하지 못했다. 물리적 한국어 IME 조합을 검증한 것으로 계산하지 않는다.

## 전체 검사에서 발견한 보정

첫 Seal Run `a6603bd28f044e84bf17aa234d52c445`는 실패 기록으로 보존한다.
필수 프런트·Rust 검사가 실패하여 Completion은 거부되었다.

- Rust 전체 검사에서 기존 IPC 권한 목록 검사가 새 터미널 명령 6개를 누락했다.
  허용된 명령을 정확히 검사하도록 기대 목록을 갱신했다.
- 401/601개 이력 fixture 검사에서 전체 문서의 접근성 이름을 반복 계산하여
  5초 제한에 도달했다. 탭·트리·사건 영역으로 조회를 좁히고 무관한 관찰 응답을
  고정했다. 이력 수·200개 페이지·삭제·복귀·포커스 검증은 유지한다.

## 실제 Engine

사용자의 기존 컨테이너와 분리한 `d2u-terminal-8581ca6e7940` 테스트 자원에서
`real_terminal_owned_container_input_resize_and_normal_exit`를 선택 실행했다.
정확한 전체 ID 및 소유 라벨을 먼저 확인한다.

- 실제 Docker exec 입력·echo 출력, 101열×31행 resize: 통과.
- 소유 테스트 Compose 서비스와 독립 컨테이너에서 각각 같은 실제 exec 검사를
  통과했다. 원래 사용자의 컨테이너는 변경하지 않았다.
- 일반 목록 새로고침 후 동일 terminal ID 입력, exit 0, 명시적 닫기: 통과.
- 컨테이너 기본 사용자·작업 디렉터리를 사용하는 실제 대화형 `/bin/sh`이다.
- 대량 출력·셸 부재·재연결 오류는 별도 자동/fixture 검사 결과이며 이 실제
  Engine 실행에서 재현한 장애로 주장하지 않는다.

## 보관 증거와 한계

로컬 원본은 `.cache/terminal-checks/`, `.cache/native-smoke/runs/`,
`.cache/terminal-live/`에 보관한다. 저장소에는 검증 범위만 남긴다.
Seal Basic Acceptance는 선택된 검사와 소스 변경의 기계적 증거다. 네이티브 UI,
실제 Engine, 배포 서명·공증, 사용자의 물리적 입력 환경을 대신 증명하지 않는다.
