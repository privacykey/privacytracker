/**
 * Shared date-format helper. Stores the user's preference under
 * `app_settings.date_format`; valid values:
 *
 *   'auto' — browser locale (default)
 *   'dmy'  — 31/12/2025
 *   'mdy'  — 12/31/2025
 *   'iso'  — 2025-12-31
 *
 * Clients call `formatDate(ms, mode)`. Server components read the
 * preference via `lib/date-format-server.ts`.
 */

export type DateFormatMode = 'auto' | 'dmy' | 'mdy' | 'iso';

export const DATE_FORMAT_MODES: ReadonlyArray<DateFormatMode> = [
  'auto', 'dmy', 'mdy', 'iso',
];

export const DATE_FORMAT_DEFAULT: DateFormatMode = 'auto';

/**
 * Coerce an arbitrary string to a known `DateFormatMode` — falls back
 * to `auto` for anything unrecognised.
 */
export function normaliseDateFormat(raw: string | null | undefined): DateFormatMode {
  if (raw === 'dmy' || raw === 'mdy' || raw === 'iso' || raw === 'auto') {
    return raw;
  }
  return DATE_FORMAT_DEFAULT;
}

interface FormatOpts {
  /** Include time-of-day after the date. Default false (date only). */
  withTime?: boolean;
  /** When `withTime` is true, include seconds. Default false. */
  withSeconds?: boolean;
}

/**
 * Format `epochMs` as a date according to `mode`. Safe on both
 * server and client. Returns an empty string for non-finite inputs.
 */
export function formatDate(
  epochMs: number | null | undefined,
  mode: DateFormatMode = DATE_FORMAT_DEFAULT,
  opts: FormatOpts = {},
): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  // ISO is the only fixed-format mode; the rest go through Intl.DateTimeFormat.
  if (mode === 'iso') {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    let stamp = `${yyyy}-${mm}-${dd}`;
    if (opts.withTime) {
      const hh = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');
      stamp += ` ${hh}:${min}`;
      if (opts.withSeconds) {
        const ss = String(date.getSeconds()).padStart(2, '0');
        stamp += `:${ss}`;
      }
    }
    return stamp;
  }

  // dmy/mdy use locales that produce the desired numeric ordering.
  // We don't expose the locale to callers — picking a date format
  // shouldn't accidentally translate month names too.
  const locale =
    mode === 'dmy' ? 'en-GB'
    : mode === 'mdy' ? 'en-US'
    : undefined;

  const dtfOpts: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: 'numeric',
  };
  // dmy/mdy: purely numeric so the format is unambiguous.
  if (mode === 'dmy' || mode === 'mdy') {
    dtfOpts.month = '2-digit';
    dtfOpts.day = '2-digit';
  }
  if (opts.withTime) {
    dtfOpts.hour = 'numeric';
    dtfOpts.minute = '2-digit';
    if (opts.withSeconds) dtfOpts.second = '2-digit';
  }
  try {
    return new Intl.DateTimeFormat(locale, dtfOpts).format(date);
  } catch {
    // ICU unavailable — fall back to ISO.
    return formatDate(epochMs, 'iso', opts);
  }
}

/** Sample value renderer for the Settings dropdown preview. */
export function describeDateFormat(mode: DateFormatMode): string {
  const reference = new Date(2025, 11, 31, 14, 5).getTime();
  return formatDate(reference, mode);
}
