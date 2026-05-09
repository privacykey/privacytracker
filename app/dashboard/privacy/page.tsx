import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { getAllApps, getGroupedPrivacyView } from '../../../lib/scraper';
import PrivacyGroupedView from '../../components/PrivacyGroupedView';
import Nav from '../../components/Nav';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('page_metadata');
  return {
    title: t('privacy_map_title'),
  };
}

export default function PrivacyPage() {
  if (resolveFlagFromDb('flag.page.privacy_map') !== 'on') notFound();

  let apps: any[] = [];
  let grouped: any[] = [];
  try {
    apps = getAllApps() as any[];
    grouped = getGroupedPrivacyView() as any[];
  } catch (error) {
    // DB not ready
    console.warn('[privacy] getAllApps/getGroupedPrivacyView failed:', error);
  }

  if (apps.length === 0) {
    redirect('/onboard');
  }

  return (
    <>
      <Nav />
      <PrivacyGroupedView initialData={grouped} />
    </>
  );
}
