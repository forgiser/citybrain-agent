import { spawn } from "node:child_process";

export const QGIS_LTR_DOWNLOAD_URL = "https://qgis.org/download/";

/**
 * Best-effort browser launch for install guidance. Never throws; callers show
 * a manual-open hint when this returns false.
 */
export function openInBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/d", "/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
