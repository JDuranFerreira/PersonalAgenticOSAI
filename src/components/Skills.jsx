/* ==========================================================================
   Agentic OS — Skills library
   Browse the read-only C:\AIAccess skill library, install into this project,
   inspect Markdown instructions, and assign installed skills to agents.
   ========================================================================== */
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSkills, installSkill, readSkill } from "../utils/api";
import { FUTURE_AGENTS } from "../agents/zazu";
import { loadAgentSettings, saveAgentSettings } from "../agents/settings";
import { BookOpen, Download, Check, Search, RefreshCw, PackageCheck, Shield, Puzzle, AlertCircle } from "lucide-react";
import "./Skills.css";

const AGENTS = [{ id: "zazu", name: "Zazu" }, ...FUTURE_AGENTS.map(({ id, name }) => ({ id, name }))];

export default function Skills() {
  const [catalog, setCatalog] = useState({ installed: [], available: [] });
  const [section, setSection] = useState("library");
  const [selected, setSelected] = useState(null);
  const [document, setDocument] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignments, setAssignments] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, loadAgentSettings(a.id).skills || []])));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchSkills();
      setCatalog(next);
      setAssignments(Object.fromEntries(AGENTS.map((a) => [a.id, loadAgentSettings(a.id).skills || []])));
    } catch (err) {
      setError(err.message || "Couldn't load the skills library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchSkills()
      .then((next) => {
        if (!alive) return;
        setCatalog(next);
        setAssignments(Object.fromEntries(AGENTS.map((agent) => [agent.id, loadAgentSettings(agent.id).skills || []])));
      })
      .catch((err) => {
        if (alive) setError(err.message || "Couldn't load the skills library");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const source = section === "installed" ? catalog.installed : catalog.available;
  const filtered = useMemo(() => source.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.slug}`.toLowerCase().includes(query.trim().toLowerCase())
  ), [source, query]);

  async function selectSkill(skill, scope) {
    setSelected({ ...skill, scope });
    setDocument(null);
    setError("");
    try {
      const doc = await readSkill(skill.slug, scope, skill.group);
      setDocument(doc);
    } catch (err) {
      setError(err.message || "Couldn't read skill instructions");
    }
  }

  async function doInstall(skill) {
    setBusy(skill.slug);
    setError("");
    try {
      await installSkill(skill.group, skill.slug);
      await refresh();
      setSection("installed");
      await selectSkill({ ...skill, group: "project" }, "installed");
      setNotice(`${skill.name} installed for this project`);
      setTimeout(() => setNotice(""), 3000);
    } catch (err) {
      setError(err.message || "Install failed");
    } finally {
      setBusy("");
    }
  }

  function toggleAgent(agentId) {
    if (!selected || selected.scope !== "installed") return;
    const current = loadAgentSettings(agentId);
    const skillIds = current.skills || [];
    const enabled = skillIds.includes(selected.slug);
    if (!enabled && skillIds.length >= 8) {
      setError("Limit each agent to 8 enabled skills so its instructions stay focused.");
      return;
    }
    const nextSkills = enabled ? skillIds.filter((id) => id !== selected.slug) : [...skillIds, selected.slug];
    saveAgentSettings(agentId, { ...current, skills: nextSkills });
    setAssignments((prev) => ({ ...prev, [agentId]: nextSkills }));
    setError("");
  }

  return (
    <section className="skills-page">
      <header className="skills-header">
        <div className="skills-brand">
          <span className="skills-brand-icon"><Puzzle size={19} /></span>
          <div><h1>Skills</h1><p>{catalog.installed.length} installed in this project · {catalog.available.length} available from the skill library</p></div>
        </div>
        <button className="skills-refresh" onClick={refresh} title="Refresh skill library"><RefreshCw size={15} /></button>
      </header>

      <div className="skills-workspace">
        <aside className="skills-browser">
          <div className="skills-tabs">
            <button className={section === "installed" ? "active" : ""} onClick={() => { setSection("installed"); setSelected(null); setDocument(null); }}>
              <PackageCheck size={14} /> Project <span>{catalog.installed.length}</span>
            </button>
            <button className={section === "library" ? "active" : ""} onClick={() => { setSection("library"); setSelected(null); setDocument(null); }}>
              <BookOpen size={14} /> Library <span>{catalog.available.length}</span>
            </button>
          </div>
          <label className="skills-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a skill…" /></label>
          <div className="skills-list">
            {loading ? <div className="skills-empty">Loading skills…</div> : filtered.length ? filtered.map((skill) => {
              const active = selected?.slug === skill.slug && selected?.scope === (section === "installed" ? "installed" : "library");
              return (
                <button key={`${skill.group}/${skill.slug}`} className={`skill-list-item ${active ? "active" : ""}`} onClick={() => selectSkill(skill, section === "installed" ? "installed" : "library")}>
                  <span className="skill-item-icon"><BookOpen size={15} /></span>
                  <span className="skill-item-copy"><b>{skill.name}</b><small>{section === "library" ? `${skill.group} library · ` : ""}{skill.description}</small></span>
                  {section === "installed" && <Check size={13} className="skill-installed-check" />}
                </button>
              );
            }) : <div className="skills-empty">{section === "installed" ? "No skills installed in this project yet." : "No available skills match your search."}</div>}
          </div>
          <div className="skills-source-note"><Shield size={13} /> Read-only source: C:\AIAccess\Skills. Installs copy to this project; bundled scripts are never auto-run.</div>
        </aside>

        <main className="skill-detail">
          {error && <div className="skills-error"><AlertCircle size={15} />{error}</div>}
          {!selected ? (
            <div className="skills-welcome"><Puzzle size={36} /><h2>Select a skill</h2><p>Browse project-installed skills or explore the library to install one.</p></div>
          ) : (
            <>
              <div className="skill-detail-header">
                <div><span className="skill-category">{selected.scope === "installed" ? "INSTALLED IN THIS PROJECT" : `LIBRARY · ${selected.group}`}</span><h2>{selected.name}</h2><p>{selected.description}</p></div>
                {selected.scope === "library" && (
                  <button className="skills-install-btn" disabled={busy === selected.slug} onClick={() => doInstall(selected)}>
                    {busy === selected.slug ? <RefreshCw size={15} className="spin" /> : <Download size={15} />}
                    {busy === selected.slug ? "Installing…" : "Install skill"}
                  </button>
                )}
                {selected.scope === "installed" && <span className="skill-installed-badge"><Check size={13} /> Installed</span>}
              </div>
              {selected.scope === "installed" && (
                <section className="skill-assignment">
                  <div><b>Use this skill with</b><small>Assigned skills are added to that agent's instructions for each task.</small></div>
                  <div className="skill-agent-options">
                    {AGENTS.map((agent) => {
                      const checked = (assignments[agent.id] || []).includes(selected.slug);
                      return <label key={agent.id} className={`skill-agent-option ${checked ? "checked" : ""}`}><input type="checkbox" checked={checked} onChange={() => toggleAgent(agent.id)} /><span>{agent.name}</span></label>;
                    })}
                  </div>
                </section>
              )}
              <div className="skill-instructions-label">SKILL INSTRUCTIONS · MARKDOWN</div>
              {document ? <pre className="skill-markdown"><code>{document.content}</code></pre> : <div className="skills-empty">Loading skill instructions…</div>}
            </>
          )}
        </main>
      </div>
      {notice && <div className="skills-toast"><Check size={14} />{notice}</div>}
    </section>
  );
}
