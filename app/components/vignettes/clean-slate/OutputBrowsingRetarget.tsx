import PhoneFrame from "../PhoneFrame";
import CleanSlatePulses from "./CleanSlatePulses";

/**
 * BROWSING HISTORY · output A — "It followed you here".
 *
 * The everyday, visceral output of browsing data: you look at running
 * shoes on one site, and the exact pair shows up as an ad on a totally
 * unrelated app (a recipe site). A second phone wakes up and its ad
 * slot fills with the product you were just looking at.
 */
export default function OutputBrowsingRetarget() {
  const px = 206;
  const py = 16;
  const pw = 100;
  const sx = px + 6;
  const sw = pw - 12;

  return (
    <g className="v-cs v-cs-browse-retarget">
      <CleanSlatePulses y={84} />

      {/* "Unrelated app" label above the phone — kept clear of the
          frame so it never gets occluded. */}
      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="256"
        y="12"
      >
        A DIFFERENT, UNRELATED APP
      </text>

      <g className="v-cs-othersite">
        <PhoneFrame height={150} width={pw} x={px} y={py} />

        {/* Unrelated site header */}
        <text fontSize="9" x={sx + 2} y={py + 32}>
          🍳
        </text>
        <text
          fill="var(--text-2)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 14}
          y={py + 31}
        >
          RecipeBox
        </text>
        {/* A couple of filler lines under the header — just enough to
            read as "some other app's content" above the centred ad. */}
        <rect
          fill="var(--surface-active)"
          height="5"
          rx="2"
          width={sw - 4}
          x={sx + 2}
          y={py + 39}
        />
        <rect
          fill="var(--surface-active)"
          height="5"
          rx="2"
          width={sw - 18}
          x={sx + 2}
          y={py + 45}
        />
      </g>

      {/* The retargeted ad slot fills in late — the punchline.
          Vertically centred in the phone screen (rect centre = py+75 ≈
          screen centre). */}
      <g className="v-cs-adslot">
        <rect
          fill="var(--blue-soft, #dbeafe)"
          height="48"
          rx="6"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.2"
          width={sw}
          x={sx}
          y={py + 51}
        />
        <text
          fill="var(--blue, #2563eb)"
          fontSize="5.5"
          fontWeight="700"
          letterSpacing="0.4"
          x={sx + 4}
          y={py + 61}
        >
          AD · FOR YOU
        </text>
        <text fontSize="20" x={sx + 4} y={py + 85}>
          👟
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 30}
          y={py + 77}
        >
          Trail Runner
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="9"
          fontWeight="800"
          x={sx + 30}
          y={py + 89}
        >
          $129
        </text>
      </g>
    </g>
  );
}
