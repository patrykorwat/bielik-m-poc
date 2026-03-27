#!/usr/bin/env node

/**
 * Heroku Startup Wrapper
 *
 * Single entry point that:
 * 1. Serves the Vite SPA from dist/
 * 2. Spawns MCP proxy + RAG service as child processes
 * 3. Exposes /api/solve (SSE) as the single public API endpoint
 *
 * MCP proxy and RAG are internal only, accessed by solve-pipeline.js via localhost.
 *
 * Uses only built-in Node modules + express (already a dependency).
 */

import tracer from 'dd-trace';
import express from 'express';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 5000;
const MCP_PORT = process.env.MCP_PORT || 3001;
const RAG_PORT = process.env.RAG_PORT || 3003;

const app = express();
const children = [];

// ── HTTPS redirect (Heroku sets x-forwarded-proto) ────────────────────

app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.hostname}${req.url}`);
  }
  next();
});

// ── Child process spawning ──────────────────────────────────────────────

function spawnChild(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) console.log(`[${label}] ${trimmed}`);
    }
  });
  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) console.error(`[${label}] ${trimmed}`);
    }
  });
  child.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code}`);
  });

  children.push(child);
  return child;
}

// Start MCP proxy
console.log(`Starting MCP proxy on localhost:${MCP_PORT}...`);
spawnChild('mcp-proxy', 'node', ['--import', 'dd-trace/initialize.mjs', 'mcp-proxy-server.js'], {
  MCP_PORT: String(MCP_PORT),
  DD_SERVICE: 'formulo-mcp-proxy',
});

// Start RAG service
console.log(`Starting RAG service on localhost:${RAG_PORT}...`);
const pythonCmd = existsSync(join(__dirname, 'rag_service', 'venv', 'bin', 'python3'))
  ? join(__dirname, 'rag_service', 'venv', 'bin', 'python3')
  : 'python3';
spawnChild('rag', pythonCmd, [join(__dirname, 'rag_service', 'main.py')], {
  RAG_PORT: String(RAG_PORT),
  RAG_HOST: '127.0.0.1',
});

let bot_active = false;
let bot_status = 'not_started';
let bot_pid = null;

// Start Discord bot (optional — only if DISCORD_TOKEN is set)
if (process.env.DISCORD_TOKEN) {
  console.log('Starting Discord bot...');
  const botChild = spawnChild('discord-bot', 'node', ['discord-bot.js']);
  bot_active = true;
  bot_status = 'spawned';
  bot_pid = botChild.pid;
  botChild.on('exit', (code) => {
    bot_status = `exited(${code})`;
    bot_active = false;
  });
} else {
  console.log('DISCORD_TOKEN not set — skipping Discord bot');
  bot_status = 'no_token';
}

// Give child processes a moment to start
await new Promise((resolve) => setTimeout(resolve, 3000));

// ── Routes (MCP + RAG are internal only, accessed via localhost) ────────

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      mcp: `http://127.0.0.1:${MCP_PORT}`,
      rag: `http://127.0.0.1:${RAG_PORT}`,
    },
    bot: {
      active: bot_active,
      status: bot_status,
      pid: bot_pid,
    },
  });
});

// ── Formula reference (serves mathematical_methods.json) ─────────────

let formulasCache = null;

// Map category IDs from mathematical_methods.json to education levels
const CATEGORY_LEVEL = {
  algebra_expressions:      'matura_podstawowa',
  equations_inequalities:   'matura_podstawowa',
  functions:                'matura_podstawowa',
  sequences_series:         'matura_podstawowa',
  trigonometry:             'matura_podstawowa',
  plane_geometry:           'podstawowa',
  solid_geometry:           'matura_rozszerzona',
  analytic_geometry:        'matura_rozszerzona',
  combinatorics_probability:'matura_rozszerzona',
  proofs_reasoning:         'matura_rozszerzona',
  number_theory:            'studia',
  derivatives_calculus:     'studia',
  special_techniques:       'matura_rozszerzona',
  exam_strategy:            'matura_podstawowa',
};

const LEVEL_ORDER = ['podstawowa', 'matura_podstawowa', 'matura_rozszerzona', 'studia'];
const LEVEL_LABELS = {
  podstawowa: 'Szkoła podstawowa',
  matura_podstawowa: 'Matura podstawowa',
  matura_rozszerzona: 'Matura rozszerzona',
  studia: 'Studia',
};

app.get('/api/formulas', (req, res) => {
  if (!formulasCache) {
    try {
      // Load SymPy method reference (mathematical_methods.json)
      const raw = readFileSync(join(__dirname, 'docs', 'mathematical_methods.json'), 'utf8');
      const data = JSON.parse(raw);
      const methodCategories = (data.categories || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        name_en: cat.name_en,
        level: CATEGORY_LEVEL[cat.id] || 'matura_podstawowa',
        type: 'methods',
        methods: (cat.methods || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description,
          sympy_functions: m.sympy_functions,
          when_to_use: m.when_to_use,
          worked_example: m.worked_example ? {
            problem: m.worked_example.problem,
            common_pitfalls: m.worked_example.common_pitfalls,
          } : null,
        })),
      }));

      // Load CKE matura formula reference (matura-formulas.json)
      const ckeRaw = readFileSync(join(__dirname, 'docs', 'matura-formulas.json'), 'utf8');
      const ckeData = JSON.parse(ckeRaw);
      const ckeCategories = (ckeData.sections || []).map(sec => ({
        id: sec.id,
        name: sec.name,
        name_en: '',
        level: sec.level,
        type: 'formulas',
        methods: (sec.formulas || []).map(f => ({
          id: f.id,
          name: f.name,
          description: f.latex ? `$${f.latex}$` : '',
          sympy_functions: [],
          when_to_use: '',
          worked_example: null,
          latex: f.latex || '',
        })),
      }));

      const allCategories = [...ckeCategories, ...methodCategories];

      formulasCache = LEVEL_ORDER.map(level => ({
        level,
        label: LEVEL_LABELS[level],
        categories: allCategories.filter(c => c.level === level),
      }));
    } catch (err) {
      console.error('[formulas] Failed to load:', err.message);
      return res.status(500).json({ error: 'Failed to load formulas' });
    }
  }
  res.json({ levels: formulasCache });
});

// ── Server-side solve pipeline (SSE) ──────────────────────────────────

import { solve } from './solve-pipeline.js';

// In-memory session store: keeps last N messages per sessionId
// Entries expire after 12 hours of inactivity
const sessionStore = new Map(); // sessionId -> { messages: [{role, content}], lastAccess: Date }
const SESSION_MAX_MESSAGES = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSessionHistory(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) return [];
  session.lastAccess = Date.now();
  return session.messages.slice(-SESSION_MAX_MESSAGES);
}

function addToSession(sessionId, role, content) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const session = sessionStore.get(sessionId);
  session.lastAccess = Date.now();
  session.messages.push({ role, content });
  // Keep only the last N messages
  if (session.messages.length > SESSION_MAX_MESSAGES * 2) {
    session.messages = session.messages.slice(-SESSION_MAX_MESSAGES);
  }
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionStore) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, 10 * 60 * 1000);

const solveJsonParser = express.json({ limit: '50kb' });

app.post('/api/solve', solveJsonParser, async (req, res) => {
  const { message, sessionId: clientSessionId } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  const sessionId = clientSessionId || randomUUID();

  // Get conversation history for this session, then record user message
  const chatHistory = getSessionHistory(sessionId);
  addToSession(sessionId, 'user', message);
  const shareId = randomUUID().replace(/-/g, '').slice(0, 8);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Collect steps for the share cache
  const collectedSteps = [];

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await solve(message, sessionId, (step) => {
      collectedSteps.push(step);
      sendSSE('step', step);
    }, chatHistory);

    // Include shareId in the done event so the client can reference it
    sendSSE('done', { ...result, shareId });

    // Record a short summary of the response in session history
    const summaryStep = collectedSteps.find(s => s.step === 'summary_done' && s.content);
    if (summaryStep) {
      // Keep only first 300 chars to avoid bloating session memory
      addToSession(sessionId, 'assistant', summaryStep.content.slice(0, 300));
    }

    // Save to Postgres (fire and forget, don't block SSE close)
    const shareMessages = collectedSteps
      .filter(s => s.step?.endsWith('_done') && !s.blocked && s.agentName !== 'Guardrail' && s.agentName !== 'Klasyfikator')
      .map(s => ({ role: 'assistant', content: s.content, agentName: s.agentName }));
    if (shareMessages.length > 0) {
      shareMessages.unshift({ role: 'user', content: message });
      saveShare(shareId, message, shareMessages);
    }
  } catch (err) {
    console.error('[solve] Pipeline error:', err);
    sendSSE('error', { error: err.message || 'Pipeline failed' });
  }

  res.end();
});

// ── SEO static pages (served before SPA fallback) ─────────────────────

const seoPath = join(__dirname, 'seo', 'pages');
app.use('/zadania', express.static(join(seoPath, 'zadania'), { extensions: ['html'] }));
app.use('/tematy', express.static(join(seoPath, 'tematy'), { extensions: ['html'] }));
app.get('/sitemap.xml', (_req, res) => {
  res.sendFile(join(__dirname, 'seo', 'sitemap.xml'));
});
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://formulo.pl/sitemap.xml`);
});

// ── Shared solution cache (permalinks, Postgres) ────────────────────

const SHARE_SHORT_TTL_HOURS = 24;
const SHARE_EXTENDED_TTL_DAYS = 60;

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pool) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      messages JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `).then(() =>
    // Migration: add expires_at if table existed before this column was introduced
    pool.query(`ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {})
  ).then(() =>
    // Backfill: set expires_at for any old rows that have NULL (24h from created_at)
    pool.query(`UPDATE shares SET expires_at = created_at + INTERVAL '24 hours' WHERE expires_at IS NULL`).catch(() => {})
  ).then(() =>
    pool.query(`CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at)`)
  ).then(() => {
    console.log('[shares] Postgres table ready');
  }).catch(err => console.error('[shares] Table init error:', err.message));

  // Cleanup expired entries on startup and every hour
  const cleanupExpired = () => {
    pool.query('DELETE FROM shares WHERE expires_at < NOW()')
      .then(res => { if (res.rowCount > 0) console.log(`[shares] Cleaned up ${res.rowCount} expired entries`); })
      .catch(err => console.error('[shares] Cleanup error:', err.message));
  };
  setTimeout(cleanupExpired, 5000);
  setInterval(cleanupExpired, 3600000);
} else {
  console.warn('[shares] DATABASE_URL not set, permalink sharing disabled');
}

// Called by the solve pipeline after a successful response
async function saveShare(id, question, messages) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO shares (id, question, messages, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${SHARE_SHORT_TTL_HOURS} hours')
       ON CONFLICT (id) DO UPDATE SET messages = $3, expires_at = NOW() + INTERVAL '${SHARE_SHORT_TTL_HOURS} hours'`,
      [id, question, JSON.stringify(messages)]
    );
  } catch (err) {
    console.error('[shares] Save error:', err.message);
  }
}

// Extend lifespan to 60 days (triggered by user clicking "share")
app.post('/api/share/:id/extend', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE shares SET expires_at = NOW() + INTERVAL '${SHARE_EXTENDED_TTL_DAYS} days' WHERE id = $1 AND expires_at > NOW()`,
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Solution not found or expired' });
    }
    res.json({ url: `/s/${req.params.id}` });
  } catch (err) {
    console.error('[shares] Extend error:', err.message);
    res.status(500).json({ error: 'Failed to extend' });
  }
});

// Fetch a shared solution
app.get('/api/share/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  try {
    const { rows } = await pool.query(
      'SELECT question, messages, created_at, expires_at FROM shares WHERE id = $1 AND expires_at > NOW()',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Solution not found or expired' });
    }
    res.json({
      question: rows[0].question,
      messages: rows[0].messages,
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    console.error('[shares] Get error:', err.message);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// ── Static SPA serving ──────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');

// Serve static assets at root
app.use(express.static(distPath));

// SPA fallback — all non-file routes serve index.html
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

// ── Start server ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Heroku wrapper listening on port ${PORT}`);
  console.log(`   SPA:  http://localhost:${PORT}/`);
  console.log(`   MCP:  internal only (localhost:${MCP_PORT})`);
  console.log(`   RAG:  internal only (localhost:${RAG_PORT})`);
  console.log(`   BOT:  active: ${bot_active}`);
  console.log(`   ENV:  DISCORD_TOKEN=${process.env.DISCORD_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`   ENV:  DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID ? process.env.DISCORD_CHANNEL_ID : 'MISSING'}`);
  console.log(`   ENV:  LLM_API_URL=${process.env.LLM_API_URL || 'MISSING'}`);
  console.log(`   ENV:  LLM_API_KEY=${process.env.LLM_API_KEY ? 'set' : 'MISSING'}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down child processes...`);
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
