import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** On route change: jump to the #anchor if the URL has one (e.g. a rule-card deep link), else scroll to top — React Router does neither automatically. */
export function ScrollToTopOrHash() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash !== "") {
      const id = decodeURIComponent(hash.slice(1));
      const el = document.getElementById(id);
      if (el !== null) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);

  return null;
}
