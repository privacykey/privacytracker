"use client";

/**
 * Language picker card. Lives alongside the other personalisation
 * controls in the "You" group rather than in the global footer where it
 * started. `LocaleSwitcher` fetches the active locale from `/api/locale`
 * itself — this card is only chrome around it.
 *
 * Anchor id `language` matches the SettingsSidebar entry; see
 * ./README.md for why the id and class names must stay as they are.
 */

import { useTranslations } from "next-intl";
import LocaleSwitcher from "../LocaleSwitcher";

export default function LanguageSection() {
  const tSections = useTranslations("settings.sections");
  const tSettings = useTranslations("settings");

  return (
    <div className="settings-section" id="language">
      <h2 className="settings-section-title">{tSections("language")}</h2>
      <p className="settings-section-subtitle">
        {tSettings("language_section.subtitle")}
      </p>
      <LocaleSwitcher />
    </div>
  );
}
