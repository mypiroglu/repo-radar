import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { defaultRoots, fetchRepo, gitAvailable, refreshRepo, scan, type RepoStatus } from "./api";
import { filterAndSort, FILTERS, isDirty, isUnpushed, relativeTime, shortPath, type Filter, type SortKey } from "./repo";
import "./App.css";

const STORAGE_KEY = "reporadar.settings.v1";
const FETCH_CONCURRENCY = 4;

interface Settings {
  roots: string[];
  maxDepth: number;
}

function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Settings) : null;
  } catch {
    return null;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasGit, setHasGit] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("attention");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastScan = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  // First run: use saved settings or detect common code folders.
  useEffect(() => {
    gitAvailable().then(setHasGit);
    const saved = loadSettings();
    if (saved) setSettings(saved);
    else
      defaultRoots().then((roots) => {
        const s = { roots, maxDepth: 4 };
        setSettings(s);
        saveSettings(s);
        if (roots.length === 0) setShowSettings(true);
      });
  }, []);

  const runScan = useCallback(async () => {
    if (!settings || settings.roots.length === 0) return;
    setScanning(true);
    try {
      setRepos(await scan(settings.roots, settings.maxDepth));
      lastScan.current = Date.now();
    } catch (e) {
      notify("error", String(e));
    } finally {
      setScanning(false);
    }
  }, [settings, notify]);

  useEffect(() => {
    runScan();
  }, [runScan]);

  // Re-scan when the window regains focus (you probably just committed/pushed somewhere).
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastScan.current > 5000) runScan();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runScan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        runScan();
      } else if (e.key === "Escape") {
        if (showSettings) setShowSettings(false);
        else setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runScan, showSettings]);

  const replaceRepo = (updated: RepoStatus) => setRepos((rs) => rs.map((r) => (r.path === updated.path ? updated : r)));

  const setRepoBusy = (path: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(path);
      else n.delete(path);
      return n;
    });

  const onFetch = async (repo: RepoStatus, quiet = false) => {
    setRepoBusy(repo.path, true);
    try {
      const updated = await fetchRepo(repo.path);
      replaceRepo(updated);
      if (!quiet) notify("ok", updated.behind > 0 ? `${repo.name}: ${updated.behind} new commit(s) to pull` : `${repo.name} is up to date`);
      return true;
    } catch (e) {
      if (!quiet) notify("error", `${repo.name}: ${e}`);
      return false;
    } finally {
      setRepoBusy(repo.path, false);
    }
  };

  const onFetchAll = async () => {
    const targets = repos.filter((r) => r.remoteUrl);
    if (targets.length === 0) return;
    let done = 0;
    let failed = 0;
    setFetchProgress({ done, total: targets.length });
    const queue = [...targets];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (!(await onFetch(r, true))) failed++;
        setFetchProgress({ done: ++done, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    setFetchProgress(null);
    notify(failed ? "error" : "ok", `Fetched ${targets.length - failed}/${targets.length} repositories${failed ? ` (${failed} failed)` : ""}`);
  };

  const onRefresh = async (repo: RepoStatus) => replaceRepo(await refreshRepo(repo.path));

  const safe = (fn: () => Promise<unknown>) => () => fn().catch((e) => notify("error", String(e)));

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, repos.filter(f.test).length])), [repos]);
  const visible = useMemo(() => filterAndSort(repos, filter, query, sort), [repos, filter, query, sort]);

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <img src="/logo.svg" alt="" width={22} height={22} />
          <h1>RepoRadar</h1>
        </div>
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Search name, path, branch or remote…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="attention">Sort: Needs attention</option>
          <option value="recent">Sort: Recent commit</option>
          <option value="name">Sort: Name</option>
        </select>
        <button onClick={onFetchAll} disabled={!!fetchProgress || repos.length === 0} title="git fetch every repository with a remote">
          {fetchProgress ? `Fetching ${fetchProgress.done}/${fetchProgress.total}…` : "Fetch all"}
        </button>
        <button onClick={runScan} disabled={scanning} title="Rescan (⌘R)">
          {scanning ? "Scanning…" : "↻ Rescan"}
        </button>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Folders to scan">
          ⚙
        </button>
      </header>

      {!hasGit && (
        <div className="banner error">
          Git was not found. Install it (macOS: <code>xcode-select --install</code>) and restart RepoRadar.
        </div>
      )}

      <nav className="filters">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? "active" : ""} chip-${f.key}`} onClick={() => setFilter(f.key)}>
            {f.label}
            <span className="count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </nav>

      <main className="list">
        {visible.map((r) => (
          <RepoRow
            key={r.path}
            repo={r}
            busy={busy.has(r.path)}
            onFetch={() => onFetch(r)}
            onRefresh={safe(() => onRefresh(r))}
            onReveal={safe(() => revealItemInDir(r.path))}
            onOpenRemote={safe(() => openUrl(r.webUrl!))}
          />
        ))}
        {!scanning && visible.length === 0 && (
          <div className="empty">
            {repos.length === 0 ? (
              <>
                No repositories found.
                <button onClick={() => setShowSettings(true)}>Choose folders to scan</button>
              </>
            ) : filter === "attention" ? (
              "🎉 Everything is committed and pushed."
            ) : (
              "Nothing matches."
            )}
          </div>
        )}
        {scanning && repos.length === 0 && <div className="empty">Scanning for repositories…</div>}
      </main>

      <footer className="statusbar">
        <span>
          {visible.length} of {repos.length} repositories
        </span>
        <span className="muted">
          {settings?.roots.map(shortPath).join(" · ")} · depth {settings?.maxDepth}
        </span>
      </footer>

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onChange={updateSettings}
          onError={(e) => notify("error", e)}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function RepoRow({
  repo: r,
  busy,
  onFetch,
  onRefresh,
  onReveal,
  onOpenRemote,
}: {
  repo: RepoStatus;
  busy: boolean;
  onFetch: () => void;
  onRefresh: () => void;
  onReveal: () => void;
  onOpenRemote: () => void;
}) {
  const clean = !r.error && !isDirty(r) && !isUnpushed(r) && r.behind === 0;
  return (
    <div className={`repo ${busy ? "busy" : ""}`}>
      <div className={`dot ${r.error || r.conflicted > 0 ? "err" : clean ? "ok" : "warn"}`} />
      <div className="repo-main">
        <div className="repo-title">
          <span className="name">{r.name}</span>
          <span className={`branch ${r.branch ? "" : "detached"}`} title={r.upstream ? `tracking ${r.upstream}` : "no upstream branch"}>
            {r.branch ?? "detached HEAD"}
          </span>
        </div>
        <div className="path" title={r.path}>
          {shortPath(r.path)}
        </div>
      </div>

      <div className="pills">
        {r.error && (
          <span className="pill err" title={r.error}>
            error
          </span>
        )}
        {r.conflicted > 0 && <span className="pill err">⚠ {r.conflicted} conflict{r.conflicted > 1 ? "s" : ""}</span>}
        {r.staged > 0 && <span className="pill staged" title="staged">+{r.staged} staged</span>}
        {r.modified > 0 && <span className="pill modified" title="modified, not staged">● {r.modified} modified</span>}
        {r.untracked > 0 && <span className="pill untracked" title="untracked files">? {r.untracked} new</span>}
        {r.ahead > 0 && <span className="pill ahead" title="commits not pushed">↑ {r.ahead}</span>}
        {r.behind > 0 && <span className="pill behind" title="commits to pull">↓ {r.behind}</span>}
        {r.branch && !r.upstream && r.remoteUrl && <span className="pill ahead" title="branch was never pushed">not pushed</span>}
        {!r.remoteUrl && !r.error && <span className="pill muted-pill">no remote</span>}
        {r.stashes > 0 && <span className="pill stash" title="stash entries">≡ {r.stashes} stash</span>}
        {clean && r.remoteUrl && <span className="pill ok">✓ clean</span>}
      </div>

      <div className="commit" title={r.lastCommit ? `${r.lastCommit.summary}\n${r.lastCommit.author} · ${r.lastCommit.hash.slice(0, 8)}` : ""}>
        {r.lastCommit ? (
          <>
            <div className="when">{relativeTime(r.lastCommit.timestamp)}</div>
            <div className="summary">{r.lastCommit.summary}</div>
          </>
        ) : (
          <div className="when muted">no commits</div>
        )}
      </div>

      <div className="actions">
        <button onClick={onFetch} disabled={busy || !r.remoteUrl} title="git fetch">
          {busy ? "…" : "Fetch"}
        </button>
        <button className="ghost" onClick={onRefresh} title="Refresh status">
          ↻
        </button>
        <button className="ghost" onClick={onReveal} title="Show in Finder / Explorer">
          Open
        </button>
        <button className="ghost" onClick={onOpenRemote} disabled={!r.webUrl} title={r.webUrl ?? "no web remote"}>
          ↗
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
  onError,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const addFolder = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: true, title: "Choose folders that contain your repositories" });
      const list = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (list.length) onChange({ ...settings, roots: [...new Set([...settings.roots, ...list])] });
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Folders to scan">
        <h2>Folders to scan</h2>
        <p className="muted">RepoRadar looks for git repositories inside these folders.</p>
        <ul className="roots">
          {settings.roots.map((root) => (
            <li key={root}>
              <span title={root}>{shortPath(root)}</span>
              <button className="ghost" onClick={() => onChange({ ...settings, roots: settings.roots.filter((r) => r !== root) })} aria-label={`Remove ${root}`}>
                ✕
              </button>
            </li>
          ))}
          {settings.roots.length === 0 && <li className="muted">No folders yet.</li>}
        </ul>
        <button onClick={addFolder}>+ Add folder…</button>

        <label className="depth">
          Search depth
          <select value={settings.maxDepth} onChange={(e) => onChange({ ...settings, maxDepth: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {d} level{d > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Skipped automatically: hidden folders, <code>node_modules</code>, <code>target</code>, <code>vendor</code>, <code>build</code>, <code>dist</code>…
        </p>

        <div className="panel-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
