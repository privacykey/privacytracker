"use client";

/**
 * Settings → Companion: pair the privacytracker iPhone app with this
 * instance (privacykey/privacytracker-ios).
 *
 * A pairing is one read-only token (lib/companion.ts): it can read the app
 * list, each app's labels and history and the change feed, and nothing
 * else. The token exists in plaintext only in the reply to "Make a pairing
 * code"; this card turns it into a QR code and a copyable link, and drops
 * it when the panel closes. The server keeps only its hash.
 *
 * Where the phone should connect:
 *   - inside the desktop app (`lan.supported`), the Wi-Fi listener: a
 *     second, TLS-only port serving the companion routes, whose certificate
 *     fingerprint rides in the code so the phone can pin it. It has to be
 *     switched on first; a code pointing at 127.0.0.1 is useless to a phone.
 *   - everywhere else (Docker, a server), the address this page is open
 *     at. When that is loopback the card says the phone can't reach it.
 *
 * The outer `flag.settings.admin.companion` gate stays in SettingsView.
 * Anchor id `companion` matches the SettingsSidebar entry.
 */

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { buildPairingLink } from "@/lib/companion-link";
import CompanionQrCode from "./CompanionQrCode";
import "./companion-section.css";

interface Device {
  claimExpiresAt: number;
  createdAt: number;
  firstUsedAt: number | null;
  id: string;
  label: string;
  lastUsedAt: number | null;
  scope: string;
  state: "waiting" | "active" | "expired";
}

interface CompanionPayload {
  claimWindowMs: number;
  devices: Device[];
  instanceName: string;
  maxDevices: number;
}

interface LanPayload {
  addresses: string[];
  enabled: boolean;
  error: string | null;
  fingerprint: string | null;
  port: number | null;
  running: boolean;
  supported: boolean;
}

interface Issued {
  deviceLabel: string;
  expiresAt: number;
  link: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body;
}

export default function CompanionSection({
  showToast,
}: {
  showToast: (message: string) => void;
}) {
  const t = useTranslations("settings.companion_card");
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const format = useFormatter();
  const nameId = useId();
  const labelId = useId();

  const [data, setData] = useState<CompanionPayload | null>(null);
  const [lan, setLan] = useState<LanPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [phoneLabel, setPhoneLabel] = useState("iPhone");
  const [pairing, setPairing] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [companion, lanState] = await Promise.all([
        fetch("/api/companion").then((r) => readJson<CompanionPayload>(r)),
        fetch("/api/companion/lan").then((r) => readJson<LanPayload>(r)),
      ]);
      setData(companion);
      setNameDraft(companion.instanceName);
      setLan(lanState);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a code is on screen, tick so the expiry reads true, and poll the
  // list so the row flips to "Paired" the moment the phone scans it.
  useEffect(() => {
    if (!issued) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      fetch("/api/companion")
        .then((r) => readJson<CompanionPayload>(r))
        .then(setData)
        .catch(() => {
          // The next poll tries again.
        });
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [issued]);

  const pageHost =
    typeof window === "undefined" ? "" : window.location.hostname;
  const pageIsLoopback = LOOPBACK_HOSTS.has(pageHost);
  const lanAddress =
    lan?.addresses.includes(address ?? "") === true
      ? address
      : (lan?.addresses[0] ?? null);

  let baseUrl: string | null = null;
  let fingerprint: string | null = null;
  if (lan?.supported) {
    if (lan.running && lanAddress && lan.port) {
      baseUrl = `https://${lanAddress}:${lan.port}`;
      fingerprint = lan.fingerprint;
    }
  } else if (typeof window !== "undefined") {
    baseUrl = window.location.origin;
  }

  const saveName = async () => {
    setSavingName(true);
    try {
      const next = await fetch("/api/companion", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: nameDraft }),
      }).then((r) => readJson<CompanionPayload>(r));
      setData(next);
      setNameDraft(next.instanceName);
      showToast(t("saved"));
    } catch (error) {
      showToast(t("error_generic", { error: String(error) }));
    } finally {
      setSavingName(false);
    }
  };

  const setLanEnabled = async (enabled: boolean) => {
    setLanBusy(true);
    try {
      const next = await fetch("/api/companion/lan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      }).then((r) => readJson<LanPayload>(r));
      setLan(next);
    } catch (error) {
      showToast(t("error_generic", { error: String(error) }));
    } finally {
      setLanBusy(false);
    }
  };

  const makeCode = async () => {
    if (!(baseUrl && data)) {
      return;
    }
    setPairing(true);
    try {
      const created = await fetch("/api/companion/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: phoneLabel }),
      }).then((r) => readJson<{ device: Device; token: string }>(r));
      setIssued({
        deviceLabel: created.device.label,
        expiresAt: created.device.claimExpiresAt,
        link: buildPairingLink({
          baseUrl,
          fingerprint,
          instanceName: data.instanceName,
          token: created.token,
        }),
      });
      setNow(Date.now());
      await load();
    } catch (error) {
      showToast(t("error_generic", { error: String(error) }));
    } finally {
      setPairing(false);
    }
  };

  const remove = async (device: Device) => {
    try {
      await fetch(`/api/companion/pairings/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      }).then((r) => readJson<{ ok: boolean }>(r));
      setConfirmRemove(null);
      showToast(t("removed", { label: device.label }));
      await load();
    } catch (error) {
      showToast(t("error_generic", { error: String(error) }));
    }
  };

  const copyLink = async () => {
    if (!issued) {
      return;
    }
    try {
      await navigator.clipboard.writeText(issued.link);
      showToast(t("copied"));
    } catch {
      showToast(t("copy_failed"));
    }
  };

  const issuedDevice = issued
    ? data?.devices.find(
        (d) =>
          d.label === issued.deviceLabel &&
          d.claimExpiresAt === issued.expiresAt
      )
    : undefined;
  const secondsLeft = issued
    ? Math.max(0, Math.round((issued.expiresAt - now) / 1000))
    : 0;

  return (
    <div className="settings-section companion-section" id="companion">
      <h2 className="settings-section-title">{tSections("companion")}</h2>
      <p className="settings-section-subtitle">{tSub("companion")}</p>
      <p className="companion-scope-note">{t("scope_note")}</p>

      {loadError && (
        <p className="companion-error" role="alert">
          {t("error_generic", { error: loadError })}
        </p>
      )}

      {data && (
        <>
          <div className="settings-field companion-name">
            <label className="settings-field-label" htmlFor={nameId}>
              {t("instance_name_label")}
            </label>
            <div className="companion-inline">
              <input
                className="settings-input"
                id={nameId}
                maxLength={60}
                onChange={(e) => setNameDraft(e.target.value)}
                value={nameDraft}
              />
              <button
                className="btn btn-secondary"
                disabled={savingName || nameDraft.trim() === data.instanceName}
                onClick={saveName}
                type="button"
              >
                {t("save")}
              </button>
            </div>
            <span className="settings-field-help">
              {t("instance_name_hint")}
            </span>
          </div>

          {lan?.supported && (
            <div className="companion-lan">
              <label className="settings-checkbox-row">
                <input
                  checked={lan.enabled}
                  className="settings-checkbox"
                  disabled={lanBusy}
                  onChange={(e) => setLanEnabled(e.target.checked)}
                  type="checkbox"
                />
                <span>
                  <span className="settings-field-label">{t("lan_title")}</span>
                  <span className="settings-field-help companion-block">
                    {t("lan_body")}
                  </span>
                </span>
              </label>
              <p
                className={`companion-lan-status${lan.running ? " is-on" : ""}`}
                role="status"
              >
                {lan.error
                  ? t("lan_error", { error: lan.error })
                  : lan.running && lanAddress && lan.port
                    ? t("lan_on_at", {
                        url: `https://${lanAddress}:${lan.port}`,
                      })
                    : t("lan_off")}
              </p>
              {lan.running && lan.addresses.length > 1 && (
                <label className="settings-field companion-address">
                  <span className="settings-field-label">
                    {t("lan_address_label")}
                  </span>
                  <select
                    className="settings-input"
                    onChange={(e) => setAddress(e.target.value)}
                    value={lanAddress ?? ""}
                  >
                    {lan.addresses.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <div className="companion-pair">
            <h3 className="companion-subtitle">{t("pair_title")}</h3>
            {lan?.supported && !baseUrl && (
              <p className="companion-note">{t("pair_needs_lan")}</p>
            )}
            {!lan?.supported && pageIsLoopback && (
              <p className="companion-note">
                {t("pair_loopback_warning", { host: pageHost })}
              </p>
            )}
            <div className="companion-inline">
              <label className="companion-visually-hidden" htmlFor={labelId}>
                {t("pair_label")}
              </label>
              <input
                className="settings-input"
                id={labelId}
                maxLength={60}
                onChange={(e) => setPhoneLabel(e.target.value)}
                placeholder={t("pair_label")}
                value={phoneLabel}
              />
              <button
                className="btn btn-primary"
                disabled={
                  pairing || !baseUrl || data.devices.length >= data.maxDevices
                }
                onClick={makeCode}
                type="button"
              >
                {t("pair_button")}
              </button>
            </div>
          </div>

          {issued && (
            <div
              aria-labelledby="companion-qr-title"
              className="companion-qr-panel"
              role="region"
            >
              <CompanionQrCode
                label={t("qr_alt", { label: issued.deviceLabel })}
                value={issued.link}
              />
              <div className="companion-qr-copy">
                <h3 className="companion-subtitle" id="companion-qr-title">
                  {issuedDevice?.state === "active"
                    ? t("qr_scanned", { label: issued.deviceLabel })
                    : t("qr_title")}
                </h3>
                <p>{t("qr_body")}</p>
                <p className="companion-note">{t("qr_secret_note")}</p>
                {issuedDevice?.state !== "active" && (
                  <p className="companion-countdown">
                    {secondsLeft > 0
                      ? t("qr_expires_in", {
                          minutes: Math.floor(secondsLeft / 60),
                          seconds: String(secondsLeft % 60).padStart(2, "0"),
                        })
                      : t("qr_expired")}
                  </p>
                )}
                <div className="companion-inline">
                  <button
                    className="btn btn-secondary"
                    onClick={copyLink}
                    type="button"
                  >
                    {t("copy_link")}
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setIssued(null)}
                    type="button"
                  >
                    {t("qr_done")}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="companion-devices">
            <h3 className="companion-subtitle">{t("devices_title")}</h3>
            {data.devices.length === 0 ? (
              <p className="companion-note">{t("devices_empty")}</p>
            ) : (
              <ul className="companion-device-list">
                {data.devices.map((device) => (
                  <li className="companion-device" key={device.id}>
                    <div className="companion-device-main">
                      <span className="companion-device-label">
                        {device.label}
                      </span>
                      <span
                        className={`companion-state companion-state--${device.state}`}
                      >
                        <span aria-hidden="true">
                          {device.state === "active"
                            ? "✓"
                            : device.state === "waiting"
                              ? "…"
                              : "✕"}
                        </span>{" "}
                        {t(`state_${device.state}`)}
                      </span>
                      <span className="companion-device-meta">
                        {t("paired_on", {
                          date: format.dateTime(new Date(device.createdAt), {
                            dateStyle: "medium",
                          }),
                        })}
                        {" · "}
                        {device.lastUsedAt
                          ? t("last_used", {
                              relative: format.relativeTime(
                                new Date(device.lastUsedAt),
                                now
                              ),
                            })
                          : t("never_used")}
                      </span>
                    </div>
                    {confirmRemove === device.id ? (
                      <div className="companion-confirm" role="group">
                        <span>
                          {t("remove_confirm", { label: device.label })}
                        </span>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => remove(device)}
                          type="button"
                        >
                          {t("remove")}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setConfirmRemove(null)}
                          type="button"
                        >
                          {t("cancel")}
                        </button>
                      </div>
                    ) : (
                      <button
                        aria-label={t("remove_aria", { label: device.label })}
                        className="btn btn-secondary btn-sm"
                        onClick={() => setConfirmRemove(device.id)}
                        type="button"
                      >
                        {t("remove")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
