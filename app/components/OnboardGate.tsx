"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type DeviceClass, detectDeviceFromUA } from "@/lib/device";
import { useFlagBundle } from "@/lib/use-flag-bundle";
import OnboardWizard from "./OnboardWizard";

/**
 * Client gate + loader for /onboard (Rust-core Phase 0).
 *
 * Replaces three server reads:
 *  - the `flag.focus.audience` check that bounced audience-less visitors
 *    to /welcome (now `audienceSet` from GET /api/focus, the field added
 *    in batch 1),
 *  - `flag.onboarding.method.configurator` (shared flag fetch),
 *  - the User-Agent sniff.
 *
 * On the UA: the server sniffed it so the first paint had the right
 * device-specific method cards, and the client then refined the guess
 * via `refineDeviceOnClient`. Detecting from `navigator.userAgent` here
 * reaches the same answer — `lib/device` is pure and client-safe — and
 * the wizard's own refinement pass is unchanged. What's lost is only
 * the correct-cards-in-the-initial-HTML property, which a static export
 * cannot have anyway; the wizard is held back until the values land, so
 * there's no flash of the wrong option either.
 */
export default function OnboardGate() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [initialDevice, setInitialDevice] = useState<DeviceClass | null>(null);
  const flags = useFlagBundle(["flag.onboarding.method.configurator"]);

  useEffect(() => {
    setInitialDevice(
      detectDeviceFromUA(
        typeof navigator === "undefined" ? null : navigator.userAgent
      )
    );
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/focus")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then((json: { audienceSet?: boolean }) => {
        if (!live) {
          return;
        }
        if (json.audienceSet) {
          setAllowed(true);
        } else {
          setAllowed(false);
          router.replace("/welcome");
        }
      })
      .catch(() => {
        // Unreadable focus means "not set yet" — the same bounce the
        // server page performed for an empty setting.
        if (live) {
          setAllowed(false);
          router.replace("/welcome");
        }
      });
    return () => {
      live = false;
    };
  }, [router]);

  if (!(allowed && flags && initialDevice)) {
    return null;
  }
  return (
    <OnboardWizard
      flags={{
        methodConfigurator: flags["flag.onboarding.method.configurator"],
      }}
      initialDevice={initialDevice}
    />
  );
}
