# Compose Apply 실제 Engine 검증

검증일: 2026-09-13 (KST)\
작업본: `/Users/jgoneit/project/Docker2U/.worktrees/compose-apply-v1`\
브랜치: `codex/compose-apply-v1`

## 검증 대상과 결과

`src-tauri/src/docker_live_compose_apply_test.rs`에 opt-in ignored 통합 검사를 추가했다.
최종 검사 결과는 **1 passed, 0 failed**, 실행 시간 **52.56초**다. 일반 Rust suite는
이 검사를 자동 실행하지 않는다. `DOCKER2U_REAL_COMPOSE_APPLY=1`과 `--ignored`를
함께 지정해야 실제 Engine에 고유 fixture를 만든다.

최종 검증 파일 SHA-256:
`c6f4f41e9c597ac5b51abc34536d7ed102c7944a17bb68ec33d30669420a5722`

연결은 `Core::get_environment()`에서 현재 CLI context를 해석하고 고정한 target을
사용했다. 이후 fixture 조회·검증·정리도 동일 endpoint와 Engine fingerprint를
검증한 뒤 실행했다. 전역 context나 builder 설정을 바꾸지 않았다.

| 항목 | 실제 확인 값 |
| --- | --- |
| CLI context | `desktop-linux` |
| Endpoint | `unix:///Users/jgoneit/.docker/run/docker.sock` |
| Engine ID | `7746b44c-6893-4d15-af9c-944246b6d6f4` |
| Engine | Docker `29.7.2`, API `1.55`, Linux ARM64 |
| Docker Desktop | `4.90.0 (238679)` |
| Compose | `5.5.1` |
| BuildKit | `v0.32.2`, docker driver |
| 최종 fixture project | `docker2u-apply-619d94578858` |

## 실행 경로와 단정

실제 Compose 실행은 테스트가 CLI 명령을 직접 대신 실행한 결과가 아니다.
프로덕션 `Core`의 등록 preview/save → Apply preview → prepare → start → read
경로를 사용했다. 각 작업은 최종 `succeeded`, 실행한 단계의 exit code `0`,
상태 재조회 `succeeded`, 프로젝트 컨테이너 수 `4`를 확인했다.
검증용 파일 작성, 소유 컨테이너의 marker 기록·조회, inspect, cleanup에는
동일 고정 target의 Docker CLI를 보조 수단으로 사용했다.

| 작업 | 선택 | 실제 검증 |
| --- | --- | --- |
| 최초 혼합 생성 | puller=pull, builder=build, config=none, untouched=none | pull → build → recreate 성공, 컨테이너 4개 생성 |
| pull 단독 | puller=pull | pull과 재생성 성공, puller ID만 변경 |
| Dockerfile 변경 | builder=build | 이미지 ID와 Dockerfile revision label 변경, builder ID만 변경 |
| Compose 설정 변경 | config=none | 준비 단계 생략, 새 환경값 반영, config ID만 변경 |
| 혼합 준비 | puller=pull, builder=build, config=none | 단계 순서 성공, 선택 3개 ID 변경, untouched 최초 ID 유지 |

`puller`에는 `untouched` dependency를 두었다. 구성 파일에서 비선택 서비스의
환경값도 바뀐 상태에서 최종 혼합 Apply를 실행했지만 `untouched` ID와 기존
환경값은 유지됐다. 자동 dependency 재생성이 발생하지 않았음을 확인했다.

모든 fixture 서비스가 동일 read-only bind와 동일 named volume을 사용했다.
최초와 최종 상태에서 mount destination·bind source·read-only 여부·volume 이름과
각 컨테이너에서 읽은 정확한 UUID marker 내용을 확인했다. 최종 `Core` 목록의
컨테이너 4개 모두 `running`과 `healthy`로 조회됐다.

## 재현 명령

아래 명령은 의도적으로 실제 Docker Engine에 fixture를 생성·재생성한다.
등록 정보는 임시 디렉터리의 별도 registry에만 저장한다.

```sh
CARGO_HOME="$PWD/.cache/toolchain/cargo" \
RUSTUP_HOME="$PWD/.cache/toolchain/rustup" \
PATH="$PWD/.cache/toolchain/cargo/bin:$PATH" \
DOCKER2U_REAL_COMPOSE_APPLY=1 \
.cache/toolchain/cargo/bin/cargo test \
  --manifest-path src-tauri/Cargo.toml --lib --locked \
  real_compose_apply_preserves_unselected_services_and_shared_data \
  -- --ignored --nocapture
```

`cargo fmt --check`와 `git diff --check`도 통과했다.

## 자원 보존과 정리

프로젝트 이름과 ownership label은 매 실행마다 새 UUID를 사용했다.
ownership label은 `io.github.jgoneit.docker2u.compose-apply-smoke`다.
기존 사용자 프로젝트에 Compose 명령을 보내지 않았다.

컨테이너와 볼륨은 ownership label·Compose project label을 재확인하고 정확한
컨테이너 ID 또는 volume 이름으로만 제거했다. 빌드 이미지는 ownership label을
검사하고 정확한 이미지 ID를 force 없이 제거했다. `compose down`, `prune`,
사용자 컨테이너 삭제, 사용자 이미지 삭제는 실행하지 않았다. fixture 서비스는
`network_mode: none`이어서 별도 Compose 네트워크를 만들지 않았다.

최종 cleanup 후 ownership label을 가진 컨테이너·볼륨·빌드 이미지가 모두 0개임을
다시 조회했다. 실패했던 개발 실행들의 fixture도 cleanup 완료를 확인했다.
임시 Compose/Dockerfile/registry/bind marker 디렉터리도 정리했다.

사용자 컨테이너 4개의 전체 ID·표시 이미지·이름 목록이 실행 전후 동일했다.
기존 `django-docker-box`의 PostgreSQL·Redis·Memcached 두 컨테이너는 유지됐다.
이 목록 비교는 사용자 애플리케이션 데이터 전체를 검증한 결과를 뜻하지 않는다.

공용 base는 기존 mutable tag를 덮어쓰지 않도록 아래 immutable digest를 사용했다.

`busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0`

이 공용 BusyBox digest와 BuildKit cache는 소유 fixture 자원이 아니므로 남겨 두었다.
정리 범위는 ownership label로 식별한 컨테이너·볼륨·빌드 이미지이며, Engine의
공유 이미지 레이어나 빌드 캐시 전체를 원래 상태로 되돌렸다는 의미는 아니다.

## 개발 중 실패와 검증 경계

첫 harness 실행은 연결 후 목록 refresh가 빠져 `NeedsValidation`으로 등록 전
중단됐다. 앱과 같은 `list_containers` 순서를 넣은 뒤 검사를 진행했다.
Health 추가 전 통합 검사와 Health 추가 후 재검사는 각각 통과했으나, bind source를
문자열로 비교하는 검사에서는 개발 중 두 번의 실패가 있었다.

진단을 추가한 실행에서 healthy 컨테이너의 실제 source가
`/host_mnt/private/var/folders/.../shared`로 반환됐고, macOS canonical source는
`/private/var/folders/.../shared`였다. 최종 검사는 관측된 Docker Desktop
`/host_mnt` prefix만 제거한 뒤 정확한 경로를 비교한다. mount 검사에는
healthy가 된 시점에 다시 읽은 snapshot을 사용한다. read-only·volume ID·UUID
파일 내용 조건은 유지했다. prefix 처리 후 최종 통합 검사가 통과했다.
이 실패를 프로덕션 Core 실행 오류나 권한 문제로 분류하지 않는다.

이 결과는 실제 Engine에서 프로덕션 Core의 성공 경로를 검증한다. GUI 클릭,
WKWebView 레이아웃, 설치 앱 교체, 코드 서명, notarization, Gatekeeper는 별도
검증이다. 실제 Engine의 pull/build 실패·취소·timeout이나 외부 registry의 변경된
태그 수신은 이 검사에서 검증하지 않았다. pull은 고정 digest에 실제 Compose
pull을 수행한 결과이며 신규 이미지 레이어 다운로드를 보장하는 검사는 아니다.
