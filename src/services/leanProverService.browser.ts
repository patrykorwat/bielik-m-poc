// Moved to backend solve-pipeline.js

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
  constructor(_proxyUrl?: string) {}
  async isAvailable(): Promise<boolean> { return false; }
  async verifyTheorem(_theoremContent: string, _filename?: string): Promise<LeanProverResult> {
    return { success: false, output: '', error: 'Moved to backend' };
  }
  async proveFromProblem(_problem: string, _proof?: string): Promise<LeanProverResult> {
    return { success: false, output: '', error: 'Moved to backend' };
  }
  async getInstallationInstructions(): Promise<string> { return ''; }
  static getDefaultInstructions(): string { return ''; }
}
