import PQueue from "p-queue";
import { getPref } from "../../utils/prefs";

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

export function authHeaders(url: string): Record<string, string> {
  switch (new URL(url).hostname) {
    case "api.semanticscholar.org": {
      const apiKey = getPref("updateSource.semanticScholar.apiKey").trim();
      return apiKey ? { "x-api-key": apiKey } : {};
    }
    default:
      return {};
  }
}

// Bound requests so a slow request can't hang the update queue.
// Zotero.HTTP (not bare `fetch`) routes through Zotero's proxy
// rewriting, which campus users rely on, and shares the translator
// framework's HTTP/proxy/cookie footing for follow-up requests.
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
        headers: authHeaders(url),
      }),
    { throwOnTimeout: true },
  );
}

async function fetchTextBounded(url: string): Promise<string> {
  return (await requestBounded(url)).responseText!;
}

async function fetchJSONBounded<T = any>(url: string): Promise<T> {
  return JSON.parse((await requestBounded(url)).responseText!) as T;
}

export interface Fetcher {
  fetchText(url: string): Promise<string>;
  fetchJSON<T = any>(url: string): Promise<T>;
}

export const defaultFetcher: Fetcher = {
  fetchText: fetchTextBounded,
  fetchJSON: fetchJSONBounded,
};
