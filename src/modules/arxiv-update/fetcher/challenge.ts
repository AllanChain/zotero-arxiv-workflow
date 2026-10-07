/**
 * Clears anonymous bot challenges (currently DBLP's Anubis) by loading the
 * challenged URL in a hidden browser, letting the page's own JavaScript solve
 * it, then retrying. The browser shares the default cookie jar with
 * `Zotero.HTTP`, so a clear also unblocks later requests to the host,
 * including translator-internal ones.
 *
 * Success is decided by the retried request, never by inspecting the browser:
 * Anubis's success cookie name is deployment-dynamic.
 */
import { type Fetcher, fetcherFromRequest, looksLikeHTML } from "./base";

/**
 * Injected seam: clear any bot challenge for `url`, leaving whatever success
 * signal the host uses in the default cookie jar.
 */
export type ClearChallenge = (url: string) => Promise<void>;

// How long to let a challenge page's own JavaScript run before destroying the
// browser. Anubis solves its proof-of-work and redirects back within this
// window; a shorter delay just costs another retry round.
const SETTLE_MS = 6000;

// Clear-and-retry rounds before falling through to the ordinary parse error.
const MAX_CLEAR_ATTEMPTS = 3;

// Markers Anubis's challenge page carries.
const ANUBIS_MARKUP = /\/\.within\.website\/|id=["']anubis_challenge["']/;

/**
 * Whether a response is an Anubis challenge page. Pure; gated on an HTML
 * response so ordinary JSON cannot match by accident.
 */
export function isAnubisChallenge(
  contentType: string | null,
  body: string,
): boolean {
  return looksLikeHTML(contentType, body) && ANUBIS_MARKUP.test(body);
}

/** Load `url` in a hidden browser (default cookie jar) and let its JS run. */
export const clearChallengeInBrowser: ClearChallenge = async (url) => {
  const { HiddenBrowser } = ChromeUtils.importESModule(
    "chrome://zotero/content/HiddenBrowser.mjs",
  ) as {
    HiddenBrowser: new (
      options: ZoteroHiddenBrowserOptions,
    ) => ZoteroHiddenBrowser;
  };
  const browser = new HiddenBrowser({
    customUserAgent: Zotero.VersionHeader.getPlainFirefoxUA?.(),
  });
  try {
    await browser.load(url);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  } finally {
    browser.destroy();
  }
};

/** Injectable seam for `makeChallengeFetcher`. */
export interface ChallengeFetcherDeps {
  /** Defaults to `clearChallengeInBrowser`. */
  clearChallenge?: ClearChallenge;
}

/**
 * Decorate the raw request seam so challenged responses are cleared and
 * retried. Detection keys on the response markup, so wrapping a non-Anubis
 * host is a no-op.
 */
export function makeChallengeFetcher(
  rawRequest: Fetcher["request"],
  deps: ChallengeFetcherDeps = {},
): Fetcher {
  const clearChallenge = deps.clearChallenge ?? clearChallengeInBrowser;
  // At most one hidden browser per host at a time; concurrent challenged
  // requests await the same clear instead of spawning N browsers.
  const clearing = new Map<string, Promise<void>>();

  /**
   * The response body for detection. `responseText` is only available for the
   * default text response; the translator import path requests a document, so
   * read the parsed document's markup there.
   */
  function bodyOf(xhr: XMLHttpRequest): string {
    if (xhr.responseType === "document") {
      const doc = xhr.response as Document | null;
      // Trusted Types make outerHTML `string | TrustedHTML`.
      return String(doc?.documentElement?.outerHTML ?? "");
    }
    return xhr.responseText ?? "";
  }

  function isChallenge(xhr: XMLHttpRequest): boolean {
    return isAnubisChallenge(
      xhr.getResponseHeader("content-type"),
      bodyOf(xhr),
    );
  }

  /**
   * Zotero's `UnexpectedStatusException`, which carries the rejected `xmlhttp`.
   * Declared ad hoc here: `zotero-types` does not export the class.
   */
  function isUnexpectedStatusError(
    error: unknown,
  ): error is { xmlhttp: XMLHttpRequest } {
    return (
      !!error &&
      typeof error === "object" &&
      !!(error as { xmlhttp?: XMLHttpRequest }).xmlhttp
    );
  }

  /** A 4xx challenge arrives as a rejected `UnexpectedStatusException`. */
  function isChallengeError(error: unknown): boolean {
    return isUnexpectedStatusError(error) && isChallenge(error.xmlhttp);
  }

  function ensureCleared(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const inFlight = clearing.get(host);
    if (inFlight) return inFlight;
    const task = (async () => {
      // On Zotero 9.0.3+ the retry must look like the browser that cleared the
      // challenge; earlier versions lack the helper and keep the default UA.
      Zotero.VersionHeader.registerPlainUAHost?.(host);
      try {
        await clearChallenge(url);
      } catch (e) {
        // A failed clear is not fatal: the retry still decides, and a
        // persistent failure surfaces as the ordinary parse error.
        ztoolkit.log(`Challenge clearing failed for ${host}:`, String(e));
      }
    })().finally(() => clearing.delete(host));
    clearing.set(host, task);
    return task;
  }

  const request: Fetcher["request"] = async (url, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      // On the final attempt, return/throw the challenge response so the
      // ordinary parse error describes it instead of retrying forever.
      const finalAttempt = attempt >= MAX_CLEAR_ATTEMPTS;
      try {
        const xhr = await rawRequest(url, options);
        if (!isChallenge(xhr) || finalAttempt) return xhr;
      } catch (error) {
        if (!isChallengeError(error) || finalAttempt) throw error;
      }
      await ensureCleared(url);
    }
  };

  return fetcherFromRequest(request);
}
