import fs from "node:fs";
import path from "node:path";

export const LOCAL_HOST = "127.0.0.1";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5174",
  "http://127.0.0.1:5174",
]);

export function isOriginAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const remainder = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.resolve(resolved, ...remainder);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isPathWithinRoots(target, roots) {
  const normalizedTarget = canonicalPath(target);
  if (!normalizedTarget) return false;
  const targetLower = normalizedTarget.toLowerCase();
  return roots.some((root) => {
    const normalizedRoot = canonicalPath(root);
    if (!normalizedRoot) return false;
    const rootLower = normalizedRoot.toLowerCase();
    return targetLower === rootLower || targetLower.startsWith(rootLower + path.sep.toLowerCase());
  });
}

const AUDIT_SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".vite"]);
const MAX_AUDIT_FILES = 5000;
const MAX_AUDIT_FILE_BYTES = 1024 * 1024;
const MAX_AUDIT_TOTAL_BYTES = 50 * 1024 * 1024;

const SECRET_PATTERNS = [
  { category: "Private key material", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { category: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { category: "Cloud/API token", regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g },
  { category: "Bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  {
    category: "Possible secret assignment",
    regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*(?:["']([^"'\r\n]{8,})["']|([A-Za-z0-9_./+=-]{12,}))/gi,
  },
  { category: "Personal email address", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { category: "Personal Windows user path", regex: /\b[A-Z]:\\+Users\\+[^\\/\s"'`]+/gi },
];

function isPlaceholder(value) {
  return /^(?:your[-_ ]|replace[-_ ]|insert[-_ ]|example|placeholder|changeme|xxxx|\$\{|process\.env|env\.)/i.test(value.trim());
}

function isScannableText(filePath, buffer) {
  if (buffer.includes(0)) return false;
  if (path.basename(filePath).toLowerCase().startsWith(".env")) return true;
  const extension = path.extname(filePath).toLowerCase();
  return new Set([
    "", ".env", ".txt", ".md", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".html", ".css", ".scss",
    ".ps1", ".bat", ".cmd", ".sh", ".py", ".example", ".template", ".pem", ".key", ".rsa",
  ]).has(extension);
}

/**
 * Locally audit a project before publishing. Findings intentionally contain
 * only a relative filename, line number, and rule name—never matching text.
 */
export function auditGitHubSafety(projectRoot) {
  const root = path.resolve(projectRoot);
  const findings = [];
  let filesScanned = 0;
  let totalBytesScanned = 0;
  let truncated = false;

  const addFinding = (finding) => {
    findings.push(finding);
  };

  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_AUDIT_FILES) {
        truncated = true;
        return;
      }

      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!AUDIT_SKIP_DIRS.has(entry.name)) walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      filesScanned += 1;
      const basename = entry.name.toLowerCase();
      if ((basename.startsWith(".env") && basename !== ".env.example" && basename !== ".env.template")
        || /^credentials(?:\.|$)/i.test(entry.name)
        || /^secrets?(?:\.|$)/i.test(entry.name)
        || /\.(?:pem|key|p12|pfx|rsa)$/i.test(entry.name)
        || /^id_(?:rsa|ed25519)$/i.test(entry.name)) {
        addFinding({
          severity: "high",
          category: "Sensitive filename",
          file: relative,
          line: null,
          message: "This filename commonly contains local credentials or private configuration.",
        });
      }

      let stat;
      try { stat = fs.statSync(absolute); } catch { continue; }
      if (stat.size > MAX_AUDIT_FILE_BYTES) continue;
      if (totalBytesScanned + stat.size > MAX_AUDIT_TOTAL_BYTES) {
        truncated = true;
        return;
      }
      totalBytesScanned += stat.size;

      let buffer;
      try { buffer = fs.readFileSync(absolute); } catch { continue; }
      if (!isScannableText(absolute, buffer)) continue;

      const lines = buffer.toString("utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of SECRET_PATTERNS) {
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(line);
          if (!match) continue;
          const possibleValue = match[1] || match[2] || match[0];
          if (pattern.category === "Possible secret assignment" && isPlaceholder(possibleValue)) continue;
          if (pattern.category === "Personal email address" && /@(example\.(?:com|org|net)|test\.invalid)$/i.test(possibleValue)) continue;
          addFinding({
            severity: pattern.category.startsWith("Personal ") ? "medium" : "high",
            category: pattern.category,
            file: relative,
            line: index + 1,
            message: "Review this line locally. The matched value is deliberately hidden.",
          });
        }
      });
    }
  }

  walk(root);

  let ignoreText = "";
  try { ignoreText = fs.readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { /* surfaced below */ }
  const ignoreLines = ignoreText.split(/\r?\n/).map((line) => line.trim());
  const hasPattern = (pattern) => ignoreLines.includes(pattern);
  const protections = {
    envFiles: hasPattern(".env") && hasPattern(".env.*") && hasPattern("*.env"),
    privateKeys: hasPattern("*.pem") && hasPattern("*.key"),
    credentials: hasPattern("credentials/") && hasPattern("secrets/"),
    generatedFiles: hasPattern("node_modules/") && hasPattern("dist/"),
  };

  return {
    scannedAt: new Date().toISOString(),
    filesScanned,
    truncated,
    gitignorePresent: Boolean(ignoreText),
    protections,
    findings,
  };
}
