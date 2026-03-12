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
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
      role?: string;
    };
    finish_reason?: string;
  }>;
  usage?: any;
}

const LLM_PROXY_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MCP_PROXY_URL) || 'http://localhost:3001';

/**
 * Unified LLM Agent supporting MLX, Ollama, and Remote APIs (all OpenAI-compatible)
 * Remote API requests are proxied through MCP proxy server to avoid CORS issues.
 */
export class LLMAgent {
  private provider: LLMProviderType;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private apiKey?: string;

  constructor(config: LLMConfig) {
    this.provider = config.provider || 'mlx';
    this.baseUrl = config.baseUrl || (this.provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8080');
    this.model = config.model || (this.provider === 'ollama' ? 'SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M' : 'speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit');
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
    this.apiKey = config.apiKey;
  }

  private get useProxy(): boolean {
    return this.provider === 'remote';
  }

  /**
   * Check if LLM server is available
   */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (this.useProxy) {
        const params = new URLSearchParams({ targetUrl: `${this.baseUrl}/v1/models` });
        if (this.apiKey) params.set('apiKey', this.apiKey);
        const response = await fetch(`${LLM_PROXY_URL}/llm-proxy/models?${params}`);
        return response.ok;
      }
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      return response.ok;
    } catch (error) {
      console.error(`[LLMAgent:${this.provider}] Server not available:`, error);
      return false;
    }
  }

  /**
   * Get list of available models from LLM server
   */
  async listModels(): Promise<string[]> {
    try {
      let data: { data?: Array<{ id: string }> };

      if (this.useProxy) {
        const params = new URLSearchParams({ targetUrl: `${this.baseUrl}/v1/models` });
        if (this.apiKey) params.set('apiKey', this.apiKey);
        const response = await fetch(`${LLM_PROXY_URL}/llm-proxy/models?${params}`);
        if (!response.ok) return [];
        data = await response.json();
      } else {
        const response = await fetch(`${this.baseUrl}/v1/models`, {
          method: 'GET',
          headers: this.authHeaders(),
        });
        if (!response.ok) return [];
        data = await response.json();
      }

      return data.data?.map((m) => m.id) || [];
    } catch (error) {
      console.error(`[LLMAgent:${this.provider}] Error listing models:`, error);
      return [];
    }
  }

  /**
   * Execute LLM inference with chat completion (OpenAI-compatible API)
   */
  async execute(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    overrides?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    try {
      // Build OpenAI-compatible messages
      const messagesWithSystem = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      const requestBody = {
        model: this.model,
        messages: messagesWithSystem,
        stream: false,
        temperature: overrides?.temperature ?? this.temperature,
        max_tokens: overrides?.maxTokens ?? this.maxTokens,
      };

      console.log(`[LLMAgent:${this.provider}] Sending request:`, {
        baseUrl: this.baseUrl,
        model: this.model,
        messagesCount: messagesWithSystem.length,
        proxied: this.useProxy,
      });

      // Create abort controller with 5 minute timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);

      try {
        let response: Response;

        if (this.useProxy) {
          // Route through MCP proxy to avoid CORS
          response = await fetch(`${LLM_PROXY_URL}/llm-proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetUrl: `${this.baseUrl}/v1/chat/completions`,
              apiKey: this.apiKey,
              payload: requestBody,
            }),
            signal: controller.signal,
          });
        } else {
          response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...this.authHeaders(),
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LLM API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as LLMResponse;
        const content = data.choices?.[0]?.message?.content || '';

        console.log(`[LLMAgent:${this.provider}] Response received:`, {
          contentLength: content.length,
          finishReason: data.choices?.[0]?.finish_reason,
        });

        return content;
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error(`${this.providerLabel()} request timeout after 5 minutes. Try simpler query or smaller max_tokens.`);
        }
        throw fetchError;
      }
    } catch (error) {
      console.error(`[LLMAgent:${this.provider}] Error executing:`, error);

      // Provide helpful error messages
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED') || error.message.includes('Failed to fetch')) {
          const hint = this.useProxy
            ? `Make sure MCP proxy is running (npm run mcp-proxy) and remote API is accessible at ${this.baseUrl}`
            : `Make sure the server is running at ${this.baseUrl}`;
          throw new Error(`Cannot connect to ${this.providerLabel()} server. ${hint}`);
        }
      }
      throw error;
    }
  }

  /**
   * Get current model name
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set the model to use
   */
  setModel(model: string): void {
    console.log(`[LLMAgent:${this.provider}] Changing model from ${this.model} to ${model}`);
    this.model = model;
  }

  /**
   * Get base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get provider type
   */
  getProvider(): LLMProviderType {
    return this.provider;
  }

  private providerLabel(): string {
    return this.provider === 'ollama' ? 'Ollama' : this.provider === 'remote' ? 'Remote API' : 'MLX';
  }
}

// Backward-compatible aliases
export { LLMAgent as MLXAgent };
export type { LLMConfig as MLXConfig, LLMResponse as MLXResponse };
