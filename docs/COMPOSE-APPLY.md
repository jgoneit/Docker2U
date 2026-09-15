# Compose 선택 서비스 변경 반영 v1

등록 프로젝트의 **변경 반영**에서 서비스를 선택하고 각 이미지의 준비 방법을
지정한다. 처음에는 아무 서비스도 선택하지 않는다. 발견 프로젝트는 먼저 Compose
파일을 연결해 등록한다. 기존 프로젝트 실행·중지와 로그·저장소·이력은 그대로 사용한다.

## 선택과 확인

- **이미지 내려받기**: `image`가 있는 서비스만 선택할 수 있다.
- **이미지 빌드**: `build`가 있는 서비스만 선택할 수 있다.
- **현재 로컬 이미지 사용**: 준비를 생략한다. 해당 시점의 로컬 이미지가 없으면
  적용이 실패하며 자동 다운로드나 빌드로 대체하지 않는다.

비활성 profile의 서비스도 이름과 profile을 보고 직접 선택할 수 있다. profile
전체를 활성화하는 조작은 없다. 확인 화면은 Engine, 등록 프로젝트, 선택 서비스,
준비 방식과 현재 관측된 모든 복제본을 보여준다. 컨테이너가 없는 서비스는 새로
생성될 수 있다. 관측 정보가 오래되거나 없으면 현재 복제본 수를 보장하지 않는다.

선택한 서비스의 모든 복제본을 재생성·실행하며 의존 서비스를 자동으로 추가하거나
시작하지 않는다. 복제본 수는 Compose 구성과 Compose의 동작을 따른다. 앱에서
별도 scale 값을 지정하지 않는다. 같은 이미지를 쓰는 서비스도 자동 선택하지 않는다.
준비를 생략한 서비스는 다른 준비 단계에서 갱신된 로컬 이미지를 사용할 수 있다.

## 실행 계약

`preview_compose_apply(sessionId, projectId, expectedRevision)`는 Core가 등록 파일을
검증해 최소 서비스 메타데이터를 반환하는 읽기 전용 IPC다. 전체 Compose 해석 결과나
환경변수 값은 반환하지 않는다. 구성 조회에만 `--profile '*'`를 사용한다.

기존 `prepare_compose_operation`에 `action: apply`와
`selections: [{ service, preparation: pull | build | none }]`를 추가한다.
Core는 빈 목록, 중복, 알 수 없는 서비스와 불가능한 준비 방법을 거부한다.
확정된 선택과 준비 정책은 세션·Engine·등록 revision·파일 증명·구성 digest를 가진
메모리 준비 토큰에 고정된다. 기존 `up`·`stop`은 서비스 선택을 받지 않는다.

필요한 준비 단계만 아래 순서대로 한 번씩 실행한다. 각 목록은 Core가 정렬하고,
서비스 이름을 `--` 뒤의 개별 argv로 전달한다. UI에서 명령이나 옵션을 입력받지 않는다.

| 단계 | 고정 명령 |
| --- | --- |
| 다운로드 | `compose pull --policy always -- <pull 서비스>` |
| 빌드 | `compose build -- <build 서비스>` |
| 재생성 | `compose up --detach --no-deps --no-build --pull never --force-recreate -- <선택 서비스>` |

각 명령은 세션에 고정된 Engine, 등록 파일·작업 폴더·환경 파일과 기존 Compose
환경 정책을 사용한다. 적용 단계에서 준비 방법을 다시 고르지 않는다.
[Compose up 옵션](https://docs.docker.com/reference/cli/docker/compose/up/)의
의미와 별개로 서비스 자체의 준비 완료를 판정하는 `--wait`나 HTTP/TCP 검사는 없다.

작업에는 정확한 `requestId`, 선택 목록, 단계별 대상·상태·종료 코드가 남는다.
시작 응답을 잃으면 같은 세션의 정확한 requestId로 해당 작업을 복구한다.
다른 작업을 같은 프로젝트 이름만으로 대신 표시하거나 자동 재실행하지 않는다.
단계 경계가 표시된 작업 출력을 제공하며 출력 문자열로 개별 서비스의 성공이나
진행률을 추정하지 않는다. 보관 상한은 작업당 2 MiB, 전체 8 MiB·최근 10개이며
생략된 출력은 안내한다.

## 구성 경계

- `additional_contexts`의 `service:` 빌드 참조는 모든 참조 대상이 명시적인 **빌드**
  선택에 포함되어야 한다. 누락된 대상 이름을 표시하고 실행 준비를 거부한다.
- 다운로드와 빌드가 같은 이미지 참조를 갱신하거나, 두 빌드 서비스가 같은 태그를
  만드는 구성을 거부한다. `build.tags`와 이미지가 없는 빌드 서비스의 기본
  `<project>-<service>` 이름도 검사한다.
- Docker Hub, `library`, 생략된 `latest`, `index.docker.io`의 기본 이름 표현을
  정규화해 비교한다. 이미지 내용이나 서로 다른 digest의 동등성은 추정하지 않는다.
  공유 안내는 해당 Compose 프로젝트의 서비스 메타데이터에 한정한다.
- 선택 서비스에 `type: image` 마운트가 있으면 v1 변경 반영을 거부한다.
  Compose는 서비스 이미지의 `--pull never`와 별개로 마운트 이미지를 받을 수 있다.
  기존 읽기 전용 저장소 조회는 계속 제공한다.
- `provider` 서비스도 선택할 수 없다. 해당 서비스의 `up`은 로컬 컨테이너 재생성이
  아니라 외부 provisioner 실행으로 이어질 수 있어 이 흐름의 이미지 준비 계약과
  맞지 않는다. 선택하지 않은 provider가 있는 프로젝트는 다른 일반 서비스를
  변경 반영할 수 있다. 기존 프로젝트 실행·중지는 변경하지 않는다.

빌드 참조와 image 마운트 경계는
[Compose build 구현](https://github.com/docker/compose/blob/v2.39.4/pkg/compose/build.go)과
[마운트 이미지 다운로드 구현](https://github.com/docker/compose/blob/v2.39.4/pkg/compose/pull.go#L275-L296)을
기준으로 한다. Dockerfile과 build context 전체를 스냅샷으로 고정하는 기능은 없다.
provider의 실행 방식은 [Compose provider 문서](https://docs.docker.com/compose/how-tos/provider-services/)를
따른다.

## 실패·취소와 현재 상태

다운로드나 빌드가 실패하면 후속 명령은 실행하지 않는다. 완료된 단계는 유지하고
나머지는 미실행으로 표시한다. 그룹 명령 실패라도 일부 이미지는 준비됐을 수 있다.

실행 중인 프로세스의 취소·timeout은 그 단계의 `resultUnknown`이다. 단계 사이
취소는 `cancelled`, 아무 명령도 시작하기 전 취소는 `cancelledBeforeStart`다.
이전에 생성된 이미지나 적용된 변경을 자동 삭제·재시도·rollback하지 않는다.

각 다음 명령 전에 세션·Engine·등록 revision·파일 증명·해석된 구성을 다시 확인한다.
변경되면 앞선 단계 결과를 남기고 중단한다. 전체 명령은 한 변경 작업 예약과 공유
30분 deadline을 사용한다. 종료 후 상태 재조회는 별도 45초 제한이며 결과를 표시한다.
기존 로그·자원 관측은 계속한다.

명령 결과와 현재 State·Health는 별개다. 진행 화면은 선택 서비스의 실제 컨테이너만
표시하고 정확한 ID의 로그·진단으로 이동한다. 닫아도 작업은 계속되며 하단의 최근
작업으로 다시 열 수 있다. 재생성된 ID는 목록·저장소 관측으로 갱신되지만 사라진
컨테이너 상세를 이름이 같은 새 ID로 자동 대체하지 않는다.

준비만 실행, 변경 자동 감지·자동 배포, rollback, 터미널, 이미지 push, 추가 빌드
옵션 편집은 제외한다. 이번 검증 경계와 재개 항목은
[검증 기록](COMPOSE-APPLY-AUDIT.md)을 따른다.
