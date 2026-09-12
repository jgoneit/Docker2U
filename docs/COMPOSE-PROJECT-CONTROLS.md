# Compose 프로젝트 등록·실행 v1

이 기능은 로컬 Compose 파일을 등록하고 프로젝트를 실행·중지한 뒤 서비스 상태와
로그를 확인하는 흐름을 제공한다. 구현과 검증 기록은 완료 후보에서 아래에 갱신한다.

## 범위

- 로컬 Compose 파일 1개, 실행 폴더, 선택 환경 파일 1개를 등록한다. 기본 실행
  폴더는 Compose 파일의 부모이며 해당 폴더의 `.env`를 선택 후보로 제안한다.
- 현재 연결된 로컬 Engine에 표준 `up -d` 또는 `stop`을 실행한다. 필요한 초기
  이미지 준비와 빌드는 Compose가 수행한다. `up`은 기존 컨테이너를 재생성할 수 있다.
- 등록 해제는 앱의 설정만 제거한다. 컨테이너·이미지·볼륨에는 영향을 주지 않는다.
- 다중 파일·프로필 선택·YAML 편집·강제 재빌드·Down·삭제·Terminal은 포함하지 않는다.

## 등록과 실행 계약

등록 정보는 Core 소유 `compose-projects.v1.json`에 원자적으로 저장한다. 이름은
앱 안에서 유일하다. 저장값은 등록 ID·revision·이름·경로이며 세션과 환경변수 값,
로그를 저장하지 않는다. 파일 손상은 Compose 기능의 오류로 표시하고 원본을 덮지 않는다.

등록 설정은 Engine과 독립적이다. 실행은 검토한 현재 세션·Engine에 고정한다.
같은 이름의 기존 프로젝트는 Compose 파일과 작업 폴더 출처까지 확인한다.
출처가 다르거나 없는 경우 기존 구성을 추정해 실행하지 않는다.

기존 IPC는 유지하고 등록 목록·미리보기·저장·해제, 실행 준비·시작·목록·cursor
조회·취소를 위한 typed IPC를 추가한다. 임의 명령이나 executable은 받지 않는다.
전체 `compose config` 응답과 환경변수 값은 UI·감사 기록에 전달하지 않는다.

Compose 변경 작업은 세션당 한 개이며 개별 컨테이너 변경과 상호 배제한다.
목록·자원·이벤트·로그 관찰은 계속된다. 준비 단계부터 취소를 적용하며 재연결은
이전 권한을 먼저 폐기한 뒤 자식 프로세스를 정리한다. 오래된 결과가 새 세션을
덮지 못하게 하고, 중복 request ID는 새 변경을 실행하지 않는다.

출력은 작업당 2 MiB, 완료 작업은 최근 10건·전체 8 MiB 상한으로 세션 내 보관한다.
진행 창을 닫아도 작업은 계속되며 최근 작업에서 다시 연다. 명령 종료와 서비스
실제 상태를 구분한다. 취소·timeout·부분 실패 후에는 현재 상태를 확인하며
자동 재실행·rollback을 수행하지 않는다.

## 구성 확인과 실행 결과

구성은 [`docker compose config --format json`](https://docs.docker.com/reference/cli/docker/compose/config/)으로
해석한다. 선택 파일과 환경 파일의 내용 및 해석한 설정의 SHA-256을 메모리에서
비교해 실행 직전 변경을 검출한다. UI에는 서비스 이름·이미지·빌드 여부·프로필만
전달한다. Dockerfile과 build context 전체의 내용은 스냅샷으로 고정하지 않는다.

[`up --detach`](https://docs.docker.com/reference/cli/docker/compose/up/)의 성공은
Compose 명령의 종료 성공이다. 모든 서비스가 healthy 또는 준비 완료라는 뜻은
아니며, 진행 창에서 마지막 컨테이너 목록의 상태를 별도로 확인한다.
[`stop`](https://docs.docker.com/reference/cli/docker/compose/stop/)은 컨테이너를
제거하지 않는다. 취소와 시간 초과는 이미 Engine에 반영된 변경을 되돌리지 않는다.

## 검증 기록

등록·실행·중지와 작업 복구를 구현했다. 전체 검사와 브라우저·Native Smoke 직접
조작 결과는 [검증 기록](COMPOSE-PROJECT-CONTROLS-AUDIT.md)에 남긴다.
가짜 CLI와 격리된 Engine fixture를 사용했으며, 실제 사용 중인 컨테이너의
Compose 실행·중지는 검증하지 않았다.
