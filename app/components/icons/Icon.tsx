import type { SVGProps } from "react";
import {
  CATEGORY_ICON,
  ICON_PATHS,
  type IconName,
  type IconShape,
} from "./icon-paths";

export type { IconName } from "./icon-paths";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  /** Accessible name. Without one the icon is decorative (aria-hidden). */
  label?: string;
  name: IconName;
  /** Rendered size in CSS pixels; defaults to 1em so it follows the text. */
  size?: number | string;
}

/**
 * The product's line icon. One set, one stroke weight, `currentColor`, so
 * an icon takes the colour of the text or severity token beside it and
 * never introduces a second icon language next to the nav's SVGs.
 */
export function Icon({
  name,
  size = "1em",
  label,
  className,
  strokeWidth = 1.6,
  ...rest
}: IconProps) {
  const shapes: readonly IconShape[] = ICON_PATHS[name];
  const cls = ["ui-icon", `ui-icon-${name}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cls}
      fill="none"
      focusable="false"
      height={size}
      role={label ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      {shapes.map((shape, i) => {
        const key = `${name}-${i}`;
        if ("d" in shape) {
          return (
            <path
              d={shape.d}
              fill={shape.fill ? "currentColor" : undefined}
              key={key}
              stroke={shape.fill ? "none" : undefined}
            />
          );
        }
        if ("r" in shape) {
          return (
            <circle
              cx={shape.cx}
              cy={shape.cy}
              fill={shape.fill ? "currentColor" : undefined}
              key={key}
              r={shape.r}
              stroke={shape.fill ? "none" : undefined}
            />
          );
        }
        return (
          <rect
            height={shape.h}
            key={key}
            rx={shape.rx}
            width={shape.w}
            x={shape.x}
            y={shape.y}
          />
        );
      })}
    </svg>
  );
}

/** The icon for one of Apple's data categories; `package` for unknown keys. */
export function categoryIconName(categoryKey: string | null | undefined) {
  return (categoryKey && CATEGORY_ICON[categoryKey]) || "package";
}

/** A user's verdict on an app, as an icon: keep, replace or remove. */
export const VERDICT_ICON: Record<string, IconName> = {
  safe: "check",
  replace: "refresh",
  uninstall: "trash",
};

export function VerdictIcon({
  verdict,
  ...rest
}: Omit<IconProps, "name"> & { verdict: string }) {
  return <Icon name={VERDICT_ICON[verdict] ?? "check"} {...rest} />;
}

/** Privacy-profile preset icons, keyed by lib/privacy-profile preset key. */
export const PRESET_ICON: Record<string, IconName> = {
  strict: "shield-check",
  balanced: "scale",
  anti_tracking: "ban",
  permissive: "sun",
};

export function CategoryIcon({
  category,
  ...rest
}: Omit<IconProps, "name"> & { category: string | null | undefined }) {
  return <Icon name={categoryIconName(category)} {...rest} />;
}
