import { useEffect, useRef, useState } from "react";

type WorkspaceRoute = "annual" | "documents" | "calendar";
type Entry = { index: number; route: WorkspaceRoute };
const historyKey = "workspaceIndex";
const paths: Record<WorkspaceRoute, string> = {
  annual: "/",
  documents: "/documents",
  calendar: "/calendar",
};
function currentRoute(): WorkspaceRoute {
  return location.pathname === "/documents"
    ? "documents"
    : location.pathname === "/calendar"
      ? "calendar"
      : "annual";
}

export default function useWorkspaceRoute(
  prepare: (route: WorkspaceRoute) => Promise<boolean>,
) {
  const [route, setRoute] = useState(currentRoute);
  const current = useRef<Entry>({
    index: history.state?.[historyKey] ?? 0,
    route,
  });
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const busy = useRef(false);
  const traversal = useRef<{
    target: Entry;
    phase: "restore" | "prepare" | "commit";
  } | null>(null);

  useEffect(() => {
    history.replaceState(
      { ...history.state, [historyKey]: current.current.index },
      "",
    );
    const onPop = () => {
      const target: Entry = {
        index: history.state?.[historyKey] ?? 0,
        route: currentRoute(),
      };
      const pending = traversal.current;
      if (
        pending?.phase === "commit" &&
        target.index === pending.target.index
      ) {
        current.current = target;
        setRoute(target.route);
        traversal.current = null;
        busy.current = false;
        return;
      }
      if (target.index !== current.current.index) {
        // Restore the current entry before saving. A failed save keeps both
        // the current URL and the original back/forward entries intact.
        if (!busy.current) {
          busy.current = true;
          traversal.current = { target, phase: "restore" };
        }
        history.go(current.current.index - target.index);
        return;
      }
      if (pending?.phase !== "restore") return;
      pending.phase = "prepare";
      void prepareRef.current(pending.target.route).then((allowed) => {
        if (allowed) {
          pending.phase = "commit";
          history.go(pending.target.index - current.current.index);
        } else {
          traversal.current = null;
          busy.current = false;
        }
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function commit(next: WorkspaceRoute) {
    if (next === current.current.route) return;
    const url = new URL(location.href);
    url.pathname = paths[next];
    const entry = {
      index: current.current.index + 1,
      route: next,
    };
    history.pushState({ ...history.state, [historyKey]: entry.index }, "", url);
    current.current = entry;
    setRoute(next);
  }
  async function navigate(next: WorkspaceRoute) {
    if (busy.current || next === current.current.route) return;
    busy.current = true;
    try {
      if (await prepareRef.current(next)) commit(next);
    } finally {
      busy.current = false;
    }
  }
  return { route, navigate, commit };
}
