# 독립 컨테이너 사건 확인 검증 기록

작성일: 2026-09-16 (Asia/Seoul)

- 최초 구현 기준: `a832e9df96e1b2a95583c08acca47c09e1f3dece`; 최종 선행 PR 기준: `7dc75ea0a800eebc7e24df6d2b8ba5e7c6328cac`
- 작업 브랜치: `codex/standalone-incident-v1`
- 상태: 자동 검사, 최종 네이티브 후보, 실제 Engine 검사를 통과했다. Seal Acceptance와 최종 커밋의 CI·설치 기록은 PR과 로컬 build record에 별도로 결합한다.
- 이 문서의 `.cache/` 경로는 작업 디렉터리에 보존한 로컬 실행 증거다. 저장소에 해당 원본 로그가 포함된다는 뜻은 아니다.

## 변경 범위와 계약

독립 컨테이너 그룹과 소속 컨테이너에서 통합 로그·이력을 열고, 사건 당시 기록에서 현재 상세로 이동한 뒤 같은 사건으로 돌아오는 흐름을 확장했다. 사용 흐름은 [독립 컨테이너 안내](../STANDALONE-INCIDENTS.md)에 정리했다.

| 영역 | 확인 대상 계약 |
| --- | --- |
| 탐색 | 그룹 행은 통합 로그·이력을 선택하고, 화살표는 자식 목록만 접거나 펼친다. 그룹과 각 자식의 검색·일시정지·비운 로그 경계·읽던 위치를 각각 보존한다. |
| 수집 | 그룹 또는 독립 컨테이너를 처음 방문하면 독립 범위 전체를 수집한다. 그룹·자식·상세 탭 사이에서는 수집을 다시 시작하지 않는다. Compose 이동은 활성 수집 범위를 바꾸며 보관 자료는 한도 안에서 남긴다. |
| 상한 | 활성 수집 관리자는 하나이며 동시에 최대 64개 소스를 수집한다. 초과 시 명시 선택이 필요하다. 자동 선택에는 새 ID가 합류하지만 명시 선택은 원래 전체 ID에 고정된다. |
| API | 내부 범위는 `Project { name } \| Standalone`이다. 새 `configure_standalone_logs`, `query_standalone_logs`, `retry_standalone_logs` 응답은 `project: null`을 사용한다. 기존 프로젝트 API는 프로젝트 문자열 계약을 유지한다. `stop_project_logs`는 어느 범위든 현재 활성 수집을 중단한다. |
| 사건 조회 | 세션·범위·전체 ID·발생 시각으로 대상을 고정한다. 기본 전후 2분, 선택 구간 1분·5분, 같은 ID의 로그·자원을 조회한다. 조회 자체는 수집 설정을 변경하지 않는다. |
| 화면 보존 | 최초 조회 결과를 유지하고 명시적 새로고침으로 갱신한다. 현재 상세에서 돌아오면 사건·시간 구간·이력 위치·포커스를 복원한다. 터미널 탭 방문만으로 셸을 실행하지 않는다. |
| 삭제·재생성 | 삭제된 ID의 자료를 계속 조회하고 같은 이름의 새 ID와 섞지 않는다. 원래 ID가 현재 목록에 없으면 현재 정보 버튼을 비활성화한다. 독립 컨테이너가 0개가 되어도 보관 이력에 접근할 수 있다. |
| 재연결 | 사건 상세·복귀·화면 캐시를 초기화하고 이전 세션의 늦은 응답을 폐기한다. |

보관 상한은 Compose와 공유한다. 로그는 전체 32 MiB/100,000행, 소스별 1 MiB, 단일 행 64 KiB이며 조회 응답은 최대 500행/2 MiB다. 자원·이벤트 및 추가 로그의 시간 상한은 30분이다. 소스별 최신 수신 300행은 시간 상한과 별도로 유지하되 byte·행 수 상한을 우선 적용한다. 따라서 30분 전체 기록을 보장하지 않는다. 자세한 제한은 [수집·보관 계약](../PROJECT-OBSERVATION.md)을 따른다.

시간 없는 로그는 수신 시각을 사용하고 이를 표시한다. 빈 결과·만료·잘림·수집 공백을 구분해 안내하며, 관찰 표본이 없는 자원 구간을 0으로 채우지 않는다. 기존 [사건 조회 계약](../INCIDENT-REVIEW.md)을 독립 범위에도 적용한다.

## 자동 검사 결과

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| 프런트 전체 | 선행 PR 검사 보강 반영 후 58개 파일, 887개 테스트 통과 | `.cache/standalone-checks/frontend-full-after-rebase.log` |
| Python native fixture | 79개 테스트 통과, 16.017초 | `python3 -B -m unittest discover -s tests/native-smoke -p 'test_*.py'` 실행 출력 |
| Rust 전체 최종 실행 | 287개 통과, 실패 0개, 무시 10개; main/doc tests 통과 | `.cache/standalone-rust-tests-final.log` |
| 신규 브라우저 초기 집중 검사 | 최소 창 한국어·라이트에서 7개 통과 | `.cache/standalone-checks/browser-seven-initial.log` |
| 브라우저 최종 회귀 | 234개 통과, 4.7분 | `.cache/standalone-checks/browser-regression-final.log` |
| 실제 Engine 전용 검사 | 1개 통과, 15.09초 | `.cache/standalone-checks/real-engine.log` |

위 234개 브라우저 회귀 실행은 기존 observation·incident·terminal 검사와 독립 컨테이너 검사 7개를 포함한다. 한국어/영어 × 라이트/다크 × 1024×680/1280×800의 8개 조합과 영어·라이트 1600×1000의 1개 조합을 실행했다. 신규 검사는 그룹 선택과 펼침 분리, 그룹·자식 수집 유지, 독립 화면 상태, 사건 기록 고정과 상세 복귀, 삭제·동명 재생성·빈 목록, 재연결, 전체 ID 필터, 로그 비우기·복사 피드백을 확인한다.

프런트 단위 검사에는 jsdom의 canvas 미구현 안내가 출력됐다. 해당 통과 결과는 실제 xterm 또는 WKWebView 렌더링 증거로 사용하지 않는다. Rust의 무시된 10개 검사가 모두 실행됐다는 주장도 하지 않는다. 별도로 실행한 실제 Engine 검사는 아래에 구분한다.

## 첫 실행 실패와 재검증

### 브라우저

첫 전체 실행은 228개 통과, 6개 실패였다 (`.cache/standalone-checks/browser-regression.log`).

- 4개는 영어 삭제 표시에 대한 검사 문구의 대소문자 문제였다. 검사는 `/Removed/`를 기대했지만 실제 레이블은 `Container removed`였다.
- 2개는 light-en-1280x800에서 사건 상세 또는 재생성 ID 필터가 사라진 검사였다. 프런트 담당자가 두 trace에서 검사 중 `App` HMR 업데이트와 `IncidentDetail` Fast Refresh 무효화·재마운트를 확인했다. 이 개발 서버 실행은 안정된 후보의 생명주기 검증으로 채택하지 않았다.
- 문구 검사를 정정하고 코드 변경을 멈춘 뒤 수행한 최종 실행은 동일한 전체 234개가 통과했다. 초기 실패 기록은 최종 통과 기록과 별도로 보존했다.

### Rust

첫 실행은 285개 통과, 1개 실패, 10개 무시였다 (`.cache/standalone-rust-tests.log`). 실패는 `process_tests::parent_exit_does_not_leave_descendant_holding_pipes_open`의 `started.elapsed() < Duration::from_secs(3)` 조건이었다. 동시 검사 자원 경합 중 발생한 시간 조건 실패로 분류했으며, 로그가 직접 입증하는 범위는 3초 조건 위반이다. 이를 독립 컨테이너 조회 결함을 수정한 근거로 사용하지 않는다. 최종 재실행은 287개 통과, 실패 0개, 10개 무시였다.

## 초기 네이티브 후보 검증

이 절은 합성 Unix socket Engine과 실제 네이티브 Rust IPC·화면을 연결한 fixture 실행이다. 실제 Docker Engine 장애 재현 결과는 다음 절과 구분한다.

- 실행 ID: `d2u-smoke-f78c996b6f`
- 바이너리 SHA-256: `c2ffd7f5bf2b2002ed9b5501053d6a3b9a873dc563b572242e6a9dd46ae30bfe`
- fixture 모드: `standalone`; coverage profile: `group-observation-v2`
- 원본 UI 결과: `.cache/standalone-checks/native-ui-initial.json`
- 검증 보고서: `.cache/standalone-checks/native-report-initial.json`
- 보고서 결과: `accepted: true`, `requiredCoverageComplete: true`, `standaloneCoverageComplete: true`
- 완료 probe: `standalone-incident`, `standalone-archive`, `standalone-empty`

| 단계 | 기록한 결과 |
| --- | --- |
| 그룹 수집 | 전체 ID가 64자리로 0 패딩된 3·4를 수집했다. 초기 그룹 로그 4행과 자원 표본 12개를 확인했다. |
| 사건 선택 | ID 3의 사건 sequence 191, `2026-09-15T16:24:39.846344+00:00`을 선택했다. 최초 사건 응답 5행 모두 같은 ID·시간 구간에 속했고, 화면 로그와 그래프 사건 표시 2개를 확인했다. |
| 구간·새로고침 | 전후 1분·5분·2분 변경과 명시적 새로고침을 수행했다. 최종 구간은 `2026-09-15T16:22:39.846Z`–`2026-09-15T16:26:39.846Z`였다. |
| 현재 상세·복귀 | 현재 진단·터미널을 방문하고 같은 사건·2분 구간으로 복귀했다. 포커스 복원이 확인됐으며 터미널 시작 횟수는 0이었다. |
| 동명 재생성 | 현재 ID가 4·5로 바뀐 뒤에도 삭제된 ID 3의 사건 로그 77행을 조회했다. 응답 전체의 ID·시간 구간을 검사했고 현재 정보 버튼 비활성화를 확인했다. |
| 전체 삭제 | 현재 독립 ID가 빈 목록이 된 뒤에도 그룹을 유지하고 ID 3의 같은 사건 로그 77행을 조회했다. |

사건 선택부터 복귀·삭제 자료 조회까지 API 계수는 configure 2, stop 3, retry 0, terminal start 0으로 유지됐다. 이 값은 최초 연결 준비를 포함한 누적 계수이며, 사건 조회 과정에서 계수가 증가하지 않았음을 확인한 것이다. probe 결과는 실행 ID·바이너리 hash·시작 시각·세션·전체 ID에 결합하고 validator가 확인했다. 자동 probe 동작은 합성 fixture에 한정한다.

초기 보고서는 실행 중 채취한 스냅샷으로 `status: running`이다. 이 파일만으로 프로세스 종료·회수까지 완료했다고 주장하지 않는다. 또한 초기 후보 hash의 통과를 최종 후보 hash의 검증으로 대신하지 않는다. 최종 후보 결과는 아래 절에 별도로 기록한다.

## 실제 Docker Engine 검증

실행한 테스트는 `docker::project_logs::standalone_live_tests::real_standalone_and_compose_incidents_keep_retained_ids_across_recreation`이다. 명시적으로 지정한 실행 소유자·manifest·Engine endpoint를 확인한 후 소유한 검사 컨테이너에서 실제 health 전환, 독립 컨테이너 삭제·동명 재생성, 보관 조회를 실행했다. 이 검사는 실제 Engine 변경을 포함한다.

| 항목 | 실행 기록 |
| --- | --- |
| 검사 실행 소유자 | `d2u-terminal-8581ca6e7940` |
| 이전 독립 전체 ID | `e4e6134dcb8174fddee4aa517f2ffe651569a3468bd98bea1b3d6395d923da5b` |
| 동명 재생성 전체 ID | `de0cd7fb74e7f7131a318886d082228371db2cca7e1cefa2aad4493e5816b802` |
| Compose 전체 ID | `8ad3b3f4f3011842766bafcd3f551e08d936a9fec6c301fe6ce226dcd19aaa8a` |
| 독립 health 사건 시각 (UTC) | `2026-09-15T16:27:04.519751700+00:00` |
| Compose health 사건 시각 (UTC) | `2026-09-15T16:27:13.834914800+00:00` |
| 이전 독립 ID 보관 조회 | 재생성 후에도 원래 ID의 로그 3행 유지 |
| 자원 | 독립·Compose 양쪽 사건 구간의 같은 ID 관찰 표본 확인 |
| 정리 | 검사에서 추가한 라벨 컨테이너가 모두 제거됐고 Compose health가 healthy로 복원됐음을 검사 |

검사는 사건 전후 2분·사건 anchor 조회가 기존 수집 설정을 유지하는지, 새 ID의 로그가 원래 ID 응답에 섞이지 않는지, Compose를 수집 중에도 독립 보관 자료를 읽을 수 있는지 확인했다. 반대 범위의 ID를 요청했을 때 빈 결과를 반환하는 것도 확인했다. 테스트의 정리 결과는 이번 검사에서 추가한 컨테이너와 변경한 health 상태에 해당하며, 별도 상위 fixture의 최종 정리까지 포함하는 주장은 아니다.

이 결과는 통제된 검사 컨테이너의 실제 health 사건과 보관 조회 증거다. 자연 발생 운영 장애나 모든 장애 유형의 원인 분석을 검증한 것은 아니다. 물리 키보드·IME 입력, 최종 설치 앱 화면, 전체 서비스 장시간 부하 검증으로 확대 해석하지 않는다.

선행 PR의 키보드·측정 검사 보강을 반영한 뒤 기존 browser fixture의 독립 그룹 레이블도 새 이름으로 갱신했다. 제품 소스는 바뀌지 않았다. 전체 브라우저 CI 결과는 최종 커밋의 PR 실행에 결합한다.

## 최종 네이티브 후보

- 실행 ID: `d2u-smoke-e6292b332a`
- 바이너리 SHA-256: `076f4f8ca51fafb161e1134ddbeb9b02cb3130ab4fdf7d15fdc00e731876f60c`
- UI 결과: `.cache/standalone-checks/native-ui-final.json`
- validator 결과: `.cache/standalone-checks/native-report-final.json`; `requiredCoverageComplete`, `standaloneCoverageComplete`, `terminalCoverageComplete` 모두 true.
- 독립 사건 sequence 156, ID 3, `2026-09-15T16:28:22.800178+00:00`을 조회했다. 재생성·전체 삭제 후에도 같은 ID의 로그 87행을 조회했고 현재 정보 버튼은 비활성화됐다. 수집 configure/stop/retry 계수는 사건·현재 상세·복귀 동안 그대로였다.
- 최종 후보에서 터미널 연결, 한글·ANSI 출력, Ctrl+C, 113×37 resize, 컨테이너·탭 이동 중 같은 emulator와 출력 유지, exit code 7을 추가 확인했다.
- Computer Use로 실제 WKWebView를 1024×680으로 줄여 한국어/영어 × 라이트/다크 터미널과 독립 사건 화면을 확인했다. 터미널 버튼은 줄바꿈되며, 사건 그래프·로그·현재 정보 버튼은 세로 스크롤로 접근했다. 닫기 버튼의 Tab 포커스와 사건 복귀 포커스를 확인했다. 화면 관찰은 Codex 작업의 이미지 출력에 남아 있으며 이 문서에 이미지 파일을 첨부한 것은 아니다.
- 언어·테마 전환 뒤 사건 sequence·선택 구간과 터미널 출력이 유지됐다. 한글 바이트/붙여넣기 검증과 물리 OS IME 조합은 구분한다. 물리 IME 조합은 직접 검증하지 못했다.
- 실행 종료는 `pnpm native:smoke stop`으로 해당 소유 프로세스에 요청했고, 종료 상태는 `.cache/standalone-checks/native-status-final.json`에 기록했다. 이 합성 fixture 실행은 실제 Docker 컨테이너를 만들거나 지우지 않는다.

Seal Task는 구현 전 생성한 `docker2u-standalone-b2d2f010ad504cc59975f68cea089ecf`이며 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`를 선택했다. 완료 후보에서 `verify → complete --run-id`로 얻은 공개 결과는 PR에 기록한다. 이 소스 문서에 아직 수행하지 않은 Acceptance·CI·설치 결과를 미리 확정하지 않는다.

## 한계와 되돌리기

- 로그·관찰 이력은 앱 세션 안의 제한된 메모리 보관이다. 첫 방문 이전 로그, 용량으로 잘린 행, 수집 중단 구간은 다시 만들어낼 수 없다. 빈 구간만으로 실패 원인을 단정하지 않는다.
- 한 활성 범위와 64개 소스 상한은 유지된다. 더 많은 독립 컨테이너는 수집 대상 선택이 필요하며, 대규모 장시간 운영 부하는 이번 검사 범위가 아니다.
- 현재 상세는 지금 존재하는 동일 전체 ID의 정보다. 사건 당시 상태 스냅샷과 혼동하지 않도록 표시하며, 삭제된 ID의 현재 작업은 허용하지 않는다.
- 네이티브·실제 Engine 검증과 Seal Acceptance는 각각 별도 증거다. 이 문서는 PR 병합·CI·배포·설치·공증 증거를 대신하지 않는다.
- 되돌릴 경우 이 변경의 독립 범위 API·통합 수집·사건 탐색 변경을 함께 되돌려 기준 커밋의 독립 컨테이너 화면으로 복구한다. 기존 Compose 사건 조회와 터미널 기능은 이번 확장의 되돌리기 범위와 구분한다. 저장 데이터 마이그레이션은 없다.
