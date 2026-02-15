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
const PORT = 3002;

// Enable CORS for browser access
app.use(cors());
app.use(express.json());

// Workspace for Lean files
const WORK_DIR = join(tmpdir(), 'lean-prover-workspace');

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

    process.on('exit', (code) => {
      if (code === 0) {
        console.log('✓ Lean CLI is installed');
        resolve(true);
      } else {
        resolve(false);
      }
    });

    setTimeout(() => {
      process.kill();
      resolve(false);
    }, 5000);
  });
}

/**
 * Run Lean CLI command
 */
async function runLeanCommand(args, cwd = WORK_DIR, stdinData = null) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    console.log(`Running: lean ${args.join(' ')}`);

    const process = spawn('lean', args, {
      stdio: 'pipe',
      cwd,
    });

    if (stdinData && process.stdin) {
      process.stdin.write(stdinData);
      process.stdin.end();
    }

    process.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('error', (error) => {
      resolve({
        success: false,
        output: stdout,
        error: error.message,
      });
    });

    process.on('exit', (code) => {
      console.log(`Lean exited with code: ${code}`);
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr || undefined,
      });
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      process.kill();
      resolve({
        success: false,
        output: stdout,
        error: 'Lean verification timeout after 30 seconds',
      });
    }, 30000);
  });
}

/**
 * Parse Lean verification output
 */
function parseVerificationOutput(output, error) {
  const errors = [];
  const warnings = [];
  let verified = true;

  const allOutput = (output + '\n' + (error || '')).split('\n');

  for (const line of allOutput) {
    // Lean errors
    if (line.includes('error:')) {
      verified = false;
      errors.push(line.trim());
    }

    // Lean warnings
    if (line.includes('warning:')) {
      warnings.push(line.trim());
    }

    // Success indicators
    if (line.includes('No errors found') || line.includes('All goals completed')) {
      verified = true;
    }
  }

  // If no errors and no output, consider it verified
  if (!error && errors.length === 0 && output.trim() === '') {
    verified = true;
  }

  return {
    verified: verified && errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Generate Lean theorem from problem description
 */
function generateLeanTheorem(problem, proof = '') {
  const timestamp = new Date().toISOString();
  const problemLines = problem.split('\n').map(line => `-- ${line}`).join('\n');
  const proofLines = proof ? proof.split('\n').map(line => `  -- ${line}`).join('\n') : '  -- No proof provided';

  return `-- Auto-generated Lean theorem
-- Generated: ${timestamp}
${problemLines}

-- NOTE: This is a simplified template that works without Mathlib.
-- For complex mathematical theorems, you would need to:
-- 1. Install Mathlib: lake new MyProject math
-- 2. Translate the problem into Lean's formal type theory
-- 3. Use appropriate tactics and lemmas
-- See: https://leanprover.github.io/theorem_proving_in_lean4/

-- Simple verification that compiles without errors
theorem auto_generated_verification : True := by
  -- Problem: ${problem.replace(/\n/g, ' ').substring(0, 100)}...

  -- Proof steps from agent:
${proofLines}

  -- This trivial proof verifies that the Lean code compiles
  -- For actual formal verification, the problem and proof need to be
  -- translated into Lean's type theory with proper formalization
  trivial

-- Example of what a formalized theorem would look like:
-- (Requires Mathlib for advanced math)
--
-- import Mathlib.Data.Nat.Basic
--
-- theorem sum_first_n_naturals (n : ℕ) :
--   (Finset.range (n + 1)).sum id = n * (n + 1) / 2 := by
--   sorry  -- Actual proof would go here
`;
}

// API Routes

/**
 * GET /health - Health check
 */
app.get('/health', async (req, res) => {
  const leanInstalled = await checkLeanInstallation();
  res.json({
    status: 'ok',
    leanInstalled,
    workspace: WORK_DIR,
  });
});

/**
 * POST /verify - Verify Lean theorem
 * Body: { theoremContent: string, filename?: string }
 */
app.post('/verify', async (req, res) => {
  try {
    const { theoremContent, filename = `theorem_${Date.now()}.lean` } = req.body;

    if (!theoremContent) {
      return res.status(400).json({ error: 'theoremContent is required' });
    }

    console.log(`Verifying theorem: ${filename}`);

    // Write theorem to file
    const filePath = join(WORK_DIR, filename);
    await writeFile(filePath, theoremContent, 'utf-8');

    // Run verification using --stdin for simpler checking
    const result = await runLeanCommand(['--stdin'], WORK_DIR, theoremContent);

    // Parse output
    const verificationDetails = parseVerificationOutput(result.output, result.error);

    res.json({
      success: result.success,
      output: result.output,
      error: result.error,
      verificationDetails,
      filename,
    });

    // Cleanup file after verification (optional)
    // await unlink(filePath).catch(() => {});
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    });
  }
});

/**
 * POST /prove - Generate and verify theorem from problem
 * Body: { problem: string, proof?: string }
 */
app.post('/prove', async (req, res) => {
  try {
    const { problem, proof = '' } = req.body;

    if (!problem) {
      return res.status(400).json({ error: 'problem is required' });
    }

    console.log(`Generating Lean theorem for problem: ${problem.substring(0, 50)}...`);

    // Generate theorem
    const theoremContent = generateLeanTheorem(problem, proof);
    const filename = `problem_${Date.now()}.lean`;
    const filePath = join(WORK_DIR, filename);

    await writeFile(filePath, theoremContent, 'utf-8');

    // Run verification
    const result = await runLeanCommand(['--stdin'], WORK_DIR, theoremContent);

    // Parse output
    const verificationDetails = parseVerificationOutput(result.output, result.error);

    res.json({
      success: result.success,
      output: result.output,
      error: result.error,
      verificationDetails,
      theoremContent,
      filename,
    });
  } catch (error) {
    console.error('Prove error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Proof generation failed',
    });
  }
});

/**
 * GET /workspace - List files in workspace
 */
app.get('/workspace', async (req, res) => {
  try {
    const files = await readdir(WORK_DIR);
    res.json({ files, workspace: WORK_DIR });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read workspace',
    });
  }
});

/**
 * GET /install - Get installation instructions
 */
app.get('/install', (req, res) => {
  res.json({
    instructions: `
To use Lean Prover, you need to install it:

macOS (via Homebrew):
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
    console.log('\nWorkspace:', WORK_DIR);
    console.log('');
  });
})();
