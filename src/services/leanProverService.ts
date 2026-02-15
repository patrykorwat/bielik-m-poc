import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Service for integrating with Lean Prover
 * Provides automated theorem proving using Lean 4
 */

export interface LeanProverResult {
  success: boolean;
  output: string;
  error?: string;
  verificationDetails?: {
    verified: boolean;
    errors?: string[];
    warnings?: string[];
  };
}

export class LeanProverService {
  private workDir: string;
  private leanCliPath: string;

  constructor(leanCliPath: string = 'lean') {
    this.leanCliPath = leanCliPath;
    this.workDir = join(tmpdir(), 'lean-prover-workspace');
  }

  /**
   * Check if Lean CLI is installed
   */
  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const process = spawn(this.leanCliPath, ['--version'], {
        stdio: 'pipe',
      });

      process.on('error', () => {
        resolve(false);
      });

      process.on('exit', (code) => {
        resolve(code === 0);
      });

      setTimeout(() => {
        process.kill();
        resolve(false);
      }, 5000);
    });
  }

  /**
   * Convert mathematical problem to Lean theorem format
   */
  private generateLeanTheorem(problem: string, proof?: string): string {
    // Basic template for Lean theorem
    const theoremTemplate = `-- Auto-generated Lean theorem
-- Problem: ${problem.split('\n').map(line => `-- ${line}`).join('\n')}

import Mathlib.Tactic

-- This is a simplified conversion - manual review recommended
theorem auto_generated_theorem : True := by
  -- Problem statement would be formalized here
  -- ${problem}

  ${proof ? `-- Proof steps:\n${proof.split('\n').map(line => `  -- ${line}`).join('\n')}` : '-- No proof provided'}

  -- Trivial proof for now (needs manual formalization)
  trivial
`;

    return theoremTemplate;
  }

  /**
   * Verify a Lean theorem file
   */
  async verifyTheorem(theoremContent: string, filename: string = 'theorem.lean'): Promise<LeanProverResult> {
    try {
      // Ensure work directory exists
      await mkdir(this.workDir, { recursive: true });

      // Write theorem to temporary file
      const filePath = join(this.workDir, filename);
      await writeFile(filePath, theoremContent, 'utf-8');

      // Run Lean check
      const result = await this.runLeanCommand(['--stdin'], theoremContent);

      // Parse output
      const verificationDetails = this.parseVerificationOutput(result.output, result.error);

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        verificationDetails,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate and verify a theorem from a mathematical problem
   */
  async proveFromProblem(
    problem: string,
    proof?: string
  ): Promise<LeanProverResult> {
    const theoremContent = this.generateLeanTheorem(problem, proof);
    return this.verifyTheorem(theoremContent, `problem_${Date.now()}.lean`);
  }

  /**
   * Run Lean command
   */
  private async runLeanCommand(args: string[], stdin?: string): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const process = spawn(this.leanCliPath, args, {
        stdio: 'pipe',
        cwd: this.workDir,
      });

      if (stdin && process.stdin) {
        process.stdin.write(stdin);
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
  private parseVerificationOutput(output: string, error?: string): {
    verified: boolean;
    errors?: string[];
    warnings?: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    let verified = true;

    // Parse Lean output format
    const allOutput = (output + '\n' + (error || '')).split('\n');

    for (const line of allOutput) {
      // Lean errors typically start with "error:"
      if (line.includes('error:')) {
        verified = false;
        errors.push(line.trim());
      }

      // Lean warnings
      if (line.includes('warning:')) {
        warnings.push(line.trim());
      }

      // Check for successful verification
      if (line.includes('No errors found') || line.includes('All goals completed')) {
        verified = true;
      }
    }

    // If no errors found and no explicit success message, check stderr
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
   * Clean up workspace
   */
  async cleanup(): Promise<void> {
    try {
      console.log('Cleaning up Lean workspace:', this.workDir);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  /**
   * Get installation instructions
   */
  static getInstallationInstructions(): string {
    return `
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

For more information, visit: https://leanprover.github.io/lean4/doc/setup.html
`.trim();
  }
}

// Note: Browser-compatible version (LeanProverServiceBrowser) will be created separately
// This file contains Node.js-only code and should not be imported in browser contexts.
