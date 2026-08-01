import PQueue from "p-queue";

// Limit concurrent requests per host to avoid being rate-limited.
const hostQueues = new Map<string, PQueue>();
function hostQueue(host: string): PQueue {
  let queue = hostQueues.get(host);
  if (!queue) {
    queue = new PQueue({
      concurrency: 1,
      intervalCap: 1,
      interval: 1500,
    });
    hostQueues.set(host, queue);
  }
  return queue;
}

// Bound requests so a slow request can't hang the update queue.
// Zotero.HTTP (not bare `fetch`) routes through Zotero's proxy
// rewriting, which campus users rely on, and shares the translator
// framework's HTTP/proxy/cookie footing for follow-up requests.
// errorDelayMax: 30000 caps Zotero's 5xx retry backoff at 30s (default 1h)
// so a failing host can't stall the queue. throwOnTimeout: true is a runtime
// no-op (no queue timeout is set) but narrows p-queue add()'s return type to
// the task result instead of `TaskResultType | void`.
export function requestBounded(
  url: string,
  options: { timeout?: number; responseType?: string } = {},
): Promise<XMLHttpRequest> {
  return hostQueue(new URL(url).hostname).add(
    () =>
      Zotero.HTTP.request("GET", url, {
        timeout: 15000,
        errorDelayMax: 30000,
        ...options,
      }),
    { throwOnTimeout: true },
  );
}

export async function fetchTextBounded(url: string): Promise<string> {
  return (await requestBounded(url)).responseText!;
}

export async function fetchJSONBounded<T = any>(url: string): Promise<T> {
  return JSON.parse((await requestBounded(url)).responseText!) as T;
}
