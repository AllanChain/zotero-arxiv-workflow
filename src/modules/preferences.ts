import { catchError } from "./error";
import { getString } from "../utils/locale";
import { config } from "../../package.json";

export class Preferences {
  @catchError
  static registerPreferences() {
    ztoolkit.PreferencePane.register({
      pluginID: config.addonID,
      src: rootURI + "chrome/content/preferences.xhtml",
      stylesheets: [`chrome://${config.addonRef}/content/preferences.css`],
      label: getString("prefs-title"),
      image: `chrome://${config.addonRef}/content/icons/favicon.svg`,
      defaultXUL: true,
    });
  }
}
