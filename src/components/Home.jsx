/* ==========================================================================
   Agentic OS — Home
   Landing tab: one glance at the whole system — today's calendar events,
   routines that already ran, project + skill counts, and model-provider
   health. Every card deep-links into its full tab.
   ========================================================================== */
import { useCallback, useEffect, useState } from "react";
import { calendarList, fetchRoutines, fetchProjects, fetchSkills, fetchHealth } from "../utils/api";
import {
  Home as HomeIcon, CalendarDays, Repeat, Code2, Puzzle, Activity, Bot, FolderOpen,
  CircleCheck, CircleX, LoaderCircle, ArrowRight,
} from "lucide-react";
import "./Home.css";

const NAVIGATE_EVENT = "agentic_os_navigate";

const PROVIDER_NAMES = { openrouter: "OpenRouter", ollama: "Ollama", opencode: "OpenCode", hermes: "Hermes" };

// Reuse the same navigation channel ZazuPanel uses so App.jsx switches tabs
function navigate(tab) {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { tab } }));
}

function timeOfDay(d) {
  const h = d.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relTime(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function cooldownLeft(until) {
  const m = Math.ceil(((until || 0) - Date.now()) / 60000);
  return m > 0 ? `${m}m left` : "clearing";
}

function shortModel(id) {
  const clean = String(id || "").replace(/^[a-z]+\//, "");
  return clean.length > 24 ? `${clean.slice(0, 23)}…` : clean;
}

const AGENT_NAMES = { zazu: "Zazu", coder: "Coder", scriber: "Scriber", scout: "Scout", artist: "Artist", chat: "Chat (you)" };
function agentName(id) { return AGENT_NAMES[id] || id; }

export default function Home() {
  const [data, setData] = useState({ events: null, routines: null, projects: null, skills: null, health: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());

  const refresh = useCallback(async () => {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    // allSettled: one failing endpoint shouldn't blank the whole page
    const [events, routines, projects, skills, health] = await Promise.allSettled([
      calendarList({ from: dayStart.getTime(), to: dayEnd.getTime() }),
      fetchRoutines(),
      fetchProjects(),
      fetchSkills(),
      fetchHealth(),
    ]);
    const pick = (r) => (r.status === "fulfilled" ? r.value : null);
    setData({
      events: pick(events),
      routines: pick(routines),
      projects: pick(projects),
      skills: pick(skills),
      health: pick(health),
    });
    const allFailed = [events, routines, projects, skills, health].every((r) => r.status === "rejected");
    setError(allFailed ? "Couldn't reach the server — retrying…" : "");
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => { clearInterval(t); clearInterval(tick); };
  }, [refresh]);

  // ---- derived summaries -------------------------------------------------
  const events = [...(data.events || [])].sort((a, b) => new Date(a.startAt || 0) - new Date(b.startAt || 0));
  const nowMs = now.getTime();
  const isToday = (iso) => iso && new Date(iso).toDateString() === now.toDateString();
  const upcoming = events.find((e) => new Date(e.endAt || e.startAt).getTime() >= nowMs);
  const isLive = (e) => !e.allDay && new Date(e.startAt).getTime() <= nowMs && new Date(e.endAt || e.startAt).getTime() >= nowMs;

  const routines = data.routines?.routines || [];
  const enabledRoutines = routines.filter((r) => r.enabled !== false).length;
  const runs = (data.routines?.runs || []).filter((r) => isToday(r.startedAt)).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const okRuns = runs.filter((r) => r.status === "ok").length;
  const errRuns = runs.filter((r) => r.status === "error").length;
  const runningNow = (data.routines?.running || []).length;

  const projects = data.projects?.projects || [];
  const recentProject = projects[0];
  const skills = data.skills?.installed || [];
  const library = data.skills?.available || [];

  const providers = data.health?.providers || null;
  const cooldowns = data.health?.cooldowns || [];
  const agents = data.health?.agents || [];
  const totals = data.health?.totals || null;
  const providersDown = providers ? Object.entries(providers).filter(([, ok]) => ok === false).length : 0;
  const healthOk = providers && providersDown === 0 && cooldowns.length === 0;
  const healthTitle = !providers
    ? "Health unavailable"
    : healthOk
      ? "All systems operational"
      : providersDown > 0
        ? `${providersDown} provider${providersDown > 1 ? "s" : ""} down`
        : `${cooldowns.length} model${cooldowns.length > 1 ? "s" : ""} cooling down`;

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="home-brand">
          <div className="home-brand-icon"><HomeIcon /></div>
          <div>
            <h1>Home</h1>
            <p>{timeOfDay(now)} · {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
          </div>
        </div>
        <div className="home-clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
      </header>

      {error && <div className="home-banner"><CircleX /> {error}</div>}

      <div className="home-body">
        {loading ? (
          <p className="home-muted">Loading overview…</p>
        ) : (
          <>
            <section className="home-stats">
              <button className="home-stat" onClick={() => navigate("calendar")} title="Open Calendar">
                <div className="home-stat-icon cal"><CalendarDays /></div>
                <div className="home-stat-main">
                  <span className="home-stat-num">{events.length}</span>
                  <span className="home-stat-label">Events today</span>
                  <span className="home-stat-sub">
                    {events.length === 0 ? "nothing scheduled" : upcoming ? `next: ${upcoming.title} · ${upcoming.allDay ? "all day" : fmtTime(upcoming.startAt)}` : "no more events today"}
                  </span>
                </div>
                <ArrowRight className="home-stat-arrow" />
              </button>

              <button className="home-stat" onClick={() => navigate("routines")} title="Open Routines">
                <div className="home-stat-icon rtn"><Repeat /></div>
                <div className="home-stat-main">
                  <span className="home-stat-num">{runs.length}</span>
                  <span className="home-stat-label">Routines ran today</span>
                  <span className="home-stat-sub">
                    {enabledRoutines} enabled{okRuns ? ` · ${okRuns} ok` : ""}{errRuns ? ` · ${errRuns} failed` : ""}{runningNow ? ` · ${runningNow} running` : ""}
                  </span>
                </div>
                <ArrowRight className="home-stat-arrow" />
              </button>

              <button className="home-stat" onClick={() => navigate("projects")} title="Open Projects">
                <div className="home-stat-icon prj"><Code2 /></div>
                <div className="home-stat-main">
                  <span className="home-stat-num">{projects.length}</span>
                  <span className="home-stat-label">Projects</span>
                  <span className="home-stat-sub">{recentProject ? `latest: ${recentProject.name}` : "no projects yet"}</span>
                </div>
                <ArrowRight className="home-stat-arrow" />
              </button>

              <button className="home-stat" onClick={() => navigate("skills")} title="Open Skills">
                <div className="home-stat-icon skl"><Puzzle /></div>
                <div className="home-stat-main">
                  <span className="home-stat-num">{skills.length}</span>
                  <span className="home-stat-label">Skills installed</span>
                  <span className="home-stat-sub">{library.length} more in library</span>
                </div>
                <ArrowRight className="home-stat-arrow" />
              </button>
            </section>

            <button
              className={`home-health ${providers ? (healthOk ? "ok" : "warn") : "warn"}`}
              onClick={() => navigate("health")}
              title="Open Model Health"
            >
              <Activity />
              <span className="home-health-pill">{healthTitle}</span>
              {providers && Object.entries(providers).map(([p, ok]) => (
                <span key={p} className={`home-provider ${ok === false ? "down" : ""}`}>{PROVIDER_NAMES[p] || p}</span>
              ))}
              {cooldowns.slice(0, 3).map((c) => (
                <span key={c.model} className="home-provider cool">{shortModel(c.model)} · {cooldownLeft(c.until)}</span>
              ))}
              {cooldowns.length > 3 && <span className="home-provider cool">+{cooldowns.length - 3} more cooling</span>}
              <ArrowRight className="home-stat-arrow" />
            </button>

            <div className="home-columns">
              <section className="home-panel">
                <header className="home-panel-head">
                  <CalendarDays /> Today's schedule
                  <span className="count">{events.length}</span>
                </header>
                {events.length === 0 ? (
                  <p className="home-muted">Nothing scheduled for today.</p>
                ) : (
                  <ul className="home-panel-list">
                    {events.map((e) => (
                      <li key={e.id} className={`home-panel-item ${isLive(e) ? "live" : ""}`}>
                        <span className="home-event-time">
                          {e.allDay ? "All day" : `${fmtTime(e.startAt)}${e.endAt ? ` – ${fmtTime(e.endAt)}` : ""}`}
                        </span>
                        <span className="home-event-title">{e.title}</span>
                        {isLive(e) && <span className="home-badge">now</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="home-panel">
                <header className="home-panel-head">
                  <Repeat /> Routines already ran today
                  <span className="count">{runs.length}</span>
                </header>
                {runs.length === 0 ? (
                  <p className="home-muted">No routines have run yet today.</p>
                ) : (
                  <ul className="home-panel-list">
                    {runs.map((r) => (
                      <li key={r.id} className="home-panel-item">
                        <span className={`home-run-status ${r.status}`}>
                          {r.status === "ok" ? <CircleCheck /> : r.status === "error" ? <CircleX /> : <LoaderCircle className="spin" />}
                        </span>
                        <span className="home-run-name">{r.name}</span>
                        {r.trigger === "manual" && <span className="home-tag">manual</span>}
                        <span className="home-run-time">{relTime(r.startedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="home-columns r2">
              <section className="home-panel">
                <header className="home-panel-head">
                  <Bot /> Agent token usage
                  <span className="count">{totals ? `${fmtTokens(totals.promptTokens + totals.completionTokens)} tokens` : ""}</span>
                </header>
                {agents.length === 0 ? (
                  <p className="home-muted">No agent activity recorded yet.</p>
                ) : (
                  <ul className="home-panel-list">
                    {agents.map((a) => (
                      <li key={a.agent} className="home-panel-item">
                        <span className="home-agent-name">{agentName(a.agent)}</span>
                        <span className="home-agent-stat">{fmtTokens((a.promptTokens || 0) + (a.completionTokens || 0))} tok</span>
                        <span className="home-agent-stat muted">{a.requests} req{a.requests === 1 ? "" : "s"}</span>
                        {a.errors > 0 && <span className="home-agent-stat err">{a.errors} err</span>}
                      </li>
                    ))}
                    {totals && (
                      <li className="home-panel-item home-agent-total">
                        <span className="home-agent-name">Total</span>
                        <span className="home-agent-stat">{fmtTokens(totals.promptTokens + totals.completionTokens)} tok</span>
                        <span className="home-agent-stat muted">{totals.requests} req{totals.requests === 1 ? "" : "s"}</span>
                        {totals.errors > 0 && <span className="home-agent-stat err">{totals.errors} err</span>}
                      </li>
                    )}
                  </ul>
                )}
              </section>

              <section className="home-panel">
                <header className="home-panel-head">
                  <FolderOpen /> Projects
                  <span className="count">{projects.length}</span>
                </header>
                {projects.length === 0 ? (
                  <p className="home-muted">No projects found in AIAccess/Projects.</p>
                ) : (
                  <div className="home-proj-grid">
                    {projects.map((p) => (
                      <span key={p.slug} className="home-proj-item" title={p.path || p.name}>
                        <Code2 />
                        <span className="home-proj-name">{p.name}</span>
                        <span className="home-proj-time">{p.modified ? relTime(new Date(p.modified).toISOString()) : ""}</span>
                      </span>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <p className="home-foot">Auto-refreshes every 30 s · click any card to open its tab</p>
          </>
        )}
      </div>
    </div>
  );
}
