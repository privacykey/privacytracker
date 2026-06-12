"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useFlag } from "../../lib/feature-flags-hooks";
import { useModalFocus } from "../../lib/use-modal-focus";

interface Props {
  onClose: () => void;
  open: boolean;
}

/**
 * Step-by-step how-to for copying app names out of an iPhone screenshot using
 * Apple's built-in Live Text. No OCR runs in the browser — the user lets iOS
 * do the work (it's faster, more accurate, and offline), then pastes the
 * result into the "Type app names" textarea on the previous step.
 *
 * Opened from the manual-entry panel on phone + tablet devices. The modal
 * reuses the existing `.modal-overlay` / `.modal-card` classes so it matches
 * the cancel / restore dialogs stylistically. Escape + click-outside close;
 * focus lands on the "Got it" button once the dialog is mounted.
 */
export default function LiveTextModal({ open, onClose }: Props) {
  // i18n — every visible string in the modal chrome reads from
  // `live_text_modal.*`. The inline SVG illustration deliberately
  // stays in English since it mocks the iOS Storage screen visually
  // and its labels are recognised graphically as iOS UI.
  const t = useTranslations("live_text_modal");

  // Wave I: gate the whole modal behind `flag.global.live_text_modal`.
  // Off in the minimal accessibility focus where the on-device OCR walk-
  // through adds noise. The trigger in OnboardWizard stays — this just
  // means the modal renders nothing when the user clicks it under that
  // focus, which is a safe no-op (the textarea below is the real input).
  const liveTextOn = useFlag("flag.global.live_text_modal") === "on";

  const liveTextModalRef = useModalFocus<HTMLDivElement>({
    open,
    onClose,
    closeOnEscape: true,
  });

  // Keep the page behind the modal from scrolling.
  useEffect(() => {
    if (!open) {
      return;
    }
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  if (!open) {
    return null;
  }
  if (!liveTextOn) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        aria-labelledby="live-text-modal-title"
        aria-modal="true"
        className="modal-card live-text-modal"
        onClick={(event) => event.stopPropagation()}
        ref={liveTextModalRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* Dedicated close button — the only obvious dismiss affordance on
            touch devices where Escape isn't available and backdrop taps can
            feel accidental. Positioned absolutely so it floats over the
            badge / title without stealing their space. */}
        <button
          aria-label={t("close_aria")}
          className="live-text-modal-close"
          onClick={onClose}
          type="button"
        >
          <svg
            aria-hidden="true"
            focusable="false"
            height="16"
            viewBox="0 0 16 16"
            width="16"
          >
            <path
              d="M4 4 L12 12 M12 4 L4 12"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
            />
          </svg>
        </button>

        {/* Scrollable body — keeps the modal card bounded to the viewport on
            small phones so borders stay visible even when the how-to grid
            doesn't fit. The "Got it" footer sits outside this so it's
            always reachable without scrolling. */}
        <div className="live-text-modal-body">
          <div className="modal-badge">{t("badge")}</div>
          <h2 className="modal-title" id="live-text-modal-title">
            {t("title")}
          </h2>
          <p className="modal-copy">{t("copy")}</p>

          <div className="live-text-howto">
            <div className="live-text-steps">
              <ol>
                <li>
                  {t.rich("step_1", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </li>
                <li>
                  {t.rich("step_2", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </li>
                <li>
                  {t.rich("step_3", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </li>
                <li>
                  {t.rich("step_4", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    em: (chunks) => <em>{chunks}</em>,
                  })}
                </li>
              </ol>
            </div>
            <div aria-hidden="true" className="live-text-illustration">
              <LiveTextIllustration />
            </div>
          </div>

          <p className="live-text-tip">
            {t.rich("tip", { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose} type="button">
            {t("got_it")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline SVG illustration of an iPhone-shaped frame containing a mocked-up
 * "iPhone Storage" list, with the Live Text button in the bottom-right
 * corner highlighted by a soft halo + label arrow. SVG is inlined (rather
 * than loaded from /public) because it has to tint correctly in both the
 * dark and light themes; inline strokes/fills pick up CSS custom properties.
 */
function LiveTextIllustration() {
  return (
    <svg
      aria-hidden="true"
      height="auto"
      style={{ maxWidth: 220 }}
      viewBox="0 0 260 500"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Phone frame */}
      <rect
        fill="var(--surface-2, #1c1c1e)"
        height="488"
        rx="40"
        ry="40"
        stroke="var(--border, #3a3a3c)"
        strokeWidth="3"
        width="248"
        x="6"
        y="6"
      />
      {/* Screen */}
      <rect
        fill="var(--surface, #0b0b0d)"
        height="464"
        rx="30"
        ry="30"
        width="224"
        x="18"
        y="18"
      />
      {/* Dynamic island */}
      <rect fill="#000" height="16" rx="8" ry="8" width="60" x="100" y="28" />

      {/* Status bar */}
      <text
        fill="var(--text, #fff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="11"
        fontWeight="600"
        x="40"
        y="62"
      >
        9:41
      </text>

      {/* Nav header */}
      <text
        fill="var(--blue, #0a84ff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="13"
        x="30"
        y="92"
      >
        &lt; General
      </text>
      <text
        fill="var(--text, #fff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="18"
        fontWeight="700"
        x="30"
        y="120"
      >
        iPhone Storage
      </text>

      {/* Storage bar */}
      <rect
        fill="#2c2c2e"
        height="8"
        rx="4"
        ry="4"
        width="200"
        x="30"
        y="134"
      />
      <rect
        fill="var(--blue, #0a84ff)"
        height="8"
        rx="4"
        ry="4"
        width="140"
        x="30"
        y="134"
      />

      {/* App rows */}
      {[
        { name: "Instagram", size: "412 MB", y: 170 },
        { name: "WhatsApp", size: "1.3 GB", y: 210 },
        { name: "Spotify", size: "287 MB", y: 250 },
        { name: "CommBank", size: "118 MB", y: 290 },
        { name: "Strava", size: "94 MB", y: 330 },
        { name: "Uber", size: "212 MB", y: 370 },
      ].map((row) => (
        <g key={row.name}>
          <rect
            fill="#3a3a3c"
            height="28"
            rx="6"
            ry="6"
            width="28"
            x="30"
            y={row.y - 14}
          />
          <text
            fill="var(--text, #fff)"
            fontFamily="-apple-system, system-ui, sans-serif"
            fontSize="12"
            fontWeight="600"
            x="68"
            y={row.y + 2}
          >
            {row.name}
          </text>
          <text
            fill="var(--text-2, #8e8e93)"
            fontFamily="-apple-system, system-ui, sans-serif"
            fontSize="11"
            textAnchor="end"
            x="225"
            y={row.y + 2}
          >
            {row.size}
          </text>
          <line
            stroke="#2c2c2e"
            strokeWidth="0.5"
            x1="68"
            x2="230"
            y1={row.y + 14}
            y2={row.y + 14}
          />
        </g>
      ))}

      {/* Live Text halo */}
      <circle
        cx="214"
        cy="446"
        fill="none"
        opacity="0.85"
        r="22"
        stroke="var(--blue, #0a84ff)"
        strokeWidth="3"
      >
        <animate
          attributeName="r"
          dur="2.2s"
          repeatCount="indefinite"
          values="20;26;20"
        />
        <animate
          attributeName="opacity"
          dur="2.2s"
          repeatCount="indefinite"
          values="0.85;0.35;0.85"
        />
      </circle>

      {/* Live Text button (three lines in a frame) */}
      <rect
        fill="var(--surface-2, #1c1c1e)"
        height="28"
        rx="6"
        ry="6"
        stroke="var(--text, #fff)"
        strokeWidth="1.5"
        width="28"
        x="200"
        y="432"
      />
      <line
        stroke="var(--text, #fff)"
        strokeWidth="1.5"
        x1="205"
        x2="219"
        y1="439"
        y2="439"
      />
      <line
        stroke="var(--text, #fff)"
        strokeWidth="1.5"
        x1="205"
        x2="223"
        y1="446"
        y2="446"
      />
      <line
        stroke="var(--text, #fff)"
        strokeWidth="1.5"
        x1="205"
        x2="215"
        y1="453"
        y2="453"
      />

      {/* Pointer arrow + label */}
      <path
        d="M 170 446 L 196 446"
        stroke="var(--blue, #0a84ff)"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M 196 446 L 191 442 M 196 446 L 191 450"
        fill="none"
        stroke="var(--blue, #0a84ff)"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <text
        fill="var(--blue, #0a84ff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="10"
        fontWeight="600"
        textAnchor="end"
        x="165"
        y="450"
      >
        Live Text
      </text>
    </svg>
  );
}
