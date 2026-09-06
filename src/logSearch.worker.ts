import { LogSearchRunner, type LogSearchReply, type LogSearchRequest } from './logSearch';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LogSearchRequest>) => void) | null;
  postMessage: (reply: LogSearchReply) => void;
};
const runner = new LogSearchRunner(reply => workerScope.postMessage(reply));
workerScope.onmessage = event => runner.handle(event.data);
workerScope.postMessage({ type: 'ready' });
