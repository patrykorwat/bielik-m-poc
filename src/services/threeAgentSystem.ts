import { LLMAgent, LLMProviderType } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';
import { LeanProverServiceBrowser } from './leanProverService.browser';
import prompts from '../../prompts.json';
import { logInfo, logDebug, logWarn, logError, setLogLevel, LogLevel } from './logger';

// Initialize log level from config
setLogLevel(((prompts as any).features?.log_level ?? 1) as LogLevel);

export type LLMProvider = LLMProviderType;
export type ProverBackend = 'sympy' | 'lean' | 'both';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  timestamp: Date;
  agentName?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
  isError?: boolean;
}

export interface MLXConfig {
  provider?: LLMProviderType;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey?: string;
}

/**
 * Multi-agent orchestrator for Polish matura math problems.
 *
 * Pipeline:
 *   1. Analytical Agent  — plans the solution (always)
 *   2. Executor Agent    — writes & runs SymPy code (always)
 *   3. Summary Agent     — explains the solution step-by-step (always)
 *   4. Lean Verifier     — formally verifies the result (optional, proof problems only)
 */
export class ThreeAgentOrchestrator {
  // @ts-ignore kept for constructor signature compatibility
  private llmAgent: LLMAgent;
  private mcpClient: MCPClient | null = null;
  private leanClient: LeanProverServiceBrowser | null = null;
  private conversationHistory: Message[] = [];
  private proverBackend: ProverBackend;
  private availableTools: MCPTool[] = [];
  private leanAvailable: boolean = false;
  private classifierMode: boolean = true;

  constructor(
    proverBackend: ProverBackend = 'both',
    mlxConfig: MLXConfig,
    classifierMode: boolean = true,
  ) {
    this.proverBackend = proverBackend;
    this.classifierMode = classifierMode;

    if (!mlxConfig) {
      throw new Error('LLM config is required');
    }
    this.llmAgent = new LLMAgent(mlxConfig);

    // Initialize Lean client (for verification only)
    if (proverBackend === 'lean' || proverBackend === 'both') {
      this.leanClient = new LeanProverServiceBrowser();
    }
  }

  /**
   * Update classifierMode at runtime (e.g. when user toggles the switch in UI)
   */
  setClassifierMode(enabled: boolean): void {
    this.classifierMode = enabled;
    logDebug(`🔧 classifierMode set to ${enabled}`);
  }

  /**
   * Connect to MCP server (SymPy) — always needed
   */
  async connectMCP(proxyUrl: string = 'http://localhost:3001'): Promise<void> {
    try {
      this.mcpClient = new MCPClient(proxyUrl);
      await this.mcpClient.connect();
      this.availableTools = await this.mcpClient.listTools();
      logDebug('🔌 Connected to MCP server. Available tools:', this.availableTools.map(t => t.name));
    } catch (error) {
      logError('Failed to connect to MCP server:', error);
      throw error;
    }
  }

  /**
   * Connect to Lean Prover backend (required — verification is mandatory)
   */
  async connectLean(proxyUrl: string = 'http://localhost:3002'): Promise<void> {
    if (this.proverBackend === 'sympy') {
      logDebug('⏩ Skipping Lean connection (SymPy-only mode)');
      return;
    }

    if (!this.leanClient) {
      this.leanClient = new LeanProverServiceBrowser(proxyUrl);
    }

    const available = await this.leanClient.isAvailable();
    if (!available) {
      throw new Error('Lean Prover niedostępny — uruchom Lean Proxy na porcie 3002 (./start.sh)');
    }

    this.leanAvailable = true;
    logDebug('🎯 Lean Prover available (will be used for verification)');
  }

  /**
   * Disconnect from servers
   */
  disconnect(): void {
    if (this.mcpClient) {
      this.mcpClient.disconnect();
      this.mcpClient = null;
      this.availableTools = [];
    }
    this.leanClient = null;
    this.leanAvailable = false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Server-side solve via /api/solve (SSE, includes guardrail + generator + arithmetic)
  // ═══════════════════════════════════════════════════════════════════

  private static SOLVE_SESSION_ID = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  private async tryServerSolve(
    userMessage: string,
    newMessages: Message[],
    onMessageCallback?: (message: Message) => void,
  ): Promise<Message[] | null> {
    try {
      const res = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          sessionId: ThreeAgentOrchestrator.SOLVE_SESSION_ID,
        }),
        signal: AbortSignal.timeout(300000),
      });

      if (!res.ok || !res.body) {
        logWarn(`Server-side solve unavailable (${res.status}), falling back to client pipeline`);
        return null;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: any = null;

      const agentIcons: Record<string, string> = {
        'Guardrail': '🛡️',
        'Klasyfikator': '🔍',
        'Agent Analityczny': '🧠',
        'Agent Wykonawczy': '⚡',
        'Agent Podsumowujący': '📝',
        'Generator Zadań': '📝',
        'Kalkulator': '🧮',
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);

              if (eventType === 'step') {
                const { step, agentName, content } = data;

                // Show intermediate steps as messages
                if (step.endsWith('_done') && !data.blocked && agentName !== 'Guardrail' && agentName !== 'Klasyfikator') {
                  const icon = agentIcons[agentName] || '📋';
                  const msg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content,
                    agentName: `${icon} ${agentName}`,
                    timestamp: new Date(),
                  };
                  this.conversationHistory.push(msg);
                  newMessages.push(msg);
                  if (onMessageCallback) onMessageCallback(msg);
                }

                // Handle guardrail block
                if (data.blocked) {
                  const blockedMsg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: content || 'Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.',
                    agentName: '🛡️ Guardrail',
                    timestamp: new Date(),
                  };
                  this.conversationHistory.push(blockedMsg);
                  newMessages.push(blockedMsg);
                  if (onMessageCallback) onMessageCallback(blockedMsg);
                  return newMessages;
                }
              }

              if (eventType === 'done') {
                finalResult = data;
              }

              if (eventType === 'error') {
                logWarn(`Server-side solve error: ${data.error}`);
                return null; // Fall back to client pipeline
              }
            } catch (e) {
              // Skip unparseable lines
            }
            eventType = '';
          }
        }
      }

      if (!finalResult) {
        logWarn('Server-side solve: no final result received');
        return null;
      }

      logInfo('Server-side solve completed successfully');
      return newMessages;

    } catch (err) {
      // /api/solve not available (local dev, network error) — silent fallback
      logDebug(`Server-side solve unavailable: ${err}`);
      return null;
    }
  }

  /**
   * Process a user message through the full pipeline.
   *
   * Pipeline:
   *   Agent 1: Analytical  → plan the solution
   *   Agent 2: Executor    → SymPy code (always)
   *   Agent 3: Summary     → step-by-step explanation
   *   Agent 4: Verifier    → Lean verification (optional, proof problems only)
   */
  async processMessage(
    userMessage: string,
    onMessageCallback?: (message: Message) => void,
    options?: { classifierMode?: boolean }
  ): Promise<Message[]> {
    // Allow per-call override of classifierMode
    if (options?.classifierMode !== undefined) {
      this.classifierMode = options.classifierMode;
    }
    logInfo(`🎯 Processing with multi-agent system (classifierMode=${this.classifierMode}):`, userMessage);

    // === Parse #UNI=ON/OFF toggle ===
    const uniMatch = userMessage.match(/^#UNI\s*=\s*(ON|OFF)\b/im);
    const universityEnabled = uniMatch ? uniMatch[1].toUpperCase() === 'ON' : ((prompts as any).features?.university_level ?? true);
    // Strip the #UNI tag from the message so LLM doesn't see it
    if (uniMatch) {
      userMessage = userMessage.replace(/^#UNI\s*=\s*(ON|OFF)\s*/im, '').trim();
      logDebug(`🎓 University mode: ${universityEnabled ? 'ON' : 'OFF'} (from #UNI tag)`);
    }

    // Add user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    };
    this.conversationHistory.push(userMsg);
    if (onMessageCallback) onMessageCallback(userMsg);

    const newMessages: Message[] = [userMsg];

    // ═══════════════════════════════════════════════════════════════════
    // Server-side pipeline (guardrail + generator + arithmetic + solve)
    // ═══════════════════════════════════════════════════════════════════
    const serverResult = await this.tryServerSolve(userMessage, newMessages, onMessageCallback);
    if (serverResult) {
      return serverResult;
    }

    // Server unavailable
    const errorMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Serwer jest niedostępny. Spróbuj ponownie za chwilę.',
      agentName: '⚠️ Błąd',
      timestamp: new Date(),
    };
    this.conversationHistory.push(errorMsg);
    newMessages.push(errorMsg);
    if (onMessageCallback) onMessageCallback(errorMsg);
    return newMessages;
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): Message[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get current backend info
   */
  getBackendInfo(): { prover: ProverBackend; mcpConnected: boolean; leanConnected: boolean } {
    return {
      prover: this.proverBackend,
      mcpConnected: this.mcpClient !== null,
      leanConnected: this.leanAvailable,
    };
  }
}
