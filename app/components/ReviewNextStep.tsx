"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useResolvedFlag } from "@/lib/use-flag-bundle";
import type { VerdictValue } from "@/lib/verdict-types";
import "./focus-overview.css";

export function ReviewNextStep({
  appId,
  verdict,
  onChange,
}: {
  appId: string;
  verdict: VerdictValue | null;
  onChange: () => void;
}) {
  const t = useTranslations("focus_review");
  const canCompare = useResolvedFlag("flag.page.compare");
  const [days, setDays] = useState(7);
  const [until, setUntil] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/verdicts?appId=${encodeURIComponent(appId)}&decision=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (live) {
          setUntil(data.deferredUntil);
          setAccepted(data.accepted === true);
        }
      })
      .catch(() => {
        if (live) {
          setError(true);
        }
      });
    return () => {
      live = false;
    };
  }, [appId, verdict]);
  async function defer(cancel = false) {
    setSaving(true);
    setError(false);
    try {
      const res = await fetch(
        cancel
          ? `/api/verdicts?appId=${encodeURIComponent(appId)}&deferredOnly=1`
          : "/api/verdicts",
        {
          method: cancel ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          ...(cancel
            ? {}
            : { body: JSON.stringify({ appId, deferDays: days }) }),
        }
      );
      if (!res.ok) {
        throw new Error("Save failed");
      }
      const data = await res.json();
      setUntil(data.deferredUntil ?? null);
      onChange();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="review-next-step">
      {verdict === "safe" && <p>{t(accepted ? "accepted" : "keep_hint")}</p>}
      {verdict === "replace" && (
        <div>
          <p>{t("replace_hint")}</p>
          {canCompare && (
            <Link
              className="btn btn-primary"
              href={`/dashboard/compare?a=id:${encodeURIComponent(appId)}&from=review`}
            >
              {t("find_compare")}
            </Link>
          )}
        </div>
      )}
      <div className="review-later-controls">
        <label>
          {t("remind_in")}{" "}
          <select
            disabled={saving}
            onChange={(e) => setDays(Number(e.target.value))}
            value={days}
          >
            {[1, 7, 30].map((day) => (
              <option key={day} value={day}>
                {t("days", { count: day })}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-secondary"
          disabled={saving}
          onClick={() => defer()}
          type="button"
        >
          {t(saving ? "saving" : "later")}
        </button>
      </div>
      {until && (
        <div role="status">
          <p>
            {t("scheduled", { date: new Date(until).toLocaleDateString() })}
          </p>
          <button
            className="btn btn-ghost btn-sm"
            disabled={saving}
            onClick={() => defer(true)}
            type="button"
          >
            {t("cancel")}
          </button>
        </div>
      )}
      {error && <p role="alert">{t("error")}</p>}
    </div>
  );
}
