import { config } from "../package.json";
import PQueue from "p-queue";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { UpdateWindowData } from "./types";
import { getPref } from "./utils/prefs";
import { arXivMerge } from "./modules/arxiv-merge";
import { arXivUpdate } from "./modules/arxiv-update";
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
    arXivUpdate: UpdateWindowData;
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
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      arXivUpdate: {
        tableData: [],
        queue: new PQueue({ concurrency: getPref("update.concurrency") }),
      },
    };
    this.hooks = hooks;
  }
}

export default Addon;
