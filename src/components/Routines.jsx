/* ==========================================================================
   Agentic OS — Routines
   Scheduled tasks Zazu runs (or delegates) automatically: daily / monthly
   schedules with specific hours. Add routines by hand, or describe one and
   let Zazu draft it. Every run is logged to Vault/Logs/Routines.
   ========================================================================== */
import { useCallback, useEffect, useState } from "react";
import { fetchRoutines, createRoutine, updateRoutine, deleteRoutine, runRoutineNow, assistRoutine } from "../utils/api";
import { Repeat, Play, Pause, Pencil, Plus, Sparkles, LoaderCircle, ChevronDown, ChevronRight, Trash, X, CircleCheck, CircleX, Clock, Square } from "lucide-react";
import "./Routines.css";

const AGENTS = [
  { id: "zazu", name: "Zazu (orchestrator)" },
  { id: "coder", name: "Coder" },
  { id: "scriber", name: "Scriber" },
  { id: "scout", name: "Scout" },
  { id: "artist", name: "Artist" },
];

const EMPTY_FORM = {
  name: "",
  prompt: "",
  type: "daily",
  hours: [9],
  minute: 0,
  dayOfMonth: 1,
  agent: "zazu",
  enabled: true,
};

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

function scheduleText(s) {
  const hh = (s.hours?.length ? s.hours : [9]).map((h) => `${String(h).padStart(2, "0")}:${String(s.minute || 0).padStart(2, "0")}`);
  return s.type === "monthly" ? `Monthly · day ${s.dayOfMonth || 1} · ${hh.join(", ")}` : `Daily · ${hh.join(", ")}`;
}

function nextRunText(nextRunAt, serverNow) {
  if (!nextRunAt) return "";
  const delta = nextRunAt - (serverNow || Date.now());
  if (delta <= 0) return "due now";
  const m = Math.round(delta / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function Routines() {
  const [data, setData] = useState({ routines: [], runs: [], serverNow: Date.now() });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null); // form state when open
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistText, setAssistText] = useState("");
  const [assistBusy, setAssistBusy] = useState(false);
  const [expandedRun, setExpandedRun] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchRoutines();
      setData(next);
      setError("");
    } catch (err) {
      setError(err.message || "Couldn't reach the proxy");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const openCreate = () => {
    setEditingId(null);
    setEditor({ ...EMPTY_FORM });
    setAssistOpen(false);
  };

  const openEdit = (r) => {
    setEditingId(r.id);
    setEditor({
      name: r.name,
      prompt: r.prompt,
      type: r.schedule?.type || "daily",
      hours: r.schedule?.hours?.length ? [...r.schedule.hours] : [9],
      minute: r.schedule?.minute ?? 0,
      dayOfMonth: r.schedule?.dayOfMonth || 1,
      agent: r.agent || "zazu",
      enabled: r.enabled !== false,
    });
    setAssistOpen(false);
  };

  const save = async () => {
    if (!editor.name.trim() || !editor.prompt.trim()) {
      setError("Name and prompt are required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: editor.name,
        prompt: editor.prompt,
        schedule: { type: editor.type, hours: editor.hours, minute: Number(editor.minute) || 0, dayOfMonth: Number(editor.dayOfMonth) || 1 },
        agent: editor.agent,
        enabled: editor.enabled,
      };
      if (editingId) await updateRoutine(editingId, payload);
      else await createRoutine(payload);
      setEditor(null);
      setEditingId(null);
      setNotice(editingId ? "Routine updated" : "Routine created");
      setTimeout(() => setNotice(""), 4000);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleHour = (h) => {
    setEditor((f) => ({
      ...f,
      hours: f.hours.includes(h) ? f.hours.filter((x) => x !== h) : [...f.hours, h].sort((a, b) => a - b),
    }));
  };

  const askZazu = async () => {
    if (!assistText.trim()) return;
    setAssistBusy(true);
    setError("");
    try {
      const draft = await assistRoutine(assistText);
      setEditingId(null);
      setEditor({
        name: draft.name,
        prompt: draft.prompt,
        type: draft.schedule?.type || "daily",
        hours: draft.schedule?.hours?.length ? draft.schedule.hours : [9],
        minute: draft.schedule?.minute ?? 0,
        dayOfMonth: draft.schedule?.dayOfMonth || 1,
        agent: draft.agent || "zazu",
        enabled: true,
      });
      setAssistOpen(false);
      setAssistText("");
      setNotice("Zazu drafted a routine — review and save it");
    } catch (err) {
      setError(err.message);
    } finally {
      setAssistBusy(false);
    }
  };

  const running = new Set(data.running || []);

  return (
    <div className="routines-page">
      <header className="routines-header">
        <div className="routines-brand">
          <div className="routines-brand-icon"><Repeat /></div>
          <div>
            <h1>Routines</h1>
            <p>{data.routines.length} routine{data.routines.length === 1 ? "" : "s"} · Zazu runs them automatically in the background</p>
          </div>
        </div>
        <div className="routines-actions">
          <button className="routine-btn" onClick={() => { setAssistOpen(!assistOpen); setEditor(null); }}>
            <Sparkles /> Ask Zazu
          </button>
          <button className="routine-btn primary" onClick={openCreate}>
            <Plus /> New routine
          </button>
        </div>
      </header>

      {error && <div className="routines-banner error"><CircleX /> {error}</div>}
      {notice && <div className="routines-banner ok"><CircleCheck /> {notice}</div>}

      {assistOpen && (
        <section className="routines-assist">
          <b><Sparkles /> Describe the routine — Zazu will draft it</b>
          <textarea
            value={assistText}
            onChange={(e) => setAssistText(e.target.value)}
            placeholder={'e.g. "Every morning at 7 and evening at 19, check my Vault notes for open TODOs, scout any links I saved, and write a short digest into Vault/Reports"'}
            rows={3}
          />
          <div className="routines-assist-row">
            <button className="routine-btn primary" onClick={askZazu} disabled={assistBusy || !assistText.trim()}>
              {assistBusy ? <LoaderCircle className="spin" /> : <Sparkles />} {assistBusy ? "Zazu is drafting…" : "Draft it"}
            </button>
            <small>The draft opens in the editor below for you to review before it is saved.</small>
          </div>
        </section>
      )}

      {editor && (
        <section className="routines-editor">
          <div className="re-head">
            <b>{editingId ? "Edit routine" : "New routine"}</b>
            <button className="routine-icon-btn" onClick={() => { setEditor(null); setEditingId(null); }} title="Close"><X /></button>
          </div>
          <label>Name
            <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} placeholder="Morning vault digest" />
          </label>
          <label>Prompt (what Zazu should do on every run)
            <textarea value={editor.prompt} onChange={(e) => setEditor({ ...editor, prompt: e.target.value })} rows={4}
              placeholder="Write a self-contained instruction. Zazu starts each run fresh — include what to do, what to produce, and where to save it." />
          </label>
          <div className="re-row">
            <label className="re-type">
              Repeat
              <select value={editor.type} onChange={(e) => setEditor({ ...editor, type: e.target.value })}>
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {editor.type === "monthly" && (
              <label className="re-dom">
                Day of month
                <select value={editor.dayOfMonth} onChange={(e) => setEditor({ ...editor, dayOfMonth: Number(e.target.value) })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            )}
            <label className="re-agent">
              Run as
              <select value={editor.agent} onChange={(e) => setEditor({ ...editor, agent: e.target.value })}>
                {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <div className="re-hours">
            <span>Hours</span>
            <div className="re-hour-grid">
              {Array.from({ length: 24 }, (_, h) => (
                <button key={h} className={`re-hour ${editor.hours.includes(h) ? "on" : ""}`} onClick={() => toggleHour(h)}>
                  {String(h).padStart(2, "0")}
                </button>
              ))}
            </div>
          </div>
          <div className="re-row">
            <label className="re-minute">
              Minute
              <input type="number" min="0" max="59" value={editor.minute} onChange={(e) => setEditor({ ...editor, minute: e.target.value })} />
            </label>
            <label className="re-enabled">
              <input type="checkbox" checked={editor.enabled} onChange={(e) => setEditor({ ...editor, enabled: e.target.checked })} />
              Enabled
            </label>
          </div>
          <div className="re-actions">
            <button className="routine-btn primary" onClick={save} disabled={saving}>
              {saving ? <LoaderCircle className="spin" /> : <Square />} {saving ? "Saving…" : editingId ? "Save changes" : "Create routine"}
            </button>
          </div>
        </section>
      )}

      <div className="routines-body">
        <section className="routines-list">
          <h2><Clock /> Scheduled</h2>
          {loading ? <p className="routines-muted">Loading…</p>
            : data.routines.length === 0 ? (
              <p className="routines-muted">No routines yet. Create one by hand, or describe it and let Zazu draft it.</p>
            ) : data.routines.map((r) => (
              <div key={r.id} className={`routine-card ${r.enabled ? "" : "disabled"}`}>
                <div className="rc-main">
                  <div className="rc-title">
                    <b>{r.name}</b>
                    <span className={`rc-status ${r.lastStatus || ""}`}>
                      {running.has(r.id) ? <LoaderCircle className="spin" /> : null}
                      {running.has(r.id) ? "running" : r.lastStatus ? `${r.lastStatus} · ${relTime(r.lastRun)}` : "never run"}
                    </span>
                  </div>
                  <small className="rc-schedule">{scheduleText(r.schedule || {})} · agent: {r.agent || "zazu"} · next {nextRunText(r.nextRunAt, data.serverNow)}</small>
                  <p className="rc-prompt">{r.prompt}</p>
                </div>
                <div className="rc-actions">
                  <button className="routine-icon-btn" title={r.enabled ? "Pause" : "Resume"} onClick={async () => { try { await updateRoutine(r.id, { enabled: !r.enabled }); await refresh(); } catch (err) { setError(err.message); } }}>
                    {r.enabled ? <Pause /> : <Play />}
                  </button>
                  <button className="routine-icon-btn" title="Run now" onClick={async () => { try { await runRoutineNow(r.id); setNotice("Routine started — watch the run below"); setTimeout(() => setNotice(""), 4000); await refresh(); } catch (err) { setError(err.message); } }}>
                    <Play />
                  </button>
                  <button className="routine-icon-btn" title="Edit" onClick={() => openEdit(r)}><Pencil /></button>
                  <button className="routine-icon-btn danger" title="Delete" onClick={async () => { try { await deleteRoutine(r.id); await refresh(); } catch (err) { setError(err.message); } }}>
                    <Trash />
                  </button>
                </div>
              </div>
            ))}
        </section>

        <section className="routines-runs">
          <h2><Clock /> Recent runs</h2>
          {data.runs.length === 0 ? <p className="routines-muted">No runs yet.</p> : data.runs.map((run) => (
            <div key={run.id} className={`run-card ${run.status}`}>
              <button className="run-head" onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
                {expandedRun === run.id ? <ChevronDown /> : <ChevronRight />}
                <b>{run.name}</b>
                <span className={`run-status ${run.status}`}>
                  {run.status === "running" ? <LoaderCircle className="spin" /> : run.status === "ok" ? <CircleCheck /> : <CircleX />}
                  {run.status}
                </span>
                <span className="run-time">{relTime(run.startedAt)} · {run.trigger}</span>
              </button>
              {expandedRun === run.id && (
                <div className="run-detail">
                  {run.error && <p className="run-error">{run.error}</p>}
                  {run.logFile && <small>Log saved: {run.logFile}</small>}
                  <pre>{run.output || (run.status === "running" ? "Working…" : "(no output)")}</pre>
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
