import { useState } from "react";
import { createRoot } from "react-dom/client";
import RichMarkdownEditor from "../../../src/documents/editor/RichMarkdownEditor";

function Fixture() {
  const [error, setError] = useState("");
  const params = new URL(location.href).searchParams;
  const linkTitles = params.get("linkTitles");
  const place = params.get("place");
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <RichMarkdownEditor
        initialMarkdown={params.get("markdown") ?? ""}
        {...(place ? { initialPlace: JSON.parse(place) } : {})}
        readOnly={false}
        {...(linkTitles === "false" ? { linkTitles: false } : {})}
        // The saved Markdown, for the test to read.
        onChange={(markdown) =>
          document.body.setAttribute("data-markdown", markdown)
        }
        onUnsupported={setError}
        onReady={() => {}}
      />
    </>
  );
}

createRoot(document.getElementById("fixture-root")!).render(<Fixture />);
