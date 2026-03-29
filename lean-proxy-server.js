#!/usr/bin/env node

/**
 * Lean Prover Proxy Server
 * HTTP API bridge to Lean CLI for browser-based applications
 */

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { writeFile, mkdir, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const app = express();
const PORT = process.env.LEAN_PROXY_PORT || 3002;

// Enable CORS for browser access
app.use(cors());
app.use(express.json());

// Workspace for Lean files
const WORK_DIR = join(tmpdir(), 'lean-prover-workspace');

// 👇 ZMIANA TUTAJ: Zmieniono /root/lean-project na /app/lean-project
const LEAN_PROJECT_DIR = process.env.LEAN_PROJECT_DIR || '/app/lean-project';

/**
 * Ensure workspace directory exists
 */
async function ensureWorkspace() {
  try {
    await mkdir(WORK_DIR, { recursive: true });
    console.log('✓ Workspace created:', WORK_DIR);
  } catch (error) {
    console.error('Failed to create workspace:', error);
  }
}

/**
 * Check if Lean CLI is installed
 */
async function checkLeanInstallation() {
  return new Promise((resolve) => {
    const process = spawn('lean', ['--version'], {
      stdio: 'pipe',
    });

    process.on('error', () => {
      console.warn('⚠️  Lean CLI not found.');
      console.warn('   Install with: brew install elan-init && elan default leanprover/lean4:stable');
      resolve(false);
    });

    process.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Lean CLI is installed');
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// ── Endpoints ─────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const isInstalled = await checkLeanInstallation();
  res.json({
    status: 'ok',
    leanInstalled: isInstalled,
    workspace: WORK_DIR,
    projectDir: LEAN_PROJECT_DIR,
  });
});

app.post('/verify', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'No Lean code provided' });
  }

  const filename = `proof_${Date.now()}.lean`;
  const filepath = join(WORK_DIR, filename);

  try {
    // Write code to temporary file
    await writeFile(filepath, code);
    console.log(`[lean-proxy] Verifying theorem: ${filename}`);
    console.log(`[lean-proxy] Running: lean --stdin`);

    // Verify using bare Lean CLI (no Mathlib)
    const process = spawn('lean', ['--stdin'], {
      cwd: WORK_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Write code to stdin
    process.stdin.write(code);
    process.stdin.end();

    process.on('close', async (exitCode) => {
      // Clean up file
      await unlink(filepath).catch(console.error);

      if (exitCode !== 0) {
        console.error(`[lean-proxy] Lean exited with code: ${exitCode}`);
        return res.status(400).json({
          status: 'error',
          error: stderr || stdout || 'Unknown verification error',
        });
      }

      console.log(`[lean-proxy] Verification successful: ${filename}`);
      res.json({
        status: 'success',
        output: stdout,
      });
    });

    process.on('error', async (error) => {
      await unlink(filepath).catch(console.error);
      console.error('[lean-proxy] Process error:', error);
      res.status(500).json({ error: 'Failed to run Lean CLI' });
    });

  } catch (error) {
    console.error('[lean-proxy] Verification failed:', error);
    res.status(500).json({ error: 'Server error during verification' });
  }
});

app.post('/prove', async (req, res) => {
  const { problem, language = 'pl' } = req.body;

  if (!problem) {
    return res.status(400).json({ error: 'No problem provided' });
  }

  // TODO: Add AI generation step here
  // For now, this is a placeholder
  res.json({
    status: 'pending',
    message: 'Theorem generation not yet implemented in proxy. Use client-side LLM.',
  });
});

app.get('/workspace', async (req, res) => {
  try {
    const files = await readdir(WORK_DIR);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read workspace' });
  }
});

app.get('/install', (req, res) => {
  res.json({
    instructions: `
To use the Lean prover proxy, Lean 4 must be installed on your system.

macOS:
  brew install elan-init
  elan default leanprover/lean4:stable

Linux:
  curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh
  elan default leanprover/lean4:stable

Windows:
  Download from: https://github.com/leanprover/lean4/releases

After installation:
  lean --version

For more information, visit:
  - Documentation: https://leanprover.github.io/lean4/doc/
  - Tutorial: https://leanprover.github.io/theorem_proving_in_lean4/
  - Community: https://leanprover-community.github.io/

After installation, restart this server.
    `.trim(),
  });
});

// Initialize and start server
(async () => {
  await ensureWorkspace();
  const leanInstalled = await checkLeanInstallation();

  if (!leanInstalled) {
    console.log('\n⚠️  WARNING: Lean CLI not found!');
    console.log('   Install with: brew install elan-init && elan default leanprover/lean4:stable');
    console.log('   Server will start but /verify and /prove endpoints will fail.\n');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 Lean Prover Proxy Server running on http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health     - Health check and Lean status');
    console.log('  POST /verify     - Verify Lean theorem');
    console.log('  POST /prove      - Generate and verify from problem');
    console.log('  GET  /workspace  - List workspace files');
    console.log('  GET  /install    - Installation instructions');
    console.log(`Workspace: ${WORK_DIR}`);
    console.log(`Project:   ${LEAN_PROJECT_DIR}`);
  });
})();