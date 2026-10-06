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

// An HTML page served at HTTP 200 (DBLP's anti-bot challenge, a captive
// portal) would otherwise reach the user as a bare "SyntaxError: JSON.parse".
// Trust the content type first, then a leading HTML tag.
function looksLikeHTML(contentType: string | null, body: string): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  return /^<(?:!doctype html|html|head|body)[\s>]/i.test(body);
}

// The page <title>, decoded by the browser so entities and markup are handled
// for us. Only called for bodies that already look like HTML.
function htmlTitle(body: string): string | undefined {
  const title = new DOMParser()
    .parseFromString(body, "text/html")
    .querySelector("title")?.textContent;
  return title?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Parse a JSON body, replacing the bare `JSON.parse` error with one that names
 * the host and HTTP status. Network-free so it is unit-testable.
 */
export function parseJSONResponse<T>(
  url: string,
  status: number,
  contentType: string | null,
  text: string,
): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const host = new URL(url).host;
    const body = text.trim();
    if (looksLikeHTML(contentType, body)) {
      const title = htmlTitle(body);
      throw new Error(
        `${host} returned an HTML page instead of JSON (HTTP ${status})` +
          (title ? `: ${title}` : ""),
      );
    }
    if (!body) {
      throw new Error(
        `${host} returned an empty response instead of JSON (HTTP ${status})`,
      );
    }
    const snippet = body.length > 160 ? `${body.slice(0, 160)}…` : body;
    throw new Error(
      `${host} returned an invalid JSON response (HTTP ${status}), starting with: ${snippet}`,
    );
  }
}

async function fetchJSONBounded<T = any>(url: string): Promise<T> {
  const xhr = await requestBounded(url);
  return parseJSONResponse<T>(
    url,
    xhr.status,
    xhr.getResponseHeader("content-type"),
    xhr.responseText ?? "",
  );
}

export interface Fetcher {
  fetchText(url: string): Promise<string>;
  fetchJSON<T = any>(url: string): Promise<T>;
}

export const defaultFetcher: Fetcher = {
  fetchText: fetchTextBounded,
  fetchJSON: fetchJSONBounded,
};
