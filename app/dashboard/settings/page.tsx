import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAllApps } from '../../../lib/scraper';
import SettingsView from '../../components/SettingsView';
import Nav from '../../components/Nav';
import YourFocusCard from '../../components/YourFocusCard';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('page_metadata');
  return {
    title: t('settings_title'),
    description: t('settings_description'),
  };
}

export default function SettingsPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready
    console.warn('[settings-page] getAllApps failed:', error);
  }

  if (apps.length === 0) {
    redirect('/onboard');
  }

  // YourFocusCard is a server component (synchronous DB read of the
  // active focus). We pass it down as a child prop so the client-side
  // SettingsView can slot it in at the top without needing to import a
  // server component directly.
  return (
    <>
      <Nav />
      <SettingsView focusCard={<YourFocusCard />} />
    </>
  );
}
