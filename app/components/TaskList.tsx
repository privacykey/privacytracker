import { resolveAllTasks, resolveOptInCandidates } from '../../lib/tasks-server';
import { type OptInCandidate, type ResolvedTask } from '../../lib/tasks';
import TaskListInteractive from './TaskListInteractive';
import './task-list.css';

/**
 * Inline tasks panel — first child of HomeView. Server component so the
 * first paint already has the right task list + audience copy (no flash
 * of empty rows during hydration).
 *
 * Returns null when there's nothing to show — neither active/completed
 * tasks nor opt-in candidates. The chip tray surfaces extras even when
 * the auto-included task list is empty (e.g. user dismissed everything
 * and now wants to add a new task).
 */

interface TaskListProps {
  /** Server-resolved tasks. The HomeView server caller passes them in so
   *  the panel renders without a fetch. May be omitted in non-dashboard
   *  contexts. */
  tasks?: ResolvedTask[];
  /** Server-resolved opt-in candidates for the "Add a task" chip tray. */
  candidates?: OptInCandidate[];
}

export default function TaskList({ tasks: tasksProp, candidates: candidatesProp }: TaskListProps) {
  const tasks = tasksProp ?? safeResolveTasks();
  const candidates = candidatesProp ?? safeResolveCandidates();

  if (tasks.length === 0 && candidates.length === 0) return null;

  const audience = tasks[0]?.audience ?? 'self';
  // Visible-on-server = everything that's not dismissed. Completed rows
  // stay visible so users see progress (CSS strikes the title through
  // and the glyph flips to ✓).
  const visibleRows = tasks.filter(x => x.state !== 'dismissed');

  // `aria-label` translation happens client-side inside TaskListInteractive
  // — server-side `getTranslations` worked too, but pushing the label down
  // keeps this component free of i18n-server imports and avoids a second
  // bundle of next-intl's server runtime just for the wrapper.
  return (
    <section
      className="task-list-card"
      data-tour="task-list"
      aria-labelledby="task-list-heading"
    >
      <TaskListInteractive
        initialTasks={tasks}
        initialCandidates={candidates}
        audience={audience}
        visibleRows={visibleRows}
      />
    </section>
  );
}

function safeResolveTasks(): ResolvedTask[] {
  try {
    return resolveAllTasks(undefined, false);
  } catch (error) {
    console.warn('[task-list] resolveAllTasks failed:', error);
    return [];
  }
}

function safeResolveCandidates(): OptInCandidate[] {
  try {
    return resolveOptInCandidates(undefined, false);
  } catch (error) {
    console.warn('[task-list] resolveOptInCandidates failed:', error);
    return [];
  }
}
