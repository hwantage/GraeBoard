// iOS는 돋보기·스페이스바 트랙패드로 옮긴 커서를 따라 한 줄 입력칸을 가로로
// 스크롤하지 않고, 글자를 입력하거나 지워야 커서 위치로 옮긴다. 커서(선택 끝)가
// 바뀔 때 그 x 좌표를 재서 입력칸 안에 보이도록 scrollLeft를 맞춘다.
let measureCanvas: HTMLCanvasElement | null = null;

export function revealInputCaret(input: HTMLInputElement, margin = 8) {
  if (input.ownerDocument.activeElement !== input) return;
  const caret =
    input.selectionDirection === "backward"
      ? input.selectionStart
      : input.selectionEnd;
  if (caret === null) return;
  const context = (measureCanvas ||=
    document.createElement("canvas")).getContext("2d");
  if (!context) return;
  const style = getComputedStyle(input),
    left = parseFloat(style.paddingLeft) || 0,
    right = parseFloat(style.paddingRight) || 0;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const x = context.measureText(input.value.slice(0, caret)).width;
  const visible = input.clientWidth - left - right;
  if (x < input.scrollLeft + margin) input.scrollLeft = Math.max(0, x - margin);
  else if (x > input.scrollLeft + visible - margin)
    input.scrollLeft = x - visible + margin;
}

// 입력칸의 ref 콜백으로 붙인다(React 19의 ref 정리 함수). 문서의
// selectionchange를 직접 들어 iOS의 커서 이동도 놓치지 않는다.
export function revealCaretOnSelection(input: HTMLInputElement | null) {
  if (!input) return;
  const doc = input.ownerDocument,
    reveal = () => revealInputCaret(input);
  doc.addEventListener("selectionchange", reveal);
  return () => doc.removeEventListener("selectionchange", reveal);
}
