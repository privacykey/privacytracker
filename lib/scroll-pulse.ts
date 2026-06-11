/**
 * Shared scroll-into-view + pulse choreography for deep-link targets.
 *
 * Four surfaces (Privacy Map cards, changelog timeline rows, settings
 * sections, home-dashboard sections) all do the same dance when the user
 * arrives via a hash / chip / notification link: scroll the target into
 * view, flash a pulse animation on it, and clear the pulse after the
 * keyframes finish. They each hand-rolled the rAF + timeout pair; this
 * helper owns it once.
 *
 * Choreography contract:
 * - The pulse is switched OFF synchronously, then ON one frame later
 *   (inside requestAnimationFrame). The one-frame gap lets the browser
 *   paint the neutral state first, which guarantees the keyframes
 *   restart from 0% on repeat triggers instead of skipping straight to
 *   the settled values — no `void el.offsetWidth` reflow hack needed.
 * - Scrolling respects `prefers-reduced-motion`: an explicit
 *   `behavior: "smooth"` bypasses the CSS `scroll-behavior: auto`
 *   override in globals.css, so the JS side has to downgrade to an
 *   instant jump itself.
 * - Re-triggering on an element with a pulse already in flight cancels
 *   the stale timer first, so a rapid second click can't cut the new
 *   pulse short when the first timer fires.
 *
 * The returned cancel function clears the pending frame and timer —
 * return it from a useEffect so an unmount can't fire a stale timeout
 * (it intentionally does NOT toggle the pulse off; the element is
 * either gone or about to re-run the choreography).
 */

export interface ScrollPulseOptions {
  /** scrollIntoView alignment. Defaults to "start". */
  block?: ScrollLogicalPosition;
  /** Class-based pulse: toggled directly on the element. */
  className?: string;
  /** How long the pulse stays on. Slightly longer than the CSS
      animation so the final keyframe isn't clipped. Default 1900. */
  durationMs?: number;
  /** State-based pulse: invoked with true/false instead of a class.
      Preferred inside components so the React reconciler can't strip
      a class during a concurrent re-render. */
  onPulse?: (pulsing: boolean) => void;
}

const activePulses = new WeakMap<Element, () => void>();

export function scrollPulse(
  el: HTMLElement,
  options: ScrollPulseOptions = {}
): () => void {
  activePulses.get(el)?.();

  const { className, onPulse, block = "start", durationMs = 1900 } = options;
  const reduceMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const setPulse = (pulsing: boolean) => {
    if (className) {
      el.classList.toggle(className, pulsing);
    }
    onPulse?.(pulsing);
  };

  setPulse(false);
  const rafId = requestAnimationFrame(() => {
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block });
    setPulse(true);
  });
  const timer = window.setTimeout(() => {
    setPulse(false);
    activePulses.delete(el);
  }, durationMs);

  const cancel = () => {
    cancelAnimationFrame(rafId);
    window.clearTimeout(timer);
    activePulses.delete(el);
  };
  activePulses.set(el, cancel);
  return cancel;
}
