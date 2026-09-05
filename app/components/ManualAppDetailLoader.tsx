"use client";

import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import ManualAppDetailView from "./ManualAppDetailView";

/**
 * Client loader for /manual-apps/[id] (Rust-core Phase 0).
 *
 * The page used to read four things server-side — the app row, its
 * event history, the current policy version, and the source metadata —
 * and 404 on an unknown id. `GET /api/manual-apps/[id]` now returns all
 * four in one payload (the `events` / `currentVersion` / `meta` fields
 * were added alongside this conversion; `app` was already there).
 *
 * It also sets the document title, which `generateMetadata` used to do
 * by reading the app name from the DB. Dynamic routes can't prerender a
 * per-id title in a static export anyway — there's no way to enumerate
 * ids at build time — so the title belongs on the client for this route
 * regardless of the layout batch.
 */

type Payload = Omit<Parameters<typeof ManualAppDetailView>[0], never>;

export default function ManualAppDetailLoader() {
  const tMeta = useTranslations("page_metadata");
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<Payload | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) {
      return;
    }
    let live = true;
    fetch(`/api/manual-apps/${encodeURIComponent(id)}`)
      .then((res) => {
        if (res.status === 404) {
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`HTTP ${res.status}`));
      })
      .then((json: Payload | null) => {
        if (!live) {
          return;
        }
        if (json) {
          setData(json);
          // Localized ICU pattern — the same key generateMetadata used
          // before this page became a shell; the hard-coded English
          // template it briefly had dropped the zh title.
          document.title = tMeta("manual_app_detail_title", {
            name: json.app.name,
          });
        } else {
          setMissing(true);
        }
      })
      .catch((error) => {
        console.warn("[manual-app-detail] load failed:", error);
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (missing) {
    notFound();
  }
  if (!data) {
    return null;
  }
  return (
    <ManualAppDetailView
      app={data.app}
      currentVersion={data.currentVersion}
      events={data.events}
      meta={data.meta}
    />
  );
}
