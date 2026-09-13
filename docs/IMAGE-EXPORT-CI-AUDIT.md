# 이미지 내보내기 CI 후속 검증

날짜: 2026-09-13 (KST)

## 최초 게시 후보

PR #12의 최초 소스 HEAD는 `601f9924a12ab87ba2dae60f2fec059cd916052c`다.
[CI Run 34751354352](https://github.com/jgoneit/Docker2U/actions/runs/34751354352)은
이 HEAD를 대상으로 실행했다. 검사 merge commit `47bd7b402eb789200d06a95fa5151de4abefea8a`의
tree `97fcae41e3cf892813d855431757621fa7f2aff0`이 로컬 소스와 같음을 확인했다.

- macOS ARM64 build: 통과. Rust 257 passed / 8 ignored, 새 export pipeline 5개
  통과, unsigned ARM64 bundle 생성 및 아키텍처 확인을 완료했다.
- Frontend checks: React 809개와 native fixture 59개, frontend build는 통과했다.
  브라우저 576개를 2개 worker로 실행하던 중 전체 job의 25분 제한으로 취소됐다.
- 종료 전 로그에는 통과 시도 551개와 실패 시도 39개가 기록됐다. 재시도를 포함한
  시도 수이며, 최종 테스트 통과·실패 집계로 취급하지 않는다.
- 실패 목록은 observation 기반 이미지 내보내기 두 시나리오와 최소 화면의 기존
  도구막대 배치 단정에 집중됐다. job이 취소되어 최종 Playwright 요약과 실패
  아티팩트가 생성되지 않았다. 최초 로그를 보존하고 이 실행을 통과로 표시하지 않는다.

## 확인한 원인과 보완

1. observation fixture의 초기 상태 조회와 로그 초기화가 각각 목록 수집을 시작했다.
   화면이 generation N을 받은 뒤 로그 초기화가 N+1을 만들면, 다음 관측 전까지
   내보내기 준비가 오래된 handle로 거절될 수 있었다. 진행 중인 초기·갱신 조회를
   공유하고 이전 세션의 늦은 응답이 현재 fixture 캐시를 덮어쓰지 않게 했다.
   이미지 내보내기의 generation·handle 검증 조건은 유지했다.
2. 기존 usability 검사는 탭과 작업 버튼이 반드시 같은 행에 있어야 한다고 단정했다.
   승인된 줄바꿈 동작에 맞게 각 버튼의 가시성·화면 안 경계와 그룹 간 비중첩을
   검사하도록 바꿨다. 키보드·검색·일시정지·스크롤·API 호출 보존 검사는 유지했다.
3. 내보내기 브라우저 테스트가 실패하면 상세 오류를 즉시 job 로그에 기록한다.
   전체 suite가 종료되기 전 취소되더라도 이미 발생한 실패 내용을 확인할 수 있다.

공유 조회 회귀는 지연된 초기 응답, 3초 갱신 경계, 진행 중 조회 공유, hold 중 주기
조회 중단과 이전 세션 응답을 다룬다. 정상 화면 generation으로 실제 export fixture의
prepare를 호출해 오래된 handle 거절이 발생하지 않는지도 확인한다.

후속 로컬 검사에서 프런트 52개 파일·812개 테스트와 production build·타입 검사·
fixture 격리 검사가 통과했다. 새 export 브라우저 72개와 usability 162개는 수집을
확인했으며, 실제 화면 결과는 최종 PR CI에서 별도로 확인한다.

## Seal 및 실제 환경의 경계

최초 커밋 후보의 Seal Run `5507a71abf7549f58db50135d0bceef8`은 기록됐으며,
필수 `rust-tests` exit 101로 `complete`가 exit 5를 반환했다. 나머지 필수 검사와
Scope·검사 중 소스 안정성은 통과했다. 이 로컬 실패 기록은 위 CI의 Rust 통과와
구분하고 그대로 보존한다.

후속 수정·문서 커밋에서 같은 Basic Task의 새 `verify` Run을 생성하고 정확한 ID로
`complete`한다. 최종 후보의 Seal 결과와 PR HEAD CI는 PR 본문과 작업 응답에 기록한다.
카탈로그·필수 여부·검사 timeout과 CI timeout을 변경하지 않았다.

실제 Engine export/load와 native 저장 창 직접 조작은 이 세션의 소켓 권한 제한으로
여전히 미검증이다. CI의 fake CLI·Chromium·unsigned 앱 빌드는 이를 대신하지 않는다.
main 병합, Release 게시 및 설치 앱 교체를 수행하지 않는다.
