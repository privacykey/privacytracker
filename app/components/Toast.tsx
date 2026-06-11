"use client";

/**
 * Shared transient toast. Replaces the inline `{toast && <div
 * className="toast">{toast}</div>}` pattern, which unmounted the node
 * the instant the parent cleared its toast state — entrance animated,
 * exit just blinked away. This wrapper holds the last non-empty content
 * for the duration of the `toastOut` animation (globals.css) so the
 * dismissal is symmetric with the entrance.
 *
 * Usage: render unconditionally and pass the (possibly null) toast
 * content as children — `<Toast>{toast}</Toast>`. The component owns
 * the mount/unmount choreography.
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

/* Matches the `toastOut` animation duration in globals.css. */
const TOAST_OUT_MS = 200;

export default function Toast({
  children,
  role = "status",
  style,
}: {
  children?: ReactNode;
  role?: string;
  style?: CSSProperties;
}) {
  const [shown, setShown] = useState<ReactNode>(null);
  const [leaving, setLeaving] = useState(false);
  // Mirror of `shown` so the effect can test "is anything visible?"
  // without depending on the state value (which would re-run the exit
  // logic on its own updates).
  const shownRef = useRef<ReactNode>(null);

  useEffect(() => {
    if (children) {
      shownRef.current = children;
      setShown(children);
      setLeaving(false);
      return;
    }
    if (shownRef.current === null) {
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      shownRef.current = null;
      setShown(null);
      setLeaving(false);
    }, TOAST_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [children]);

  if (shown === null) {
    return null;
  }
  return (
    <div
      aria-hidden={leaving || undefined}
      className={`toast${leaving ? " toast-leaving" : ""}`}
      role={role}
      style={style}
    >
      {shown}
    </div>
  );
}
