/**
 * Onboarding layout — mounts the device-connect toast under every
 * /onboard route. The toast is gated on `cfgutil_imported_at` + IOKit
 * event delivery, so it only surfaces for users who've used cfgutil
 * before and who plug in a device while in the import flow.
 */

import type { ReactNode } from 'react';
import DeviceConnectedToast from '../components/DeviceConnectedToast';

export default function OnboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DeviceConnectedToast />
      {children}
    </>
  );
}
