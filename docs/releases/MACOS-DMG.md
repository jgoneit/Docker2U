# Apple Silicon DMG 패키징

대상은 macOS 14 이상 / Apple Silicon이다. Docker CLI와 실행 중인 로컬 Linux
Engine은 별도로 준비해야 한다. Windows·Intel Mac과 자동 업데이트는 포함하지 않는다.
이 문서는 패키징 절차이며 공개 Release 또는 전체 지원 환경의 검증 완료를 뜻하지 않는다.

## 원본과 빌드

앱 아이콘 원본은 사용자가 선택한 `assets/app-icon.png`다. 원본을 다시 생성하거나
편집하지 않고 Tauri가 ICNS와 해상도별 PNG로 변환한다.

- 원본: 1254 × 1254 PNG, alpha 채널 포함
- 원본 SHA-256: `a42079aeff781ccb84cee4ebead344e328f8aa07c0d5e464575b67bbf75ed821`
- 초기 앱 버전: `0.1.0-alpha.1`

macOS ARM64 환경에서 저장소에 고정한 Node·pnpm·Rust 도구체인을 사용한다.

```sh
pnpm install --frozen-lockfile
pnpm native:build:dmg --ci -- --locked
```

기존 `native:build`는 `.app`만 만들며 기존 CI 동작을 유지한다. 새 명령은
`aarch64-apple-darwin` 대상의 `.app`과 `.dmg`를 생성한다. 기본 출력 디렉터리는
`src-tauri/target/aarch64-apple-darwin/release/bundle/`이다.

## 서명 구분

정식 외부 배포의 Developer ID 서명·Hardened Runtime·Apple 공증·ticket stapling과
깨끗한 Mac의 Gatekeeper 검증 기준은 개발 정의서를 따른다. 빌드 성공만으로 해당
기준을 충족했다고 판단하지 않는다. 인증서나 공증 자격 증명을 저장소에 넣지 않는다.

유료 계정 없이 로컬 테스트 패키지를 만들 때는 다음 ad-hoc 서명을 사용할 수 있다.
Apple 공증 환경변수를 설정하지 않은 별도 빌드 환경에서 실행한다.

```sh
APPLE_SIGNING_IDENTITY=- pnpm native:build:dmg --ci -- --locked
```

ad-hoc 서명은 Apple이 확인한 개발자 신원이나 공증을 제공하지 않는다. 공개한다면
사용자가 선택한 테스트용 Pre-release로 명시하고, 최초 실행 시 보안 경고나
추가 허용이 필요할 수 있음을 알려야 한다. 이를 정식 서명·공증 배포로 표현하지 않는다.
시스템 전체 보안 설정 변경이나 Gatekeeper 비활성화를 설치 절차로 안내하지 않는다.

## 패키지 검증과 게시 자료

1. `lipo -verify_arch arm64`로 앱 실행 파일의 아키텍처를 확인한다.
2. `codesign --verify --deep --strict`와 `codesign -dv --verbose=4`로 앱의 서명
   무결성과 실제 서명 방식을 확인한다.
3. `hdiutil verify`로 DMG를 검사하고 읽기 전용으로 마운트하여 `Docker2U.app`,
   Applications 링크, 앱 버전·identifier와 새 아이콘을 확인한다.
4. 패키지에서 복사한 앱의 최초 실행과 아이콘을 확인한다. Gatekeeper 검증 여부와
   실제 Docker 조작 검증 여부를 따로 기록한다.
5. 게시할 commit·tag, 빌드 환경·검증 결과, DMG SHA-256, 의존성 목록과
   third-party notices를 함께 제공한다. 미수행 검사와 알려진 제약은 숨기지 않는다.

DMG 실패 시 성공한 `.app` 빌드만으로 DMG 생성이나 설치 검증을 완료했다고
기록하지 않는다. 공개하지 못한 로컬 산출물은 Release 다운로드 링크로 안내하지 않는다.

## 디스크 장치를 사용할 수 없는 빌드 환경

이 세션에서는 Tauri의 `hdiutil create`와 읽기 전용 `hdiutil attach`가 모두
`장치가 구성되지 않았음`으로 실패했다. 시스템 설정을 바꾸지 않고, 서명 검사를
통과한 앱과 Applications 링크를 별도 폴더에 준비한 뒤 `hdiutil makehybrid -hfs`와
`hdiutil convert -format UDZO`로 파일 기반 DMG를 만들 수 있었다.

이 방식은 Tauri의 Finder 창 배치를 적용하지 않는다. 생성 후 DMG에도 ad-hoc
서명을 적용하고 이미지 체크섬과 코드서명을 각각 검사한다. 파일 기반 생성과
검사가 성공하더라도 마운트·설치·Gatekeeper 검증은 별도로 남겨야 한다.
