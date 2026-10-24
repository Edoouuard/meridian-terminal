/** Where the UI settings live in localStorage (lib/uiSettings.ts). Kept apart so the server layout can import the boot script. */
export const SETTINGS_KEY = "meridian:ui:v1";

/** Runs in <head> before paint so a light-theme user never sees a dark flash. */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})||"{}");var t=s.theme==="light"||s.theme==="dark"?s.theme:s.theme==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;document.documentElement.dataset.text=s.textSize==="large"?"large":"normal";}catch(e){document.documentElement.dataset.theme="dark";}})();`;
