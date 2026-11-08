import { createContext, useContext } from "react";
import { siteFor } from "./site";

export const SiteContext = createContext(siteFor(null));
export const useSite = () => useContext(SiteContext);
