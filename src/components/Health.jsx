/* ==========================================================================
   Agentic OS — Model Health
   One place to see every model Agentic OS can reach: provider key status,
   rate-limit cooldowns, what the models are actually being used for, and a
   one-click sync that re-fetches each provider's live free-model list.
   ========================================================================== */
import { useCallback, useEffect, useState } from "react";
import { fetchHealth, syncFreeModels, fmtContext, ragStatus, ragReindex } from "../utils/api";
import { Activity, RefreshCw, RotateCw, CircleCheck, CircleX, CircleExclamationPoint, Timer, Zap, BookOpen } from "lucide-react";
import "./Health.css";

const PROVIDER_INFO = {
  openrouter: { name: "OpenRouter", note: "cloud · free tier" },
  opencode: { name: "opencode Zen", note: "cloud · free" },
  hermes: { name: "Hermes (Nous Portal)", note: "cloud · free + paid" },
  ollama: { name: "Ollama", note: "local" },
};

function relTime(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function badgeFor(m, hasKey) {
  if (!hasKey) return { text: "no key", cls: "warn" };
  if (m.cooldownUntil) return { text: `cooldown ${relTime(m.cooldownUntil).replace(" ago", "")}`, cls: "cooldown" };
  if (m.paid) return { text: "paid", cls: "paid" };
  return { text: "free", cls: "free" };
}

export default function Health() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      setHealth(await fetchHealth());
    } catch (err) {
      setError(err.message || "Couldn't reach the proxy");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncError("");
    setSyncResult(null);
    try {
      setSyncResult(await syncFreeModels());
      await refresh();
    } catch (err) {
      setSyncError(err.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  // RAG knowledge index state + manual reindex
  const [rag, setRag] = useState(null);
  const [ragIndexing, setRagIndexing] = useState(false);
  const [ragError, setRagError] = useState("");
  const ragRefresh = useCallback(async () => {
    try { setRag(await ragStatus()); } catch (err) { setRagError(err.message || "RAG status failed"); }
  }, []);
  useEffect(() => { ragRefresh(); }, [ragRefresh]);
  const runRagReindex = useCallback(async () => {
    setRagIndexing(true);
    setRagError("");
    try {
      setRag(await ragReindex(true));
    } catch (err) {
      setRagError(err.message || "Reindex failed");
    } finally {
      setRagIndexing(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="health-page">
        <div className="health-empty">Loading model health…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="health-page">
        <div className="health-empty">{error} — is the proxy (port 5175) running?</div>
      </div>
    );
  }

  const providers = health.providers || {};
  const providerNames = Object.keys(health.models || {}).filter((p) => (health.models[p] || []).length);
  const activity = (health.activity || []).filter((a) => a.lastUsed);
  const totalCooldowns = (health.cooldowns || []).length;

  return (
    <div className="health-page">
      <header className="health-header">
        <div className="health-brand">
          <div className="health-brand-icon"><Activity /></div>
          <div>
            <h1>Model Health</h1>
            <p>
              {Object.values(health.models || {}).reduce((n, l) => n + l.length, 0)} models ·
              {" "}{totalCooldowns} on cooldown ·
              {health.lastSync ? ` free models synced ${relTime(Date.parse(health.lastSync))}` : " free models never synced"}
            </p>
          </div>
        </div>
        <div className="health-actions">
          <button className="health-btn" onClick={refresh} title="Refresh status">
            <RefreshCw /> Refresh
          </button>
          <button className="health-btn primary" onClick={runSync} disabled={syncing} title="Re-fetch each provider's live free-model list">
            <RotateCw className={syncing ? "spin" : ""} /> {syncing ? "Syncing…" : "Sync free models"}
          </button>
        </div>
      </header>

      {syncError && <div className="health-banner error"><CircleExclamationPoint /> {syncError}</div>}
      {syncResult && (
        <div className="health-banner ok">
          <CircleCheck />
          <span>
            Sync finished
            {Object.entries(syncResult.providers || {}).map(([p, r]) =>
              ` · ${p}: ${r.ok ? `${r.total} free (${r.added.length} added, ${r.removed.length} removed)` : `failed — ${r.error}`}`).join("")}
          </span>
        </div>
      )}

      {/* Provider status cards */}
      <section className="health-providers">
        {Object.entries(PROVIDER_INFO).map(([id, info]) => {
          const ok = providers[id] !== false;
          const models = health.models[id] || [];
          const cooldowns = models.filter((m) => m.cooldownUntil).length;
          return (
            <div key={id} className={`health-provider-card ${ok ? "" : "down"}`}>
              <div className="hp-dot" />
              <div className="hp-copy">
                <b>{info.name}</b>
                <small>{info.note}</small>
              </div>
              <div className="hp-stats">
                <span>{models.length} models</span>
                {cooldowns > 0 && <span className="hp-cool">{cooldowns} cooling</span>}
              </div>
            </div>
          );
        })}
      </section>

      <div className="health-body">
        {/* Knowledge index (RAG) */}
        <section className="health-activity">
          <h2><BookOpen /> Knowledge index (RAG)</h2>
          {ragError && <p className="health-muted">RAG status unavailable: {ragError}</p>}
          {!ragError && rag && (
            <p className="health-muted">
              {rag.ready
                ? <>Vault indexed for semantic search: <b>{rag.totalChunks}</b> chunks from <b>{rag.filesIndexed}</b> files · model <b>{rag.model}</b>{rag.dim ? ` (${rag.dim}-dim)` : ""} · {rag.lastIndexed ? `updated ${relTime(Date.parse(rag.lastIndexed))}` : "never indexed"}</>
                : "Index not built yet — press Reindex to embed the Vault."}
              {rag.indexing ? " · indexing now…" : ""}
            </p>
          )}
          <div className="health-actions" style={{ marginTop: 8 }}>
            <button className="health-btn" onClick={runRagReindex} disabled={ragIndexing} title="Re-embed changed Vault files for semantic recall">
              <RotateCw className={ragIndexing ? "spin" : ""} /> {ragIndexing ? "Indexing…" : "Reindex Vault"}
            </button>
          </div>
          <p className="health-muted small">
            The agent recalls this index automatically each turn (top passages injected into context) and via [[RECALL: query]].
          </p>
        </section>

        {/* What the models are working on */}
        <section className="health-activity">
          <h2><Zap /> Activity — what the models are working on</h2>
          {activity.length === 0 ? (
            <p className="health-muted">No model activity this session yet. Send a chat and it will show up here.</p>
          ) : (
            <ul className="health-activity-list">
              {activity.map((a) => (
                <li key={a.model}>
                  <span className="ha-model">{a.model}</span>
                  <span className="ha-reqs">{a.requests} request{a.requests === 1 ? "" : "s"}</span>
                  <span className="ha-last">{relTime(a.lastUsed)}</span>
                  {a.errors > 0 && (
                    <span className="ha-err" title={`${a.lastError || ""} (${relTime(a.lastErrorAt)})`}>
                      <CircleX /> {a.errors} error{a.errors === 1 ? "" : "s"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="health-muted small">
            Server up since {new Date(health.startedAt).toLocaleString()} · cooldowns clear after 5 minutes
          </p>
        </section>

        {/* Full model inventory */}
        <section className="health-catalog">
          <h2><Timer /> Model inventory</h2>
          {providerNames.map((provider) => {
            const ok = providers[provider] !== false;
            return (
              <div key={provider} className="health-provider-group">
                <h3>
                  {PROVIDER_INFO[provider]?.name || provider}
                  <span className={`hpg-key ${ok ? "ok" : "bad"}`}>{ok ? "key ok" : "no key"}</span>
                </h3>
                <table className="health-table">
                  <thead>
                    <tr><th>Model</th><th>Context</th><th>Flags</th><th>Status</th><th>Used</th></tr>
                  </thead>
                  <tbody>
                    {(health.models[provider] || []).map((m) => {
                      const badge = badgeFor(m, ok);
                      return (
                        <tr key={m.id} className={m.cooldownUntil ? "cooling" : ""}>
                          <td>
                            <b>{m.label}</b>
                            <small>{provider}/{m.id}</small>
                          </td>
                          <td>{m.context ? fmtContext(m.context) : "—"}</td>
                          <td>
                            {m.vision && <span className="hflag">vision</span>}
                            <span className={`hbadge ${badge.cls}`}>{badge.text}</span>
                          </td>
                          <td>
                            {m.cooldownUntil
                              ? <span className="hstatus cool">cooldown {relTime(m.cooldownUntil)}</span>
                              : ok ? <span className="hstatus ok">ready</span>
                              : <span className="hstatus bad">no key</span>}
                          </td>
                          <td>{m.usage?.requests ? `${m.usage.requests}× · ${relTime(m.usage.lastUsed)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
