import { logDebug, logVerbose, logError } from './logger.js';
const LLM_PROXY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_MCP_PROXY_URL) || 'http://localhost:3001';
/**
 * Unified LLM Agent supporting MLX, Ollama, and Remote APIs (all OpenAI-compatible)
 * Remote API requests are proxied through MCP proxy server to avoid CORS issues.
 */
export class LLMAgent {
    constructor(config) {
        this.provider = config.provider || 'mlx';
        this.baseUrl = config.baseUrl || (this.provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8080');
        this.model = config.model || (this.provider === 'ollama' ? 'SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M' : 'speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit');
        this.temperature = config.temperature ?? 0.7;
        this.maxTokens = config.maxTokens || 4096;
        this.apiKey = config.apiKey;
    }
    get useProxy() {
        return this.provider === 'remote';
    }
    /**
     * Check if LLM server is available
     */
    authHeaders() {
        return this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
    }
    async isAvailable() {
        try {
            if (this.useProxy) {
                const params = new URLSearchParams({ targetUrl: `${this.baseUrl}/v1/models` });
                if (this.apiKey)
                    params.set('apiKey', this.apiKey);
                const response = await fetch(`${LLM_PROXY_URL}/llm-proxy/models?${params}`);
                return response.ok;
            }
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                method: 'GET',
                headers: this.authHeaders(),
            });
            return response.ok;
        }
        catch (error) {
            logError(`[LLMAgent:${this.provider}] Server not available:`, error);
            return false;
        }
    }
    /**
     * Get list of available models from LLM server
     */
    async listModels() {
        try {
            let data;
            if (this.useProxy) {
                const params = new URLSearchParams({ targetUrl: `${this.baseUrl}/v1/models` });
                if (this.apiKey)
                    params.set('apiKey', this.apiKey);
                const response = await fetch(`${LLM_PROXY_URL}/llm-proxy/models?${params}`);
                if (!response.ok)
                    return [];
                data = await response.json();
            }
            else {
                const response = await fetch(`${this.baseUrl}/v1/models`, {
                    method: 'GET',
                    headers: this.authHeaders(),
                });
                if (!response.ok)
                    return [];
                data = await response.json();
            }
            return data.data?.map((m) => m.id) || [];
        }
        catch (error) {
            logError(`[LLMAgent:${this.provider}] Error listing models:`, error);
            return [];
        }
    }
    /**
     * Execute LLM inference with chat completion (OpenAI-compatible API)
     */
    async execute(systemPrompt, messages, overrides) {
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
            logDebug(`[LLMAgent:${this.provider}] Sending request:`, {
                baseUrl: this.baseUrl,
                model: this.model,
                messagesCount: messagesWithSystem.length,
                proxied: this.useProxy,
            });
            // Create abort controller with 5 minute timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000);
            try {
                let response;
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
                }
                else {
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
                    logError(`LLM API error (${response.status}):`, errorText);
                    throw new Error(`Błąd API LLM (HTTP ${response.status})`);
                }
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '';
                logVerbose(`[LLMAgent:${this.provider}] Response received:`, {
                    contentLength: content.length,
                    finishReason: data.choices?.[0]?.finish_reason,
                });
                return content;
            }
            catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    throw new Error(`${this.providerLabel()} request timeout after 5 minutes. Try simpler query or smaller max_tokens.`);
                }
                throw fetchError;
            }
        }
        catch (error) {
            logError(`[LLMAgent:${this.provider}] Error executing:`, error);
            // Provide helpful error messages (without leaking internal URLs)
            if (error instanceof Error) {
                if (error.message.includes('ECONNREFUSED') || error.message.includes('Failed to fetch')) {
                    const hint = this.useProxy
                        ? 'Sprawdź połączenie z serwerem LLM.'
                        : 'Sprawdź, czy serwer LLM jest uruchomiony.';
                    throw new Error(`Nie można połączyć z ${this.providerLabel()}. ${hint}`);
                }
                if (error.message.includes('LLM API error')) {
                    throw new Error('Błąd serwera LLM. Spróbuj ponownie za chwilę.');
                }
            }
            throw new Error('Wystąpił nieoczekiwany błąd podczas komunikacji z LLM.');
        }
    }
    /**
     * Get current model name
     */
    getModel() {
        return this.model;
    }
    /**
     * Set the model to use
     */
    setModel(model) {
        logDebug(`[LLMAgent:${this.provider}] Changing model from ${this.model} to ${model}`);
        this.model = model;
    }
    /**
     * Get base URL
     */
    getBaseUrl() {
        return this.baseUrl;
    }
    /**
     * Get provider type
     */
    getProvider() {
        return this.provider;
    }
    providerLabel() {
        return this.provider === 'ollama' ? 'Ollama' : this.provider === 'remote' ? 'Remote API' : 'MLX';
    }
}
// Backward-compatible aliases
export { LLMAgent as MLXAgent };
