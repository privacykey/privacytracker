'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useFlag } from '../../lib/feature-flags-hooks';

interface Props {
  open: boolean;
  onClose: () => void;
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
  const t = useTranslations('live_text_modal');

  // Wave I: gate the whole modal behind `flag.global.live_text_modal`.
  // Off in the minimal accessibility focus where the on-device OCR walk-
  // through adds noise. The trigger in OnboardWizard stays — this just
  // means the modal renders nothing when the user clicks it under that
  // focus, which is a safe no-op (the textarea below is the real input).
  const liveTextOn = useFlag('flag.global.live_text_modal') === 'on';

  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  // Autofocus the primary action on open, and keep the page behind the modal
  // from scrolling. A tiny timeout gives React a tick to mount the node
  // before we poke at its ref.
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handle = setTimeout(() => confirmButtonRef.current?.focus(), 30);
    return () => {
      clearTimeout(handle);
      document.body.style.overflow = original;
    };
  }, [open]);

  if (!open) return null;
  if (!liveTextOn) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card live-text-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="live-text-modal-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
      >
        {/* Dedicated close button — the only obvious dismiss affordance on
            touch devices where Escape isn't available and backdrop taps can
            feel accidental. Positioned absolutely so it floats over the
            badge / title without stealing their space. */}
        <button
          type="button"
          className="live-text-modal-close"
          aria-label={t('close_aria')}
          onClick={onClose}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M4 4 L12 12 M12 4 L4 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {/* Scrollable body — keeps the modal card bounded to the viewport on
            small phones so borders stay visible even when the how-to grid
            doesn't fit. The "Got it" footer sits outside this so it's
            always reachable without scrolling. */}
        <div className="live-text-modal-body">
          <div className="modal-badge">{t('badge')}</div>
          <h2 id="live-text-modal-title" className="modal-title">
            {t('title')}
          </h2>
          <p className="modal-copy">{t('copy')}</p>

          <div className="live-text-howto">
            <div className="live-text-steps">
              <ol>
                <li>
                  {t.rich('step_1', { strong: chunks => <strong>{chunks}</strong> })}
                </li>
                <li>
                  {t.rich('step_2', { strong: chunks => <strong>{chunks}</strong> })}
                </li>
                <li>
                  {t.rich('step_3', { strong: chunks => <strong>{chunks}</strong> })}
                </li>
                <li>
                  {t.rich('step_4', {
                    strong: chunks => <strong>{chunks}</strong>,
                    em: chunks => <em>{chunks}</em>,
                  })}
                </li>
              </ol>
            </div>
            <div className="live-text-illustration" aria-hidden="true">
              <LiveTextIllustration />
            </div>
          </div>

          <p className="live-text-tip">
            {t.rich('tip', { strong: chunks => <strong>{chunks}</strong> })}
          </p>
        </div>

        <div className="modal-actions">
          <button
            ref={confirmButtonRef}
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            {t('got_it')}
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
      viewBox="0 0 260 500"
      width="100%"
      height="auto"
      style={{ maxWidth: 220 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Phone frame */}
      <rect
        x="6"
        y="6"
        width="248"
        height="488"
        rx="40"
        ry="40"
        fill="var(--surface-2, #1c1c1e)"
        stroke="var(--border, #3a3a3c)"
        strokeWidth="3"
      />
      {/* Screen */}
      <rect
        x="18"
        y="18"
        width="224"
        height="464"
        rx="30"
        ry="30"
        fill="var(--surface, #0b0b0d)"
      />
      {/* Dynamic island */}
      <rect x="100" y="28" width="60" height="16" rx="8" ry="8" fill="#000" />

      {/* Status bar */}
      <text
        x="40"
        y="62"
        fill="var(--text, #fff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="11"
        fontWeight="600"
      >
        9:41
      </text>

      {/* Nav header */}
      <text
        x="30"
        y="92"
        fill="var(--blue, #0a84ff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="13"
      >
        &lt; General
      </text>
      <text
        x="30"
        y="120"
        fill="var(--text, #fff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="18"
        fontWeight="700"
      >
        iPhone Storage
      </text>

      {/* Storage bar */}
      <rect x="30" y="134" width="200" height="8" rx="4" ry="4" fill="#2c2c2e" />
      <rect x="30" y="134" width="140" height="8" rx="4" ry="4" fill="var(--blue, #0a84ff)" />

      {/* App rows */}
      {[
        { name: 'Instagram', size: '412 MB', y: 170 },
        { name: 'WhatsApp', size: '1.3 GB', y: 210 },
        { name: 'Spotify', size: '287 MB', y: 250 },
        { name: 'CommBank', size: '118 MB', y: 290 },
        { name: 'Strava', size: '94 MB', y: 330 },
        { name: 'Uber', size: '212 MB', y: 370 },
      ].map(row => (
        <g key={row.name}>
          <rect x="30" y={row.y - 14} width="28" height="28" rx="6" ry="6" fill="#3a3a3c" />
          <text
            x="68"
            y={row.y + 2}
            fill="var(--text, #fff)"
            fontFamily="-apple-system, system-ui, sans-serif"
            fontSize="12"
            fontWeight="600"
          >
            {row.name}
          </text>
          <text
            x="225"
            y={row.y + 2}
            fill="var(--text-2, #8e8e93)"
            fontFamily="-apple-system, system-ui, sans-serif"
            fontSize="11"
            textAnchor="end"
          >
            {row.size}
          </text>
          <line
            x1="68"
            x2="230"
            y1={row.y + 14}
            y2={row.y + 14}
            stroke="#2c2c2e"
            strokeWidth="0.5"
          />
        </g>
      ))}

      {/* Live Text halo */}
      <circle
        cx="214"
        cy="446"
        r="22"
        fill="none"
        stroke="var(--blue, #0a84ff)"
        strokeWidth="3"
        opacity="0.85"
      >
        <animate
          attributeName="r"
          values="20;26;20"
          dur="2.2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0.85;0.35;0.85"
          dur="2.2s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Live Text button (three lines in a frame) */}
      <rect
        x="200"
        y="432"
        width="28"
        height="28"
        rx="6"
        ry="6"
        fill="var(--surface-2, #1c1c1e)"
        stroke="var(--text, #fff)"
        strokeWidth="1.5"
      />
      <line x1="205" x2="219" y1="439" y2="439" stroke="var(--text, #fff)" strokeWidth="1.5" />
      <line x1="205" x2="223" y1="446" y2="446" stroke="var(--text, #fff)" strokeWidth="1.5" />
      <line x1="205" x2="215" y1="453" y2="453" stroke="var(--text, #fff)" strokeWidth="1.5" />

      {/* Pointer arrow + label */}
      <path
        d="M 170 446 L 196 446"
        stroke="var(--blue, #0a84ff)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M 196 446 L 191 442 M 196 446 L 191 450"
        stroke="var(--blue, #0a84ff)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <text
        x="165"
        y="450"
        fill="var(--blue, #0a84ff)"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="10"
        fontWeight="600"
        textAnchor="end"
      >
        Live Text
      </text>
    </svg>
  );
}
