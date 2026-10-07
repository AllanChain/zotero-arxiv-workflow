/**
 * Zotero APIs used by browser-based challenge handling that
 * `zotero-types@4.1.3` does not declare yet. Signatures mirror Zotero's own
 * source (`chrome/content/zotero/...`); delete members here as upstream
 * catches up.
 */

/** Options of `new HiddenBrowser(...)` from `HiddenBrowser.mjs`. */
interface ZoteroHiddenBrowserOptions {
  /** Added in Zotero 9.0.3; ignored by Zotero 8. */
  customUserAgent?: string;
}

/** The subset of `HiddenBrowser` the challenge clearer uses. */
interface ZoteroHiddenBrowser {
  load(
    source: string,
    options?: { requireSuccessfulStatus?: boolean },
  ): Promise<boolean>;
  destroy(): void;
}

declare namespace Zotero {
  /**
   * Present since Zotero 7; the plain-UA helpers below were added in Zotero
   * 9.0.3, so they stay optional for Zotero 8 and earlier 9.
   */
  const VersionHeader: {
    /** Send the plain Firefox UA (no `Zotero/<version>`) to `host`. */
    registerPlainUAHost?(host: string): void;
    /** The plain Firefox UA a hidden browser is loaded with. */
    getPlainFirefoxUA?(): string;
  };
}
