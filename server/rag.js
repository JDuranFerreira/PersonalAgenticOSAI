/* ==========================================================================
   Agentic OS — RAG (Retrieval-Augmented Generation)
   Proper retrieval pipeline over the Vault:
     1. Chunk Vault .md/.txt files (heading-aware, ~900 chars)
     2. Embed chunks locally with Ollama (nomic-embed-text, 768-dim)
     3. Store vectors in LanceDB (native vector search)
     4. Hybrid ranking: cosine vector search + BM25 keyword search,
        fused with Reciprocal Rank Fusion (RRF)
   Endpoints: GET /api/rag/status, POST /api/rag/reindex, GET /api/rag/query
   Injection: buildHistory() in Chat/ZazuPanel and the routine agent loop.
   ========================================================================== */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as lancedb from "@lancedb/lancedb";

const VAULT_ROOT = "C:\\AIAssistant\\AIAccess\\Vault";
const MEMORY_FILE = "C:\\AIAssistant\\AIAccess\\Vault\\Notes\\zazu-memory.md";
const RAG_DIR = "C:\\AIAssistant\\AgenticOS\\server\\rag-index";
const MANIFEST_FILE = path.join(RAG_DIR, "manifest.json");
const EMBED_MODEL = "nomic-embed-text";
const OLLAMA_BASE = "http://127.0.0.1:11434";
const TABLE = "chunks";
const CHUNK_TARGET = 900;      // chars per chunk (heading-aware)
const EMBED_BATCH = 32;
const RRF_K = 60;              // standard RRF constant

const state = {
  db: null,
  table: null,
  manifest: { files: {}, dim: 0, model: EMBED_MODEL, lastIndexed: null },
  bm25: null,                  // { docs: [{id, path, heading, ordinal, text, tokens, len}], avgLen, df: Map, n }
  indexing: false,
};

// ---------------------------------------------------------------------------
// File walking & chunking
// ---------------------------------------------------------------------------
function walkFiles(root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (/\.(md|txt)$/i.test(e.name)) out.push(full);
  }
  return out;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

// Heading-aware chunker: flushes on heading boundaries and ~CHUNK_TARGET chars.
function chunkMarkdown(text, filePath) {
  const rel = path.relative(VAULT_ROOT, filePath).replace(/\\/g, "/");
  const chunks = [];
  const lines = text.split(/\r?\n/);
  const headingStack = []; // [{ level, title }]
  let buf = [];
  let bufLen = 0;

  const flush = () => {
    const body = buf.join("\n").trim();
    buf = []; bufLen = 0;
    if (!body || body.length < 20) return; // skip trivial fragments
    const heading = headingStack.map((h) => h.title).join(" › ") || rel;
    chunks.push({ path: filePath, heading, ordinal: chunks.length, text: body.slice(0, 4000) });
  };

  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, title: m[2].trim() });
      continue;
    }
    buf.push(line);
    bufLen += line.length + 1;
    if (bufLen >= CHUNK_TARGET) flush();
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Embeddings (Ollama, local). Batch /api/embed with per-item /api/embeddings
// fallback for older Ollama versions.
// ---------------------------------------------------------------------------
async function embedBatch(texts) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(120000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) return data.embeddings;
      throw new Error(`Ollama /api/embed returned ${Array.isArray(data.embeddings) ? data.embeddings.length : "no"} embeddings`);
    }
    throw new Error(`Ollama /api/embed ${res.status}`);
  } catch (err) {
    // Fallback: legacy single-item endpoint
    const out = [];
    for (const text of texts) {
      const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`Ollama embeddings unavailable: ${err.message}`);
      const data = await res.json();
      if (!Array.isArray(data.embedding)) throw new Error("Ollama returned no embedding vector");
      out.push(data.embedding);
    }
    return out;
  }
}

async function embedOne(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

// ---------------------------------------------------------------------------
// BM25 keyword index over the in-memory chunk list
// ---------------------------------------------------------------------------
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;

function tokenize(text) {
  return (text.toLowerCase().match(WORD_RE) || []).slice(0, 400);
}

async function loadAllRows() {
  const rows = await state.table.query().toArrow();
  return rows.toArray().map((r) => r.toJSON());
}

async function buildBm25() {
  const rows = await loadAllRows();
  const docs = rows.map((r) => {
    const tokens = tokenize(`${r.heading || ""} ${r.text || ""}`);
    return { id: r.id, path: r.path, heading: r.heading, ordinal: r.ordinal, text: r.text, tokens, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / (docs.length || 1) || 1;
  state.bm25 = { docs, df, n: docs.length, avgLen };
  return state.bm25;
}

function bm25Scores(queryTokens, topN) {
  const bm = state.bm25;
  if (!bm || !bm.n) return [];
  const k1 = 1.4, b = 0.75;
  const scores = new Map();
  const uniqueQuery = [...new Set(queryTokens)];
  for (const term of uniqueQuery) {
    const df = bm.df.get(term) || 0;
    if (!df) continue;
    const idf = Math.log(1 + (bm.n - df + 0.5) / (df + 0.5));
    for (const d of bm.docs) {
      let tf = 0;
      for (const t of d.tokens) if (t === term) tf++;
      if (!tf) continue;
      const denom = tf + k1 * (1 - b + b * (d.len / bm.avgLen));
      const s = idf * (tf * (k1 + 1)) / denom;
      scores.set(d.id, (scores.get(d.id) || 0) + s);
    }
  }
  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, topN)
    .map(([id, score]) => ({ id, score }));
}

// ---------------------------------------------------------------------------
// LanceDB table plumbing
// ---------------------------------------------------------------------------
async function openTable() {
  if (state.table) return state.table;
  fs.mkdirSync(RAG_DIR, { recursive: true });
  state.db = await lancedb.connect(RAG_DIR);
  const names = await state.db.tableNames();
  state.table = names.includes(TABLE) ? await state.db.openTable(TABLE) : null;
  return state.table;
}

function rowId(file, ordinal) {
  return `${sha1(file)}:${ordinal}`;
}

function escapeFilter(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function deleteChunksFor(file) {
  if (!state.table) return;
  await state.table.delete(`path = '${escapeFilter(file)}'`);
}

async function addChunks(rows) {
  if (!rows.length) return;
  if (!state.table) state.table = await state.db.createTable(TABLE, rows);
  else await state.table.add(rows);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------
async function embedAndStore(file, text) {
  const chunks = chunkMarkdown(text, file);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embedBatch(batch.map((c) => `${c.heading}\n${c.text}`));
    if (!state.manifest.dim) state.manifest.dim = vectors[0].length;
    if (vectors[0].length !== state.manifest.dim) {
      throw new Error(`Embedding dimension changed (${vectors[0].length} != ${state.manifest.dim}) — full reindex required`);
    }
    const rows = batch.map((c, j) => ({
      id: rowId(file, c.ordinal),
      path: file,
      heading: c.heading,
      ordinal: c.ordinal,
      text: c.text,
      vector: Float32Array.from(vectors[j]),
    }));
    await addChunks(rows);
  }
  return chunks.length;
}

// Reindex only files whose content hash changed since the last run.
export async function reindex(force = false) {
  if (state.indexing) return { skipped: true, reason: "already indexing" };
  state.indexing = true;
  const started = Date.now();
  try {
    await openTable();

    // Load persisted manifest
    try { state.manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")); } catch { /* fresh index */ }
    if (typeof state.manifest.files !== "object" || !state.manifest.files) state.manifest.files = {};
    state.manifest.model = EMBED_MODEL;

    const files = walkFiles(VAULT_ROOT);
    const seen = new Set();
    let added = 0, removed = 0, embedded = 0;

    for (const file of files) {
      seen.add(file);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const hash = sha1(text);
      const prev = state.manifest.files[file];
      if (prev && prev.hash === hash && prev.dim === (state.manifest.dim || 0) && !force) continue;
      await deleteChunksFor(file);
      if (prev) removed += prev.chunks || 0;
      const count = await embedAndStore(file, text);
      state.manifest.files[file] = { hash, chunks: count, dim: state.manifest.dim || 0 };
      added += count;
      embedded += 1;
    }

    for (const file of Object.keys(state.manifest.files)) {
      if (seen.has(file)) continue;
      await deleteChunksFor(file);
      removed += state.manifest.files[file].chunks || 0;
      delete state.manifest.files[file];
    }

    state.manifest.lastIndexed = new Date().toISOString();
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(state.manifest, null, 2));
    await buildBm25();
    return {
      ok: true,
      files: files.length,
      embedded,
      chunksAdded: added,
      chunksRemoved: removed,
      totalChunks: Object.values(state.manifest.files).reduce((n, f) => n + f.chunks, 0),
      dim: state.manifest.dim,
      ms: Date.now() - started,
    };
  } finally {
    state.indexing = false;
  }
}

// Single-file incremental reindex (used after [[LEARN]] appends to memory).
export async function reindexFile(file) {
  try {
    await openTable();
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    const hash = sha1(text);
    const prev = state.manifest.files[file];
    if (prev && prev.hash === hash) return;
    await deleteChunksFor(file);
    const count = await embedAndStore(file, text);
    state.manifest.files[file] = { hash, chunks: count, dim: state.manifest.dim || 0 };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(state.manifest, null, 2));
    await buildBm25();
  } catch (err) {
    console.warn("RAG incremental reindex failed:", err.message);
  }
}

export async function ensureIndexed() {
  try {
    const status = await getStatus();
    if (!status.ready || status.filesIndexed === 0) await reindex();
    else await reindex(); // changed-file detection makes this cheap
  } catch (err) {
    console.warn("RAG startup index skipped:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Querying — hybrid (vector + BM25) with Reciprocal Rank Fusion
// ---------------------------------------------------------------------------
export async function query(q, k = 5) {
  const text = String(q || "").trim();
  if (!text) return [];
  await openTable();
  if (!state.table) return [];
  if (!state.bm25) await buildBm25();

  const qVec = await embedOne(text);
  const candidates = Math.max(k * 4, 24);

  // Vector leg (native Lance search); cosine similarity computed from the
  // returned (normalized) vectors so ranking is independent of Lance's
  // default distance metric.
  const arrow = await state.table.search(Float32Array.from(qVec)).limit(candidates).toArrow();
  const vectorHits = arrow.toArray().map((r) => {
    const { vector, _distance, ...rest } = r.toJSON();
    let sim = 0;
    if (vector && vector.length === qVec.length) {
      for (let i = 0; i < qVec.length; i++) sim += qVec[i] * vector[i];
    }
    return { ...rest, vectorSim: sim };
  });

  // Keyword leg (BM25)
  const keywordHits = bm25Scores(tokenize(text), candidates);

  // Reciprocal Rank Fusion
  const fused = new Map();
  const byId = new Map();
  for (const [i, hit] of vectorHits.entries()) {
    fused.set(hit.id, (fused.get(hit.id) || 0) + 1 / (RRF_K + i + 1));
    byId.set(hit.id, hit);
  }
  for (const [i, hit] of keywordHits.entries()) {
    fused.set(hit.id, (fused.get(hit.id) || 0) + 1 / (RRF_K + i + 1));
    if (!byId.has(hit.id)) {
      const doc = state.bm25.docs.find((d) => d.id === hit.id);
      if (doc) byId.set(hit.id, { id: doc.id, path: doc.path, heading: doc.heading, ordinal: doc.ordinal, text: doc.text });
    }
  }

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => {
      const hit = byId.get(id) || {};
      return {
        path: hit.path ? path.relative(VAULT_ROOT, hit.path).replace(/\\/g, "/") : "?",
        heading: hit.heading || "",
        ordinal: hit.ordinal ?? 0,
        text: hit.text || "",
        score: Number(score.toFixed(5)),
      };
    });
}

export async function getStatus() {
  try {
    await openTable();
  } catch {
    return { ready: false, model: EMBED_MODEL, filesIndexed: 0, totalChunks: 0, lastIndexed: null, indexing: state.indexing };
  }
  let count = 0;
  try { count = await state.table.countRows(); } catch { /* no table yet */ }
  return {
    ready: Boolean(state.table) && state.manifest.dim > 0,
    model: EMBED_MODEL,
    dim: state.manifest.dim || null,
    filesIndexed: Object.keys(state.manifest.files).length,
    totalChunks: count,
    lastIndexed: state.manifest.lastIndexed,
    indexing: state.indexing,
  };
}

// Format retrieval hits for prompt injection.
export function formatHits(hits, maxChars = 3600) {
  const parts = [];
  let total = 0;
  for (const hit of hits) {
    const body = hit.text.slice(0, 900);
    const part = `### ${hit.heading}  (source: Vault/${hit.path})\n${body}`;
    if (total + part.length > maxChars) break;
    total += part.length;
    parts.push(part);
  }
  return parts.join("\n\n");
}
