"use client";

import { useEffect, useState } from "react";
import { type AgeBandKey, isValidAgeBand } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import { type FocusWorkflow, isFocusWorkflow } from "@/lib/focus-workflow";
import WelcomeSplash from "./WelcomeSplash";

/**
 * Client loader for /welcome (Rust-core Phase 0).
 *
 * The page read the active focus, the raw `flag.focus.audience` setting
 * and the stored child age band from the DB, then handed WelcomeSplash
 * a pre-filled focus (or null for a first-time visitor). All of it comes
 * from `GET /api/focus` now — including `audienceSet`, the field added
 * in batch 1 for exactly this distinction: `getActiveFocus()` returns
 * `self` as a default-when-unset, so "has the user ever chosen?" needs
 * the raw setting.
 *
 * The splash is held until the fetch resolves so the goal cards don't
 * paint unhighlighted and then flip on a returning user.
 */

interface InitialFocus {
  accessibility: boolean;
  audience: Audience;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  workflow: FocusWorkflow;
}

export default function WelcomeSplashLoader() {
  const [ready, setReady] = useState(false);
  const [initialFocus, setInitialFocus] = useState<InitialFocus | null>(null);
  const [childAgeBand, setChildAgeBand] = useState<AgeBandKey | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/focus")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then(
        (json: {
          accessibility?: boolean;
          audience?: string;
          audienceSet?: boolean;
          childAgeBand?: string | null;
          cleanup?: boolean;
          minimal?: boolean;
          monitor?: boolean;
          workflow?: string;
        }) => {
          if (!live) {
            return;
          }
          if (json.audienceSet) {
            setInitialFocus({
              audience: (json.audience ?? "self") as Audience,
              monitor: Boolean(json.monitor),
              cleanup: Boolean(json.cleanup),
              minimal: Boolean(json.minimal),
              accessibility: Boolean(json.accessibility),
              workflow: isFocusWorkflow(json.workflow ?? "")
                ? (json.workflow as FocusWorkflow)
                : "custom",
            });
          }
          setChildAgeBand(
            isValidAgeBand(json.childAgeBand ?? "")
              ? (json.childAgeBand as AgeBandKey)
              : null
          );
          setReady(true);
        }
      )
      .catch((error) => {
        // A failed read means "first-time visitor" — the same result the
        // server page produced when its try/catch swallowed a DB error.
        console.warn("[welcome] focus load failed:", error);
        if (live) {
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  if (!ready) {
    return null;
  }
  return (
    <WelcomeSplash
      initialChildAgeBand={childAgeBand}
      initialFocus={initialFocus}
    />
  );
}
