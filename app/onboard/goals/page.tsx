"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Legacy alias for the goals step, which now lives on /welcome.
 *
 * Rust-core Phase 0: this was a server `redirect()`. A static export
 * can't serve one, so the forward happens client-side — the same shape
 * the root landing page uses. Metadata moves to the client with the
 * layout batch (see the ledger test's note), so this file keeps no
 * server exports at all.
 */
export default function OnboardGoalsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/welcome");
  }, [router]);
  return null;
}
