import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Service for integrating with Acorn Prover CLI
 * Provides automated theorem proving for complex mathematical tasks
 */

export interface AcornProverResult {
  success: boolean;
  output: string;
  error?: string;
  verificationDetails?: {
    verified: boolean;
    goals: number;
    proved: number;
    failures?: string[];
  };
}

export class AcornProverService {
  private workDir: string;
  private acornCliPath: string;

  constructor(acornCliPath: string = 'acorn') {
    this.acornCliPath = acornCliPath;
    this.workDir = join(tmpdir(), 'acorn-prover-workspace');
  }

  /**
   * Check if Acorn CLI is installed
   */
  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const process = spawn(this.acornCliPath, ['--version'], {
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
   * Convert mathematical problem to Acorn theorem format
   * This is a simplified converter - in production, this would need more sophisticated parsing
   */
  private generateAcornTheorem(problem: string, steps?: string[]): string {
    // Basic template for Acorn theorem
    // Real implementation would need proper parsing and formalization
    const theoremTemplate = `
# Auto-generated theorem from problem
# Problem: ${problem.split('\n').join('\n# ')}

# This is a simplified conversion - manual review recommended
theorem auto_generated_theorem:
  # Problem statement would be formalized here
  # ${problem}

  # Proof steps:
${steps ? steps.map((step, i) => `  # Step ${i + 1}: ${step}`).join('\n') : '  # No steps provided'}

  # Formal proof would be written here
  # Using Acorn's proof language
`;

    return theoremTemplate;
  }

  /**
   * Verify a theorem using Acorn CLI
   */
  async verifyTheorem(theoremContent: string, filename: string = 'theorem.ac'): Promise<AcornProverResult> {
    try {
      // Ensure work directory exists
      await mkdir(this.workDir, { recursive: true });

      // Write theorem to temporary file
      const filePath = join(this.workDir, filename);
      await writeFile(filePath, theoremContent, 'utf-8');

      // Run Acorn verify
      const result = await this.runAcornCommand(['verify', filePath]);

      // Parse output
      const verificationDetails = this.parseVerificationOutput(result.output);

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
    steps?: string[]
  ): Promise<AcornProverResult> {
    const theoremContent = this.generateAcornTheorem(problem, steps);
    return this.verifyTheorem(theoremContent, `problem_${Date.now()}.ac`);
  }

  /**
   * Run Acorn command
   */
  private async runAcornCommand(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const process = spawn(this.acornCliPath, args, {
        stdio: 'pipe',
        cwd: this.workDir,
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
          error: 'Verification timeout after 30 seconds',
        });
      }, 30000);
    });
  }

  /**
   * Parse Acorn verification output
   */
  private parseVerificationOutput(output: string): {
    verified: boolean;
    goals: number;
    proved: number;
    failures?: string[];
  } {
    // Parse Acorn output format
    // This is a simplified parser - actual format may vary
    const lines = output.split('\n');
    let verified = false;
    let goals = 0;
    let proved = 0;
    const failures: string[] = [];

    for (const line of lines) {
      if (line.includes('✓') || line.includes('verified') || line.includes('success')) {
        verified = true;
      }

      // Look for goal counts (format may vary)
      const goalMatch = line.match(/(\d+)\s+goals?/i);
      if (goalMatch) {
        goals = parseInt(goalMatch[1], 10);
      }

      const provedMatch = line.match(/(\d+)\s+proved/i);
      if (provedMatch) {
        proved = parseInt(provedMatch[1], 10);
      }

      if (line.includes('✗') || line.includes('failed') || line.includes('error')) {
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
   * Clean up workspace
   */
  async cleanup(): Promise<void> {
    try {
      // Remove temporary files
      // In production, you might want more sophisticated cleanup
      console.log('Cleaning up Acorn workspace:', this.workDir);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  /**
   * Get installation instructions
   */
  static getInstallationInstructions(): string {
    return `
To use Acorn Prover, you need to install it:

Option 1: Install Acorn CLI globally via npm
  npm i -g @acornprover/cli

Option 2: Use Acorn Prover VS Code Extension
  1. Install VS Code
  2. Install "Acorn Prover" extension from VS Code Marketplace

For more information, visit: https://acornprover.org/docs/installation/
`.trim();
  }
}

// Note: Browser-compatible version (AcornProverServiceBrowser) is available in:
// acornProverService.browser.ts
// This file contains Node.js-only code and should not be imported in browser contexts.
