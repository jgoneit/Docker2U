# Compose 변경 반영 및 이미지 내보내기 검증 기록

날짜: 2026-09-13 (KST)

기준은 PR #11이 병합된 `main`의
`6f13a3fd4b2a9ba99071c151c7625bd2e9275589`다. 기존
`codex/compose-apply-v1` 작업본의 미커밋 Compose 구현·후속 수정 33개 파일을
별도로 보존한 뒤, 같은 격리 작업본에서 이미지 내보내기를 추가했다. 원본 작업본,
`.local-apps/`와 이전 검증 기록은 유지했다.

## 구현 범위

- 실행·중지 컨테이너의 실제 `.Image` ID를 확인하고, native picker로 선택한
  새 `.tar` 파일에 `docker image save -- <image-id>` stdout을 직접 기록한다.
- 준비·저장 위치·시작·조회·최근 목록·취소의 typed IPC를 추가했다. 임의 경로와
  이미지 ID를 받는 IPC, 범용 파일 쓰기·shell capability는 추가하지 않았다.
- 전용 작업 예약, 30분 제한, request ID 복구, 최근 10개, 이전 세션 처리,
  단조로운 완료 상태와 native picker·대화상자 포커스 경계를 구현했다.
- 폴더 descriptor와 임시 파일 inode를 확인하고, 파일 동기화 후 macOS
  `renameatx_np(RENAME_EXCL)`로 확정한다. 기존 파일·symlink는 덮어쓰지 않는다.
- 모달과 작업 수명을 분리하고 로그·선택·저장소 상태를 유지한다. 실제 이미지 ID
  저장에 따른 원래 태그의 복원 제한과 데이터 백업 범위를 화면·문서에 안내한다.

## 이번 세션의 실행 환경 제한

`docker context show`는 `desktop-linux`를 반환했으나 `docker version`은
`unix:///Users/jgoneit/.docker/run/docker.sock` 연결에서 permission denied로 실패했다.
별도 임시 디렉터리의 Python Unix socket bind도 `Operation not permitted`였다.

브라우저 검사는 한 번 실행을 시도했지만 Vite가 `127.0.0.1:1422`에 bind할 때
`listen EPERM`으로 실패했다. 브라우저 테스트 본문은 시작되지 않았다. 권한을
우회하거나 테스트를 삭제·skip하여 통과시키지 않았다.

## 검사 결과

| 검사 | 결과 | 증거 범위 |
| --- | --- | --- |
| 프런트 전체 | 51개 파일, 809개 통과 | React, typed IPC, request ID·세션·완료 결과·포커스 회귀 |
| Production frontend build | 통과 | TypeScript, Vite, test fixture 격리 |
| unsigned macOS 앱 빌드 | 통과 | `pnpm native:build --ci --no-sign -- --locked`, 설치·실행·서명 검증은 포함하지 않음 |
| Core 이미지 내보내기 순수 검사 | 11개 통과 | 이미지 파서, 토큰, 파일 충돌·교체, 취소·확정, 보관 한도, 느린 디렉터리 동기화 |
| Core 전체 export pipeline | 5개 실패 | 모두 fixture Unix socket 생성 EPERM에서 중단, 테스트 본문 미실행 |
| typed IPC capability 검사 | 1개 통과 | 여섯 전용 IPC 권한과 허용 목록 일치 |
| Process 회귀 | 29개 통과 | 새 binary FD 검사 4개 포함, 기존 follow·프로세스 종료 회귀 |
| Native 이미지 fixture 검사 | 9개 통과 | 고정 inspect/save argv, 바이너리 tar, 실패·중지 컨테이너 |
| Native fixture 전체 | 59개 중 53개 통과, 6개 오류 | 기존 HTTP·관측 검사의 Unix socket bind 권한 오류 |
| 이미지 브라우저 검사 수집 | 8개 시나리오 × 9개 환경, 72개 수집 | 수집·구문 검증이며 화면 동작 통과를 뜻하지 않음 |
| 이미지 브라우저 실행 | 실행 전 차단 | Vite bind EPERM |
| 실제 Engine 이미지 export/load | 미실행 | Docker socket 권한 제한 |
| Native 저장 창·화면 직접 조작 | 미검증 | fixture socket 실행 제한 |

실제 디스크를 가득 채우는 검사는 하지 않았다. 파일 쓰기 실패와 부분 출력·명령
실패 후 정리 경로를 검증하며, 실제 파일시스템 ENOSPC와 전원 차단까지 검증한
것으로 확대 해석하지 않는다.

결과 로그는 작업본의 `.cache/image-export/` 아래에 보관한다. 저장소에 바이너리
tar, 앱 bundle, socket, 캐시와 로컬 테스트 출력은 커밋하지 않는다.

## 전체 실행 경로의 회귀

`docker_image_export_pipeline_tests.rs`는 실제 Core의 준비 → 저장 위치 등록 →
시작 → 조회·취소를 사용하는 strict fake CLI 검사다. 실제 Engine fixture socket을
bind해야 하므로 이 세션의 순수 파일·파서 검사와 구분한다.

검사는 실행·중지 상태, 표시 태그 변경 후 실제 ID 고정, 컨테이너·이미지 누락,
부분 출력 실패, 로그·목록 병행 조회, 중복 실행 거부, 취소와 제한 시간을 다룬다.
다섯 검사는 컴파일됐지만 위 권한 제한으로 실행 경로를 검증하지 못했다.

`docker_live_image_export_test.rs`는 별도의 opt-in 실제 Engine 검사다. UUID label로
식별한 컨테이너 두 개에서 각각 export하고, ID·상태·시작 시간이 유지되는지 확인한
뒤 검증 자원만 제거한다. 두 tar를 각각 load해 원래 이미지 ID와 label을 확인한다.
새 opt-in 검사는 일반 Rust suite에서 ignored이며, 실행 전용 환경변수가 필요하다.
native 저장 창 조작은 이 Rust 검사의 증거에 포함되지 않는다.

독립 검토 후 디렉터리 동기화를 전역 상태 잠금 밖으로 옮겼다. 파일 확정과 성공
결정만 취소·세션 교체와 직렬화하고, 동기화 경고를 첫 완료 응답에 포함한다.
실제 Engine 테스트의 실패 경로에서도 export worker 취소·대기를 먼저 수행한 뒤
검증 자원을 정리하도록 보완했다. 브라우저 로그 보존 검사는 비동기 조회 완료 후
실제로 표시된 행과 스크롤 위치를 비교하도록 정리했다.

## Seal 및 게시 경계

CLI와 플러그인의 공개 버전은 `0.3.0-rc.4`로 일치한다. 기존 Compose의 Accepted
Run `2f6cba59f4d147f183cfae8eb5e7b4b1`과 이전 실패 기록을 보존하고, 범위가 추가된
새 Basic Task `docker2u-compose-apply-image-export-v1-20260913`을 생성했다.

필수 검사는 기존 `frontend-tests`, `frontend-build`, `rust-format`, `rust-tests`다.
최종 소스·문서 커밋에 대한 `verify`의 정확한 Run ID로 `complete`를 수행하고,
CLI 결과와 PR의 최종 HEAD CI 결과는 PR 본문과 작업 최종 응답에 별도로 기록한다.
이전 Compose의 Acceptance를 이미지 내보내기 후보의 Acceptance로 재사용하지 않는다.

이번 게시 범위는 커밋·브랜치 게시·PR 생성·CI 확인이다. main 병합, Release,
설치 앱 교체는 포함하지 않는다.
