import type { Messages } from '../i18n';

export const frontendErrorMessages = {
  staleInventory: {
    ko: '최신 목록을 확인하지 못했습니다. Refresh로 다시 조회하세요.',
    en: 'The latest container list could not be verified. Refresh the list again.',
  },
  staleLogs: {
    ko: '이전 로그 응답입니다. Recent Logs로 다시 조회하세요.',
    en: 'The log response belongs to an earlier request. Load the logs again.',
  },
  invalidBulkResponse: {
    ko: '요청 대상과 일치하는 전체 일괄 응답을 확인하지 못했습니다.',
    en: 'A complete bulk response matching the requested targets could not be verified.',
  },
  ipcFailure: {
    ko: '앱과 실행 계층의 응답을 확인하지 못했습니다.',
    en: 'The response between the app and its execution layer could not be verified.',
  },
  nativeRequired: {
    ko: 'Docker2U.app에서 로컬 환경에 연결할 수 있습니다. 브라우저 미리보기에는 Docker 연결이 없습니다.',
    en: 'Open Docker2U.app to connect to the local environment. The browser preview has no Docker connection.',
  },
} satisfies Messages;
