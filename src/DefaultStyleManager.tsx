import Select from "./Select";
import BorderControls from "./BorderControls";
import { bordersCSS } from "../shared/borders.js";
import { useState } from "react";
import type { Team, Style, Settings } from "./types";
import {
  FONTS,
  FONT_SIZES,
  fontFamilyCSS,
  normalizeSettings,
  textMode,
} from "../shared/domain.js";
import { send } from "./api";
import { Button, ErrorNote } from "./components";

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
  const [style, setStyle] = useState<Style>({
    fontFamily: FONTS[0],
    fontSize: 9,
    verticalAlign: "top",
    ...team.settings.defaultStyle,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  function change(part: Partial<Style>) {
    setStyle((s) => ({ ...s, ...part }));
    setMessage("");
  }
  return (
    <div className="default-style-manager">
      <p className="field-help">
        {team.name}의 새 업무와 그 업무의 빈 일정 셀에 적용할 서식입니다. 기존
        업무의 서식은 유지됩니다.
      </p>
      <ErrorNote error={error} />
      {message && (
        <p className="success-note" role="status">
          {message}
        </p>
      )}
      <div className="form-grid">
        <label>
          기본 글꼴
          <Select
            aria-label="기본 글꼴"
            value={style.fontFamily || FONTS[0]}
            onChange={(e) => change({ fontFamily: e.target.value })}
          >
            {FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
        </label>
        <label>
          기본 글자 크기
          <Select
            aria-label="기본 글자 크기"
            value={style.fontSize || 9}
            onChange={(e) => change({ fontSize: Number(e.target.value) })}
          >
            {FONT_SIZES.map((n) => (
              <option value={n} key={n}>
                {n}pt
              </option>
            ))}
          </Select>
        </label>
        <label>
          기본 글자 색상
          <input
            aria-label="기본 글자 색상"
            type="color"
            value={style.color || "#243642"}
            onChange={(e) => change({ color: e.target.value })}
          />
        </label>
        <label>
          기본 배경색
          <input
            aria-label="기본 배경색"
            type="color"
            value={style.backgroundColor || "#ffffff"}
            onChange={(e) => change({ backgroundColor: e.target.value })}
          />
        </label>
        <label>
          기본 가로 정렬
          <Select
            aria-label="기본 가로 정렬"
            value={style.textAlign || "left"}
            onChange={(e) =>
              change({ textAlign: e.target.value as Style["textAlign"] })
            }
          >
            <option value="left">왼쪽</option>
            <option value="center">가운데</option>
            <option value="right">오른쪽</option>
          </Select>
        </label>
        <label>
          기본 세로 정렬
          <Select
            aria-label="기본 세로 정렬"
            value={style.verticalAlign || "top"}
            onChange={(e) =>
              change({
                verticalAlign: e.target.value as Style["verticalAlign"],
              })
            }
          >
            <option value="top">위</option>
            <option value="middle">중간</option>
            <option value="bottom">아래</option>
          </Select>
        </label>
        <label>
          기본 텍스트 표시
          <Select
            aria-label="기본 텍스트 표시"
            value={textMode(style)}
            onChange={(e) =>
              change({
                textMode: e.target.value as Style["textMode"],
                wrap: e.target.value === "wrap",
              })
            }
          >
            <option value="overflow">오버플로우</option>
            <option value="wrap">줄바꿈</option>
            <option value="clip">자르기</option>
          </Select>
        </label>
      </div>
      <div className="check-grid default-style-options">
        {(
          [
            ["bold", "굵게"],
            ["italic", "기울임"],
            ["underline", "밑줄"],
            ["strike", "취소선"],
          ] as const
        ).map(([key, label]) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              aria-label={`기본 ${label}`}
              checked={!!style[key]}
              onChange={(e) => change({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="form-grid">
        {(
          [
            ["Top", "위쪽"],
            ["Right", "오른쪽"],
            ["Bottom", "아래쪽"],
            ["Left", "왼쪽"],
          ] as const
        ).map(([side, label]) => (
          <BorderControls
            key={side}
            label={`기본 ${label} 테두리`}
            value={style[`border${side}`]}
            onChange={(border) => change({ [`border${side}`]: border })}
            disabled={busy}
          />
        ))}
      </div>
      <div
        className="default-style-preview"
        style={{
          ...bordersCSS(style),
          fontFamily: fontFamilyCSS(style.fontFamily),
          fontSize: `${style.fontSize || 9}pt`,
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? "italic" : "normal",
          textDecoration: [
            style.underline ? "underline" : "",
            style.strike ? "line-through" : "",
          ].join(" "),
          textAlign: style.textAlign,
          whiteSpace: textMode(style) === "wrap" ? "pre-wrap" : "nowrap",
          overflow: textMode(style) === "clip" ? "hidden" : "auto",
          alignItems:
            style.verticalAlign === "top"
              ? "flex-start"
              : style.verticalAlign === "bottom"
                ? "safe flex-end"
                : "safe center",
        }}
      >
        <span>
          {
            "주간 업무 계획과 진행 내용을 기록합니다.\n다음 업무도 같은 서식으로 시작합니다."
          }
        </span>
      </div>
      <footer className="form-actions">
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
                { ...settings, defaultStyle: style },
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
      </footer>
    </div>
  );
}
