import { NavLink, Outlet } from "react-router-dom";
import { GitHubIcon } from "./icons";

const GITHUB_URL = "https://github.com/RufixDuke/crosscheck";
const NPM_URL = "https://www.npmjs.com/package/@rufixduke/crosscheck";

export function Layout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ▲●■
            </span>
            CrossCheck
          </NavLink>
          <ul className="topbar-nav">
            <li>
              <NavLink to="/quickstart" className={({ isActive }) => (isActive ? "active" : undefined)}>
                Docs
              </NavLink>
            </li>
          </ul>
          <div className="topbar-actions">
            <a className="icon-btn" href={GITHUB_URL} aria-label="CrossCheck on GitHub">
              <GitHubIcon />
            </a>
          </div>
        </div>
      </header>
      <main id="main" style={{ flex: 1, width: "100%", display: "flex", flexDirection: "column" }}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="footer-inner">
          <span>MIT License · offline-first · free forever</span>
          <nav aria-label="Footer">
            <a href={GITHUB_URL}>GitHub</a>
            <a href={NPM_URL}>npm</a>
            <NavLink to="/privacy">Privacy</NavLink>
            <NavLink to="/faq">FAQ</NavLink>
          </nav>
        </div>
      </footer>
    </>
  );
}
