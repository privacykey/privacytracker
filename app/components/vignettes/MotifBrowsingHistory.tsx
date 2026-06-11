/**
 * Mini browser; URL bar types in a domain; tabs accumulate beneath it.
 */
export default function MotifBrowsingHistory() {
  return (
    <g className="v-motif-browsing">
      <rect
        fill="var(--surface)"
        height="124"
        rx="6"
        stroke="var(--border-strong)"
        width="124"
        x="10"
        y="22"
      />
      {/* Chrome bar */}
      <rect
        fill="var(--surface-active)"
        height="18"
        rx="6"
        width="124"
        x="10"
        y="22"
      />
      <circle cx="18" cy="31" fill="var(--red, #dc2626)" r="2" />
      <circle cx="25" cy="31" fill="#f59e0b" r="2" />
      <circle cx="32" cy="31" fill="var(--green, #16a34a)" r="2" />
      {/* URL bar */}
      <rect
        fill="var(--surface)"
        height="10"
        rx="2"
        stroke="var(--border)"
        width="84"
        x="42"
        y="26"
      />
      <g className="v-url">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6"
          x="46"
          y="33"
        >
          browsinghistory
        </text>
      </g>

      {/* Tabs that pop in one by one */}
      <g className="v-tab v-tab-1">
        <rect
          fill="var(--surface-active)"
          height="12"
          rx="2"
          width="108"
          x="18"
          y="50"
        />
        <text fill="var(--text-2)" fontSize="7" x="22" y="59">
          📄 recipes.com
        </text>
      </g>
      <g className="v-tab v-tab-2">
        <rect
          fill="var(--surface-active)"
          height="12"
          rx="2"
          width="108"
          x="18"
          y="66"
        />
        <text fill="var(--text-2)" fontSize="7" x="22" y="75">
          📄 marathon-training.com
        </text>
      </g>
      <g className="v-tab v-tab-3">
        <rect
          fill="var(--blue-soft, #dbeafe)"
          height="12"
          rx="2"
          width="108"
          x="18"
          y="82"
        />
        <text
          fill="var(--blue, #2563eb)"
          fontSize="7"
          fontWeight="700"
          x="22"
          y="91"
        >
          📄 running-shoes.com
        </text>
      </g>
      <g className="v-tab v-tab-4">
        <rect
          fill="var(--surface-active)"
          height="12"
          rx="2"
          width="108"
          x="18"
          y="98"
        />
        <text fill="var(--text-2)" fontSize="7" x="22" y="107">
          📄 sportswear-deals.net
        </text>
      </g>
    </g>
  );
}
