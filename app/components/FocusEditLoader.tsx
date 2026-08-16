"use client";

import { useEffect, useState } from "react";
import { type AgeBandKey, isValidAgeBand } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import { type FocusWorkflow, isFocusWorkflow } from "@/lib/focus-workflow";
import FocusEditForm from "./FocusEditForm";

/**
 * Client loader for the focus editor (Rust-core Phase 0).
 *
 * `/dashboard/settings/focus` used to read the active focus straight
 * from the DB in its server component and pass six props into
 * FocusEditForm. This fetches the same values from `GET /api/focus` —
 * which already returned all of them — and renders the form once they
 * land, so the form itself is untouched.
 *
 * The form is held back until the fetch resolves: it stages edits from
 * its initial props, so mounting it with placeholder values and then
 * swapping them would either be ignored or clobber what the user had
 * already touched.
 *
 * The modules imported here (`age-rating`, `feature-flag-rules`,
 * `focus-workflow`) are the client-safe pure-data half of lib/ — the
 * same ones FocusEditForm itself imports.
 */

interface FocusResponse {
  accessibility?: boolean;
  audience?: string;
  childAgeBand?: string | null;
  cleanup?: boolean;
  minimal?: boolean;
  monitor?: boolean;
  workflow?: string;
}

interface FocusState {
  accessibility: boolean;
  audience: Audience;
  childAgeBand: AgeBandKey | null;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  workflow: FocusWorkflow;
}

const VALID_AUDIENCES: readonly string[] = ["self", "loved_one", "guardian"];

export default function FocusEditLoader() {
  const [focus, setFocus] = useState<FocusState | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/focus")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then((json: FocusResponse) => {
        if (!live) {
          return;
        }
        setFocus({
          // Default to `self` if audience was somehow blank — the
          // radiogroup needs an initial value. Same fallback the server
          // page applied.
          audience: (VALID_AUDIENCES.includes(json.audience ?? "")
            ? json.audience
            : "self") as Audience,
          monitor: Boolean(json.monitor),
          cleanup: Boolean(json.cleanup),
          minimal: Boolean(json.minimal),
          accessibility: Boolean(json.accessibility),
          childAgeBand: isValidAgeBand(json.childAgeBand ?? "")
            ? (json.childAgeBand as AgeBandKey)
            : null,
          workflow: isFocusWorkflow(json.workflow ?? "")
            ? (json.workflow as FocusWorkflow)
            : "custom",
        });
      })
      .catch((error) => {
        console.warn("[focus-edit] load failed:", error);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!focus) {
    return null;
  }
  return (
    <FocusEditForm
      initialAccessibility={focus.accessibility}
      initialAudience={focus.audience}
      initialChildAgeBand={focus.childAgeBand}
      initialDeclutter={focus.cleanup}
      initialMinimal={focus.minimal}
      initialUnderstand={focus.monitor}
      initialWorkflow={focus.workflow}
    />
  );
}
