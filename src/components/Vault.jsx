/* ==========================================================================
   Agentic OS — Vault (second brain)
   Collections sidebar, searchable card grid / list, and a reader pane for
   notes, code and images. Zazu can open any note via [[NAVIGATE: vault:path]].
   ========================================================================== */
import { useState, useEffect, useCallback, useRef } from "react";
import { fsList, fsRead, fsSearch, fsRawUrl } from "../utils/api";
import { renderMarkdown, escapeHtml } from "../utils/markdown";
import { VAULT_OPEN_EVENT, VAULT_PENDING_KEY } from "../utils/vaultEvents";
import { useResizableWidth } from "../utils/useResizableWidth";
import ResizeHandle from "./ResizeHandle";
import { Maximize2, Minimize2 } from "lucide-react";

// Visible grip between the browser and the preview. Drag it, double-click to
// reset, or focus it and use ← / → to resize from the keyboard.
function Splitter({ onDragStart, onNudge, onReset, label }) {
  return (
    <div
      className="vault-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click to reset · ← → to nudge"
      onPointerDown={onDragStart}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); onNudge(16); }
        if (e.key === "ArrowRight") { e.preventDefault(); onNudge(-16); }
      }}
    >
      <span className="vault-splitter-grip" />
    </div>
  );
}
import {
  Brain, Home, Folder, FolderOpen, FileText, FileCode, Image, File, Clock,
  Copy, Check, Download, X, RefreshCw, LayoutGrid, List, Search, ChevronRight, Sparkles,
} from "lucide-react";
import "./Vault.css";

const ROOT = "Vault";
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const NOTE_EXT = ["md", "txt"];
const CODE_EXT = ["json", "yaml", "yml", "js", "jsx", "ts", "tsx", "css", "html", "py"];
const KIND_ICON = { dir: Folder, note: FileText, code: FileCode, image: Image, binary: File };

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function kindOf(name, type) {
  if (type === "dir") return "dir";
  const ext = extOf(name);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (NOTE_EXT.includes(ext)) return "note";
  if (CODE_EXT.includes(ext)) return "code";
  return "binary";
}

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? ROOT : p.slice(0, i);
}

function joinPath(dir, name) {
  return `${dir}/${name}`;
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024;
    i++;
  }
  return `${s.toFixed(i > 0 && s < 10 ? 1 : 0)} ${units[i]}`;
}

function timeAgo(ms) {
  if (!ms) return "";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function titleFrom(name, content = "") {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

function excerptFrom(content = "") {
  const body = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|\||```|---|>|[-*]\s*$)/.test(l))
    .slice(0, 4)
    .join(" ");
  return body
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .slice(0, 180);
}

export default function Vault() {
  const [currentPath, setCurrentPath] = useState(ROOT);
  const [entries, setEntries] = useState([]);
  const [entriesPath, setEntriesPath] = useState(ROOT);
  const [rootFolders, setRootFolders] = useState([]);
  const [subFolders, setSubFolders] = useState([]);
  const [previews, setPreviews] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState("grid");
  const [openFile, setOpenFile] = useState(null);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef(null);
  const openReqRef = useRef(0);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const treeRail = useResizableWidth({
    storageKey: "agentic_os_vault_tree_width",
    defaultValue: 216,
    min: 150,
    max: 360,
    side: "right",
  });
  const readerRail = useResizableWidth({
    storageKey: "agentic_os_vault_reader_width",
    defaultValue: 480,
    min: 300,
    max: 900,
    side: "left",
  });

  const loadFolder = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fsList(path);
      setEntries(data.entries || []);
      setEntriesPath(path);
    } catch (err) {
      setEntries([]);
      setEntriesPath(path);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRoots = useCallback(async () => {
    try {
      const data = await fsList(ROOT);
      setRootFolders((data.entries || []).filter((e) => e.type === "dir"));
    } catch {
      setRootFolders([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fsList(ROOT)
      .then((data) => {
        if (alive) setRootFolders((data.entries || []).filter((entry) => entry.type === "dir"));
      })
      .catch(() => {
        if (alive) setRootFolders([]);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    fsList(currentPath)
      .then((data) => {
        if (!alive) return;
        setEntries(data.entries || []);
        setEntriesPath(currentPath);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setEntries([]);
        setEntriesPath(currentPath);
        setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [currentPath]);

  const activeRoot = currentPath.split("/")[1] || "";
  const visibleSubFolders = activeRoot ? subFolders : [];
  useEffect(() => {
    if (!activeRoot) return;
    let alive = true;
    fsList(`${ROOT}/${activeRoot}`)
      .then((d) => {
        if (alive) setSubFolders((d.entries || []).filter((e) => e.type === "dir"));
      })
      .catch(() => {
        if (alive) setSubFolders([]);
      });
    return () => {
      alive = false;
    };
  }, [activeRoot]);

  // Titles and excerpts for note cards, read in the background
  useEffect(() => {
    let alive = true;
    if (entriesPath !== currentPath) return undefined;
    const targets = entries
      .filter((e) => e.type === "file" && NOTE_EXT.includes(extOf(e.name)))
      .slice(0, 60);
    Promise.all(
      targets.map(async (e) => {
        const p = joinPath(currentPath, e.name);
        try {
          const d = await fsRead(p);
          return [p, { title: titleFrom(e.name, d.content), excerpt: excerptFrom(d.content) }];
        } catch {
          return [p, { title: titleFrom(e.name), excerpt: "" }];
        }
      })
    ).then((pairs) => {
      if (alive && pairs.length) setPreviews((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      alive = false;
    };
  }, [entries, entriesPath, currentPath]);

  // Full-text search across the whole vault (debounced)
  useEffect(() => {
    const q = query.trim();
    if (!q) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      fsSearch(q, ROOT)
        .then((data) => {
          if (alive) setResults(data.results || []);
        })
        .catch((err) => {
          if (!alive) return;
          setResults([]);
          setError(err.message);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const openPath = useCallback(async (path, name, meta = {}) => {
    const kind = kindOf(name, "file");
    const id = ++openReqRef.current;
    const base = { path, name, kind, ...meta };
    if (kind !== "note" && kind !== "code") {
      setOpenFile(base);
      return;
    }
    setOpenFile({ ...base, loading: true });
    try {
      const d = await fsRead(path);
      if (id === openReqRef.current) {
        setOpenFile({ ...base, content: d.content, truncated: d.truncated, size: d.size });
      }
    } catch (err) {
      if (id === openReqRef.current) setOpenFile({ ...base, error: err.message });
    }
  }, []);

  const handleSearchChange = useCallback((value) => {
    setQuery(value);
    setResults(null);
    setSearching(Boolean(String(value || "").trim()));
  }, []);

  const navigateFolder = useCallback((path) => {
    setLoading(true);
    setError(null);
    setCurrentPath(path);
  }, []);

  const go = (path) => {
    handleSearchChange("");
    setOpenFile(null);
    navigateFolder(path);
  };

  const openFromItem = (entry) => {
    if (entry.type === "dir") return go(joinPath(currentPath, entry.name));
    openPath(joinPath(currentPath, entry.name), entry.name, { size: entry.size, modified: entry.modified });
  };

  const openFromSearch = (r) => {
    if (r.type === "dir") return go(r.path);
    handleSearchChange("");
    navigateFolder(parentOf(r.path));
    openPath(r.path, r.name);
  };

  const openByPath = useCallback(
    (raw) => {
      const clean = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
      if (!clean) return;
      const full = clean.startsWith(`${ROOT}/`) ? clean : `${ROOT}/${clean}`;
      handleSearchChange("");
      navigateFolder(parentOf(full));
      openPath(full, full.split("/").pop());
    },
    [openPath, handleSearchChange, navigateFolder]
  );

  // Zazu can open a note: live event if mounted, sessionStorage handoff otherwise
  useEffect(() => {
    const onOpen = (e) => {
      sessionStorage.removeItem(VAULT_PENDING_KEY);
      openByPath(e.detail?.path);
    };
    window.addEventListener(VAULT_OPEN_EVENT, onOpen);
    const pending = sessionStorage.getItem(VAULT_PENDING_KEY);
    const pendingTimer = pending ? window.setTimeout(() => openByPath(pending), 0) : null;
    if (pending) sessionStorage.removeItem(VAULT_PENDING_KEY);
    return () => {
      window.removeEventListener(VAULT_OPEN_EVENT, onOpen);
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    };
  }, [openByPath]);

  // "/" focuses search, Esc clears search or closes the reader
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (e.key === "/" && tag !== "input" && tag !== "textarea") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (query) handleSearchChange("");
        else setOpenFile(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, handleSearchChange]);

  const copyPath = () => {
    if (!openFile) return;
    navigator.clipboard
      ?.writeText(openFile.path)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  const download = () => {
    if (openFile?.content == null) return;
    const url = URL.createObjectURL(new Blob([openFile.content], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = openFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const crumbs = currentPath.split("/");
  const folderDirs = entries.filter((e) => e.type === "dir");
  const folderFiles = entries.filter((e) => e.type === "file");
  const showingSearch = Boolean(query.trim());

  function renderItem(f) {
    const p = joinPath(currentPath, f.name);
    const kind = kindOf(f.name, "file");
    const Icon = KIND_ICON[kind];
    const pv = previews[p];
    const title = pv?.title || f.name;
    const excerpt = kind === "note" ? pv?.excerpt || "" : "";
    const active = openFile?.path === p;

    if (view === "list") {
      return (
        <button key={f.name} className={`vault-row k-${kind} ${active ? "active" : ""}`} onClick={() => openFromItem(f)}>
          <span className="vault-kind"><Icon size={16} /></span>
          <div className="vault-row-body">
            <div className="vault-card-title">{title}</div>
            <div className="vault-card-excerpt">{excerpt || f.name}</div>
          </div>
          <div className="vault-row-meta">
            <span>{extOf(f.name) || "file"}</span>
            <span>{fmtSize(f.size)}</span>
            <span>{timeAgo(f.modified)}</span>
          </div>
        </button>
      );
    }

    return (
      <button key={f.name} className={`vault-card k-${kind} ${active ? "active" : ""}`} onClick={() => openFromItem(f)}>
        {kind === "image" ? (
          <img className="vault-thumb" src={fsRawUrl(p)} alt={f.name} loading="lazy" />
        ) : (
          <div className="vault-card-top">
            <span className="vault-kind"><Icon size={16} /></span>
            <span className="vault-ext">{extOf(f.name) || "file"}</span>
          </div>
        )}
        <div className="vault-card-title">{title}</div>
        <div className="vault-card-excerpt">{excerpt}</div>
        <div className="vault-card-foot">
          <span><Clock size={11} /> {timeAgo(f.modified)}</span>
          <span>{fmtSize(f.size)}</span>
        </div>
      </button>
    );
  }

  function renderFolder() {
    if ((loading && !entries.length) || entriesPath !== currentPath) {
      return (
        <div className="vault-state">
          <div className="vault-spinner" />
          <p>Opening folder…</p>
        </div>
      );
    }
    if (error && !showingSearch) {
      return (
        <div className="vault-state error">
          <p>Couldn't read this folder</p>
          <code>{error}</code>
          <button className="vault-btn" onClick={() => loadFolder(currentPath)}>Try again</button>
        </div>
      );
    }
    if (!entries.length) {
      return (
        <div className="vault-state">
          <Brain size={40} />
          <p>This folder is empty</p>
          <span>Notes, reports and logs saved here will appear automatically.</span>
        </div>
      );
    }
    return (
      <>
        {folderDirs.length > 0 && (
          <section className="vault-section">
            <div className="vault-section-title">Folders · {folderDirs.length}</div>
            <div className="vault-folder-row">
              {folderDirs.map((d) => (
                <button key={d.name} className="vault-folder-chip" onClick={() => go(joinPath(currentPath, d.name))}>
                  <Folder size={14} />
                  <span>{d.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {folderFiles.length > 0 && (
          <section className="vault-section">
            <div className="vault-section-title">Files · {folderFiles.length}</div>
            <div className={view === "list" ? "vault-list" : "vault-grid"}>
              {folderFiles.map(renderItem)}
            </div>
          </section>
        )}
      </>
    );
  }

  function renderSearch() {
    if (searching || results === null) {
      return (
        <div className="vault-state">
          <div className="vault-spinner" />
          <p>Searching the vault…</p>
        </div>
      );
    }
    if (!results.length) {
      return (
        <div className="vault-state">
          <Search size={36} />
          <p>No matches for “{query.trim()}”</p>
          <span>Searches file names and the text of notes, code and config files.</span>
        </div>
      );
    }
    return (
      <section className="vault-section">
        <div className="vault-section-title">
          {results.length} match{results.length === 1 ? "" : "es"} for “{query.trim()}”
        </div>
        <div className="vault-results">
          {results.map((r) => {
            const kind = kindOf(r.name, r.type);
            const Icon = KIND_ICON[kind];
            return (
              <button key={r.path} className={`vault-result k-${kind}`} onClick={() => openFromSearch(r)}>
                <span className="vault-kind"><Icon size={16} /></span>
                <div className="vault-row-body">
                  <div className="vault-card-title">{r.name}</div>
                  <div className="vault-result-path">{r.path}</div>
                  {r.snippet && <div className="vault-card-excerpt">…{r.snippet}…</div>}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  function renderReaderBody() {
    if (!openFile) return null;
    if (openFile.kind === "image") {
      return (
        <div className="vault-image-wrap">
          <img src={fsRawUrl(openFile.path)} alt={openFile.name} />
        </div>
      );
    }
    if (openFile.kind === "binary") {
      return (
        <div className="vault-state">
          <File size={36} />
          <p>No preview for this file type</p>
          <code>{openFile.path}</code>
        </div>
      );
    }
    if (openFile.loading) {
      return (
        <div className="vault-state">
          <div className="vault-spinner" />
          <p>Loading…</p>
        </div>
      );
    }
    if (openFile.error) {
      return (
        <div className="vault-state error">
          <p>Couldn't open this file</p>
          <code>{openFile.error}</code>
        </div>
      );
    }
    if (openFile.kind === "code") {
      return (
        <pre className="vault-code">
          <code dangerouslySetInnerHTML={{ __html: escapeHtml(openFile.content) }} />
        </pre>
      );
    }
    return <article className="vault-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(openFile.content) }} />;
  }

  return (
    <div className="vault">
      <header className="vault-top">
        <div className="vault-brand">
          <div className="vault-brand-icon"><Brain size={20} /></div>
          <div>
            <div className="vault-title">Vault</div>
            <div className="vault-subtitle">Second brain · {rootFolders.length} collections</div>
          </div>
        </div>

        <div className="vault-search">
          <Search size={16} className="vault-search-icon" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search notes, content and files…   press /"
          />
          {query && (
            <button className="vault-icon-btn vault-search-clear" onClick={() => handleSearchChange("")} title="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="vault-actions">
          <div className="vault-seg">
            <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} title="Cards">
              <LayoutGrid size={14} />
            </button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")} title="List">
              <List size={14} />
            </button>
          </div>
          <button
            className="vault-icon-btn"
            onClick={() => {
              loadRoots();
              loadFolder(currentPath);
            }}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div className="vault-body">
        <aside className="vault-tree" style={{ width: treeRail.width }}>
          <div className="vault-tree-title">Collections</div>
          <button className={`vault-tree-item ${currentPath === ROOT ? "active" : ""}`} onClick={() => go(ROOT)}>
            <Home size={14} />
            <span>All of Vault</span>
          </button>
          {rootFolders.map((f) => {
            const p = `${ROOT}/${f.name}`;
            const isOpen = currentPath === p || currentPath.startsWith(`${p}/`);
            return (
              <div key={p} className="vault-tree-group">
                <button className={`vault-tree-item ${currentPath === p ? "active" : ""}`} onClick={() => go(p)}>
                  {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{f.name}</span>
                </button>
                {isOpen &&
                  visibleSubFolders.map((s) => {
                    const sp = `${p}/${s.name}`;
                    return (
                      <button
                        key={sp}
                        className={`vault-tree-item sub ${currentPath === sp ? "active" : ""}`}
                        onClick={() => go(sp)}
                      >
                        <span>{s.name}</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
          <div className="vault-tree-foot">
            <Sparkles size={12} /> Ask Zazu: “show me agents.md”
          </div>
        </aside>
        <ResizeHandle side="right" onDragStart={treeRail.startDrag} onReset={treeRail.reset} />

        <main className="vault-main">
          <nav className="vault-crumbs">
            {crumbs.map((seg, i) => {
              const p = crumbs.slice(0, i + 1).join("/");
              const last = i === crumbs.length - 1;
              return (
                <span key={p} className="vault-crumb-wrap">
                  {i > 0 && <ChevronRight size={13} className="vault-crumb-sep" />}
                  <button className={`vault-crumb ${last ? "last" : ""}`} onClick={() => go(p)}>
                    {seg}
                  </button>
                </span>
              );
            })}
            {!showingSearch && <span className="vault-count">{entries.length} items</span>}
          </nav>
          <div className="vault-scroll">
            {showingSearch ? renderSearch() : renderFolder()}
          </div>
        </main>

        {openFile && (
          <>
          <Splitter
            label="Resize file preview"
            onDragStart={readerRail.startDrag}
            onNudge={readerRail.nudge}
            onReset={readerRail.reset}
          />
          <aside className="vault-reader" style={{ width: previewExpanded ? "min(1100px, 78%)" : readerRail.width }}>
            <div className="vault-reader-head">
              <div className="vault-reader-meta">
                <span className={`vault-kind k-${openFile.kind}`}>
                  {(() => {
                    const Icon = KIND_ICON[openFile.kind] || File;
                    return <Icon size={16} />;
                  })()}
                </span>
                <div className="vault-reader-names">
                  <div className="vault-reader-title">{openFile.name}</div>
                  <div className="vault-reader-path">{openFile.path}</div>
                </div>
              </div>
              <div className="vault-reader-actions">
                <button className="vault-icon-btn" onClick={copyPath} title="Copy path">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  className="vault-icon-btn"
                  onClick={() => setPreviewExpanded((v) => !v)}
                  title={previewExpanded ? "Restore width" : "Expand preview"}
                >
                  {previewExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                {openFile.content != null && (
                  <button className="vault-icon-btn" onClick={download} title="Download">
                    <Download size={14} />
                  </button>
                )}
                <button className="vault-icon-btn" onClick={() => setOpenFile(null)} title="Close (Esc)">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="vault-reader-meta-row">
              {openFile.size != null && <span>{fmtSize(openFile.size)}</span>}
              {openFile.modified ? <span><Clock size={11} /> {timeAgo(openFile.modified)}</span> : null}
              {openFile.truncated && <span className="warn">Showing first 60 KB</span>}
            </div>
            <div className="vault-reader-body">{renderReaderBody()}</div>
          </aside>
          </>
        )}
      </div>
    </div>
  );
}
