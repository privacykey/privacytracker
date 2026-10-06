"use client";

/**
 * Desktop-only: hands every external link to the system browser.
 *
 * The Tauri webview has no tabs, and a link with `target="_blank"` asks
 * it for a new window that nothing provides, so on the desktop every
 * "Read more at Apple" link did nothing at all (the label definitions
 * page was where it was noticed; the same `<a target="_blank">` is on
 * about thirty pages). A capture-phase click listener catches the click
 * before any component does, decides with `externalHttpUrl` whether the
 * destination leaves the app, and opens it through the shell plugin,
 * whose `open` scope in src-tauri/tauri.conf.json allows http(s).
 *
 * Same-origin links, fragments, downloads and non-http schemes are left
 * to the browser. Outside Tauri the listener is never installed, so the
 * web and Docker builds keep their new tab. Rendered once from AppChrome.
 */

import { useEffect } from "react";
import { externalHttpUrl, isDesktop, openExternal } from "../../lib/desktop";

export default function ExternalLinkBridge() {
  useEffect(() => {
    if (!isDesktop()) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const url = externalHttpUrl(anchor.href, window.location.origin);
      if (!url) {
        return;
      }
      event.preventDefault();
      void openExternal(url);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
