# Code Scanning 경고 처리

Status: Ready

## 목표와 범위

`src/preferences.test.tsx`의 정규식 기반 스크립트 추출을 HTML 파싱으로
바꾸고, PR #14의 CodeQL 검사를 실행해 병합한다.

현재 테스트는 저장소의 `index.html`에서 첫 `<script>` 본문을 정규식으로
추출·실행하여 React 렌더링 전 저장된 테마와 언어가 적용되는지 검사한다.
이 정규식이 Code Scanning 경고 #1 (`js/bad-tag-filter`)의 대상이다.
외부 HTML 입력을 처리하는 제품 필터가 아니라 저장소 파일을 읽는 테스트다.

제품의 설정 저장 방식, 화면 동작, Docker 작업은 변경 범위에 포함하지 않는다.

## 사용 시나리오

테스트는 HTML 구조에서 인라인 부트스트랩 스크립트를 찾아 실행하며,
해당 스크립트가 없거나 비어 있으면 실패한다(AC-1, AC-2).
저장된 테마·언어·색상 모드 적용 검증과 제품의 설정 형식은 유지한다(AC-2).
PR #14는 CodeQL 결과를 갖고 병합된다(AC-3).

## 결정과 근거

- HTML 파서 사용: 경고 #1의 파서 사용 권고와 `vite.config.ts`의 기존
  jsdom 테스트 환경에 따라 `DOMParser`로 스크립트를 추출한다.
  대소문자 구분 플래그만 추가하는 대신 HTML 파싱 규칙을 사용한다.
- CodeQL 재검사: 사용자가 요청한 “CodeScanning을 제외 혹은 다시
  CodeScanning을 돌리고 merge” 중 재검사를 선택한다.
- 검증 동작 유지: `src/preferences.test.tsx`와 `index.html`에 있는
  저장된 테마·언어·색상 모드 적용 검증을 유지한다.

## Acceptance Criteria

- **AC-1** 대상 HTML 추출 정규식이 제거되어 `js/bad-tag-filter` 경고가
  해당 위치에 재발하지 않는다.
- **AC-2** 기존 부트스트랩 테스트가 통과하고, 스크립트가 없거나 비어 있으면
  테스트가 실패한다. 제품 코드와 설정 형식은 유지된다.
- **AC-3** PR #14는 CodeQL 결과를 갖고 병합된다.

## Open Decisions

없음.

## 관련 문맥

- [환경설정 테스트](../../../src/preferences.test.tsx)
- [부트스트랩 HTML](../../../index.html)
- [테스트 환경](../../../vite.config.ts)
- [보안 경고 #1](https://github.com/jgoneit/Docker2U/security/code-scanning/1)
- [PR #14](https://github.com/jgoneit/Docker2U/pull/14)
