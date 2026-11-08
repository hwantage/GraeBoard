import { useState } from "react";
import { createRoot } from "react-dom/client";
import RichMarkdownEditor from "../../../src/documents/editor/RichMarkdownEditor";

function Fixture() {
  const [error, setError] = useState("");
  const linkTitles = new URL(location.href).searchParams.get("linkTitles");
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <RichMarkdownEditor
        initialMarkdown=""
        readOnly={false}
        {...(linkTitles === "false" ? { linkTitles: false } : {})}
        onChange={() => {}}
        onUnsupported={setError}
        onReady={() => {}}
      />
    </>
  );
}

createRoot(document.getElementById("fixture-root")!).render(<Fixture />);
