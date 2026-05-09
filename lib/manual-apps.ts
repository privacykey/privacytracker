/**
 * Client-safe module for manual-app types, enums, and presentation metadata.
 * **Do not import `db`, `scheduler`, or any Node built-in from here** — client
 * components import this file and Turbopack will happily drag whatever lands
 * here into the browser bundle.
 *
 * Server-side CRUD lives in `lib/manual-apps-server.ts`; API routes and
 * server components import from there.
 */

/**
 * The four flavours of "not on the App Store" we support. Everything else
 * the UI shows — picker copy, icons, badges — keys off this union so adding
 * a fifth is a single change to `MANUAL_APP_SOURCE_META`.
 */
export type ManualAppSource = 'web_clip' | 'testflight' | 'own_build' | 'sideloaded';

export const MANUAL_APP_SOURCES: ManualAppSource[] = [
  'web_clip',
  'testflight',
  'own_build',
  'sideloaded',
];

export function isManualAppSource(value: unknown): value is ManualAppSource {
  return typeof value === 'string' && (MANUAL_APP_SOURCES as string[]).includes(value);
}

export interface ManualAppSourceMeta {
  value: ManualAppSource;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
  /** True when a "source link" (TestFlight invite, GitHub repo, etc.) makes sense for this source. */
  supportsSourceUrl: boolean;
  /** Placeholder shown in the source-url input when applicable. */
  sourceUrlPlaceholder?: string;
}

export const MANUAL_APP_SOURCE_META: Record<ManualAppSource, ManualAppSourceMeta> = {
  web_clip: {
    value: 'web_clip',
    label: 'Safari web app',
    shortLabel: 'Web app',
    icon: '🔖',
    description:
      'A website added to your Home Screen as a web clip. No App Store listing or privacy labels exist — only what the site itself publishes.',
    supportsSourceUrl: true,
    sourceUrlPlaceholder: 'https://example.com',
  },
  testflight: {
    value: 'testflight',
    label: 'TestFlight beta',
    shortLabel: 'TestFlight',
    icon: '🧪',
    description:
      'An app installed via an Apple TestFlight invite. The production build may eventually ship to the App Store; until then you manage the privacy context manually.',
    supportsSourceUrl: true,
    sourceUrlPlaceholder: 'https://testflight.apple.com/join/…',
  },
  own_build: {
    value: 'own_build',
    label: 'Personal build',
    shortLabel: 'Personal',
    icon: '🛠',
    description:
      'An app you (or a developer you know) built and side-loaded via Xcode. Link the source repository if it is public so reviewers can inspect it.',
    supportsSourceUrl: true,
    sourceUrlPlaceholder: 'https://github.com/you/app-repo',
  },
  sideloaded: {
    value: 'sideloaded',
    label: 'Sideloaded',
    shortLabel: 'Sideloaded',
    icon: '📦',
    description:
      'An app installed from a third-party marketplace (EU DMA store, AltStore, enterprise deployment, etc.). The App Store is no longer the source of truth for its privacy posture.',
    supportsSourceUrl: true,
    sourceUrlPlaceholder: 'https://store.example/app/…',
  },
};

export interface ManualApp {
  id: string;
  name: string;
  source: ManualAppSource;
  developer: string | null;
  privacyPolicyUrl: string | null;
  sourceUrl: string | null;
  notes: string | null;
  firstSeen: number;
  updatedAt: number;
}

export interface ManualAppInput {
  name: string;
  source: ManualAppSource;
  developer?: string | null;
  privacyPolicyUrl?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
}
