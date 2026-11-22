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
  useEffect(() => {
    if (!host.current || !thumbnails) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      void thumbnails
        .load(file, canWrite, controller.signal)
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
  }, [file, thumbnails, canWrite]);
  return (
    <span ref={host} className="slide-card-thumbnail" aria-hidden="true">
      {image && <img src={image} alt="" onError={() => setImage("")} />}
    </span>
  );
}
