// Text split by textLinks() in shared/domain.js: URLs and "#123456" Redmine
// numbers open in a new tab. Grid cells and the task detail description share
// it so both show the same links.
export type LinkedTextPart = { text: string; href?: string };

export default function LinkedText({
  parts,
  className,
  textDecoration,
}: {
  parts: LinkedTextPart[];
  className?: string;
  // Cell underline/strike applies to the plain parts only.
  textDecoration?: string;
}) {
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.href ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {part.text}
          </a>
        ) : (
          <span key={index} style={{ textDecoration }}>
            {part.text}
          </span>
        ),
      )}
    </span>
  );
}
