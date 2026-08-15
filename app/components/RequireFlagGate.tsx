"use client";

import { notFound } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Client-side replacement for the server-side page gate
 * `resolveFlagFromDb(key) !== "on" → notFound()`.
 *
 * Phase 0 of the Rust-core migration (core/README.md on the rust-core
 * branch): pages stop reading the flag resolver in a server component
 * and ask `GET /api/feature-flags` instead, which returns the same
 * resolved values through the same resolver chain.
 *
 * `notFound()` works in a client component, but only when thrown during
 * render — so the fetch result is held in state and the throw happens on
 * the following render. Children stay unmounted until the flag resolves
 * on, so a gated-off visitor never sees the page flash in first.
 *
 * A failed flag read renders the 404 rather than the page: these gates
 * exist to hide surfaces that shouldn't exist for this install, and
 * "couldn't tell" should not fall open.
 */
export default function RequireFlagGate({
  children,
  flag,
}: {
  children: React.ReactNode;
  flag: string;
}) {
  const [state, setState] = useState<"pending" | "on" | "off">("pending");

  useEffect(() => {
    let live = true;
    fetch("/api/feature-flags")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then((json: { flags?: { key: string; currentValue: string }[] }) => {
        if (live) {
          // `flags` is an array of per-key records; `currentValue` is the
          // resolved value — the same thing resolveFlagFromDb returned.
          const entry = json.flags?.find((f) => f.key === flag);
          setState(entry?.currentValue === "on" ? "on" : "off");
        }
      })
      .catch(() => {
        if (live) {
          setState("off");
        }
      });
    return () => {
      live = false;
    };
  }, [flag]);

  if (state === "off") {
    notFound();
  }
  return state === "on" ? children : null;
}
