import { useState } from "react";
import lockupUrl from "../assets/logo/graeboard-lockup-horizontal.svg";
import wordmarkUrl from "../assets/logo/graeboard-wordmark-ko.svg";
import grae2dUrl from "../assets/character/grae-hello-2d-256.png";
import grae3dUrl from "../assets/character/grae-hello-3d-512.png";

// 픽셀 G — 브랜드 가이드(docs/GraeBoard_Brand_Guidebook.pdf)의 5×5 셀 배열
const G_PATTERN = [".XXX.", "X....", "X.XXX", "X...X", ".XXX."];

/** 타일 없는 브랜드 마크. 팀 테마와 관계없이 언제나 브랜드 민트를 씁니다. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 292 292" aria-hidden="true">
      {G_PATTERN.flatMap((row, y) =>
        [...row].map((ch, x) => (
          <rect
            key={`${x}-${y}`}
            x={x * 60}
            y={y * 60}
            width={52}
            height={52}
            rx={12}
            fill={ch === "X" ? "#24796d" : "#deebe4"}
          />
        )),
      )}
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return <img className={className} src={wordmarkUrl} alt="그래보드" />;
}

export function BrandLockup({ className }: { className?: string }) {
  return <img className={className} src={lockupUrl} alt="그래보드 GraeBoard" />;
}

/** 캐릭터 ‘그래’. 3D는 처음 만나는 자리, 2D는 앱 안의 안내에 씁니다. */
export function Grae({
  variant = "2d",
  className,
}: {
  variant?: "2d" | "3d";
  className?: string;
}) {
  return (
    <img
      className={className}
      src={variant === "3d" ? grae3dUrl : grae2dUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** 기존 그래 캐릭터의 네 칸을 시계 방향으로 밝히는 로딩 표시. */
export function GraeLoading() {
  const [ready, setReady] = useState(false);
  return (
    <svg
      className="grae-loading"
      viewBox="0 0 256 256"
      aria-hidden="true"
      data-ready={ready || undefined}
    >
      <image
        href={grae2dUrl}
        width="256"
        height="256"
        onLoad={() => setReady(true)}
        onError={() => setReady(true)}
      />
      {/* 256px 원본의 칸 안쪽에만 색을 올려 얼굴과 윤곽을 유지합니다. */}
      <g className="grae-loading-tiles">
        {[
          "M93 114 L120 117 Q126 118 125 124 L123 137 Q122 142 117 141 L89 138 Q85 137 86 132 L88 119 Q89 114 93 114Z",
          "M144 120 L171 123 Q176 124 175 129 L173 144 Q172 148 168 147 L139 144 Q135 143 136 138 L138 124 Q139 119 144 120Z",
          "M139 153 L165 156 Q171 157 170 162 L168 177 Q167 181 162 180 L134 177 Q130 176 131 171 L133 157 Q134 152 139 153Z",
          "M89 147 L116 150 Q121 151 120 156 L118 171 Q117 175 112 174 L85 171 Q81 170 82 165 L84 151 Q85 146 89 147Z",
        ].map((d, index) => (
          <path
            key={d}
            d={d}
            className="grae-loading-tile"
            style={{ animationDelay: `${index * 0.4}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
