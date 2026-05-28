import type { SVGProps } from "react";

type PrivacyTypeIconId =
  | "DATA_NOT_COLLECTED"
  | "DATA_NOT_LINKED_TO_YOU"
  | "DATA_LINKED_TO_YOU"
  | "DATA_USED_TO_TRACK_YOU"
  | "not_collected"
  | "not_linked"
  | "linked"
  | "tracking";

interface PrivacyTypeIconProps extends SVGProps<SVGSVGElement> {
  identifier?: string | null;
  tier?: string | null;
}

function normaliseIconId({
  identifier,
  tier,
}: Pick<PrivacyTypeIconProps, "identifier" | "tier">): PrivacyTypeIconId {
  const value = identifier ?? tier;
  if (
    value === "DATA_NOT_LINKED_TO_YOU" ||
    value === "DATA_NOT_COLLECTED" ||
    value === "DATA_LINKED_TO_YOU" ||
    value === "DATA_USED_TO_TRACK_YOU" ||
    value === "not_collected" ||
    value === "not_linked" ||
    value === "linked" ||
    value === "tracking"
  ) {
    return value;
  }
  return "not_collected";
}

function NotCollectedIcon() {
  return (
    <>
      <circle cx="12" cy="12" r="8.15" />
      <path d="M8.25 12.15 10.65 14.55 15.8 9.3" strokeWidth="2.25" />
    </>
  );
}

function PersonInCircle() {
  return (
    <>
      <circle cx="12" cy="12" r="8.15" />
      <path d="M7.9 17.05c.85-3.25 7.35-3.25 8.2 0" />
      <circle className="privacy-type-icon__node" cx="12" cy="9.1" r="2.05" />
    </>
  );
}

function FilledPerson() {
  return (
    <>
      <circle className="privacy-type-icon__node" cx="12" cy="9.45" r="2.3" />
      <path
        className="privacy-type-icon__node"
        d="M7.55 18.2c.46-3.25 2.15-4.85 4.45-4.85s3.99 1.6 4.45 4.85c.1.73-.45 1.27-1.2 1.27h-6.5c-.75 0-1.3-.54-1.2-1.27Z"
      />
    </>
  );
}

function NotLinkedIcon() {
  return (
    <>
      <PersonInCircle />
      <path d="M7.25 18.65 16.75 5.35" strokeWidth="2.25" />
    </>
  );
}

function LinkedIcon() {
  return <PersonInCircle />;
}

function TrackingIcon() {
  return (
    <>
      <path d="M4.9 8.25V5.35h2.9" strokeWidth="2.05" />
      <path d="M16.2 5.35h2.9v2.9" strokeWidth="2.05" />
      <path d="M19.1 15.75v2.9h-2.9" strokeWidth="2.05" />
      <path d="M7.8 18.65H4.9v-2.9" strokeWidth="2.05" />
      <FilledPerson />
    </>
  );
}

export default function PrivacyTypeIcon({
  className,
  identifier,
  tier,
  ...svgProps
}: PrivacyTypeIconProps) {
  const iconId = normaliseIconId({ identifier, tier });
  const cls = ["privacy-type-icon", className].filter(Boolean).join(" ");

  return (
    <svg
      aria-hidden="true"
      className={cls}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...svgProps}
    >
      {iconId === "DATA_NOT_COLLECTED" || iconId === "not_collected" ? (
        <NotCollectedIcon />
      ) : iconId === "DATA_NOT_LINKED_TO_YOU" || iconId === "not_linked" ? (
        <NotLinkedIcon />
      ) : iconId === "DATA_LINKED_TO_YOU" || iconId === "linked" ? (
        <LinkedIcon />
      ) : (
        <TrackingIcon />
      )}
    </svg>
  );
}
