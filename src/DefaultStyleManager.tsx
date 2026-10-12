import Select from "./Select";
import Toolbar from "./Toolbar";
import { applyBorderPreset, gridBordersCSS } from "../shared/borders.js";
import { useState } from "react";
import type { Team, Style, Settings } from "./types";
import {
  FONTS,
  fontFamilyCSS,
  normalizeSettings,
  textMode,
} from "../shared/domain.js";
import { send } from "./api";
import { Button, ErrorNote } from "./components";
import { appendHistory } from "./history";

const INITIAL_STYLE: Style = {
  fontFamily: FONTS[0],
  fontSize: 9,
  verticalAlign: "middle",
};
type Draft = { style: Style; density: NonNullable<Settings["defaultDensity"]> };
type History = { past: Draft[]; present: Draft; future: Draft[] };

export default function DefaultStyleManager({
  team,
  onSaved,
}: {
  team: Team;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(() =>
    normalizeSettings(team.settings),
  );
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    future: [],
    present: {
      style: { ...INITIAL_STYLE, ...team.settings.defaultStyle },
      density: team.settings.defaultDensity || "compact",
    },
  }));
  const { style, density } = history.present;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  function change(part: Partial<Draft>) {
    setHistory((current) => ({
      past: appendHistory(current.past, current.present),
      present: { ...current.present, ...part },
      future: [],
    }));
    setMessage("");
  }
  const fitted = Math.max(
    density === "comfortable" ? 48 : 38,
    Math.ceil((style.fontSize || 9) * (4 / 3) * 1.55 + 16),
  );
  const height =
    density === "dense" ? Math.max(26, Math.round((fitted * 2) / 3)) : fitted;
  return (
    <div className="default-style-manager">
      <div className="default-style-actions">
        <label className="density-control">
          셀 높이
          <Select
            aria-label="셀 높이"
            value={density}
            disabled={busy}
            onChange={(e) =>
              change({ density: e.target.value as Draft["density"] })
            }
          >
            <option value="comfortable">넉넉하게</option>
            <option value="compact">편안하게</option>
            <option value="dense">촘촘하게</option>
          </Select>
        </label>
        <p className="field-help">
          서식은 새 업무에, 셀 높이는 팀 전체에 적용됩니다.
        </p>
        <Button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            setMessage("");
            try {
              const result = await send(
                `/teams/${team.id}/settings`,
                { ...settings, defaultStyle: style, defaultDensity: density },
                "PATCH",
              );
              setSettings(result.settings);
              await onSaved();
              setMessage("기본 서식을 저장했습니다.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          기본 서식 저장
        </Button>
      </div>
      <ErrorNote error={error} />
      {message && (
        <p className="success-note" role="status">
          {message}
        </p>
      )}
      <Toolbar
        label="기본 서식 도구"
        style={style}
        disabled={busy}
        onStyle={(part) => change({ style: { ...style, ...part } })}
        onBorder={(preset, border) =>
          // 기본 서식은 셀마다 따로 적용되므로 네 변 모두 바깥 경계로 본다.
          change({
            style: applyBorderPreset(style, preset, border, {
              Top: true,
              Right: true,
              Bottom: true,
              Left: true,
            }),
          })
        }
        onUndo={() => {
          setHistory((current) =>
            current.past.length
              ? {
                  past: current.past.slice(0, -1),
                  present: current.past.at(-1)!,
                  future: [current.present, ...current.future],
                }
              : current,
          );
          setMessage("");
        }}
        onRedo={() => {
          setHistory((current) =>
            current.future.length
              ? {
                  past: appendHistory(current.past, current.present),
                  present: current.future[0],
                  future: current.future.slice(1),
                }
              : current,
          );
          setMessage("");
        }}
        canUndo={!busy && !!history.past.length}
        canRedo={!busy && !!history.future.length}
      />
      <figure className="default-style-example">
        <figcaption>적용 결과 미리보기</figcaption>
        <div
          className="default-style-preview"
          aria-label="기본 서식 미리보기"
          data-density={density}
        >
          {["업무명", "1주", "2주"].map((label) => (
            <div key={label} className="preview-heading">
              {label}
            </div>
          ))}
          {[
            "신규 서비스 기획",
            "요구사항 정리",
            "기획안 검토",
            "제품 사용성 개선",
            "화면 구성과 동작 확인",
            "개선안 적용",
          ].map((text, index) => (
            <div
              key={text}
              className="preview-cell"
              style={{
                ...gridBordersCSS(style, {
                  top: index >= 3 ? style.borderBottom : undefined,
                  left: index % 3 !== 0 ? style.borderRight : undefined,
                  right: index % 3 !== 2 ? style.borderLeft : undefined,
                  bottom: index < 3 ? style.borderTop : undefined,
                }),
                height,
                fontFamily: fontFamilyCSS(style.fontFamily),
                fontSize: `${style.fontSize || 9}pt`,
                color: style.color,
                backgroundColor: style.backgroundColor || "#ffffff",
                fontWeight: style.bold ? 700 : 400,
                fontStyle: style.italic ? "italic" : "normal",
                textDecoration: [
                  style.underline ? "underline" : "",
                  style.strike ? "line-through" : "",
                ].join(" "),
                textAlign: style.textAlign,
                whiteSpace: textMode(style) === "wrap" ? "pre-wrap" : "nowrap",
                overflow: "hidden",
                alignItems:
                  style.verticalAlign === "top"
                    ? "flex-start"
                    : style.verticalAlign === "bottom"
                      ? "safe flex-end"
                      : "safe center",
              }}
            >
              <span>{text}</span>
            </div>
          ))}
        </div>
      </figure>
    </div>
  );
}
