"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeScope,
  expandScope,
  groupDevicesByOwner,
  SCOPE_ALL,
  scopeOwnerAudience,
  scopeOwnerLabel,
  toggleScopeDevice,
  UNASSIGNED_OWNER,
  UNATTACHED_ID,
} from "@/lib/device-scope";
import { useFlagBundle, useFlagBundleStatus } from "@/lib/use-flag-bundle";
import DeviceGlyph, { AllDevicesGlyph } from "./DeviceGlyph";
import { useDeviceScope } from "./DeviceScopeProvider";
import "./DeviceScopePicker.css";

/**
 * Nav control naming which device (or devices) the app is currently
 * showing, and letting the user change it.
 *
 * This exists because "family mode" installs hold apps from several
 * phones, and until now the only device control was a single-select
 * dropdown inside the apps-grid toolbar. Everything else — dashboard
 * counts, the review queue behind "delete apps off a phone", notes —
 * spoke for the whole fleet without saying so, which meant a user
 * helping a relative could be deep in a removal workflow with no
 * on-screen answer to "whose phone is this?".
 *
 * A `<select>` can't do the job: the requirement is "show all, or show
 * whichever ones I pick", which is multi-select, and native multi-selects
 * are unusable in a nav bar. So this is a popover of checkbox rows —
 * `menuitemcheckbox`, which is the role that actually matches "a menu of
 * independently-togglable options" and gets the checked state announced.
 *
 * The popover deliberately stays OPEN while toggling. Picking two of
 * three devices is the motivating case; closing after the first tick
 * would make it a two-trip operation.
 */
const FLAG_KEYS = ["flag.nav.device_scope"] as const;

export default function DeviceScopePicker({
  /** Renders trigger text as icon-only. The nav sets this at its
   *  `compact` width tier, where the full label doesn't fit. */
  compact = false,
  /**
   * Set when the picker is rendered INSIDE an element with
   * `role="menu"` — which the nav's mobile drawer is.
   *
   * A `role="menu"` may only own menuitem-ish children, so a plain
   * button in there is an `aria-required-children` violation (axe rates
   * it critical, and the repo's a11y spec catches it). As a menuitem
   * with `aria-haspopup` opening its own menu, the control is a
   * submenu trigger, which is exactly what it behaves like.
   */
  inMenu = false,
}: {
  compact?: boolean;
  inMenu?: boolean;
}) {
  const t = useTranslations("device_scope");
  // `ready` isn't read: `devices` is empty until the fetch lands, which
  // is the same signal and one fewer thing to keep in sync.
  const { audience, devices, requestAudience, scope, setAudience, setScope } =
    useDeviceScope();
  // The switch prompt below needs the focus audience, which the provider
  // reads only on request. Ask once there is a device to pick.
  const hasDevices = devices.length > 0;
  useEffect(() => {
    if (hasDevices) {
      requestAudience();
    }
  }, [hasDevices, requestAudience]);
  // Self-gated rather than gated by a prop from Nav: almost every page
  // renders `<Nav />` with no flags at all, so a prop would resolve to
  // its `true` default nearly everywhere and the flag would look wired
  // while doing nothing. Reading the shared bundle here means one gate
  // that actually holds. Fails OPEN, like the rest of the chrome — an
  // unreachable flag endpoint shouldn't strip the nav.
  const flags = useFlagBundle(FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();
  const flagOn = failedToLoad || !flags || flags["flag.nav.device_scope"];
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices]);
  const selection = useMemo(
    () => expandScope(scope, deviceIds),
    [scope, deviceIds]
  );
  const description = useMemo(
    () => describeScope(scope, devices),
    [scope, devices]
  );

  // Rows are grouped by owner when the user has told us who owns what.
  // With no ownership recorded anywhere this collapses to a single
  // unassigned group, and the headings are suppressed — an install with
  // one owner shouldn't grow a "whose?" heading it never asked for.
  const ownerGroups = useMemo(() => groupDevicesByOwner(devices), [devices]);
  const showOwnerHeadings =
    ownerGroups.length > 1 || ownerGroups[0]?.key !== UNASSIGNED_OWNER;

  /**
   * The focus-switch prompt.
   *
   * Appears only when the scope unambiguously resolves to ONE owner
   * whose audience disagrees with the focus currently in effect — i.e.
   * "you are looking at Mum's iPad while set up to work on your own
   * apps". `scopeOwnerAudience` is strict about this (see its comment):
   * a mixed selection, an unstated owner, or a scope that also includes
   * the unattached bucket all yield null.
   *
   * It is a SUGGESTION, never automatic. Switching audience rearranges
   * which features the whole app shows, and doing that behind the user's
   * back because they clicked a device filter would be a far worse
   * surprise than the mismatch it fixes.
   */
  const suggestedAudience = useMemo(
    () => scopeOwnerAudience(scope, devices),
    [scope, devices]
  );
  const ownerName = useMemo(
    () => scopeOwnerLabel(scope, devices),
    [scope, devices]
  );
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const promptKey =
    suggestedAudience && audience && suggestedAudience !== audience
      ? `${scope.deviceIds.join(",")}:${suggestedAudience}`
      : null;
  const showAudiencePrompt =
    promptKey !== null && dismissedPrompt !== promptKey;

  // Apps with no device link at all (manual + CSV imports). Only worth a
  // row when some exist — but the provider's device list doesn't carry
  // that count, so the row is offered whenever there is more than one
  // way to slice the fleet and suppressed on a clean single-device
  // install where it would only be confusing.
  const showUnattachedRow = devices.length > 0;

  /**
   * Render from ONE device, not two.
   *
   * The instinct is "a one-device install has nothing to choose between,
   * so hide it" — and that is what the grid's old dropdown tried, until
   * it turned out that users who had just imported expected to see WHICH
   * device the list was showing, and the silent hide read as the feature
   * being broken (the reasoning is preserved in AppGrid's history). A
   * single-device install also still has a real choice: that device
   * versus the apps tied to no device at all.
   *
   * `devices` is empty until the fetch lands, so this doubles as the
   * "don't flash a picker before we know" guard. Zero devices — a fresh
   * install, or one whose apps all predate device records — renders
   * nothing.
   */
  const hasChoice = devices.length > 0;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Escape closes and returns focus; pointer-down outside closes without
  // stealing it. Same pair the nav drawer uses.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  // Roving arrow-key movement across the rows. Not a focus trap — this is
  // a menu, not a modal dialog, so Tab must still walk out of it into the
  // rest of the nav.
  const onMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-scope-row]"
      ) ?? []
    );
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (index + delta + items.length) % items.length;
    items[next]?.focus();
  }, []);

  const triggerLabel = (() => {
    if (description.kind === "single" && description.name) {
      return description.name;
    }
    if (description.kind === "unattached") {
      return t("unattached_label");
    }
    if (description.kind === "multi") {
      return t("multi_label", { count: description.count });
    }
    return t("all_label");
  })();

  if (!(flagOn && hasChoice)) {
    return null;
  }

  return (
    <div className="device-scope-wrap">
      <button
        aria-expanded={open}
        aria-haspopup="true"
        // The visible label is a bare device name; on its own that reads
        // as an unexplained proper noun to a screen-reader user. Prefix
        // what the control actually does.
        aria-label={t("trigger_aria", { scope: triggerLabel })}
        className={`device-scope-trigger ${open ? "is-open" : ""} ${
          description.kind === "all" ? "" : "is-scoped"
        }`}
        data-flag-target="flag.nav.device_scope"
        onClick={() => setOpen((v) => !v)}
        ref={triggerRef}
        role={inMenu ? "menuitem" : undefined}
        type="button"
      >
        {description.device ? (
          <DeviceGlyph
            className="device-scope-trigger-icon"
            device={description.device}
          />
        ) : (
          <AllDevicesGlyph className="device-scope-trigger-icon" />
        )}
        {!compact && (
          <span className="device-scope-trigger-label">{triggerLabel}</span>
        )}
        <span aria-hidden="true" className="device-scope-caret">
          ▾
        </span>
      </button>

      {open && (
        <div
          aria-label={t("menu_aria")}
          className="device-scope-popover"
          onKeyDown={onMenuKeyDown}
          ref={popoverRef}
          role="menu"
        >
          <p className="device-scope-help">{t("help")}</p>

          <button
            aria-checked={scope.mode === "all"}
            className={`device-scope-row device-scope-row-all ${
              scope.mode === "all" ? "is-checked" : ""
            }`}
            data-scope-row=""
            onClick={() => setScope({ ...SCOPE_ALL })}
            role="menuitemcheckbox"
            type="button"
          >
            <span aria-hidden="true" className="device-scope-check">
              {scope.mode === "all" ? "✓" : ""}
            </span>
            <AllDevicesGlyph className="device-scope-row-icon" />
            <span className="device-scope-row-text">
              <span className="device-scope-row-name">{t("all_label")}</span>
              <span className="device-scope-row-sub">
                {t("all_sub", { count: devices.length })}
              </span>
            </span>
          </button>

          {/* Decorative rule. Deliberately NOT role="separator": that
              role expects an orientation/value contract meant for
              splitters, and a screen reader announcing "separator"
              between menu rows adds nothing. */}
          <div aria-hidden="true" className="device-scope-divider" />

          {ownerGroups.map((group) => (
            <div className="device-scope-group" key={group.key}>
              {/* Owner heading. Suppressed entirely when no device has an
                  owner — an install with one person shouldn't sprout a
                  "whose is this?" heading it never asked for. The group
                  is a plain container, not a `role="group"`: the rows
                  are already menuitemcheckboxes inside one menu, and an
                  extra grouping role buys nothing a visible heading and
                  the row's own label don't already convey. */}
              {showOwnerHeadings && (
                <p className="device-scope-group-heading">
                  {group.label ?? t("owner_unassigned")}
                </p>
              )}
              {group.devices.map((device) => {
                const checked = selection.has(device.id);
                return (
                  <button
                    aria-checked={checked}
                    className={`device-scope-row ${checked ? "is-checked" : ""}`}
                    data-scope-row=""
                    key={device.id}
                    onClick={() =>
                      setScope(toggleScopeDevice(scope, device.id, deviceIds))
                    }
                    role="menuitemcheckbox"
                    type="button"
                  >
                    <span aria-hidden="true" className="device-scope-check">
                      {checked ? "✓" : ""}
                    </span>
                    <DeviceGlyph
                      className="device-scope-row-icon"
                      device={device}
                    />
                    <span className="device-scope-row-text">
                      <span className="device-scope-row-name">
                        {device.name}
                      </span>
                      <span className="device-scope-row-sub">
                        {device.model || device.deviceClass
                          ? t("device_sub", {
                              count: device.appCount,
                              model: device.model ?? device.deviceClass ?? "",
                            })
                          : t("device_sub_no_model", {
                              count: device.appCount,
                            })}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {showUnattachedRow && (
            <button
              aria-checked={selection.has(UNATTACHED_ID)}
              className={`device-scope-row ${
                selection.has(UNATTACHED_ID) ? "is-checked" : ""
              }`}
              data-scope-row=""
              onClick={() =>
                setScope(toggleScopeDevice(scope, UNATTACHED_ID, deviceIds))
              }
              role="menuitemcheckbox"
              type="button"
            >
              <span aria-hidden="true" className="device-scope-check">
                {selection.has(UNATTACHED_ID) ? "✓" : ""}
              </span>
              <span
                aria-hidden="true"
                className="device-scope-row-icon device-scope-row-icon-text"
              >
                ⌁
              </span>
              <span className="device-scope-row-text">
                <span className="device-scope-row-name">
                  {t("unattached_label")}
                </span>
                <span className="device-scope-row-sub">
                  {t("unattached_sub")}
                </span>
              </span>
            </button>
          )}

          {showAudiencePrompt && suggestedAudience && (
            /* The bridge between "whose device is this?" and "what am I
               set up to do?". Before ownership existed, someone could
               scope to a relative's iPad and stay silently in
               self-audience — which is what hides the reason the delete
               flow is refusing them, three screens later.

               A suggestion with two explicit outs, never automatic: the
               audience decides which features the whole app shows, and
               changing that because someone clicked a device filter
               would be a worse surprise than the mismatch it fixes. */
            <div className="device-scope-prompt" role="note">
              {/* Two sentences, deliberately. The first says what's
                  mismatched. The second says what switching actually
                  DOES — a new user has no idea what "helping someone
                  else" is, so a prompt that only names the mode reads
                  as jargon and gets dismissed. The CTA repeats the mode
                  name so the button stands on its own. */}
              <p className="device-scope-prompt-text">
                {ownerName
                  ? t("audience_prompt_named", {
                      owner: ownerName,
                      current: t(`audience_name.${audience ?? "self"}`),
                    })
                  : t("audience_prompt", {
                      current: t(`audience_name.${audience ?? "self"}`),
                    })}
              </p>
              <p className="device-scope-prompt-why">
                {t(`audience_why.${suggestedAudience}`)}
              </p>
              <div className="device-scope-prompt-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={switching}
                  onClick={async () => {
                    setSwitching(true);
                    const ok = await setAudience(suggestedAudience);
                    setSwitching(false);
                    if (ok) {
                      // Dismiss on success too: the prompt's condition
                      // resolves on its own once the audience lands, but
                      // marking it keeps the row from flickering back
                      // while the state settles.
                      setDismissedPrompt(promptKey);
                    }
                  }}
                  type="button"
                >
                  {switching
                    ? t("audience_switching")
                    : t("audience_switch_cta", {
                        mode: t(`audience_name.${suggestedAudience}`),
                      })}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setDismissedPrompt(promptKey)}
                  type="button"
                >
                  {t("audience_keep_cta")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
