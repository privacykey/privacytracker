import type { Metadata } from "next";
import Nav from "../../../components/Nav";
import RequireAppsGate from "../../../components/RequireAppsGate";
import SettingsView from "../../../components/SettingsView";
import YourFocusCard from "../../../components/YourFocusCard";

export const metadata: Metadata = {
  title: "You \u00b7 Settings",
  description:
    "Focus, language, privacy and accessibility profiles, and notifications.",
};

/**
 * Settings \u2192 You.
 *
 * One of the four group routes derived from the section taxonomy in
 * app/components/settings/section-groups.ts. Renders SettingsView in
 * `viewMode="you"` so the state machine stays in one place \u2014 the
 * same arrangement the import-history route has used since before the split.
 */
export default function SettingsYouPage() {
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsView focusCard={<YourFocusCard />} viewMode="you" />
      </RequireAppsGate>
    </>
  );
}
