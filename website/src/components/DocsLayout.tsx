import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { MenuIcon } from "./icons";
import { TocRail } from "./TocRail";

const NAV = [
  { to: "/quickstart", label: "Quickstart" },
  { to: "/commands", label: "Commands" },
  { to: "/rules", label: "Rules" },
  { to: "/config", label: "Config" },
  { to: "/privacy", label: "Privacy" },
  { to: "/faq", label: "FAQ" },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="docs-nav-group">
      <p className="docs-nav-label">Docs</p>
      <ul className="docs-nav-list">
        {NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className={({ isActive }) => `docs-nav-link${isActive ? " active" : ""}`}
              onClick={onNavigate}
            >
              <span className="dot" aria-hidden="true" />
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DocsLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const current = NAV.find((item) => item.to === location.pathname);

  return (
    <div className="docs-shell">
      <aside className="docs-sidebar" aria-label="Docs navigation">
        <NavList />
      </aside>

      <div className="docs-mobile-bar">
        <button
          type="button"
          className="icon-btn menu-btn"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon />
        </button>
        <span className="small-print" style={{ fontFamily: "var(--font-mono)" }}>
          {current?.label ?? "Docs"}
        </span>
      </div>

      <div
        className={`docs-drawer-overlay${drawerOpen ? " open" : ""}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <nav className={`docs-drawer${drawerOpen ? " open" : ""}`} aria-label="Docs navigation (mobile)">
        <button
          type="button"
          className="icon-btn docs-drawer-close"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        >
          ✕
        </button>
        <NavList onNavigate={() => setDrawerOpen(false)} />
      </nav>

      <div className="docs-content-col">
        <Outlet />
      </div>

      <aside className="docs-toc" aria-label="On this page">
        <TocRail />
      </aside>
    </div>
  );
}
