import { useEffect, useRef } from "react";
import { api } from "../platform/api";
import { viewLayout } from "../../shared/domain.js";
import type { View } from "../types";

// Layout is per team/year. Filters have their own team-scoped persistence.
export default function useSheetLayout(
  teamId: string,
  year: number,
  onError: (message: string) => void,
) {
  const scope = useRef({ teamId, year });
  if (scope.current.teamId !== teamId || scope.current.year !== year)
    scope.current = { teamId, year };
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<null | (() => void)>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => () => flush(), [teamId, year]);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const save = pending.current;
    pending.current = null;
    save?.();
  }
  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }
  function save(view: View) {
    if (timer.current) clearTimeout(timer.current);
    const owner = scope.current;
    pending.current = () => {
      api("/views", {
        method: "PUT",
        body: JSON.stringify({
          teamId,
          name: "__current",
          data: viewLayout(view),
        }),
        keepalive: true,
      }).catch((error) => {
        if (mounted.current && scope.current === owner)
          onError("보기 설정 저장 실패: " + error.message);
      });
    };
    timer.current = setTimeout(flush, 450);
  }
  return { save, flush, cancel, hasPending: () => !!timer.current };
}
