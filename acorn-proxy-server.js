#!/usr/bin/env node

/**
 * Acorn Prover Proxy Server
 * HTTP API bridge to Acorn CLI for browser-based applications
 * Similar to MCP proxy but for Acorn theorem prover
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

// Workspace for Acorn files
const WORK_DIR = join(tmpdir(), 'acorn-prover-workspace');

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
 * Check if Acorn CLI is installed
 */
async function checkAcornInstallation() {
  return new Promise((resolve) => {
    const process = spawn('acorn', ['--version'], {
      stdio: 'pipe',
    });

    process.on('error', () => {
      console.warn('⚠️  Acorn CLI not found. Install with: npm i -g @acornprover/cli');
      resolve(false);
    });

    process.on('exit', (code) => {
      if (code === 0) {
        console.log('✓ Acorn CLI is installed');
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
 * Run Acorn CLI command
 */
async function runAcornCommand(args, cwd = WORK_DIR) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    console.log(`Running: acorn ${args.join(' ')}`);

    const process = spawn('acorn', args, {
      stdio: 'pipe',
      cwd,
    });

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
      console.log(`Acorn exited with code: ${code}`);
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
        error: 'Acorn verification timeout after 30 seconds',
      });
    }, 30000);
  });
}

/**
 * Parse Acorn verification output
 */
function parseVerificationOutput(output) {
  const lines = output.split('\n');
  let verified = false;
  let goals = 0;
  let proved = 0;
  const failures = [];

  for (const line of lines) {
    // Check for success indicators
    if (line.includes('✓') || line.match(/verified|success/i)) {
      verified = true;
    }

    // Parse goal counts
    const goalMatch = line.match(/(\d+)\s+goals?/i);
    if (goalMatch) {
      goals = parseInt(goalMatch[1], 10);
    }

    const provedMatch = line.match(/(\d+)\s+proved/i);
    if (provedMatch) {
      proved = parseInt(provedMatch[1], 10);
    }

    // Check for failures
    if (line.includes('✗') || line.match(/failed|error/i)) {
      failures.push(line.trim());
    }
  }

  return {
    verified,
    goals,
    proved,
    failures: failures.length > 0 ? failures : undefined,
  };
}

/**
 * Convert mathematical problem to Acorn theorem (simplified)
 */
function generateAcornTheorem(problem, steps = []) {
  const timestamp = new Date().toISOString();
  const stepComments = steps.length > 0
    ? steps.map((step, i) => `  # Step ${i + 1}: ${step}`).join('\n')
    : '  # No steps provided - needs manual formalization';

  return `# Auto-generated theorem
# Generated: ${timestamp}
# Problem: ${problem.split('\n').join('\n# ')}

# NOTE: This is a simplified template. Acorn requires formal mathematical notation.
# You need to manually translate the problem into Acorn's proof language.
# See: https://acornprover.org/docs/

theorem auto_generated_problem:
  # Problem formalization would go here
  # ${problem}

  # Proof steps:
${stepComments}

  # Formal proof in Acorn language would be written here
  # This requires knowledge of Acorn's syntax and proof tactics

# Example structure:
# theorem my_theorem: forall x: Nat, x + 0 = x
#   by
#     induction on x
#     case 0: reflexivity
#     case S(n): simplify; apply IH; reflexivity
`;
}

// API Routes

/**
 * GET /health - Health check
 */
app.get('/health', async (req, res) => {
  const acornInstalled = await checkAcornInstallation();
  res.json({
    status: 'ok',
    acornInstalled,
    workspace: WORK_DIR,
  });
});

/**
 * POST /verify - Verify Acorn theorem
 * Body: { theoremContent: string, filename?: string }
 */
app.post('/verify', async (req, res) => {
  try {
    const { theoremContent, filename = `theorem_${Date.now()}.ac` } = req.body;

    if (!theoremContent) {
      return res.status(400).json({ error: 'theoremContent is required' });
    }

    console.log(`Verifying theorem: ${filename}`);

    // Write theorem to file
    const filePath = join(WORK_DIR, filename);
    await writeFile(filePath, theoremContent, 'utf-8');

    // Run verification
    const result = await runAcornCommand(['verify', filePath]);

    // Parse output
    const verificationDetails = parseVerificationOutput(result.output);

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
 * Body: { problem: string, steps?: string[] }
 */
app.post('/prove', async (req, res) => {
  try {
    const { problem, steps = [] } = req.body;

    if (!problem) {
      return res.status(400).json({ error: 'problem is required' });
    }

    console.log(`Generating theorem for problem: ${problem.substring(0, 50)}...`);

    // Generate theorem
    const theoremContent = generateAcornTheorem(problem, steps);
    const filename = `problem_${Date.now()}.ac`;
    const filePath = join(WORK_DIR, filename);

    await writeFile(filePath, theoremContent, 'utf-8');

    // Run verification
    const result = await runAcornCommand(['verify', filePath]);

    // Parse output
    const verificationDetails = parseVerificationOutput(result.output);

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
To use Acorn Prover, you need to install it:

Option 1: Install Acorn CLI globally via npm
  npm i -g @acornprover/cli

Option 2: Use Acorn Prover VS Code Extension
  1. Install VS Code
  2. Install "Acorn Prover" extension from VS Code Marketplace

For more information, visit:
  - Documentation: https://acornprover.org/docs/
  - Installation: https://acornprover.org/docs/installation/
  - CLI Reference: https://acornprover.org/docs/cli/

After installation, restart this server.
    `.trim(),
  });
});

// Initialize and start server
(async () => {
  await ensureWorkspace();
  const acornInstalled = await checkAcornInstallation();

  if (!acornInstalled) {
    console.log('\n⚠️  WARNING: Acorn CLI not found!');
    console.log('   Install with: npm i -g @acornprover/cli');
    console.log('   Server will start but /verify and /prove endpoints will fail.\n');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 Acorn Prover Proxy Server running on http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health     - Health check and Acorn status');
    console.log('  POST /verify     - Verify Acorn theorem');
    console.log('  POST /prove      - Generate and verify from problem');
    console.log('  GET  /workspace  - List workspace files');
    console.log('  GET  /install    - Installation instructions');
    console.log('\nWorkspace:', WORK_DIR);
    console.log('');
  });
})();
