/**
 * Shared device-class detection used to tailor the onboarding wizard.
 * Classifies into `'phone' | 'tablet' | 'desktop'` to choose the right
 * primary import path. Detection runs server-side from the User-Agent
 * (no hydration flash) and is refined client-side via viewport + touch
 * points. Dependency-free so it imports cleanly into both bundles.
 */

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

/**
 * Cheap User-Agent sniff. Not perfect — UA strings lie — but good enough
 * for an SSR default before client refinement.
 */
export function detectDeviceFromUA(userAgent: string | null | undefined): DeviceClass {
  const ua = (userAgent ?? '').toString();
  if (!ua) return 'desktop';

  if (/iPad/i.test(ua)) return 'tablet';
  if (/iPhone|iPod/i.test(ua)) return 'phone';
  // Android: the "Mobile" substring distinguishes phones from tablets.
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'phone' : 'tablet';

  if (/Mobi|Opera Mini|IEMobile/i.test(ua)) return 'phone';
  if (/Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';

  return 'desktop';
}

/**
 * Client-side refinement over the SSR guess — call from useEffect.
 * Rules: MacIntel + touch points → tablet (desktop-mode iPad); width
 * ≤600 px → phone; width 601–1023 px + touch → tablet; otherwise the
 * original `initial`.
 */
export function refineDeviceOnClient(initial: DeviceClass): DeviceClass {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return initial;

  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const touchPoints = typeof (navigator as any).maxTouchPoints === 'number'
    ? ((navigator as any).maxTouchPoints as number)
    : 0;
  const platform = ((navigator as any).platform as string | undefined) ?? '';
  const isDesktopModeIpad = platform === 'MacIntel' && touchPoints > 1;

  if (isDesktopModeIpad) return 'tablet';

  if (width > 0 && width <= 600) return 'phone';
  if (width > 0 && width <= 1023 && touchPoints > 0) return 'tablet';

  return initial;
}
