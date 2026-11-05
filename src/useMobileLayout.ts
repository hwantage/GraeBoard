import { useEffect, useState } from "react";

// Keep behavior that depends on the compact layout aligned with the CSS breakpoint.
export function useMobileLayout() {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}
