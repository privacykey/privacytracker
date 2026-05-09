import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import GoalsScreen from '../../components/GoalsScreen';
import { getActiveFocus } from '@/lib/feature-flag-storage';
import { getSetting } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('page_metadata');
  return {
    title: t('onboard_goals_title'),
  };
}

/**
 * Onboarding screen 2 — goals picker.
 *
 * Reads the audience the user picked on screen 1 (they should have just
 * come from /welcome). If somehow the audience isn't set yet (deep link,
 * race), bounces back to /welcome to pick one first.
 *
 * Pre-fills the goal checkboxes for any user whose goals have already
 * been written to app_settings — that covers (a) revisit via Settings →
 * Focus → Adjust and (b) mid-flow browser-back navigation, where the
 * user already passed through this screen once and we don't want their
 * picks to disappear when they navigate back to verify or change them.
 * Each goal flag is checked individually so users with a partial set
 * (e.g. picked declutter on the first pass) see exactly that.
 */
export default function OnboardGoalsPage() {
  const focus = (() => {
    try {
      return getActiveFocus();
    } catch {
      return null;
    }
  })();

  // If audience isn't explicitly stored, send the user back to screen 1.
  // `getActiveFocus()` falls back to 'self' when nothing's stored, so we
  // check the underlying app_settings key directly: it's only present after
  // screen 1's /api/focus POST or the v1 migration ran.
  const audienceStored = getSetting('flag.focus.audience', '') !== '';
  if (!audienceStored || !focus) {
    redirect('/welcome');
  }

  const audience = focus.audience;

  // Pre-fill from existing focus state whenever ANY goal has been
  // written to app_settings — this catches both the Settings revisit
  // case and the mid-onboarding browser-back case. We probe the keys
  // individually rather than reusing focus.goals because the resolver
  // applies audience/goal rule defaults that we want to ignore here:
  // we only want to restore *explicitly user-picked* goals.
  const hasStoredGoal =
    getSetting('flag.focus.goal.understand', '') !== '' ||
    getSetting('flag.focus.goal.declutter', '') !== '' ||
    getSetting('flag.focus.goal.minimal', '') !== '' ||
    getSetting('flag.focus.goal.accessibility', '') !== '';

  const initialUnderstand = hasStoredGoal
    ? getSetting('flag.focus.goal.understand', '') === 'true'
    : undefined;
  const initialDeclutter = hasStoredGoal
    ? getSetting('flag.focus.goal.declutter', '') === 'true'
    : undefined;
  const initialMinimal = hasStoredGoal
    ? getSetting('flag.focus.goal.minimal', '') === 'true'
    : undefined;
  const initialAccessibility = hasStoredGoal
    ? getSetting('flag.focus.goal.accessibility', '') === 'true'
    : undefined;

  return (
    <GoalsScreen
      audience={audience}
      initialUnderstand={initialUnderstand}
      initialDeclutter={initialDeclutter}
      initialMinimal={initialMinimal}
      initialAccessibility={initialAccessibility}
    />
  );
}
