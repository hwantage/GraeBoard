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
