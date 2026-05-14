'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isDesktop } from '../../lib/desktop';
import type { OptInCandidate, ResolvedTask, UserTaskId } from '../../lib/tasks';

/**
 * Shared client-side store for the user-tasks feature. Mounted in
 * `app/layout.tsx` so the inline panel (HomeView) and the nav icon
 * (Nav) read the same state — without two parallel fetches racing or
 * showing stale data after a mutation.
 *
 * Polling cadence: 60s. State changes are user-initiated, so the only
 * reason to poll is "another tab on the same machine flipped a task."
 * Tight cadence isn't worth the request volume; the in-process refresh
 * event covers same-tab mutations.
 */

interface UserTasksContextValue {
  tasks: ResolvedTask[];
  /** Tasks marked `optInOnly` that the user can add via the chip tray. */
  candidates: OptInCandidate[];
  loading: boolean;
  /** Has the first fetch completed? Lets surfaces avoid a flash of
   *  "all tasks pending" when they actually render before the API resolves. */
  ready: boolean;
  startTask: (id: UserTaskId, opts?: { missingPrerequisite?: UserTaskId }) => Promise<void>;
  dismissTask: (id: UserTaskId) => Promise<void>;
  optInTask: (id: UserTaskId) => Promise<void>;
  refresh: () => Promise<void>;
}

const UserTasksContext = createContext<UserTasksContextValue | null>(null);

interface UserTasksProviderProps {
  children: ReactNode;
  /** Server-resolved initial state. Avoids the flash-of-empty on first
   *  paint of HomeView. Optional — surfaces that don't ship initial state
   *  hydrate via the first `/api/user-tasks` GET. */
  initialTasks?: ResolvedTask[];
}

const POLL_INTERVAL_MS = 60_000;
const REFRESH_EVENT = 'user-tasks:refresh';

export function UserTasksProvider({ children, initialTasks }: UserTasksProviderProps) {
  const [tasks, setTasks] = useState<ResolvedTask[]>(initialTasks ?? []);
  const [candidates, setCandidates] = useState<OptInCandidate[]>([]);
  const [ready, setReady] = useState<boolean>(Boolean(initialTasks?.length));
  const [loading, setLoading] = useState<boolean>(false);
  const desktopRef = useRef<boolean>(false);

  // Snapshot the runtime environment once. `isDesktop()` is stable for
  // the life of the page — Tauri's globals don't appear and disappear.
  useEffect(() => {
    desktopRef.current = isDesktop();
  }, []);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/user-tasks', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        tasks: ResolvedTask[];
        candidates?: OptInCandidate[];
      };
      setTasks(json.tasks ?? []);
      setCandidates(json.candidates ?? []);
      setReady(true);
    } catch (error) {
      console.warn('[user-tasks] fetch failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial hydration when no server-side initialTasks were passed.
  useEffect(() => {
    if (initialTasks && initialTasks.length > 0) return;
    void fetchTasks();
  }, [fetchTasks, initialTasks]);

  // Background poll. Cleared on unmount.
  useEffect(() => {
    const id = window.setInterval(() => void fetchTasks(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchTasks]);

  // Same-tab invalidation — components fire this when they know a mutation
  // just landed (e.g. starting a task) and want the panel to refresh
  // immediately rather than waiting for the next poll.
  useEffect(() => {
    const onRefresh = () => void fetchTasks();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, [fetchTasks]);

  const applyMutationResponse = useCallback((json: {
    tasks?: ResolvedTask[];
    candidates?: OptInCandidate[];
  }) => {
    setTasks(json.tasks ?? []);
    setCandidates(json.candidates ?? []);
  }, []);

  const startTask = useCallback(
    async (id: UserTaskId, opts?: { missingPrerequisite?: UserTaskId }) => {
      try {
        const res = await fetch('/api/user-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            action: 'start',
            missingPrerequisite: opts?.missingPrerequisite,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        applyMutationResponse(await res.json());
      } catch (error) {
        console.warn('[user-tasks] startTask failed:', error);
      }
    },
    [applyMutationResponse],
  );

  const dismissTask = useCallback(async (id: UserTaskId) => {
    try {
      const res = await fetch('/api/user-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'dismiss' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyMutationResponse(await res.json());
    } catch (error) {
      console.warn('[user-tasks] dismissTask failed:', error);
    }
  }, [applyMutationResponse]);

  const optInTask = useCallback(async (id: UserTaskId) => {
    try {
      const res = await fetch('/api/user-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'opt_in' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyMutationResponse(await res.json());
    } catch (error) {
      console.warn('[user-tasks] optInTask failed:', error);
    }
  }, [applyMutationResponse]);

  // Refine the task list with the runtime `isDesktop` flag. The server
  // resolver passes `isDesktop: false` (it can't inspect the client
  // runtime), so the setup_background_mode task is server-omitted on
  // every request — we never need to *hide* a task here, only realise
  // that we're on web and accept the omission as correct. This is a
  // placeholder for forward-compat: if we later add tasks that should
  // appear *only* in non-Tauri environments, the refinement happens here.
  const refinedTasks = useMemo(() => {
    // No-op for the v1 task set. The server response already excludes
    // setup_background_mode for web; on desktop a future provider iteration
    // can include it by passing `isDesktop=true` to the API.
    return tasks;
  }, [tasks]);

  const value: UserTasksContextValue = {
    tasks: refinedTasks,
    candidates,
    loading,
    ready,
    startTask,
    dismissTask,
    optInTask,
    refresh: fetchTasks,
  };

  return <UserTasksContext.Provider value={value}>{children}</UserTasksContext.Provider>;
}

export function useUserTasks(): UserTasksContextValue {
  const ctx = useContext(UserTasksContext);
  if (!ctx) {
    // Defensive fallback so child components that mount outside the
    // provider (sample mode, error boundaries) don't crash — they get
    // an empty list and no-op mutators. Mounting the provider in
    // app/layout.tsx is the supported path.
    return {
      tasks: [],
      candidates: [],
      loading: false,
      ready: false,
      startTask: async () => {},
      dismissTask: async () => {},
      optInTask: async () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}

/** Fire a same-tab refresh event from anywhere. Used by surfaces that
 *  mutate task state outside the provider (e.g. the inline panel
 *  triggering its own re-poll after a click). */
export function emitUserTasksRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(REFRESH_EVENT));
}
