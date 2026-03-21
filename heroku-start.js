#!/usr/bin/env node

/**
 * Heroku Startup Wrapper
 *
 * Single entry point that:
 * 1. Serves the Vite SPA from dist/
 * 2. Reverse-proxies /api/mcp/* → MCP proxy (localhost:MCP_PORT)
 * 3. Reverse-proxies /api/rag/*  → RAG service (localhost:RAG_PORT)
 * 4. Spawns MCP proxy + RAG service as child processes
 *
 * Uses only built-in Node modules + express (already a dependency).
 */

import express from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 5000;
const MCP_PORT = process.env.MCP_PORT || 3001;
const RAG_PORT = process.env.RAG_PORT || 3003;

const app = express();
const children = [];

// ── Child process spawning ──────────────────────────────────────────────

function spawnChild(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    console.log(`[${label}] ${data.toString().trim()}`);
  });
  child.stderr.on('data', (data) => {
    console.error(`[${label}] ${data.toString().trim()}`);
  });
  child.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code}`);
  });

  children.push(child);
  return child;
}

// Start MCP proxy
console.log(`Starting MCP proxy on localhost:${MCP_PORT}...`);
spawnChild('mcp-proxy', 'node', ['mcp-proxy-server.js'], { MCP_PORT: String(MCP_PORT) });

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

// ── Reverse proxy helper (pure Node http) ───────────────────────────────

function proxyRequest(prefix, targetPort, req, res) {
  const targetPath = req.originalUrl.replace(prefix, '') || '/';
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy] ${prefix} error:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Service unavailable: ${err.message}` });
    }
  });

  req.pipe(proxyReq, { end: true });
}

// ── Routes ──────────────────────────────────────────────────────────────

// Proxy /api/mcp/* → localhost:MCP_PORT/*
app.all('/api/mcp/*', (req, res) => proxyRequest('/api/mcp', MCP_PORT, req, res));
app.all('/api/mcp', (req, res) => proxyRequest('/api/mcp', MCP_PORT, req, res));

// Proxy /api/rag/* → localhost:RAG_PORT/*
app.all('/api/rag/*', (req, res) => proxyRequest('/api/rag', RAG_PORT, req, res));
app.all('/api/rag', (req, res) => proxyRequest('/api/rag', RAG_PORT, req, res));

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

// ── Static SPA serving ──────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');
const basePath = '/formulo';

// Redirect root to app
app.get('/', (req, res) => {
  res.redirect(basePath + '/');
});

// Serve static assets
app.use(basePath, express.static(distPath));

// SPA fallback — all non-file routes under basePath serve index.html
app.get(`${basePath}/*`, (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

// ── Start server ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Heroku wrapper listening on port ${PORT}`);
  console.log(`   SPA:  http://localhost:${PORT}${basePath}/`);
  console.log(`   MCP:  http://localhost:${PORT}/api/mcp/health`);
  console.log(`   RAG:  http://localhost:${PORT}/api/rag/health`);
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
