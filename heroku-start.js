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

app.get('/api/formulas', (req, res) => {
  if (!formulasCache) {
    try {
      const raw = readFileSync(join(__dirname, 'docs', 'mathematical_methods.json'), 'utf8');
      const data = JSON.parse(raw);
      formulasCache = (data.categories || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        name_en: cat.name_en,
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
    } catch (err) {
      console.error('[formulas] Failed to load:', err.message);
      return res.status(500).json({ error: 'Failed to load formulas' });
    }
  }
  res.json({ categories: formulasCache });
});

// ── Server-side solve pipeline (SSE) ──────────────────────────────────

import { solve } from './solve-pipeline.js';

const solveJsonParser = express.json({ limit: '50kb' });

app.post('/api/solve', solveJsonParser, async (req, res) => {
  const { message, sessionId: clientSessionId } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  const sessionId = clientSessionId || randomUUID();

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await solve(message, sessionId, (step) => {
      sendSSE('step', step);
    });

    sendSSE('done', result);
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

const SHARE_EXPIRY_DAYS = 60;

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pool) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      messages JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => {
    pool.query(`CREATE INDEX IF NOT EXISTS idx_shares_created ON shares(created_at)`);
    console.log('[shares] Postgres table ready');
  }).catch(err => console.error('[shares] Table init error:', err.message));

  // Cleanup expired entries on startup and every 6 hours
  const cleanupExpired = () => {
    pool.query(`DELETE FROM shares WHERE created_at < NOW() - INTERVAL '${SHARE_EXPIRY_DAYS} days'`)
      .then(res => { if (res.rowCount > 0) console.log(`[shares] Cleaned up ${res.rowCount} expired entries`); })
      .catch(err => console.error('[shares] Cleanup error:', err.message));
  };
  setTimeout(cleanupExpired, 5000);
  setInterval(cleanupExpired, 6 * 3600000);
} else {
  console.warn('[shares] DATABASE_URL not set, permalink sharing disabled');
}

const shareJsonParser = express.json({ limit: '200kb' });

app.post('/api/share', shareJsonParser, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  const { question, messages } = req.body || {};
  if (!question || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'question and messages[] are required' });
  }
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  try {
    await pool.query(
      'INSERT INTO shares (id, question, messages) VALUES ($1, $2, $3)',
      [id, question, JSON.stringify(messages.slice(0, 50))]
    );
    res.json({ id, url: `/s/${id}` });
  } catch (err) {
    console.error('[shares] Insert error:', err.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

app.get('/api/share/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  try {
    const { rows } = await pool.query('SELECT question, messages, created_at FROM shares WHERE id = $1', [req.params.id]);
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
