#!/usr/bin/env node

/**
 * Heroku Startup Wrapper
 *
 * Single entry point that:
 * 1. Serves the Vite SPA from dist/
 * 2. Reverse-proxies /api/mcp/* → MCP proxy (localhost:MCP_PORT)
 * 3. Reverse-proxies /api/rag/*  → RAG service (localhost:RAG_PORT)
 * 4. Spawns MCP proxy + RAG service as child processes
 */

import express from 'express';
import { spawn } from 'child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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
spawnChild('mcp-proxy', 'node', ['mcp-proxy-server.js'], { MCP_PORT });

// Start RAG service
console.log(`Starting RAG service on localhost:${RAG_PORT}...`);
const pythonCmd = existsSync(join(__dirname, 'rag_service', 'venv', 'bin', 'python3'))
  ? join(__dirname, 'rag_service', 'venv', 'bin', 'python3')
  : 'python3';
spawnChild('rag', pythonCmd, [join(__dirname, 'rag_service', 'main.py')], {
  RAG_PORT,
  RAG_HOST: '127.0.0.1',
});

// Give child processes a moment to start
await new Promise((resolve) => setTimeout(resolve, 3000));

// ── Reverse proxies ─────────────────────────────────────────────────────

app.use(
  '/api/mcp',
  createProxyMiddleware({
    target: `http://127.0.0.1:${MCP_PORT}`,
    changeOrigin: true,
    pathRewrite: { '^/api/mcp': '' },
    ws: true,
    onError: (err, req, res) => {
      console.error('[proxy:mcp] error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'MCP proxy unavailable' });
      }
    },
  })
);

app.use(
  '/api/rag',
  createProxyMiddleware({
    target: `http://127.0.0.1:${RAG_PORT}`,
    changeOrigin: true,
    pathRewrite: { '^/api/rag': '' },
    onError: (err, req, res) => {
      console.error('[proxy:rag] error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'RAG service unavailable' });
      }
    },
  })
);

// ── Health endpoint ─────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      mcp: `http://127.0.0.1:${MCP_PORT}`,
      rag: `http://127.0.0.1:${RAG_PORT}`,
    },
  });
});

// ── Static SPA serving ──────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');
const basePath = '/bielik-m-poc';

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
});

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down child processes...`);
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch (e) {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
