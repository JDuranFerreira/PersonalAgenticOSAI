import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, CircleAlert, FileWarning,
  Code2, KeyRound, LockKeyhole, RefreshCw, ShieldCheck,
} from "lucide-react";
import { fetchGitHubSecurityAudit } from "../utils/api";
import "./Security.css";

const PROTECTION_LABELS = {
  envFiles: "Environment files (.env)",
  privateKeys: "Private key files",
  credentials: "Credential and secrets folders",
  generatedFiles: "Dependencies and build output",
};

export default function Security() {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runAudit = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAudit(await fetchGitHubSecurityAudit());
    } catch (err) {
      setError(err.message || "Could not run the local security audit.");
    } finally {
      setLoading(false);
    }
  }, []);

  const protectionCount = useMemo(
    () => Object.values(audit?.protections || {}).filter(Boolean).length,
    [audit],
  );
  const needsReview = Boolean(audit && (
    audit.findings.length > 0
    || !audit.gitignorePresent
    || protectionCount < Object.keys(PROTECTION_LABELS).length
  ));

  return (
    <section className="security-page">
      <header className="security-header">
        <div className="security-title-group">
          <span className="security-brand-icon"><ShieldCheck size={21} /></span>
          <div>
            <div className="security-eyebrow">Local project check</div>
            <h1>Security</h1>
            <p>Prepare Agentic OS for a safer GitHub push.</p>
          </div>
        </div>
        <button className="security-scan-button" onClick={runAudit} disabled={loading}>
          <RefreshCw size={15} className={loading ? "security-spinning" : ""} />
          {loading ? "Scanning…" : "Run audit"}
        </button>
      </header>

      <div className="security-content">
        <section className={`security-status-card ${audit && !needsReview ? "is-ready" : "needs-review"}`} aria-live="polite">
          <span className="security-status-icon">
            {audit && !needsReview ? <CheckCircle2 size={22} /> : <ShieldCheck size={22} />}
          </span>
          <div className="security-status-copy">
            <span className="security-overline">GitHub readiness</span>
            <h2>{loading && !audit ? "Checking project files…" : audit ? (needsReview ? "Review before publishing" : "No obvious secrets found") : "Ready to run your local check"}</h2>
            <p>
              {audit
                ? `${audit.filesScanned.toLocaleString()} files checked${audit.truncated ? " (scan limit reached)" : ""}. Findings show file and line only—never secret values.`
                : "Nothing is scanned until you select Run audit. The scan stays on this computer."}
            </p>
          </div>
          {audit && <span className={`security-status-pill ${needsReview ? "review" : "ready"}`}>{needsReview ? "Review needed" : "Looks good"}</span>}
        </section>

        {error && <div className="security-error"><CircleAlert size={16} />{error}</div>}

        <div className="security-grid">
          <section className="security-card security-protections">
            <div className="security-card-heading">
              <LockKeyhole size={17} />
              <div><h2>Ignore rules</h2><p>Files that should stay out of GitHub</p></div>
            </div>
            <div className="security-check-list">
              {Object.entries(PROTECTION_LABELS).map(([key, label]) => {
                const protectedByIgnore = Boolean(audit?.protections?.[key]);
                return (
                  <div className={`security-check-row ${!audit ? "unchecked" : protectedByIgnore ? "passed" : "failed"}`} key={key}>
                    <span className="security-check-icon">{!audit ? "–" : protectedByIgnore ? <Check size={14} /> : <AlertTriangle size={14} />}</span>
                    <span>{label}</span>
                    <b>{!audit ? "Not checked" : protectedByIgnore ? "Protected" : "Missing"}</b>
                  </div>
                );
              })}
              <div className={`security-check-row ${!audit ? "unchecked" : audit.gitignorePresent ? "passed" : "failed"}`}>
                <span className="security-check-icon">{!audit ? "–" : audit.gitignorePresent ? <Check size={14} /> : <AlertTriangle size={14} />}</span>
                <span>Project .gitignore</span>
                <b>{!audit ? "Not checked" : audit.gitignorePresent ? "Found" : "Missing"}</b>
              </div>
            </div>
            <p className="security-card-note">Ignore rules only affect untracked files. They do not remove a file that Git is already tracking.</p>
          </section>

          <section className="security-card security-findings">
            <div className="security-card-heading">
              <KeyRound size={17} />
              <div><h2>Credential scan</h2><p>Local pattern scan, values are never displayed</p></div>
              {audit && <span className={`security-count ${audit.findings.length ? "has-findings" : ""}`}>{audit.findings.length}</span>}
            </div>
            {!audit && loading ? (
              <div className="security-empty"><span className="security-spinner" />Scanning local project files…</div>
            ) : !audit ? (
              <div className="security-empty"><KeyRound size={17} />Run the audit to check this project for common credential patterns.</div>
            ) : audit?.findings.length ? (
              <div className="security-findings-list">
                {audit.findings.map((finding, index) => (
                  <article className="security-finding" key={`${finding.file}:${finding.line}:${finding.category}:${index}`}>
                    <span className="security-finding-icon"><FileWarning size={15} /></span>
                    <div className="security-finding-copy">
                      <b>{finding.category}</b>
                      <code>{finding.file}{finding.line ? `:${finding.line}` : ""}</code>
                      <p>{finding.message}</p>
                    </div>
                    <span className="security-severity">Review</span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="security-empty security-clean"><CheckCircle2 size={18} />No credential-like values or sensitive filenames detected.</div>
            )}
            <p className="security-card-note">This is a heuristic check, not a guarantee. Inspect flagged lines on your machine; matching values are never sent to the UI.</p>
          </section>
        </div>

        <section className="security-guidance">
          <div className="security-guidance-icon"><Code2 size={19} /></div>
          <div>
            <h2>Before you push</h2>
            <ul>
              <li>Keep provider keys in your external local config or a deployment secret store—never in source files.</li>
              <li>Review the staged file list and scan findings yourself. This screen does not upload or change GitHub.</li>
              <li>Enable GitHub secret scanning and push protection for the repository when available.</li>
              <li>If a real token was ever committed, revoke/rotate it. Removing the file does not erase Git history.</li>
            </ul>
          </div>
          <span className="security-local-badge"><LockKeyhole size={12} /> Local only</span>
        </section>

        {audit?.scannedAt && <p className="security-scanned-at">Last scanned {new Date(audit.scannedAt).toLocaleString()}</p>}
      </div>
    </section>
  );
}
