import db from "../lib/db";
import { START_OVER_TABLES_TO_TRUNCATE } from "../lib/reset-tables";

export function resetTestDb(): void {
  for (const table of START_OVER_TABLES_TO_TRUNCATE) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM app_settings").run();
}

export function seedTrackedApp(input: {
  id: string;
  name?: string;
  url?: string;
  developer?: string;
  privacyPolicyUrl?: string;
}): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO apps (
      id, name, url, iconUrl, developer, privacyPolicyUrl, firstSeen, lastSynced, changeCount
    )
    VALUES (?, ?, ?, '', ?, ?, ?, ?, 0)
  `).run(
    input.id,
    input.name ?? "Fixture App",
    input.url ?? `https://apps.apple.com/us/app/fixture/id${input.id}`,
    input.developer ?? "Fixture Developer",
    input.privacyPolicyUrl ?? "",
    now,
    now
  );
}

export function seedPrivacyCategory(input: {
  appId: string;
  typeIdentifier: string;
  typeTitle: string;
  categoryIdentifier: string;
  categoryTitle: string;
}): void {
  const typeId = `${input.appId}_${input.typeIdentifier}`;
  db.prepare(`
    INSERT OR IGNORE INTO privacy_types (id, app_id, identifier, title, detail)
    VALUES (?, ?, ?, ?, '')
  `).run(typeId, input.appId, input.typeIdentifier, input.typeTitle);

  db.prepare(`
    INSERT OR IGNORE INTO privacy_categories (id, type_id, identifier, title)
    VALUES (?, ?, ?, ?)
  `).run(
    `${typeId}_${input.categoryIdentifier}`,
    typeId,
    input.categoryIdentifier,
    input.categoryTitle
  );
}

export function seedAccessibilityFeature(input: {
  appId: string;
  identifier: string;
  title: string;
  description?: string | null;
  iconTemplate?: string | null;
}): void {
  db.prepare(`
    INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `${input.appId}_${input.identifier}`,
    input.appId,
    input.identifier,
    input.title,
    input.description ?? null,
    input.iconTemplate ?? null
  );
}
