"use client";

import { useEffect, useState } from "react";
import type { PrivacyProfile } from "@/lib/privacy-profile";
import { useFlagBundle } from "@/lib/use-flag-bundle";
import ShortlistView, { type ShortlistFlagState } from "./ShortlistView";

/**
 * Client loader for the Shortlist page (Rust-core Phase 0).
 *
 * Replaces three server reads with their existing API twins: the group
 * list (`GET /api/shortlist`), the saved privacy profile
 * (`GET /api/privacy-profile`), and eleven `flag.shortlist.*`
 * resolutions (through the shared `useFlagBundle` fetch, so the page
 * gate above and this bundle cost one request between them).
 *
 * Both data fetches are best-effort exactly as the server page's
 * try/catch blocks were: a failure renders the empty state rather than
 * breaking the page.
 */

const SHORTLIST_FLAG_KEYS = [
  "flag.shortlist.actions.remove",
  "flag.shortlist.actions.preview",
  "flag.shortlist.actions.share",
  "flag.shortlist.actions.export",
  "flag.shortlist.actions.print",
  "flag.shortlist.actions.reset",
  "flag.shortlist.actions.undo",
  "flag.shortlist.detailed_view",
  "flag.shortlist.live_badge_prefetch",
  "flag.shortlist.profile_mismatch_pill",
  "flag.shortlist.installed_grouping",
] as const;

type Groups = Parameters<typeof ShortlistView>[0]["initialGroups"];

export default function ShortlistLoader() {
  const [groups, setGroups] = useState<Groups | null>(null);
  const [profile, setProfile] = useState<PrivacyProfile | null>(null);
  const flagValues = useFlagBundle(SHORTLIST_FLAG_KEYS);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/shortlist")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/privacy-profile")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]).then(([shortlist, profileJson]) => {
      if (!live) {
        return;
      }
      setGroups(shortlist?.groups ?? []);
      setProfile(profileJson?.profile ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!(groups && flagValues)) {
    return null;
  }

  const flags: ShortlistFlagState = {
    actionsRemove: flagValues["flag.shortlist.actions.remove"],
    actionsPreview: flagValues["flag.shortlist.actions.preview"],
    actionsShare: flagValues["flag.shortlist.actions.share"],
    actionsExport: flagValues["flag.shortlist.actions.export"],
    actionsPrint: flagValues["flag.shortlist.actions.print"],
    actionsReset: flagValues["flag.shortlist.actions.reset"],
    actionsUndo: flagValues["flag.shortlist.actions.undo"],
    detailedView: flagValues["flag.shortlist.detailed_view"],
    liveBadgePrefetch: flagValues["flag.shortlist.live_badge_prefetch"],
    profileMismatchPill: flagValues["flag.shortlist.profile_mismatch_pill"],
    installedGrouping: flagValues["flag.shortlist.installed_grouping"],
  };

  return (
    <ShortlistView
      flags={flags}
      initialGroups={groups}
      initialProfile={profile}
    />
  );
}
