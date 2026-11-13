/* ==========================================================================
   Agentic OS — Projects dashboard
   Discovers project folders in AIAccess/Projects and reports local metadata.
   ========================================================================== */
import { useEffect, useMemo, useState } from "react";
import { fetchProjects } from "../utils/api";
import {
  Boxes, RefreshCw, Search, GitCommitHorizontal, Bug, Tag, Clock3,
  FolderOpen, ExternalLink, CircleAlert, X, Code2,
} from "lucide-react";
import "./Projects.css";

function relativeDate(raw) {
  if (!raw) return "No commit history";
  const d = new Date(raw);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scannedAt, setScannedAt] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await fetchProjects();
      setProjects(data.projects || []);
      setScannedAt(data.scannedAt || "");
      setSelected((previous) => previous ? (data.projects || []).find((p) => p.slug === previous.slug) || null : null);
    } catch (err) {
      setError(err.message || "Couldn't scan project folders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    fetchProjects()
      .then((data) => {
        if (!alive) return;
        setProjects(data.projects || []);
        setScannedAt(data.scannedAt || "");
      })
      .catch((err) => {
        if (alive) setError(err.message || "Couldn't scan project folders");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter((p) => `${p.name} ${p.description} ${p.path} ${p.version}`.toLowerCase().includes(term));
  }, [projects, query]);

  return (
    <section className="projects-page">
      <header className="projects-header">
        <div className="projects-brand">
          <span className="projects-brand-icon"><Boxes size={20} /></span>
          <div><h1>Projects</h1><p>Project spaces found in AIAccess · {projects.length} {projects.length === 1 ? "project" : "projects"}</p></div>
        </div>
        <label className="projects-search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…" /></label>
        <div className="projects-header-actions">
          {scannedAt && <span className="projects-scan-time">Scanned {new Date(scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
          <button className="projects-refresh" onClick={refresh} title="Rescan Projects"><RefreshCw size={15} /></button>
        </div>
      </header>

      <div className="projects-body">
        <main className="projects-list-pane">
          {error && <div className="projects-error"><CircleAlert size={15} />{error}<button onClick={refresh}>Retry</button></div>}
          {loading ? (
            <div className="projects-empty"><span className="projects-spinner" /><p>Scanning AIAccess/Projects…</p></div>
          ) : !projects.length ? (
            <div className="projects-empty projects-no-data">
              <span className="projects-empty-icon"><FolderOpen size={30} /></span>
              <h2>No project folders yet</h2>
              <p>Add a project folder under <code>AIAccess/Projects</code>. It will appear here automatically after a refresh.</p>
              <button className="projects-refresh-text" onClick={refresh}><RefreshCw size={14} /> Rescan folder</button>
            </div>
          ) : !filtered.length ? (
            <div className="projects-empty"><Search size={28} /><p>No projects match “{query}”</p></div>
          ) : (
            <div className="projects-grid">
              {filtered.map((project) => (
                <button key={project.slug} className={`project-card ${selected?.slug === project.slug ? "selected" : ""}`} onClick={() => setSelected(project)}>
                  <div className="project-card-top">
                    <span className="project-folder-icon"><FolderOpen size={18} /></span>
                    <span className="project-version"><Tag size={11} /> {project.version}</span>
                  </div>
                  <h2>{project.name}</h2>
                  <p className="project-description">{project.description || "No project description found. Add one to the README or project manifest."}</p>
                  <div className="project-stats">
                    <span className={project.bugMarkers ? "has-markers" : ""}><Bug size={13} /> {project.bugMarkers} markers</span>
                    <span><GitCommitHorizontal size={13} /> {project.lastCommit ? project.lastCommit.shortHash : "No Git"}</span>
                  </div>
                  <div className="project-card-commit">
                    <span>{project.lastCommit?.subject || "No commits found"}</span>
                    <small>{relativeDate(project.lastCommit?.date || project.modified)}</small>
                  </div>
                </button>
              ))}
            </div>
          )}
          {!loading && projects.length > 0 && <p className="projects-metric-note"><Bug size={12} /> “Markers” are TODO/FIXME/BUG comments found in source files, not confirmed defects.</p>}
        </main>

        {selected && (
          <aside className="project-detail">
            <div className="project-detail-head">
              <div className="project-detail-icon"><Code2 size={17} /></div>
              <button className="project-close" onClick={() => setSelected(null)} title="Close details"><X size={15} /></button>
            </div>
            <span className="project-overline">PROJECT OVERVIEW</span>
            <h2>{selected.name}</h2>
            <p className="project-detail-description">{selected.description || "No description is set for this project."}</p>

            <div className="project-detail-stats">
              <div><span className="detail-stat-icon"><Tag size={14} /></span><span><small>Version</small><b>{selected.version}</b></span></div>
              <div><span className="detail-stat-icon"><Bug size={14} /></span><span><small>Open markers</small><b>{selected.bugMarkers}</b></span></div>
            </div>

            <section className="project-detail-section">
              <h3><GitCommitHorizontal size={14} /> Last commit</h3>
              {selected.lastCommit ? (
                <div className="project-commit-detail">
                  <b>{selected.lastCommit.subject || "(no commit message)"}</b>
                  <span><code>{selected.lastCommit.shortHash}</code> · {selected.lastCommit.author}</span>
                  <span><Clock3 size={12} /> {new Date(selected.lastCommit.date).toLocaleString()}</span>
                </div>
              ) : <p className="project-detail-muted">Git history is unavailable for this folder.</p>}
            </section>

            <section className="project-detail-section">
              <h3><Bug size={14} /> TODO / FIXME / BUG markers</h3>
              <p className="project-detail-muted">Heuristic source scan · {selected.scannedFiles} text files scanned{selected.scanTruncated ? " (scan limit reached)" : ""}.</p>
              {selected.markerFindings?.length ? (
                <div className="project-marker-list">
                  {selected.markerFindings.slice(0, 12).map((finding, index) => (
                    <div key={`${finding.file}:${finding.line}:${index}`} className="project-marker">
                      <span className={`marker-kind ${finding.kind.toLowerCase()}`}>{finding.kind}</span>
                      <code>{finding.file}:{finding.line}</code>
                      <p>{finding.text}</p>
                    </div>
                  ))}
                  {selected.markerFindings.length > 12 && <span className="project-detail-muted">Showing first 12 of {selected.bugMarkers} markers.</span>}
                </div>
              ) : <p className="project-detail-muted">No TODO, FIXME, or BUG markers found in scanned text files.</p>}
            </section>

            <div className="project-detail-path"><FolderOpen size={13} /><code>{selected.path}</code><ExternalLink size={12} /></div>
          </aside>
        )}
      </div>
    </section>
  );
}
