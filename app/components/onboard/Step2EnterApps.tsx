"use client";

/**
 * Step 2 — get the app names in and search the App Store for each.
 *
 * The largest step by some margin, because every import method converges
 * here: typed text, an uploaded file, OCR over screenshots, and the
 * Apple Configurator export all end up as the same list of names feeding
 * the same search pass.
 */

import Link from "next/link";
import { parseManualAppText } from "@/lib/app-import";
import {
  APPLE_CONFIGURATOR_HTTPS_URL,
  APPLE_CONFIGURATOR_MACAPPSTORE_URL,
  findChildSafetyPropertyNames,
} from "@/lib/desktop";
import type { OnboardWizardState } from "@/lib/use-onboard-wizard";
import { rovingTabIndex } from "@/lib/use-roving-radiogroup";
import AlreadyTrackedAccordion from "../AlreadyTrackedAccordion";
import ImportedAppsTable from "../ImportedAppsTable";
import RateLimitBanner from "../RateLimitBanner";
import SearchProgressCard from "../SearchProgressCard";
import Step2DiffConfirmModal from "../Step2DiffConfirmModal";
import Step2DiffPanel from "../Step2DiffPanel";
import { makeImportedAppEntry } from "./shared";

export default function Step2EnterApps({
  w,
}: {
  /** The whole `useOnboardWizard` return value. One prop rather than
   *  75: the wizard is a single state machine, so a step that took
   *  its bindings individually would have a signature nobody could read.
   *  See ./README.md. */
  w: OnboardWizardState;
}) {
  const {
    cancelSearch,
    cfgutilCheck,
    cfgutilChecking,
    cfgutilDevices,
    cfgutilDevicesLoading,
    cfgutilDiagnostic,
    cfgutilError,
    cfgutilExporting,
    commitStep2Diff,
    describeCfgutilDevice,
    describeCfgutilDeviceMeta,
    developerHints,
    handleImageDrop,
    handleImageSelection,
    handleSearch,
    handleTextDrop,
    imageFileRef,
    imageFiles,
    importInfo,
    importedApps,
    inDesktop,
    isAutoResyncCfgutil,
    isDraggingImages,
    isDraggingText,
    isIosSafari,
    method,
    methodMeta,
    ocrError,
    ocrErrorDetail,
    ocrMessage,
    ocring,
    parseTextFile,
    pendingAppText,
    priorImportHistory,
    refreshCfgutilDevices,
    resyncDeviceId,
    runCfgutilCheck,
    runCfgutilExportClick,
    searchBlocked,
    searchError,
    searchProgress,
    searching,
    selectedCfgutilDevice,
    selectedCfgutilEcid,
    selectedCount,
    setCfgutilError,
    setImageFiles,
    setImportInfo,
    setImportedApps,
    setIsDraggingImages,
    setIsDraggingText,
    setMethod,
    setOcrError,
    setOcrErrorDetail,
    setOcrMessage,
    setPendingAppText,
    setSelectedCfgutilEcid,
    setStep,
    setStep2DiffConfirmOpen,
    setStep2DiffPicked,
    setUploadedFileName,
    step,
    step2DiffCommitting,
    step2DiffConfirmOpen,
    step2DiffPicked,
    tCfg,
    tStatus,
    tStep2,
    textFileRef,
    uploadedFileName,
    userSelectedMethodRef,
    wizardRadioKeyDown,
  } = w;

  return (
    <>
      {step === 2 && (
        <>
          <h1 className="wizard-title">{methodMeta[method].title}</h1>
          <p className="wizard-subtitle">
            {method === "screenshots"
              ? tStep2("subtitle_screenshots")
              : method === "file"
                ? tStep2("subtitle_file")
                : method === "configurator"
                  ? tStep2("subtitle_configurator")
                  : tStep2("subtitle_manual")}
          </p>

          {method === "screenshots" && (
            <>
              {isIosSafari && (
                <div className="wizard-note wizard-note-amber" role="note">
                  <strong>{tStep2("ios_safari_heads_up_lead")}</strong>
                  {tStep2("ios_safari_heads_up_body_pre")}
                  <button
                    className="link-button-inline"
                    onClick={() => {
                      userSelectedMethodRef.current = true;
                      setMethod("manual");
                      setImageFiles([]);
                      setOcrError("");
                      setOcrErrorDetail("");
                      setOcrMessage("");
                    }}
                    type="button"
                  >
                    {tStep2("ios_safari_link_manual")}
                  </button>
                  {tStep2("ios_safari_between")}
                  <button
                    className="link-button-inline"
                    onClick={() => {
                      userSelectedMethodRef.current = true;
                      setMethod("file");
                      setImageFiles([]);
                      setOcrError("");
                      setOcrErrorDetail("");
                      setOcrMessage("");
                    }}
                    type="button"
                  >
                    {tStep2("ios_safari_link_file")}
                  </button>
                  {tStep2("ios_safari_end")}
                </div>
              )}

              <div className="wizard-note wizard-note-info" role="note">
                <strong>{tStep2("screenshot_tip_lead")}</strong>
                {tStep2("screenshot_tip_body")}
                <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  <li>{tStep2("screenshot_tip_li1")}</li>
                  <li>{tStep2("screenshot_tip_li2")}</li>
                  <li>{tStep2("screenshot_tip_li3")}</li>
                </ul>
              </div>

              <div
                aria-label={tStep2("drop_screenshots_aria")}
                className={`file-drop ${isDraggingImages ? "over" : ""}`}
                onClick={() => imageFileRef.current?.click()}
                onDragLeave={() => setIsDraggingImages(false)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDraggingImages(true);
                }}
                onDrop={handleImageDrop}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    imageFileRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div style={{ fontSize: 28 }}>🖼</div>
                <div className="file-drop-text">
                  {tStep2("drop_screenshots")}
                </div>
                <div className="file-drop-subtext">
                  {tStep2("drop_screenshots_sub")}
                </div>
                <input
                  accept="image/*"
                  multiple
                  onChange={(event) => handleImageSelection(event.target.files)}
                  ref={imageFileRef}
                  style={{ display: "none" }}
                  type="file"
                />
              </div>

              {imageFiles.length > 0 && (
                <div className="upload-summary">
                  <div className="upload-summary-title">
                    {tStep2("selected_count", { count: imageFiles.length })}
                  </div>
                  <div className="upload-chip-row">
                    {imageFiles.map((file) => (
                      <span
                        className="upload-chip"
                        key={`${file.name}-${file.lastModified}`}
                      >
                        {file.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {ocring && (
                <div className="wizard-note wizard-note-blue">
                  <span className="spinner-sm" />
                  <span>{ocrMessage || tStep2("scanning")}</span>
                </div>
              )}

              {!ocring && ocrMessage && (
                <div className="wizard-note wizard-note-green">
                  {ocrMessage}
                </div>
              )}

              {ocrError && (
                <div className="wizard-note wizard-note-red">
                  <div>{ocrError}</div>
                  {ocrErrorDetail && (
                    <details style={{ marginTop: 8 }}>
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          opacity: 0.85,
                        }}
                      >
                        {tStep2("show_technical")}
                      </summary>
                      <pre
                        style={{
                          margin: "6px 0 0",
                          padding: 8,
                          background: "rgba(0,0,0,0.18)",
                          borderRadius: 6,
                          fontSize: 11,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {ocrErrorDetail}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </>
          )}

          {method === "file" && (
            <>
              <div className="wizard-inline-actions">
                <Link
                  className="wizard-inline-link"
                  href="/help/export-app-list"
                  target="_blank"
                >
                  {tStep2("file_export_link")}
                </Link>
              </div>

              <div
                aria-label={tStep2("file_drop_aria")}
                className={`file-drop ${isDraggingText ? "over" : ""}`}
                onClick={() => textFileRef.current?.click()}
                onDragLeave={() => setIsDraggingText(false)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDraggingText(true);
                }}
                onDrop={handleTextDrop}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    textFileRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div style={{ fontSize: 28 }}>📂</div>
                <div className="file-drop-text">
                  {tStep2.rich("file_drop_text", {
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
                </div>
                <div className="file-drop-subtext">
                  {tStep2("file_drop_sub")}
                </div>
                <input
                  accept=".txt,.csv,text/plain,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      parseTextFile(file);
                    }
                  }}
                  ref={textFileRef}
                  style={{ display: "none" }}
                  type="file"
                />
              </div>

              {uploadedFileName && (
                <div className="upload-summary">
                  <div className="upload-summary-title">
                    {tStep2("imported_from", { filename: uploadedFileName })}
                  </div>
                  <div className="upload-summary-copy">
                    {tStep2("imported_from_review")}
                  </div>
                </div>
              )}
            </>
          )}

          {method === "configurator" &&
            (() => {
              // Once the cfgutil export has populated names AND set the
              // upload-summary title, the user is "done" with the
              // collection step — collapsing the ladder + how-to + CSV
              // dropzone gets them straight to the names list and the
              // Continue affordance, which is what they actually need
              // to act on next. Showing all three side-by-side after
              // success buries the action and makes the wizard look
              // unfinished. We keep the upload-summary visible (it's
              // the "you imported X apps from <device>" confirmation)
              // and add a fresh "Re-run import" link inside it for
              // users who want to redo the export without a tab back.
              const cfgutilImportSuccessful =
                uploadedFileName !== "" && importedApps.length > 0;
              // Pick an emoji for the device class so the success
              // summary visually matches the import-history row
              // SettingsView renders. Uses the live `selectedCfgutilDevice`
              // (richer than the source-label parse SettingsView has
              // to do) when available.
              const deviceClassRaw =
                selectedCfgutilDevice?.deviceClass?.toLowerCase() ?? "";
              const deviceIcon = deviceClassRaw.includes("iphone")
                ? "📱"
                : deviceClassRaw.includes("ipad")
                  ? "📱"
                  : deviceClassRaw.includes("ipod")
                    ? "🎵"
                    : deviceClassRaw.includes("appletv") ||
                        deviceClassRaw.includes("apple tv")
                      ? "📺"
                      : deviceClassRaw.includes("applewatch") ||
                          deviceClassRaw.includes("apple watch")
                        ? "⌚️"
                        : // Fall back to the generic Configurator glyph when
                          // cfgutil's deviceClass field came back empty (older
                          // builds, or the device went away after export).
                          "📱";
              return (
                <>
                  {/*
                  Desktop auto-import panel. Only rendered inside the Tauri
                  shell (isDesktop() returns true), and only on a platform
                  where cfgutil can actually run — check_cfgutil reports
                  "macos" / "windows" / "linux" so we can tell the user
                  up-front that the auto path is macOS-only without
                  making them click the button first.

                  The panel walks the user through three discrete steps:
                    1. Install Apple Configurator from the App Store.
                    2. Check that cfgutil is reachable.
                    3. Export installed apps from any connected device.
                  Each step only unlocks once the previous one is clearly
                  satisfied, so the success path feels like a ladder rather
                  than a forest of buttons.

                  Hidden once the import has succeeded — the names list
                  below + the upload-summary card carry the rest of the
                  flow and the user shouldn't have to scroll past three
                  collapsed-but-still-visible affordances they're done
                  with.
                */}
                  {inDesktop && !cfgutilImportSuccessful && (
                    <section
                      aria-label={tCfg("panel_aria")}
                      className="cfgutil-panel"
                    >
                      <header className="cfgutil-panel-header">
                        <div>
                          <div className="cfgutil-panel-eyebrow">
                            {tCfg("eyebrow")}
                          </div>
                          <h2 className="cfgutil-panel-title">
                            {tCfg("title")}
                          </h2>
                          <p className="cfgutil-panel-copy">{tCfg("copy")}</p>
                        </div>
                      </header>

                      <ol className="cfgutil-steps">
                        {/* Step 1 — install Apple Configurator. We render this
                          whether or not cfgutilCheck has run yet; once it has
                          run and app_installed is true, the step is marked
                          "Installed" and the button flips to a quiet "Open
                          in App Store" link instead of the bright primary
                          CTA. */}
                        <li
                          className={
                            "cfgutil-step " +
                            (cfgutilCheck?.appInstalled
                              ? "cfgutil-step-done"
                              : "cfgutil-step-pending")
                          }
                        >
                          <div className="cfgutil-step-number">1</div>
                          <div className="cfgutil-step-body">
                            <div className="cfgutil-step-title">
                              {tCfg("step1_title")}
                              {cfgutilCheck?.appInstalled && (
                                <span className="cfgutil-step-badge">
                                  {tCfg("step1_installed_badge")}
                                </span>
                              )}
                            </div>
                            <p className="cfgutil-step-copy">
                              {tCfg("step1_copy_pre")}
                              <code>cfgutil</code>
                              {tCfg("step1_copy_post")}
                            </p>
                            <div className="cfgutil-step-actions">
                              <a
                                className={
                                  cfgutilCheck?.appInstalled
                                    ? "link-button-inline"
                                    : "btn btn-primary btn-sm"
                                }
                                href={APPLE_CONFIGURATOR_MACAPPSTORE_URL}
                                rel="noreferrer"
                                // The macappstore:// protocol opens the App Store
                                // app directly; target=_self keeps the webview from
                                // spawning a new tab when the scheme handler fires.
                                target="_self"
                              >
                                {cfgutilCheck?.appInstalled
                                  ? tCfg("step1_open_installed")
                                  : tCfg("step1_open_new")}
                              </a>
                              <a
                                className="link-button-inline"
                                href={APPLE_CONFIGURATOR_HTTPS_URL}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                {tCfg("step1_view_listing")}
                              </a>
                            </div>
                          </div>
                        </li>

                        {/* Step 2 — detect cfgutil. Three visual states:
                          (a) no check yet → show "Check now" button.
                          (b) available → green badge with version string.
                          (c) unavailable → red-ish note with the reason and,
                              if the .app is installed but the symlink
                              isn't, specific "Install Automation Tools"
                              guidance. */}
                        <li
                          className={
                            "cfgutil-step " +
                            (cfgutilCheck?.available
                              ? "cfgutil-step-done"
                              : cfgutilCheck
                                ? "cfgutil-step-error"
                                : "cfgutil-step-pending")
                          }
                        >
                          <div className="cfgutil-step-number">2</div>
                          <div className="cfgutil-step-body">
                            <div className="cfgutil-step-title">
                              {tCfg("step2_title")}
                              {cfgutilCheck?.available && (
                                <span className="cfgutil-step-badge">
                                  {cfgutilCheck.version
                                    ? tCfg("step2_badge_version", {
                                        version: cfgutilCheck.version,
                                      })
                                    : tCfg("step2_badge_ready")}
                                </span>
                              )}
                            </div>
                            {!cfgutilCheck && (
                              <p className="cfgutil-step-copy">
                                {tCfg("step2_copy_initial_pre")}
                                <code>cfgutil --format JSON list</code>
                                {tCfg("step2_copy_initial_post")}
                              </p>
                            )}
                            {cfgutilCheck && !cfgutilCheck.available && (
                              <>
                                <p className="cfgutil-step-copy">
                                  {cfgutilCheck.appInstalled
                                    ? tCfg("step2_copy_app_installed")
                                    : (cfgutilCheck.error ??
                                      tCfg("step2_copy_not_found"))}
                                </p>
                                {cfgutilCheck.platform !== "macos" && (
                                  <p className="cfgutil-step-copy">
                                    {tCfg("step2_copy_not_macos")}
                                  </p>
                                )}
                              </>
                            )}
                            <div className="cfgutil-step-actions">
                              <button
                                className="btn btn-secondary btn-sm"
                                disabled={cfgutilChecking}
                                onClick={() => void runCfgutilCheck()}
                                type="button"
                              >
                                {cfgutilChecking ? (
                                  <>
                                    <span className="spinner" />{" "}
                                    {tCfg("step2_checking")}
                                  </>
                                ) : cfgutilCheck ? (
                                  tCfg("step2_recheck")
                                ) : (
                                  tCfg("step2_check")
                                )}
                              </button>
                              {cfgutilCheck?.path && (
                                <span className="cfgutil-step-sub">
                                  {tCfg("step2_path_pre")}
                                  <code>{cfgutilCheck.path}</code>
                                </span>
                              )}
                            </div>
                            {/* Diagnostics-only probe: what properties this
                              cfgutil build can read off a device. The guardian
                              age-rating feature watches for the day Apple
                              exposes a child age-range / restrictions property
                              over USB (today DeclaredAgeRange is in-app only,
                              so the hit list is expected to be empty). */}
                            {cfgutilCheck?.supportedPropertyNames &&
                              (() => {
                                const hits = findChildSafetyPropertyNames(
                                  cfgutilCheck.supportedPropertyNames
                                );
                                return (
                                  <p className="cfgutil-step-sub">
                                    {tCfg("step2_properties_probe", {
                                      count:
                                        cfgutilCheck.supportedPropertyNames
                                          .length,
                                    })}
                                    {hits.length > 0 && (
                                      <>
                                        {" "}
                                        {tCfg("step2_properties_child_hit")}{" "}
                                        <code>{hits.join(", ")}</code>
                                      </>
                                    )}
                                  </p>
                                );
                              })()}
                            {/* Larger, more visible "we're working on it"
                              panel — the cfgutil probe shells out + checks
                              the Automation Tools install, which can take
                              5–30s on a cold call. The button's 16px
                              spinner alone isn't enough signal. Renders
                              only while cfgutilChecking is true; aria-live
                              announces the title to screen readers. */}
                            {cfgutilChecking && (
                              <div
                                aria-live="polite"
                                className="cfgutil-checking-status"
                                role="status"
                              >
                                <span aria-hidden className="spinner-lg" />
                                <div className="cfgutil-checking-status-body">
                                  <div className="cfgutil-checking-status-title">
                                    {tCfg("checking_status_title")}
                                  </div>
                                  <div className="cfgutil-checking-status-copy">
                                    {tCfg("checking_status_body")}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </li>

                        {/* Step 3 — run the export. Gated behind a successful
                          step-2 check. When disabled, the copy tells the
                          user what's missing rather than showing a dead
                          button. */}
                        <li
                          className={
                            "cfgutil-step " +
                            (cfgutilCheck?.available
                              ? "cfgutil-step-ready"
                              : "cfgutil-step-locked")
                          }
                        >
                          <div className="cfgutil-step-number">3</div>
                          <div className="cfgutil-step-body">
                            <div className="cfgutil-step-title">
                              {tCfg("step3_title")}
                            </div>
                            <p className="cfgutil-step-copy">
                              {tCfg("step3_copy_pre")}
                              <strong>{tCfg("step3_copy_trust")}</strong>
                              {tCfg("step3_copy_mid")}
                              <code>
                                cfgutil --format JSON get installedApps
                              </code>
                              {tCfg("step3_copy_post")}
                            </p>
                            {cfgutilCheck?.available && (
                              <div className="cfgutil-device-picker">
                                <div className="cfgutil-device-picker-header">
                                  <div>
                                    <div className="cfgutil-device-picker-title">
                                      {tCfg("device_picker_title")}
                                    </div>
                                    <div className="cfgutil-device-picker-sub">
                                      {cfgutilDevices.length > 1
                                        ? tCfg("device_picker_multi")
                                        : selectedCfgutilDevice
                                          ? tCfg("device_picker_selected", {
                                              device: describeCfgutilDevice(
                                                selectedCfgutilDevice
                                              ),
                                            })
                                          : tCfg("device_picker_empty")}
                                    </div>
                                    {/* Prior-import badge — only renders when
                                     *  the connected device matches a row in
                                     *  the `devices` table AND we've seen at
                                     *  least one completed import for it.
                                     *  Signals "you've been here before,
                                     *  we'll diff against your last sync."
                                     *  The wizard auto-enters re-sync mode
                                     *  whenever this badge is visible (see
                                     *  the ECID lookup effect above). */}
                                    {priorImportHistory &&
                                      priorImportHistory.count > 0 && (
                                        <div
                                          className="cfgutil-device-picker-prior-badge"
                                          role="status"
                                        >
                                          <span
                                            aria-hidden="true"
                                            className="cfgutil-device-picker-prior-badge-icon"
                                          >
                                            ↻
                                          </span>
                                          <span>
                                            {tCfg("prior_imports_badge", {
                                              count: priorImportHistory.count,
                                              deviceName:
                                                priorImportHistory.deviceName ||
                                                tCfg("device_fallback"),
                                            })}
                                          </span>
                                        </div>
                                      )}
                                  </div>
                                  <button
                                    className="pill-button"
                                    disabled={cfgutilDevicesLoading}
                                    onClick={() => void refreshCfgutilDevices()}
                                    type="button"
                                  >
                                    {cfgutilDevicesLoading ? (
                                      <>
                                        <span className="spinner-sm" />{" "}
                                        {tCfg("device_refreshing")}
                                      </>
                                    ) : (
                                      tCfg("device_refresh")
                                    )}
                                  </button>
                                </div>

                                {/* While refreshing, show skeleton rows in
                                  the same slot as the real device list so
                                  the panel itself reflects the loading
                                  state — not just the pill button up top.
                                  Once cfgutil returns and devices are
                                  populated, the skeleton block is
                                  replaced by the real radiogroup. */}
                                {cfgutilDevicesLoading &&
                                  cfgutilDevices.length === 0 && (
                                    <div
                                      aria-label={tCfg("device_skeleton_aria")}
                                      aria-live="polite"
                                      className="cfgutil-device-list cfgutil-device-list--loading"
                                      role="status"
                                    >
                                      <div className="cfgutil-device-loading-banner">
                                        <span
                                          aria-hidden
                                          className="spinner-sm"
                                        />
                                        <span>
                                          {tCfg("devices_refreshing_status")}
                                        </span>
                                      </div>
                                      <div
                                        aria-hidden
                                        className="cfgutil-device-row cfgutil-device-row--skeleton"
                                      >
                                        <span className="cfgutil-device-dot" />
                                        <span className="cfgutil-device-text">
                                          <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                          <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                        </span>
                                      </div>
                                      <div
                                        aria-hidden
                                        className="cfgutil-device-row cfgutil-device-row--skeleton"
                                      >
                                        <span className="cfgutil-device-dot" />
                                        <span className="cfgutil-device-text">
                                          <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                          <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                {cfgutilDevices.length > 0 && (
                                  <div
                                    aria-label={tCfg("device_picker_aria")}
                                    className="cfgutil-device-list"
                                    onKeyDown={wizardRadioKeyDown}
                                    role="radiogroup"
                                  >
                                    {cfgutilDevices.map(
                                      (device, deviceIndex) => {
                                        const selectedDevice =
                                          selectedCfgutilEcid === device.ecid;
                                        return (
                                          <button
                                            aria-checked={selectedDevice}
                                            className={`cfgutil-device-row${selectedDevice ? " is-selected" : ""}`}
                                            key={device.ecid}
                                            onClick={() => {
                                              setSelectedCfgutilEcid(
                                                device.ecid
                                              );
                                              if (
                                                cfgutilError ===
                                                tCfg("step3_select_required")
                                              ) {
                                                setCfgutilError("");
                                              }
                                            }}
                                            role="radio"
                                            tabIndex={rovingTabIndex(
                                              selectedDevice,
                                              deviceIndex,
                                              cfgutilDevices.some(
                                                (d) =>
                                                  d.ecid === selectedCfgutilEcid
                                              )
                                            )}
                                            type="button"
                                          >
                                            <span
                                              aria-hidden
                                              className="cfgutil-device-dot"
                                            />
                                            <span className="cfgutil-device-text">
                                              <span className="cfgutil-device-name">
                                                {describeCfgutilDevice(device)}
                                              </span>
                                              <span className="cfgutil-device-meta">
                                                {describeCfgutilDeviceMeta(
                                                  device
                                                )}
                                              </span>
                                            </span>
                                          </button>
                                        );
                                      }
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="cfgutil-step-actions">
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={
                                  !cfgutilCheck?.available ||
                                  cfgutilExporting ||
                                  cfgutilDevicesLoading
                                }
                                onClick={() => void runCfgutilExportClick()}
                                type="button"
                              >
                                {cfgutilExporting ? (
                                  <>
                                    <span className="spinner" />{" "}
                                    {tCfg("step3_export_busy")}
                                  </>
                                ) : selectedCfgutilDevice ? (
                                  tCfg("step3_export_selected")
                                ) : (
                                  tCfg("step3_export")
                                )}
                              </button>
                            </div>
                          </div>
                        </li>
                      </ol>

                      {/* Generic error surface. Rendered under the ladder so
                        both the check and the export pathways feed into the
                        same UI without needing two separate slots. */}
                      {cfgutilError && (
                        <div className="cfgutil-panel-error" role="alert">
                          <strong>{tCfg("error_title")}</strong>
                          <span>{cfgutilError}</span>
                          {cfgutilDiagnostic && (
                            <details className="cfgutil-diagnostic">
                              <summary>{tCfg("diagnostic_summary")}</summary>
                              <p className="cfgutil-diagnostic-hint">
                                {tCfg("diagnostic_hint_pre")}
                                <em>{tCfg("diagnostic_hint_trust")}</em>
                                {tCfg("diagnostic_hint_post")}
                              </p>
                              <pre className="cfgutil-diagnostic-pre">
                                {cfgutilDiagnostic.length > 4096
                                  ? cfgutilDiagnostic.slice(0, 4096) +
                                    "\n\n…(truncated, " +
                                    (cfgutilDiagnostic.length - 4096) +
                                    " bytes more)"
                                  : cfgutilDiagnostic}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}

                      {/* Progress overlay while cfgutil is running. The
                        Rust command can spend 30-90 seconds talking to
                        a phone with a large library; the only existing
                        feedback was a tiny inline spinner inside the
                        button, which made the app look frozen behind
                        the macOS beach-ball cursor. The overlay covers
                        the panel (not the whole window) so the user
                        can see what action they're waiting on, and
                        carries copy that sets a realistic expectation
                        about how long it might take. Auto-dismisses
                        when `cfgutilExporting` flips back to false. */}
                      {cfgutilExporting && (
                        <div
                          aria-live="polite"
                          className="cfgutil-progress-overlay"
                          role="status"
                        >
                          <div className="cfgutil-progress-card">
                            <span
                              aria-hidden="true"
                              className="spinner spinner-large"
                            />
                            <h3 className="cfgutil-progress-title">
                              {tCfg("progress_title")}
                            </h3>
                            <p className="cfgutil-progress-body">
                              {tCfg("progress_body")}
                            </p>
                            <p className="cfgutil-progress-tip">
                              {tCfg("progress_tip")}
                            </p>
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {/* Manual Apple Configurator export instructions —
                   *  kept around for when cfgutil isn't available or
                   *  threw an error. Hidden by default because the
                   *  cfgutil command path is the primary surface for
                   *  this method; we only surface the legacy CSV
                   *  pathway when something's gone wrong (cfgutil
                   *  missing on this Mac, off-desktop platform, USB
                   *  device refused, etc). A "Switch to file upload"
                   *  link routes the user to the proper `method =
                   *  'file'` panel so they don't have to live inside a
                   *  hybrid panel. */}
                  {!cfgutilImportSuccessful &&
                    (!inDesktop ||
                      cfgutilError ||
                      cfgutilCheck?.available === false) && (
                      <div className="wizard-note wizard-note-info" role="note">
                        <strong>
                          {inDesktop
                            ? tStep2("configurator_export_lead_desktop")
                            : tStep2("configurator_export_lead_other")}
                        </strong>
                        <ol style={{ margin: "8px 0 0 20px", padding: 0 }}>
                          <li>{tStep2("configurator_step_1")}</li>
                          <li>{tStep2("configurator_step_2")}</li>
                          <li>
                            {tStep2.rich("configurator_step_3", {
                              b: (chunks) => <strong>{chunks}</strong>,
                            })}
                          </li>
                          <li>
                            {tStep2.rich("configurator_step_4", {
                              b: (chunks) => <strong>{chunks}</strong>,
                            })}
                          </li>
                          <li>{tStep2("configurator_step_5")}</li>
                        </ol>
                        <button
                          aria-label={tStep2(
                            "configurator_switch_to_file_aria"
                          )}
                          className="link-button-inline"
                          onClick={() => {
                            // Route the user to the file-upload panel,
                            // which is where the CSV drag-drop belongs.
                            // `userSelectedMethodRef` keeps the wizard's
                            // method-picker from clobbering this on the
                            // next render.
                            userSelectedMethodRef.current = true;
                            setMethod("file");
                            setCfgutilError("");
                          }}
                          style={{ marginTop: 10, fontSize: 13 }}
                          type="button"
                        >
                          {tStep2("configurator_switch_to_file")}
                        </button>
                      </div>
                    )}

                  {uploadedFileName && (
                    <div className="upload-summary">
                      <div className="upload-summary-title">
                        <span
                          aria-hidden="true"
                          className="upload-summary-device-icon"
                        >
                          {deviceIcon}
                        </span>{" "}
                        {tStep2("imported_from", {
                          filename: uploadedFileName,
                        })}
                      </div>
                      <div className="upload-summary-copy">
                        {tStep2("imported_from_review_long")}
                      </div>
                      {importInfo && (
                        <div className="upload-summary-note">{importInfo}</div>
                      )}
                      {developerHints.size > 0 && (
                        <div className="upload-summary-note">
                          {tStep2("developer_hints_note")}
                        </div>
                      )}
                      {cfgutilImportSuccessful && inDesktop && (
                        <div className="upload-summary-actions">
                          <button
                            className="link-button-inline"
                            onClick={() => {
                              // Reset the cfgutil-side state so the
                              // ladder + how-to + dropzone reappear and
                              // the user can re-run the export. We don't
                              // wipe `namesText` itself — that's user
                              // data, and the textarea below is the
                              // editable representation of the same
                              // names; the "Re-run import" button just
                              // un-collapses the import surface so the
                              // ladder is accessible again.
                              setUploadedFileName("");
                              setImportInfo("");
                            }}
                            type="button"
                          >
                            ↺ Re-run import
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

          {/* Auto-resync upfront diff: when the wizard detected a
           *  known cfgutil device (ECID match) and cfgutil has
           *  populated apps, REPLACE the normal "App names" list +
           *  AlreadyTrackedAccordion with the Step2DiffPanel. The
           *  user reviews adds + removes + already-tracked here,
           *  then clicks Continue → confirm modal → commit. The
           *  post-scrape DeviceSyncDiffOverlay only fires when the
           *  user came in via the Settings → Devices "Re-sync"
           *  button (URL-supplied `?resync=`). */}
          {isAutoResyncCfgutil && importedApps.length > 0 && (
            <>
              <Step2DiffPanel
                deviceId={resyncDeviceId!}
                deviceName={priorImportHistory?.deviceName ?? ""}
                entries={importedApps.map((e) => ({
                  id: e.id,
                  name: e.name,
                  bundleId: e.bundleId ?? null,
                }))}
                onConfirm={(picked) => {
                  setStep2DiffPicked(picked);
                  // Nothing-to-do path: panel reports 0 adds + 0 removes
                  // (matched everything via bundleId or name fallback).
                  // Skip the confirm modal entirely — it would just ask
                  // "Removing 0, adding 0? Continue / Back" which is an
                  // anticlimax. The panel's own "Done" button fires
                  // this branch directly; the few link-only writes
                  // happen via commitStep2Diff's no-op path which
                  // routes the user to /dashboard.
                  if (picked.addCount === 0 && picked.removeCount === 0) {
                    void commitStep2Diff(picked);
                  } else {
                    setStep2DiffConfirmOpen(true);
                  }
                }}
              />
              <Step2DiffConfirmModal
                addCount={step2DiffPicked?.addCount ?? 0}
                busy={step2DiffCommitting}
                deviceName={priorImportHistory?.deviceName ?? ""}
                onBack={() => setStep2DiffConfirmOpen(false)}
                onConfirm={() => void commitStep2Diff()}
                open={step2DiffConfirmOpen}
                removeCount={step2DiffPicked?.removeCount ?? 0}
              />
            </>
          )}

          {/* Pre-cfgutil-run + non-auto-resync paths: render the
           *  normal "App names" list + table. The cfgutil method
           *  still hides the empty-state heading until cfgutil
           *  populates `importedApps`. */}
          {!(
            (isAutoResyncCfgutil && importedApps.length > 0) ||
            (method === "configurator" && importedApps.length === 0)
          ) && (
            <div className="wizard-list-header">
              <div>
                <div className="wizard-list-title">{tStep2("list_title")}</div>
                <div className="wizard-list-copy">
                  {selectedCount > 0
                    ? tStep2("list_count", { count: selectedCount })
                    : method === "screenshots"
                      ? tStep2("list_empty_screenshots")
                      : method === "configurator"
                        ? tStep2("list_empty_configurator")
                        : tStep2("list_empty_manual")}
                </div>
              </div>
            </div>
          )}

          {/* AlreadyTrackedAccordion + ImportedAppsTable: shown on
           *  every path EXCEPT the auto-resync cfgutil flow (which
           *  has its own Step2DiffPanel above that subsumes both). */}
          {!(isAutoResyncCfgutil && importedApps.length > 0) && (
            <AlreadyTrackedAccordion
              deviceId={resyncDeviceId}
              deviceName={priorImportHistory?.deviceName}
              entries={importedApps}
            />
          )}

          {!(
            (isAutoResyncCfgutil && importedApps.length > 0) ||
            (method === "configurator" && importedApps.length === 0)
          ) && (
            <ImportedAppsTable
              entries={importedApps}
              onAdd={(rawText) => {
                const names = parseManualAppText(rawText);
                if (names.length === 0) {
                  return;
                }
                // Dedupe against the existing list (case-insensitive)
                // so paste-bombing the same names doesn't multiply rows.
                const existing = new Set(
                  importedApps.map((e) => e.name.toLowerCase())
                );
                const fresh = names
                  .filter((n) => !existing.has(n.toLowerCase()))
                  .map((name) =>
                    makeImportedAppEntry({ name, source: "manual" })
                  );
                if (fresh.length > 0) {
                  setImportedApps((prev) => [...prev, ...fresh]);
                }
              }}
              onPendingChange={setPendingAppText}
              onRemove={(id) =>
                setImportedApps((prev) => prev.filter((e) => e.id !== id))
              }
              pending={pendingAppText}
            />
          )}

          {/* The "N of these are already tracked" banner that used to
                live here relied on a name-lowercase fuzzy match, which
                mis-counted common names (many apps share a title) and
                also missed misspellings. It has moved to the top of
                Step 3 — see the `trackedSelectedCount` banner there —
                where the App Store appleId of each chosen candidate
                gives us an exact, authoritative count. */}

          {searchError && (
            <p style={{ color: "var(--red)", fontSize: 13, marginTop: 12 }}>
              {searchError}
              {searchBlocked && (
                <>
                  {" "}
                  <Link href="/dashboard/settings/admin#deployment-diagnostics">
                    {tStatus("search_access_blocked_link")}
                  </Link>
                </>
              )}
            </p>
          )}

          {/* Rate-limit banner above the "Find apps in App Store" CTA.

                When iTunes Search has been throttled, every name in the
                wizard's batch will fail with the same 429 — surfacing the
                cooldown here lets users see what's happening before they
                click and watch a long progress bar fail. The auto-retry
                callback re-runs `handleSearch` with the same selection,
                which kicks off a fresh batch through the existing
                queued-search path. */}
          <RateLimitBanner
            category="search"
            onResume={() => {
              if (selectedCount > 0 && !searching && !ocring) {
                handleSearch();
              }
            }}
          />

          {/* In-flight search progress. Replaces the previous endless
                spinner with a live bar + count + cancel — phase-1
                bundle-ID lookup feeds the running matched count
                instantly, then phase-2 name search chunks tick the
                bar batch-by-batch (~50 names each). */}
          {searching && searchProgress && (
            <SearchProgressCard
              onCancel={cancelSearch}
              progress={searchProgress}
            />
          )}

          {/* Step-2 footer (Back + Find apps in App Store) — hidden
           *  on the auto-resync path. Step2DiffPanel surfaces its
           *  own Continue button which fires `commitStep2Diff`,
           *  which then drives `handleSearch` once removes have
           *  committed. The user only sees one primary action at a
           *  time. */}
          {!(isAutoResyncCfgutil && importedApps.length > 0) && (
            <div className="wizard-footer-actions">
              <button
                className="btn btn-secondary"
                disabled={searching}
                onClick={() => setStep(1)}
                type="button"
              >
                {tStep2("back")}
              </button>
              <button
                className="btn btn-primary btn-lg"
                data-testid="onboard-search"
                disabled={
                  searching ||
                  (selectedCount === 0 && pendingAppText.trim().length === 0) ||
                  ocring
                }
                onClick={handleSearch}
                style={{ flex: 1 }}
                type="button"
              >
                {searching && searchProgress ? (
                  tStep2("search_busy_count", {
                    matched: searchProgress.matched,
                    total: searchProgress.total,
                  })
                ) : searching ? (
                  <>
                    <span className="spinner" /> {tStep2("search_busy")}
                  </>
                ) : (
                  tStep2("search")
                )}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
