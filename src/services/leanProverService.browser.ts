/**
 * Browser-compatible Lean Prover Service
 * Communicates with Lean Proxy Server via HTTP
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

export class LeanProverServiceBrowser {
  private proxyUrl: string;

  constructor(proxyUrl: string = 'http://localhost:3002') {
    this.proxyUrl = proxyUrl;
  }

  /**
   * Check if Lean Prover backend is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.proxyUrl}/health`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) return false;

      const data = await response.json();
      return data.leanInstalled === true;
    } catch (error) {
      console.error('Lean health check failed:', error);
      return false;
    }
  }

  /**
   * Verify a Lean theorem
   */
  async verifyTheorem(theoremContent: string, filename?: string): Promise<LeanProverResult> {
    try {
      const response = await fetch(`${this.proxyUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theoremContent,
          filename,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate and verify theorem from problem
   */
  async proveFromProblem(problem: string, proof?: string): Promise<LeanProverResult> {
    try {
      const response = await fetch(`${this.proxyUrl}/prove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problem,
          proof,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return result;
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
  async getInstallationInstructions(): Promise<string> {
    try {
      const response = await fetch(`${this.proxyUrl}/install`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        return LeanProverServiceBrowser.getDefaultInstructions();
      }

      const data = await response.json();
      return data.instructions || LeanProverServiceBrowser.getDefaultInstructions();
    } catch (error) {
      return LeanProverServiceBrowser.getDefaultInstructions();
    }
  }

  /**
   * Get default installation instructions
   */
  static getDefaultInstructions(): string {
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
