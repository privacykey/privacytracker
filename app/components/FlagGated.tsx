"use client";

import type { FlagKey } from "@/lib/feature-flag-rules";
import { useResolvedFlag } from "@/lib/use-flag-bundle";

/**
 * Renders its children only while `flag` resolves `on` — the inline
 * content counterpart to RequireFlagGate (which 404s the whole page).
 *
 * Rust-core Phase 0: server components did this with
 * `resolveFlagFromDb(key) === "on" && <p>…</p>`. Wrapping the block in
 * this component keeps the surrounding markup untouched, which matters
 * on the big static content pages where extracting a client component
 * would mean moving hundreds of lines.
 *
 * Nothing renders while the value is loading or when the flag is off,
 * matching the server behaviour for a flag that is off by default; the
 * shared `useFlagBundle` fetch means this costs no extra request.
 */
export default function FlagGated({
  children,
  flag,
}: {
  children: React.ReactNode;
  flag: FlagKey;
}) {
  return useResolvedFlag(flag) ? children : null;
}
