# Docker2U alpha.2 릴리스와 사용자 안내

Status: Ready

## 목표와 현재 상태

최근 검증한 기능을 macOS Apple Silicon용 `v0.1.0-alpha.2` 테스트 배포로 제공하고,
처음 방문한 사용자가 README와 GitHub Pages에서 용도·설치·첫 사용을 이해하게 한다.
현재 앱 버전은 `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`에
alpha.1로 기록돼 있고, 기존 `README.md`는 개발 문서 안내 비중이 높다.
독립 컨테이너 사건 확인과 선택 컨트롤 개선은 main에 최종 통합해야 한다.

## 범위와 유지 사항

- 독립 컨테이너 사건 확인·선택 컨트롤 개선을 포함한 배포 후보와 버전·배포물.
- 한국어 중심 사용자 README, 설치 안내와 GitHub Pages 제품 소개.
- 배포 의존성의 보안 검토와 릴리스 자료.
- 기존 로그·사건·터미널 동작, 세션과 전체 컨테이너 ID 경계, 로컬 Engine 정책은 유지한다.
- 자동 업데이트, Windows·Intel 지원, 새로운 컨테이너 기능과 정식 공증 배포는 범위 밖이다.

## 사용 시나리오

| 종류 | 시나리오 | 조건 |
| --- | --- | --- |
| 흐름 | 사용자가 README 또는 소개 페이지에서 준비물을 확인하고 alpha.2를 내려받아 설치·실행한다. | AC-2, AC-3, AC-4 |
| 흐름 | 사용자가 통합된 앱에서 독립 사건 확인과 터미널·선택 컨트롤 개선을 사용한다. | AC-1, AC-5 |
| 경계 | Windows·Intel 사용자 또는 Docker 환경이 없는 사용자가 다운로드 전에 지원 범위와 준비물을 확인한다. | AC-3, AC-4 |
| 경계 | 사용자는 테스트용 서명과 공증 부재, 실제로 확인하지 못한 검증 범위를 배포 자료에서 구분한다. | AC-2, AC-6 |
| 유지 | 재연결·삭제·동명 재생성·사건 왕복 이후에도 기존 세션과 전체 ID 경계가 유지된다. | AC-5 |

## 결정과 근거

- alpha.2 프리릴리스로 제공한다. 근거: 직전 릴리스 판단과 사용자의 “새 release 진행” 요청, `docs/releases/MACOS-DMG.md`의 테스트 배포 기준.
- 기존 아이콘과 제품 정보를 사용하고 Tessera처럼 다운로드·설치·사용 순서를 앞에 둔다. 근거: 사용자의 README 참조 요청과 `https://github.com/jgoneit/tessera`.
- 기본 GitHub Pages 프로젝트 주소에 정적 소개 페이지를 제공한다. 근거: 사용자의 GitHub Pages 요청. Pages가 로컬 Engine에 접속하지 않는다.
- 취약점·검증 한계·지원 범위를 숨기지 않는다. 근거: `docs/DEVELOPMENT-DEFINITION.md`의 배포·공급망 기준.

## Acceptance Criteria

- **AC-1** PR #16·#17을 포함한 최종 소스가 main에 반영되고 해당 후보의 필수 검사가 통과한다.
- **AC-2** macOS Apple Silicon용 alpha.2를 내려받아 설치·실행할 수 있고 배포물과 소스 커밋의 대응을 확인할 수 있다.
- **AC-3** README에서 용도, 준비물, 설치, 첫 사용, 주요 기능과 제한을 찾을 수 있다.
- **AC-4** GitHub Pages에서 같은 정보를 모바일·데스크톱으로 읽고 릴리스와 설치 안내로 이동할 수 있다.
- **AC-5** 기존 로그·사건·터미널 흐름과 로컬 Engine·세션·전체 ID 경계가 유지된다.
- **AC-6** 릴리스에 체크섬·변경 내역·의존성 자료와 실제 검증 범위가 포함되며 배포 의존성은 저장소 보안 기준을 충족한다.

## 관련 문맥

- [패키징](../../releases/MACOS-DMG.md)
- [개발 정의와 배포 기준](../../DEVELOPMENT-DEFINITION.md)
- [독립 사건 확인](../../STANDALONE-INCIDENTS.md)
- [터미널](../../CONTAINER-TERMINAL.md)

## Open Decisions

없음.
