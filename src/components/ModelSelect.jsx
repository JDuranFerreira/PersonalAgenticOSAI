/* ==========================================================================
   Agentic OS — ModelSelect
   Dropdown listing ALL free models available in the Agentic OS, grouped by
   provider, e.g. "GLM 5.3 Flash · 1M ctx (opencode)".
   Catalog is fetched once from the proxy and cached for the session.
   ========================================================================== */
import { useEffect, useState } from "react";
import { fetchModelCatalog, fmtContext } from "../utils/api";

const GROUP_LABELS = {
  openrouter: "OpenRouter — cloud, free",
  opencode: "opencode Zen — cloud, free",
  hermes: "Hermes (Nous Portal) — cloud",
  ollama: "Ollama — local",
};

const PROVIDER_ORDER = ["openrouter", "opencode", "hermes", "ollama"];

export default function ModelSelect({
  value,
  onChange,
  filterProviders = null, // e.g. ["ollama"] to restrict; null = all
  includeNone = false,
  noneLabel = "None",
  className = "model-select wide",
}) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchModelCatalog()
      .then((c) => alive && setCatalog(c))
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <select className={className} value={value} onChange={(e) => onChange(e.target.value)} disabled>
        <option value={value}>Model catalog unavailable — proxy off?</option>
      </select>
    );
  }

  if (!catalog) {
    return (
      <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={value}>Loading models…</option>
      </select>
    );
  }

  const { entries, availability } = catalog;
  const shown = filterProviders ? entries.filter((m) => filterProviders.includes(m.provider)) : entries;

  const groups = [];
  for (const p of PROVIDER_ORDER) {
    const models = shown.filter((m) => m.provider === p);
    if (models.length) groups.push([p, models]);
  }
  // any unexpected providers
  for (const m of shown) {
    if (!PROVIDER_ORDER.includes(m.provider)) {
      let g = groups.find(([p]) => p === m.provider);
      if (!g) { g = [m.provider, []]; groups.push(g); }
      g[1].push(m);
    }
  }

  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {includeNone && <option value="">{noneLabel}</option>}
      {groups.map(([provider, models]) => {
        const ok = availability[provider] !== false;
        return (
          <optgroup key={provider} label={GROUP_LABELS[provider] || provider}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.context ? ` · ${fmtContext(m.context)}` : ""}
                {m.vision ? " · vision" : ""}
                {m.paid ? " · paid" : ""}
                {ok ? "" : " · no key"}
                {" ("}{m.provider}{")"}
              </option>
            ))}
          </optgroup>
        );
      })}
      {/* value not in catalog (e.g. stale setting) — keep it selectable */}
      {value && !shown.some((m) => m.id === value) && value !== "" && (
        <option value={value}>{value} (custom)</option>
      )}
    </select>
  );
}
