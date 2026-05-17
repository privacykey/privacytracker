"use client";

/**
 * Boots the client-side diagnostics module on mount. Renders nothing.
 * Mounted in app/layout.tsx so every route inherits the long-task observer,
 * the fetch wrapper, and the rAF-gap monitor without per-page wiring.
 */

import { useEffect } from "react";
import { installClientDiagnostics } from "@/lib/client-diagnostics";

export default function ClientDiagnosticsBoot() {
  useEffect(() => {
    installClientDiagnostics();
  }, []);
  return null;
}
