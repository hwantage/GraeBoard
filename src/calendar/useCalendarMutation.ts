import { useEffect, useRef, useState } from "react";
export default function useCalendarMutation(
  scope: string,
  beginMutation: () => void,
  endMutation: () => void,
  setError: (error: string) => void,
) {
  const [pending, setPending] = useState(false);
  const activeScope = useRef(scope);
  const alive = useRef(true);
  const busy = useRef(false);
  activeScope.current = scope;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    beginMutation();
    setPending(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      busy.current = false;
      endMutation();
      if (alive.current) setPending(false);
    }
  }
  function localAction(work: () => unknown) {
    setError("");
    try {
      void Promise.resolve(work()).catch((error) =>
        setError((error as Error).message),
      );
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return { pending, activeScope, alive, busy, action, localAction };
}
