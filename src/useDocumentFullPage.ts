import { useMobileLayout } from "./ui/useMobileLayout";
import { useDocumentFullWidth } from "./DocumentFullWidthButton";

// Derive the mobile presentation without overwriting either desktop choice.
export function useDocumentFullPage(preferredFullPage = false) {
  const mobile = useMobileLayout();
  const preferredFullWidth = useDocumentFullWidth();
  return {
    mobile,
    fullPage: mobile || preferredFullPage,
    fullWidth: mobile || preferredFullWidth,
  };
}
