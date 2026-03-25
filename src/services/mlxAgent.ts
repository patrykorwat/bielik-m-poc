// Stub. All LLM calls go through the server-side /api/solve pipeline.
// Type exports kept for backward compatibility during migration.

export type LLMProviderType = 'mlx' | 'ollama' | 'remote';

export interface LLMConfig {
  provider?: LLMProviderType;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
}

export interface LLMResponse {
  content: string;
}

/** Stub class. No client-side LLM calls are made. */
export class LLMAgent {
  constructor(_config: LLMConfig) {}
  async isAvailable(): Promise<boolean> { return false; }
  async getModels(): Promise<string[]> { return []; }
  async execute(_system: string, _messages: Array<{role: string; content: string}>, _opts?: any): Promise<string> {
    throw new Error('Client-side LLM calls are disabled. Use /api/solve.');
  }
  changeModel(_model: string): void {}
  get provider(): LLMProviderType { return 'remote'; }
}

export { LLMAgent as MLXAgent };
export type { LLMConfig as MLXConfig, LLMResponse as MLXResponse };
