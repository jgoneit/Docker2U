# alpha.2 의존성 보안 검사

검사 시각: 2026-10-05 01:43:21 UTC. 대상은 macOS Apple Silicon 배포입니다.

- pnpm 11.19.0 audit: 운영·개발 의존성 173개, 모든 심각도의 취약점 0건.
- Cargo.lock의 432개 package-version을 OSV 공식 API와 RustSec 자료로 조회했습니다.
  ARM64 macOS resolved graph 272개에는 알려진 취약점이 없었습니다.
- `plist 1.10.1`을 통해 `quick-xml 0.42.0`을 적용했고, `time 0.3.47`,
  `serde_with 3.21.0`, 테스트 도구의 `undici 8.10.2`를 적용했습니다.
- Cargo.lock SHA-256: `278c8de40111e52aabeb5616e8c9cf3bc8880466325b7af521b250194d497201`.

## 남은 경고와 검증 경계

- macOS 대상 `unic-* 0.9.0` 다섯 패키지에는 유지보수 중단 공지가 남습니다. 취약점 판정과 구분합니다.
- 전체 lock에는 macOS 대상에 포함되지 않는 `glib 0.18.5` Moderate 권고 한 건과
  `proc-macro-error 1.0.4` 유지보수 중단 공지가 남습니다. 모든 플랫폼의 lock이 무경고라는 뜻은 아닙니다.
- 이번 검사는 공지 데이터와 실제 대상 dependency graph를 대조했습니다.
  cargo-audit CLI나 취약점 공격 재현을 실행한 결과는 아닙니다. 이후 공개되는 권고까지 보장하지 않습니다.

배포물의 정확한 소스·lock·의존성 목록은 첨부한 BUILD-INFO와 DEPENDENCIES를 기준으로 합니다.
