"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useUserTasks } from "./UserTasksProvider";

/**
 * Inline alert for failed user-task mutations. Mounted inside both the
 * nav dropdown / mobile sheet (TaskListIcon) and the dashboard card
 * (TaskListInteractive) so a click the server rejected is explained
 * where the user clicked, instead of dying in the console. 401/403 name
 * the proxy security gate and deep-link the admin-token login — the
 * same remedy the onboarding search error surfaces.
 */
export default function UserTasksMutationAlert() {
  const t = useTranslations("tasks");
  const { mutationError } = useUserTasks();
  if (!mutationError) {
    return null;
  }
  const blocked = mutationError.status === 401 || mutationError.status === 403;
  return (
    <p className="task-list-mutation-alert" role="alert">
      {blocked ? (
        <>
          {t("mutation_blocked", { status: mutationError.status })}{" "}
          <Link href="/dashboard/settings#deployment-diagnostics">
            {t("mutation_blocked_link")}
          </Link>
        </>
      ) : mutationError.status === 0 ? (
        t("mutation_failed_network")
      ) : (
        t("mutation_failed", { status: mutationError.status })
      )}
    </p>
  );
}
