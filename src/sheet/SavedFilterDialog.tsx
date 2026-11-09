import { useEffect, useRef, useState } from "react";
import { Bookmark, Pencil, UserRound, Users } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { ErrorNote } from "../ui/ErrorNote";
import type { SavedFilter } from "./useSavedFilters";

export default function SavedFilterDialog({
  filter,
  canManageFilters,
  onSave,
  onClose,
}: {
  filter?: SavedFilter;
  canManageFilters: boolean;
  onSave: (name: string, scope: SavedFilter["scope"]) => Promise<void>;
  onClose: () => void;
}) {
  const filterNameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [viewName, setViewName] = useState(filter?.name || "");
  const [filterScope, setFilterScope] =
    useState<SavedFilter["scope"]>("personal");
  const [filterNameError, setFilterNameError] = useState("");
  const [savingFilterName, setSavingFilterName] = useState(false);
  return (
    <Modal
      title={filter?.id ? "필터 이름 변경" : "필터 저장"}
      onClose={() => {
        if (!savingFilterName) onClose();
      }}
      initialFocus={filterNameInput}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (savingFilterName) return;
          setSavingFilterName(true);
          setFilterNameError("");
          try {
            await onSave(viewName, filterScope);
            if (mounted.current) onClose();
          } catch (e) {
            if (!mounted.current) return;
            setFilterNameError((e as Error).message);
            filterNameInput.current?.focus({ preventScroll: true });
          } finally {
            if (mounted.current) setSavingFilterName(false);
          }
        }}
      >
        <label>
          필터 이름
          <input
            ref={filterNameInput}
            value={viewName}
            onFocus={(e) => {
              if (filter?.id) e.currentTarget.select();
            }}
            onChange={(e) => {
              setViewName(e.target.value);
              setFilterNameError("");
            }}
            readOnly={savingFilterName}
            required
            maxLength={60}
            placeholder="예: 완료 제외 보기"
          />
        </label>
        {!filter?.id && canManageFilters && (
          <fieldset
            className="filter-scope-options"
            disabled={savingFilterName}
          >
            <legend>공개 범위</legend>
            <label>
              <input
                type="radio"
                name="filter-scope"
                value="personal"
                checked={filterScope === "personal"}
                onChange={() => setFilterScope("personal")}
              />
              <UserRound size={15} aria-hidden="true" />
              개인용
            </label>
            <label>
              <input
                type="radio"
                name="filter-scope"
                value="team"
                checked={filterScope === "team"}
                onChange={() => setFilterScope("team")}
              />
              <Users size={15} aria-hidden="true" />팀 공용
            </label>
          </fieldset>
        )}
        <ErrorNote error={filterNameError} />
        <p className="field-help">
          {filter?.id
            ? "필터 조건과 적용 상태는 그대로 유지됩니다."
            : filterScope === "team"
              ? "팀 전체에 표시되며 팀장만 수정·삭제할 수 있습니다."
              : "나에게만 표시되는 개인용 필터로 저장합니다."}
        </p>
        <footer className="form-actions">
          <Button
            type="submit"
            className="primary"
            disabled={savingFilterName || !viewName.trim()}
          >
            {filter?.id ? <Pencil size={15} /> : <Bookmark size={15} />}
            {filter?.id ? "이름 변경" : "저장"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
