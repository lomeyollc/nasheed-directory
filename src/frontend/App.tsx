import { BookOpen, GitBranch, Music4, Plus, Terminal } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "Browse", icon: Music4, end: true },
  { to: "/rubric", label: "The rubric", icon: BookOpen, end: false },
  { to: "/docs", label: "API", icon: Terminal, end: false },
  { to: "/submit", label: "Submit", icon: Plus, end: false },
];

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line sticky top-0 z-20 bg-ink/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center gap-6">
          <NavLink to="/" className="flex items-center gap-2.5 font-semibold shrink-0">
            <span className="grid place-items-center w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-accent-2 text-ink">
              <Music4 size={17} strokeWidth={2.5} />
            </span>
            <span className="hidden sm:inline">Nasheed Directory</span>
          </NavLink>

          <nav className="flex items-center gap-1 text-sm overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg flex items-center gap-1.5 whitespace-nowrap transition ${
                    isActive ? "bg-ink-2 text-white" : "text-muted hover:text-white"
                  }`
                }
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </nav>

          <a
            href="https://github.com/lomeyollc/nasheed-directory"
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-muted hover:text-white shrink-0"
            aria-label="Source on GitHub"
          >
            <GitBranch size={19} />
          </a>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-line mt-16">
        <div className="mx-auto max-w-6xl px-5 py-8 text-sm text-muted space-y-2">
          <p>
            Open source under MIT. The audio itself stays under its own licence — check each
            track before you use it, and reproduce the attribution line where one is given.
          </p>
          <p>
            This catalog states a position on what counts as halal background audio. It is a
            tool, not a fatwa. The{" "}
            <NavLink to="/rubric" className="text-accent hover:underline">
              rubric
            </NavLink>{" "}
            says exactly what was checked and by whom.
          </p>
        </div>
      </footer>
    </div>
  );
}
