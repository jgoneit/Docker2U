# Docker2U

> **Docker CLI, without the CLI friction.**

Docker2U는 Windows와 macOS에서 이미 설치된 조직 승인 로컬 컨테이너
런타임을 비전문 개발자가 안전하게 조회하고 복구할 수 있도록 돕는 경량
데스크톱 컨트롤 패널이다.

## 현재 상태

```text
제품·개발 방향 정의 완료
애플리케이션 구현 미착수
```

이 디렉터리에는 현재 정의 문서만 있다. 실행 코드, build 설정, package 파일,
installer 또는 runtime은 생성하지 않았다.

## 기준 문서

- [Docker2U 개발 정의서](docs/DEVELOPMENT-DEFINITION.md)

개발 정의서는 다음 내용을 하나의 기준으로 관리한다.

- 제품 문제, 대상 사용자와 성공·중단 기준
- Windows/macOS 및 Runtime 지원 matrix
- Rust + Tauri 2 기반 기술 방향
- v0.1 기능과 명시적 제외 범위
- Local-only endpoint와 typed IPC 보안 경계
- 테스트, 서명 배포, Acceptance Criteria와 Release Blocker

## 확정된 핵심 방향

- Docker2U는 Docker Desktop 대체품이나 Runtime 설치 도구가 아니다.
- 조직이 제공한 Docker CLI와 로컬 Docker/Moby Runtime을 그대로 사용하는
  BYOR(Bring Your Own Runtime) 제품이다.
- v0.1은 Container 조회, 최근 로그, Start, Stop, Restart에 집중한다.
- 원격 endpoint, 범용 shell, Terminal/Exec, Delete/Prune, Compose는 제외한다.
- 기술 스택은 Rust + Tauri 2 + TypeScript + Svelte로 정의한다.

구현을 시작하기 전에는 개발 정의서의 Phase 0 검증 기준과 공식 지원 Runtime
조합을 먼저 승인해야 한다.
