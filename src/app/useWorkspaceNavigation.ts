import { useRef, useState } from "react";
import type { DocumentPanelHandle } from "../documents/DocumentPanel";
import type { DocumentBrowserHandle } from "../documents/DocumentBrowser";
import useWorkspaceRoute from "./useWorkspaceRoute";

type Route = ReturnType<typeof useWorkspaceRoute>["route"];

// Coordinates screen changes through each feature's existing save/close path.
// The router owns browser history; features retain their persistence contracts.
export default function useWorkspaceNavigation(options: {
  canLeaveSheet: () => boolean;
  prepareAnnual: (fromDocuments: boolean) => Promise<void>;
  onAnnualReselect: () => void;
  flushLayout: () => void;
  onPrepared: (next: Route) => void;
  onError: (message: string) => void;
}) {
  const annualMemoRef = useRef<DocumentPanelHandle>(null);
  const documentBrowserRef = useRef<DocumentBrowserHandle>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [workspaceNavigating, setWorkspaceNavigating] = useState(false);
  const workspaceRoute = useWorkspaceRoute(prepareWorkspaceRoute);
  const documentBrowser = workspaceRoute.route === "documents";
  const screen: "annual" | "calendar" =
    workspaceRoute.route === "calendar" ? "calendar" : "annual";

  async function navigateWorkspace(action: () => void | Promise<void>) {
    if (annualMemoRef.current && !(await annualMemoRef.current.flush())) return;
    if (documentBrowser) await documentBrowserRef.current?.navigate(action);
    else await action();
  }
  async function prepareWorkspaceRoute(next: Route) {
    if (calendarBusy || workspaceNavigating || !options.canLeaveSheet())
      return false;
    if (annualMemoRef.current && !(await annualMemoRef.current.flush()))
      return false;
    const prepare = async () => {
      options.flushLayout();
      if (next === "annual") await options.prepareAnnual(documentBrowser);
      options.onPrepared(next);
    };
    try {
      if (documentBrowser)
        return (await documentBrowserRef.current?.navigate(prepare)) ?? false;
      await prepare();
      return true;
    } catch (error) {
      options.onError((error as Error).message);
      return false;
    }
  }
  function openAnnualWorkspace() {
    if (workspaceRoute.route === "annual") options.onAnnualReselect();
    else void workspaceRoute.navigate("annual");
  }
  async function closeDocumentBrowser() {
    await options.prepareAnnual(true);
    workspaceRoute.commit("annual");
  }
  return {
    workspaceRoute,
    screen,
    documentBrowser,
    annualMemoRef,
    documentBrowserRef,
    calendarBusy,
    setCalendarBusy,
    workspaceNavigating,
    setWorkspaceNavigating,
    navigateWorkspace,
    openAnnualWorkspace,
    closeDocumentBrowser,
  };
}
