import { useEffect, useRef, useState } from "react";
import type { SlideFile } from "./slide-file-api";
import type { SlideThumbnails } from "./slide-thumbnails";

export default function SlideCardThumbnail({
  file,
  thumbnails,
  canWrite,
}: {
  file: SlideFile;
  thumbnails: SlideThumbnails | null;
  canWrite: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState("");
  // A refreshed list hands over new objects for unchanged files: only what
  // identifies the picture restarts the request.
  const { teamId, id, contentHash } = file;
  useEffect(() => {
    if (!host.current || !thumbnails) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      void thumbnails
        .load({ teamId, id, contentHash }, canWrite, controller.signal)
        .then((src) => {
          if (!controller.signal.aborted) setImage(src);
        })
        .catch(() => {}); // A missing/unreadable preview never prevents opening the file.
    });
    observer.observe(host.current);
    return () => {
      controller.abort();
      observer.disconnect();
    };
  }, [teamId, id, contentHash, thumbnails, canWrite]);
  return (
    <span ref={host} className="slide-card-thumbnail" aria-hidden="true">
      {image && <img src={image} alt="" onError={() => setImage("")} />}
    </span>
  );
}
