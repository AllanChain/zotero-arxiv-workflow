import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { getPref } from "./utils/prefs";
import { arXivMerge } from "./modules/arxiv-merge";
import { arXivUpdate } from "./modules/arxiv-update";
import {
  UpdateManager,
  importPublishedVersion,
} from "./modules/arxiv-update/manager";
import { PaperFinder } from "./modules/arxiv-update/paper-finder";
import { PreferPDF } from "./modules/prefer-pdf";
import { UpdatePDF } from "./modules/update-pdf";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    arXivUpdate: {
      manager: UpdateManager;
      unregisterObserver?: () => void;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api = {
    merge: arXivMerge.merge,
    arXivUpdate: arXivUpdate.update,
    preferPDF: PreferPDF.prefer,
    updatePDF: UpdatePDF.update,
  };

  constructor() {
    const ztoolkit = createZToolkit();
    const log = (...args: unknown[]) => ztoolkit.log(...args);
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit,
      arXivUpdate: {
        manager: new UpdateManager({
          concurrency: getPref("update.concurrency"),
          paperFinder: {
            find: (item) => new PaperFinder(item, log).find(),
            arXivPDF: (item) => new PaperFinder(item, log).arXivPDF(),
          },
          importPublished: importPublishedVersion,
          log,
        }),
      },
    };
    this.hooks = hooks;
  }
}

export default Addon;
