// Browser-only printing shared by document and report exports. Rendering and
// source ownership remain with the caller; this module only owns the dialog.
export function printFontFaces(families = /Pretendard|Nanum Gothic Coding/i) {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href || document.baseURI;
    for (const rule of list)
      if (
        rule instanceof CSSFontFaceRule &&
        families.test(rule.style.getPropertyValue("font-family"))
      )
        rules.push(
          rule.cssText.replace(
            /url\((["']?)([^"')]+)\1\)/g,
            (_, _quote, url: string) => `url("${new URL(url, base).href}")`,
          ),
        );
  }
  return rules.join("\n");
}

let active: (() => void) | undefined;
export async function printPage(
  html: string,
  title: string,
  options: { frameClass: string; signal?: AbortSignal; landscape?: boolean },
) {
  if (active) throw new Error("인쇄 창이 이미 열려 있습니다.");
  options.signal?.throwIfAborted();
  const focused = document.activeElement as HTMLElement | null;
  const pageTitle = document.title;
  const frame = document.createElement("iframe");
  frame.className = options.frameClass;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Keep layout measurable, without adding a focusable/visible app surface.
  Object.assign(frame.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    width: options.landscape ? "297mm" : "210mm",
    height: options.landscape ? "210mm" : "297mm",
    border: "0",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let restore = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let leftWindow = false;
      const blur = () => {
        leftWindow = true;
      };
      const focus = () => {
        if (leftWindow) setTimeout(restore);
      };
      const abort = () => finish(options.signal?.reason);
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        window.removeEventListener("blur", blur);
        window.removeEventListener("focus", focus);
        if (document.title === title) document.title = pageTitle;
        const ownsFocus =
          document.activeElement === frame ||
          document.activeElement === document.body ||
          document.activeElement === focused;
        if (document.activeElement === frame) frame.blur();
        frame.remove();
        if (ownsFocus)
          setTimeout(() => {
            // Firefox completes frame-removal focus processing after this task.
            // Let the caller clear its busy state before restoring keyboard focus.
            if (
              focused?.isConnected &&
              (document.activeElement === document.body ||
                document.activeElement === focused)
            ) {
              window.focus();
              focused.focus({ preventScroll: true });
            }
          });
        active = undefined;
        if (error) reject(error);
        else resolve();
      };
      restore = () => finish();
      active = restore;
      options.signal?.addEventListener("abort", abort, { once: true });
      document.body.append(frame);
      const doc = frame.contentDocument!;
      const view = frame.contentWindow!;
      void (async () => {
        try {
          doc.open();
          doc.write(html);
          doc.close();
          // document.open clears listeners on the frame's window.
          view.addEventListener("afterprint", () => setTimeout(restore), {
            once: true,
          });
          view.matchMedia("print").addEventListener("change", (event) => {
            if (!event.matches) setTimeout(restore);
          });
          void doc.body.offsetHeight;
          timeout = setTimeout(
            () => finish(new Error("인쇄 자료를 불러오지 못했습니다.")),
            20000,
          );
          await Promise.all([
            ...[...doc.images].map((image) => image.decode().catch(() => {})),
            doc.fonts?.ready,
          ]);
          clearTimeout(timeout);
          if (finished) return;
          document.title = title;
          window.addEventListener("blur", blur);
          window.addEventListener("focus", focus);
          view.focus();
          view.print();
        } catch (error) {
          finish(error);
        }
      })();
    });
  } finally {
    restore();
  }
}
