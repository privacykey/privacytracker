"use client";
import "./onboard/onboard.css";
import type { DeviceClass } from "../../lib/device";
import { useOnboardWizard } from "../../lib/use-onboard-wizard";
import DeviceSyncDiffOverlay from "./DeviceSyncDiffOverlay";
import LiveTextModal from "./LiveTextModal";
import CancelSummariesModal from "./onboard/CancelSummariesModal";
import RateLimitPauseModal from "./onboard/RateLimitPauseModal";
import RestoreBackupModal from "./onboard/RestoreBackupModal";
import Step1ChooseMethod from "./onboard/Step1ChooseMethod";
import Step2EnterApps from "./onboard/Step2EnterApps";
import Step3ConfirmMatches from "./onboard/Step3ConfirmMatches";
import Step4ImportProgress from "./onboard/Step4ImportProgress";
import Step5AiSummaries from "./onboard/Step5AiSummaries";

interface OnboardWizardProps {
  /**
   * Server-resolved flags whose first paint must match the runtime-aware
   * resolver. Client-side `useFlag` falls back to hard defaults before the
   * resolver cache is hydrated, which is not enough for Tauri-only gates.
   */
  flags?: {
    methodConfigurator: boolean;
  };
  /**
   * Server-sniffed device class from the UA header. Drives the initial
   * method-card layout so the first paint shows the right primary option
   * for this device. Refined client-side by `refineDeviceOnClient` once
   * viewport width / touch points become observable.
   */
  initialDevice?: DeviceClass;
}

export default function OnboardWizard({
  initialDevice = "desktop",
  flags,
}: OnboardWizardProps) {
  const w = useOnboardWizard({ initialDevice, flags });
  const {
    stepLabels,
    router,
    tStepIndicator,
    tOnboard,
    step,
    setStep,
    liveTextModalOpen,
    setLiveTextModalOpen,
    rateLimitPauseModal,
    setRateLimitPauseModal,
    cancelModalOpen,
    setCancelModalOpen,
    restoreStage,
    restorePreview,
    pendingRestoreFilename,
    restoreError,
    setRestoreError,
    restoreConfirmText,
    setRestoreConfirmText,
    resetRestoreFlow,
    restoreModalCardRef,
    cancelModalCardRef,
    rateLimitModalCardRef,
    handleRestoreConfirm,
    isPreviewMode,
    resyncDeviceId,
    resyncOverlayOpen,
    setResyncOverlayOpen,
    resyncOverlayApps,
    requestStop,
  } = w;
  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        {/*
          Dev-only preview banner — sits above the stepper when the
          wizard was opened via `/onboard?preview=fresh` from the
          DevMenu. Click-through is fine on every step except the
          final submit (Step 4's scrape batch), which short-circuits
          server-side calls when this mode is active. Distinct purple
          border so it's never mistaken for a real onboarding banner.
        */}
        {isPreviewMode && (
          <div className="wizard-preview-banner" role="status">
            <span aria-hidden="true" className="wizard-preview-banner-icon">
              👁
            </span>
            <div>
              <strong>{tOnboard("preview_banner.lead")}</strong>
              <span className="wizard-preview-banner-sub">
                {tOnboard("preview_banner.body")}
              </span>
            </div>
          </div>
        )}
        {/* Step indicator is informational only (not a navigation control),
            so expose it as an ordered list with aria-current="step" on the
            active one. Screen readers announce position in the sequence. */}
        <ol
          aria-label={tStepIndicator("aria", {
            step,
            total: stepLabels.length,
          })}
          className="wizard-steps"
        >
          {stepLabels.map(([value, label], index) => {
            const isActive = step === value;
            const isDone = step > value;
            const statusWord = isDone
              ? tStepIndicator("completed")
              : isActive
                ? tStepIndicator("current")
                : tStepIndicator("upcoming");
            return (
              <li
                aria-current={isActive ? "step" : undefined}
                className="wizard-step-node"
                key={value}
                style={{ flex: index < stepLabels.length - 1 ? 1 : "none" }}
              >
                <span className="sr-only">{statusWord}: </span>
                <div
                  aria-hidden="true"
                  className={`wizard-step-circle ${isDone ? "done" : isActive ? "active" : "inactive"}`}
                >
                  {isDone ? "✓" : value}
                </div>
                <span
                  className={`wizard-step-label ${isActive ? "active" : isDone ? "done" : ""}`}
                >
                  {label}
                </span>
                {index < stepLabels.length - 1 && (
                  <div
                    aria-hidden="true"
                    className={`wizard-step-line ${isDone ? "done" : ""}`}
                  />
                )}
              </li>
            );
          })}
        </ol>

        <Step5AiSummaries w={w} />

        <Step1ChooseMethod w={w} />

        <Step2EnterApps w={w} />

        <Step3ConfirmMatches w={w} />

        <Step4ImportProgress w={w} />
      </div>

      {(restoreStage === "confirm" || restoreStage === "applying") &&
        restorePreview && (
          <RestoreBackupModal
            handleRestoreConfirm={handleRestoreConfirm}
            pendingRestoreFilename={pendingRestoreFilename}
            resetRestoreFlow={resetRestoreFlow}
            restoreConfirmText={restoreConfirmText}
            restoreError={restoreError}
            restoreModalCardRef={restoreModalCardRef}
            restorePreview={restorePreview}
            restoreStage={restoreStage}
            setRestoreConfirmText={setRestoreConfirmText}
            setRestoreError={setRestoreError}
          />
        )}

      <CancelSummariesModal
        cancelModalCardRef={cancelModalCardRef}
        cancelModalOpen={cancelModalOpen}
        requestStop={requestStop}
        setCancelModalOpen={setCancelModalOpen}
      />

      {/* Rate-limit pause modal. Opened by the scrape loop on the first
          Apple 429. Gives the user two concrete next steps so they don't
          just sit watching a frozen progress list:
            • "View Import History" — opens Settings → Import History so
              they can watch the background queue worker drain the rest.
            • "Summarise privacy policies" — advances the wizard to step 5
              (AI summaries) for whatever apps imported cleanly before the
              rate-limit hit. Hidden when nothing imported successfully,
              since there'd be nothing to summarise. */}
      <RateLimitPauseModal
        rateLimitModalCardRef={rateLimitModalCardRef}
        rateLimitPauseModal={rateLimitPauseModal}
        router={router}
        setRateLimitPauseModal={setRateLimitPauseModal}
        setStep={setStep}
      />

      <LiveTextModal
        onClose={() => setLiveTextModalOpen(false)}
        open={liveTextModalOpen}
      />

      {/* Re-sync diff overlay — only mounts when the wizard was opened
       *  with `?resync=<deviceId>` and the import has finished. The
       *  overlay drives /api/device-sync/preview + /api/device-sync/commit
       *  on top of the apps the import just resolved. */}
      {resyncDeviceId && (
        <DeviceSyncDiffOverlay
          currentImport={resyncOverlayApps}
          deviceId={resyncDeviceId}
          onClose={() => setResyncOverlayOpen(false)}
          onCommit={(result) => {
            setResyncOverlayOpen(false);
            // Bounce the user to the Devices page with a flash toast so
            // they see "Re-sync: 2 added, 3 removed." It's the natural
            // place to land — they came from there. `merged` counts
            // legacy duplicate rows collapsed during the commit (see
            // DiffBundleIdMerge in lib/device-sync.ts).
            const params = new URLSearchParams();
            params.set("resync_added", String(result.added));
            params.set("resync_removed", String(result.removed));
            params.set("resync_orphaned", String(result.orphanedAndDeleted));
            if (result.merged > 0) {
              params.set("resync_merged", String(result.merged));
            }
            router.push(`/dashboard/settings/devices?${params.toString()}`);
          }}
          open={resyncOverlayOpen}
        />
      )}
    </div>
  );
}

// --- PolicyRunPanel ---------------------------------------------------------
//
// Full-width progress panel shown on step 5 once a policy run kicks off.
// Replaces the config form so the user can't accidentally edit settings mid-run.
