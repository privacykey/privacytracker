/** Wire constants come from Node; predicates are checked by the route oracle. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NOTIFICATION_PREFS } from "../../lib/notification-prefs.ts";
import { TASK_DEFS } from "../../lib/tasks.ts";

const dir = mkdtempSync(join(tmpdir(), "pt-content-meta-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
const { ACTIVITY_TYPES } = await import("../../lib/activity.ts");
writeFileSync(
  new URL("../src/server/content_meta.json", import.meta.url),
  `${JSON.stringify(
    {
      activityTypes: ACTIVITY_TYPES,
      notificationDefaults: DEFAULT_NOTIFICATION_PREFS,
      tasks: TASK_DEFS.map(
        ({ id, route, prerequisites, i18nKey, optInOnly }) => ({
          id,
          route,
          prerequisites,
          i18nKey,
          optInOnly: optInOnly ?? false,
        })
      ),
    },
    null,
    2
  )}\n`
);
const { default: db } = await import("../../lib/db.ts");
db.close();
rmSync(dir, { recursive: true, force: true });
