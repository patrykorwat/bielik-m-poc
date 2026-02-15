/**
 * Browser-compatible wrapper for Acorn Prover
 * This file contains only browser-safe code (no Node.js imports)
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

/**
 * Browser-compatible client for Acorn Prover
 * Communicates with Acorn backend via HTTP
 */
export class AcornProverServiceBrowser {
  private backendUrl: string;

  constructor(backendUrl: string = 'http://localhost:3002') {
    this.backendUrl = backendUrl;
  }

  /**
   * Check if Acorn backend is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.backendUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Verify a theorem via backend
   */
  async verifyTheorem(theoremContent: string): Promise<AcornProverResult> {
    try {
      const response = await fetch(`${this.backendUrl}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ theoremContent }),
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Prove from problem via backend
   */
  async proveFromProblem(problem: string, steps?: string[]): Promise<AcornProverResult> {
    try {
      const response = await fetch(`${this.backendUrl}/prove`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ problem, steps }),
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
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
