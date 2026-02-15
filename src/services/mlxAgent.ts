export interface MLXConfig {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface MLXResponse {
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

/**
 * MLX Agent for Apple Silicon optimized inference
 * Based on magentic-agent pattern
 */
export class MLXAgent {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: MLXConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:8080';
    this.model = config.model || 'mlx-community/Llama-3.2-3B-Instruct-4bit';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
  }

  /**
   * Check if MLX server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
      });
      return response.ok;
    } catch (error) {
      console.error('[MLXAgent] Server not available:', error);
      return false;
    }
  }

  /**
   * Get list of available models from MLX server
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) || [];
    } catch (error) {
      console.error('[MLXAgent] Error listing models:', error);
      return [];
    }
  }

  /**
   * Execute MLX inference with chat completion
   */
  async execute(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    overrides?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    try {
      // Build MLX-compatible messages (OpenAI format)
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

      console.log('[MLXAgent] Sending request:', {
        baseUrl: this.baseUrl,
        model: this.model,
        messagesCount: messagesWithSystem.length,
      });

      // Create abort controller with 5 minute timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);

      try {
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`MLX API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as MLXResponse;
        const content = data.choices?.[0]?.message?.content || '';

        console.log('[MLXAgent] Response received:', {
          contentLength: content.length,
          finishReason: data.choices?.[0]?.finish_reason,
        });

        return content;
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('MLX request timeout after 5 minutes. Try simpler query or smaller max_tokens.');
        }
        throw fetchError;
      }
    } catch (error) {
      console.error('[MLXAgent] Error executing:', error);

      // Provide helpful error messages
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED') || error.message.includes('Failed to fetch')) {
          throw new Error(
            'Cannot connect to MLX server. Make sure the MLX server is running at ' + this.baseUrl
          );
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
    console.log(`[MLXAgent] Changing model from ${this.model} to ${model}`);
    this.model = model;
  }

  /**
   * Get base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}
