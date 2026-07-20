import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

interface TocItem {
  id: string;
  text: string;
  depth: number;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug === "" ? "section" : slug;
}

/** Scans the doc page's own h2/h3 headings, assigns ids + clickable "#" anchors, and tracks the active section on scroll. */
export function TocRail() {
  const location = useLocation();
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const container = document.querySelector(".docs-content-col");
    if (container === null) return;

    const headings = Array.from(container.querySelectorAll("h2, h3")) as HTMLElement[];
    const used = new Set<string>();
    const nextItems: TocItem[] = [];

    headings.forEach((heading) => {
      const text = (heading.textContent ?? "").trim();

      let id = heading.id;
      if (id === "") {
        const base = slugify(text);
        id = base;
        let i = 2;
        while (used.has(id)) {
          id = `${base}-${i}`;
          i += 1;
        }
        heading.id = id;
      }
      used.add(id);

      if (heading.querySelector(".heading-anchor") === null) {
        const anchor = document.createElement("a");
        anchor.className = "heading-anchor";
        anchor.href = `#${id}`;
        anchor.textContent = "#";
        anchor.setAttribute("aria-label", "Link to this section");
        heading.prepend(anchor);
      }

      nextItems.push({ id, text, depth: heading.tagName === "H3" ? 3 : 2 });
    });

    setItems(nextItems);
    setActiveId(nextItems[0]?.id ?? "");

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: [0, 1] },
    );

    headings.forEach((heading) => observer.observe(heading));

    return () => observer.disconnect();
  }, [location.pathname]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="docs-toc-inner">
      <p className="docs-toc-title">On this page</p>
      <ul className="docs-toc-list">
        {items.map((item) => (
          <li key={item.id} data-depth={item.depth}>
            <a href={`#${item.id}`} className={item.id === activeId ? "active" : undefined}>
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
