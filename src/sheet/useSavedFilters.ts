import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api, send } from "../platform/api";
import { savedFilter } from "../../shared/domain.js";
import type { View, Team } from "../types";

export type SavedFilter = {
  id: string;
  name: string;
  data: Pick<View, "propertyFilters" | "propertyFilterModes">;
  scope: "team" | "personal";
  canEdit: boolean;
};

function propertyFilterKey(view: SavedFilter["data"]) {
  return JSON.stringify([
    Object.entries(view.propertyFilters || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, [...new Set(values)].sort()]),
    Object.entries(view.propertyFilterModes || {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  ]);
}

// Team-owned definitions and personal selection share one ordered write queue.
// The annual layout and a copy's view are owned by their respective callers.
export default function useSavedFilters({
  teamId,
  userId,
  enabled,
  ready,
  copy,
  settings,
  onDefinitionChange,
  onError,
  onNotify,
}: {
  teamId: string;
  userId: string;
  enabled: boolean;
  ready: boolean;
  copy: boolean;
  settings: Team["settings"];
  onDefinitionChange: (data: SavedFilter["data"]) => void;
  onError: Dispatch<SetStateAction<string>>;
  onNotify: (message: string) => void;
}) {
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [notice, setNotice] = useState<{
    teamId: string;
    filterId: string;
    revision: number;
    state: "saving" | "saved" | "error";
    cleared: boolean;
  } | null>(null);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const pending = useRef(0);
  const loading = useRef(Promise.resolve());
  const current = useRef<{
    teamId: string;
    data: SavedFilter["data"];
    selectedId: string;
  }>({ teamId: "", data: {}, selectedId: "" });
  const scope = useRef({ teamId, userId, enabled });
  if (
    scope.current.teamId !== teamId ||
    scope.current.userId !== userId ||
    scope.current.enabled !== enabled
  )
    scope.current = { teamId, userId, enabled };
  const owner = scope.current;
  const sameScope = () => scope.current === owner;
  const active = useMemo(
    () => filters.find((filter) => filter.id === selectedId),
    [filters, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    setFilters([]);
    setSelectedId("");
    setDeletingId("");
    current.current = { teamId, data: {}, selectedId: "" };
    if (!teamId || !enabled) {
      loading.current = Promise.resolve();
      return;
    }
    loading.current = queue.current
      .then(() => api(`/filters?teamId=${teamId}`))
      .then((result) => {
        if (cancelled || !sameScope()) return;
        setFilters(result.filters);
        current.current = { teamId, ...result.current };
        setSelectedId(result.current.selectedId);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, userId, enabled]);

  useEffect(() => {
    setNotice(null);
  }, [teamId, selectedId]);
  useEffect(() => {
    if (
      notice?.state === "saved" &&
      notice.teamId === teamId &&
      notice.filterId === selectedId
    )
      onNotify(
        notice.cleared
          ? "해제한 필터는 저장된 필터에서 제외됩니다."
          : "필터 변경사항이 업데이트되었습니다.",
      );
  }, [notice, teamId, selectedId, onNotify]);
  useEffect(() => {
    if (ready && selectedId && !active) select("");
  }, [ready, copy, selectedId, active]);

  function saveCurrent(data: SavedFilter["data"], id: string) {
    if (!sameScope() || current.current.teamId !== teamId) return;
    current.current = { teamId, data, selectedId: id };
    ++revision.current;
    pending.current++;
    queue.current = queue.current
      .then(() =>
        api("/filters/current", {
          method: "PUT",
          body: JSON.stringify({ teamId, data, selectedId: id }),
          keepalive: true,
        }),
      )
      .catch((error) => {
        if (sameScope()) onError("필터 설정 저장 실패: " + error.message);
      })
      .finally(() => {
        pending.current--;
      });
  }

  function select(id: string) {
    setNotice(null);
    setSelectedId(id);
    if (!copy) saveCurrent(current.current.data, id);
  }

  function update(filter: SavedFilter, next: View, previous: View) {
    onNotify("");
    const data = savedFilter(next, settings) as SavedFilter["data"];
    const savedRevision = ++revision.current;
    const cleared = Object.entries(previous.propertyFilters || {}).some(
      ([key, values]) => values.length && !next.propertyFilters?.[key]?.length,
    );
    setNotice({
      teamId,
      filterId: filter.id,
      revision: savedRevision,
      state: "saving",
      cleared,
    });
    const finish = (state: "saved" | "error") => {
      if (!sameScope()) return;
      setNotice((value) =>
        value?.teamId === teamId &&
        value.filterId === filter.id &&
        value.revision === savedRevision
          ? { ...value, state }
          : value,
      );
    };
    pending.current++;
    setFilters((items) =>
      items.map((item) => (item.id === filter.id ? { ...item, data } : item)),
    );
    queue.current = queue.current
      .then(async () => {
        await api(`/filters/${filter.id}`, {
          method: "PATCH",
          body: JSON.stringify({ data }),
          keepalive: true,
        });
        finish("saved");
        if (sameScope() && revision.current === savedRevision)
          onError((message) =>
            message.startsWith(`‘${filter.name}’ 필터 저장 실패:`)
              ? ""
              : message,
          );
      })
      .catch((error) => {
        finish("error");
        if (sameScope())
          onError(`‘${filter.name}’ 필터 저장 실패: ${error.message}`);
      })
      .finally(() => {
        pending.current--;
      });
  }

  function change(next: View, previous: View, updateSelected = false) {
    if (propertyFilterKey(next) === propertyFilterKey(previous)) return;
    const id = updateSelected && active?.canEdit ? active.id : "";
    if (!copy && id && active) update(active, next, previous);
    setSelectedId(id);
    if (!copy) saveCurrent(savedFilter(next, settings), id);
  }

  async function refresh() {
    const before = revision.current;
    await queue.current;
    const result = await api(`/filters?teamId=${teamId}`).catch((error) => {
      if (sameScope()) throw error;
      return null;
    });
    if (!result) return [] as SavedFilter[];
    if (sameScope() && revision.current === before) {
      setFilters(result.filters);
      const selected = result.filters.find(
        (filter: SavedFilter) => filter.id === current.current.selectedId,
      );
      if (
        selected &&
        propertyFilterKey(selected.data) !==
          propertyFilterKey(current.current.data)
      ) {
        saveCurrent(selected.data, selected.id);
        onDefinitionChange(selected.data);
      }
    }
    return result.filters as SavedFilter[];
  }

  async function save({
    id,
    name,
    scope: visibility,
    data,
  }: {
    id?: string;
    name: string;
    scope: SavedFilter["scope"];
    data: SavedFilter["data"];
  }) {
    await queue.current;
    if (id) await send(`/filters/${id}`, { name }, "PATCH");
    else
      await send(
        "/filters",
        { teamId, scope: visibility, name, data: savedFilter(data, settings) },
        "PUT",
      );
    const latest = await refresh();
    if (!sameScope()) return;
    onNotify(id ? "필터 이름을 변경했습니다." : "필터를 저장했습니다.");
    return id
      ? undefined
      : latest.find(
          (filter) =>
            filter.name === name.trim() && filter.scope === visibility,
        );
  }

  async function remove(filter: SavedFilter) {
    if (deletingId || !filter.canEdit) return;
    setDeletingId(filter.id);
    try {
      await queue.current;
      await api(`/filters/${filter.id}`, { method: "DELETE" });
      await refresh();
      if (!sameScope()) return;
      return {
        message: `‘${filter.name}’ 필터를 삭제했습니다.`,
        async undo() {
          await send(
            "/filters",
            {
              teamId,
              scope: filter.scope,
              name: filter.name,
              data: filter.data,
            },
            "PUT",
          );
          if (sameScope()) {
            await refresh();
            onNotify(`‘${filter.name}’ 필터를 되살렸습니다.`);
          }
        },
      };
    } catch (error) {
      if (sameScope()) throw error;
    } finally {
      if (sameScope()) setDeletingId("");
    }
  }

  return {
    filters,
    selectedId,
    active,
    notice,
    deletingId,
    change,
    select,
    refresh,
    save,
    remove,
    waitForLoad: () => loading.current,
    snapshot: () => current.current,
    hasPending: () => pending.current > 0,
    enterCopy() {
      setSelectedId("");
      setNotice(null);
    },
    leaveCopy() {
      setSelectedId(current.current.selectedId);
      setNotice(null);
    },
  };
}
