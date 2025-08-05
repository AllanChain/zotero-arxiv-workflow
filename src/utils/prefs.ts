import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

export function registerPrefObserver<K extends keyof PluginPrefsMap>(
  key: K,
  handler: (value: PluginPrefsMap[K]) => void,
) {
  const sym = Zotero.Prefs.registerObserver(
    `${PREFS_PREFIX}.${key}`,
    handler,
    true,
  );
  return () => Zotero.Prefs.unregisterObserver(sym);
}

export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}
