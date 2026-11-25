import {
  Component,
  Suspense,
  lazy,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { SlidesLoadingBoard } from "./SlideLoadingState";
import { slideShareOtherTeam, writeSlideAddress } from "./slide-address";
import type { SlidesWorkspaceHandle } from "./SlidesWorkspace";

// The slides screen's code loads when the screen first opens, not with the
// page.
const SlidesWorkspace = lazy(() => import("./SlidesWorkspace"));

// A screen that cannot load (a removed build file, offline) stays inside the
// workspace instead of unmounting the page. React remembers the failed
// import, so the message asks for a reload.
class SlidesLoadBoundary extends Component<
  { children: ReactNode; failed: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.failed : this.props.children;
  }
}

// Holds the screen's place while its code loads, and after a failed load. It
// shows the screen's own loading view and answers leave() as the screen does
// with nothing open, so moving to another screen or team in the meantime
// leaves no slide address behind for the next visit to open.
function SlidesWorkspacePending({
  ref,
  teamId,
  error = "",
}: {
  ref?: Ref<SlidesWorkspaceHandle>;
  teamId: string;
  error?: string;
}) {
  useImperativeHandle(ref, () => ({
    async leave() {
      if (!slideShareOtherTeam(teamId)) writeSlideAddress();
      return true;
    },
  }));
  return <SlidesLoadingBoard error={error} />;
}

export default function SlidesWorkspaceLoader(
  props: ComponentProps<typeof SlidesWorkspace>,
) {
  const pending = (error?: string) => (
    <SlidesWorkspacePending
      ref={props.ref}
      teamId={props.teamId}
      error={error}
    />
  );
  return (
    <SlidesLoadBoundary
      failed={pending(
        "CanvaSlide 화면을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 열어 주세요.",
      )}
    >
      <Suspense fallback={pending()}>
        <SlidesWorkspace {...props} />
      </Suspense>
    </SlidesLoadBoundary>
  );
}
