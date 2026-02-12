import Anthropic from '@anthropic-ai/sdk';
import { MLXAgent } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';

export type LLMProvider = 'claude' | 'mlx';

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
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Two-agent orchestrator with Analytical Agent and SymPy Executor
 */
export class TwoAgentOrchestrator {
  private client: Anthropic | null = null;
  private mlxAgent: MLXAgent | null = null;
  private mcpClient: MCPClient | null = null;
  private conversationHistory: Message[] = [];
  private provider: LLMProvider;
  private availableTools: MCPTool[] = [];

  constructor(
    provider: LLMProvider,
    apiKey?: string,
    mlxConfig?: MLXConfig
  ) {
    this.provider = provider;

    if (provider === 'claude') {
      if (!apiKey) {
        throw new Error('API key is required for Claude provider');
      }
      this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    } else if (provider === 'mlx') {
      if (!mlxConfig) {
        throw new Error('MLX config is required for MLX provider');
      }
      this.mlxAgent = new MLXAgent(mlxConfig);
    }
  }

  /**
   * Connect to MCP server (via HTTP proxy)
   */
  async connectMCP(proxyUrl: string = 'http://localhost:3001'): Promise<void> {
    try {
      this.mcpClient = new MCPClient(proxyUrl);
      await this.mcpClient.connect();
      this.availableTools = await this.mcpClient.listTools();
      console.log('🔌 Connected to MCP server. Available tools:', this.availableTools.map(t => t.name));
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      throw error;
    }
  }

  /**
   * Disconnect from MCP server
   */
  disconnectMCP(): void {
    if (this.mcpClient) {
      this.mcpClient.disconnect();
      this.mcpClient = null;
      this.availableTools = [];
    }
  }

  /**
   * Get available MCP tools
   */
  getAvailableTools(): MCPTool[] {
    return this.availableTools;
  }

  /**
   * Execute a single agent turn
   */
  private async executeAgentTurn(
    agentName: string,
    systemPrompt: string,
    contextMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    if (this.provider === 'claude' && this.client) {
      console.log(`🤖 [${agentName}] Calling Claude API...`);

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: contextMessages,
      });

      let content = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        }
      }

      console.log(`✅ [${agentName}] Response received`);
      return content.trim();

    } else if (this.provider === 'mlx' && this.mlxAgent) {
      console.log(`🤖 [${agentName}] Calling MLX...`);

      const content = await this.mlxAgent.execute(systemPrompt, contextMessages);

      // Remove <think> blocks from Bielik responses
      const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      console.log(`✅ [${agentName}] Response received`);
      return cleanContent;

    } else {
      throw new Error(`Invalid provider configuration: ${this.provider}`);
    }
  }

  /**
   * Execute SymPy calculation via MCP
   */
  private async executeSymPyCalculation(code: string): Promise<string> {
    if (!this.mcpClient) {
      throw new Error('MCP client not connected');
    }

    console.log('🔧 Executing SymPy calculation:', code);

    try {
      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const textContent = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      console.log('✅ SymPy result:', textContent);
      return textContent;

    } catch (error) {
      console.error('❌ SymPy execution failed:', error);
      throw error;
    }
  }

  /**
   * Clean malformed LaTeX from response (e.g., "1$", " $\boxed{}")
   */
  private cleanMalformedLatex(text: string): string {
    let cleaned = text;

    // Remove ALL single dollar signs (keep only $$)
    // Replace any $ that's not followed or preceded by another $
    cleaned = cleaned.split('$$').map((part, index) => {
      // Keep $$ blocks intact, only clean the text between them
      if (index % 2 === 0) {
        // This is text outside $$...$$
        return part.replace(/\$/g, '');
      } else {
        // This is inside $$...$$ - keep it
        return part;
      }
    }).join('$$');

    // Remove empty LaTeX blocks: $$$$
    cleaned = cleaned.replace(/\$\$\s*\$\$/g, '');

    // Fix spacing around $$
    cleaned = cleaned.replace(/\s{2,}\$\$/g, ' $$');
    cleaned = cleaned.replace(/\$\$\s{2,}/g, '$$ ');

    return cleaned;
  }

  /**
   * Extract SymPy code from Executor response
   */
  private extractSymPyCode(response: string): string[] {
    const codeBlocks: string[] = [];

    // Extract code from ```python blocks
    const pythonBlockRegex = /```python\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = pythonBlockRegex.exec(response)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    // Also look for code in plain ``` blocks
    if (codeBlocks.length === 0) {
      const plainBlockRegex = /```\s*\n([\s\S]*?)\n```/g;
      while ((match = plainBlockRegex.exec(response)) !== null) {
        const code = match[1].trim();
        // Only include if it looks like Python/SymPy code
        if (code.includes('sympy') || code.includes('import') || code.includes('print')) {
          codeBlocks.push(code);
        }
      }
    }

    return codeBlocks;
  }

  /**
   * Get agent context (messages for agent to see)
   */
  private getAgentContext(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.conversationHistory
      .filter(msg => msg.role !== 'system')
      .map(msg => {
        let contentStr: string;

        if (Array.isArray(msg.content)) {
          contentStr = msg.content
            .map(block => {
              if (typeof block === 'object' && block !== null) {
                if (block.type === 'text') return block.text || '';
                return '';
              }
              return String(block);
            })
            .filter(Boolean)
            .join('\n');
        } else {
          contentStr = typeof msg.content === 'string' ? msg.content : String(msg.content);
        }

        // Add agent name prefix if present
        if (msg.role === 'assistant' && msg.agentName) {
          contentStr = `[${msg.agentName}]: ${contentStr}`;
        }

        return {
          role: msg.role as 'user' | 'assistant',
          content: contentStr,
        };
      });
  }

  /**
   * Process a user message with two-agent conversation
   */
  async processMessage(
    userMessage: string,
    onMessageCallback?: (message: Message) => void
  ): Promise<Message[]> {
    console.log('🎯 Processing user message with two-agent system:', userMessage);

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

    // System prompts for the two agents
    const analyticalPrompt = `ABSOLUTNIE ZAKAZANE jest używanie LaTeX, symboli matematycznych lub wzorów!

Jesteś Agentem Analitycznym. Opisuj plan rozwiązania TYLKO prostym tekstem po polsku.

ZABRONIONE (będziesz ukarany za ich użycie):
❌ Symbole: $, $$, \\, ^, _, {, }
❌ LaTeX: \\Delta, \\boxed, \\frac, itp.
❌ Wzory matematyczne: x^2, m+7, 2x
❌ Równania: ax + b = 0

DOZWOLONE:
✓ Proste słowa: "x do kwadratu", "m plus siedem", "dwa x"
✓ Opis: "Oblicz wyróżnik równania"
✓ Tekst: "Sprawdź czy delta jest większa od zera"

PRZYKŁAD POPRAWNY (MAKSYMALNIE 5-6 KROKÓW!):
Krok 1: Oblicz wyróżnik równania kwadratowego
Krok 2: Sprawdź czy wyróżnik jest dodatni
Krok 3: Użyj wzorów Viete'a na sumę i iloczyn pierwiastków
Krok 4: Podstaw warunek że pierwszy pierwiastek jest dwa razy większy od drugiego
Krok 5: Rozwiąż równanie dla parametru m

LIMIT: MAKSYMALNIE 5-6 KROKÓW! Pisz BARDZO KRÓTKO!
Każdy krok to JEDNA KRÓTKA LINIA tekstu!
ZAKAZANE są długie wyjaśnienia i szczegóły matematyczne!`;

    const executorPrompt = `Jesteś Agentem Wykonawczym - ekspertem w wykonywaniu obliczeń SymPy.

ABSOLUTNIE ZAKAZANE: NIE używaj LaTeX w tekście! Tylko w kodzie Python dozwolony SymPy.

Twoja rola:
1. Napisz TYLKO kod Python/SymPy realizujący plan
2. Po kodzie napisz TYLKO: "Wynik: [liczba/wartości z SymPy]"

Format odpowiedzi:
\`\`\`python
from sympy import *

# Krok 1: [opis]
[kod]
print("Krok 1:", wynik1)

# Krok 2: [opis]
[kod]
print("Krok 2:", wynik2)

print("\\nOstateczna odpowiedź:", ostateczny_wynik)
\`\`\`

Wynik: [wartość otrzymana z kodu]

ZAKAZANE:
❌ LaTeX: , \\boxed, \\frac, ^, _, itp.
❌ Długie wyjaśnienia
❌ Powtarzanie kroków z kodu

DOZWOLONE:
✓ Tylko kod Python
✓ Tylko krótka linia "Wynik: [wartość]"

Odpowiadaj po polsku.`;

    // AGENT 1: Analytical Agent creates the plan
    console.log('\n=== TURA 1: Agent Analityczny tworzy plan ===');
    const analyticalContext = this.getAgentContext();
    const analyticalResponse = await this.executeAgentTurn(
      'Agent Analityczny',
      analyticalPrompt,
      analyticalContext
    );

    // Clean malformed LaTeX from analytical response
    const cleanedAnalyticalResponse = this.cleanMalformedLatex(analyticalResponse);

    const analyticalMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: cleanedAnalyticalResponse,
      agentName: 'Agent Analityczny',
      timestamp: new Date(),
    };
    this.conversationHistory.push(analyticalMsg);
    newMessages.push(analyticalMsg);
    if (onMessageCallback) onMessageCallback(analyticalMsg);

    // AGENT 2: Executor Agent executes the plan step by step
    console.log('\n=== TURA 2: Agent Wykonawczy wykonuje plan ===');

    // Add the analytical response to context for executor
    const executorContext = this.getAgentContext();
    const executorResponse = await this.executeAgentTurn(
      'Agent Wykonawczy',
      executorPrompt,
      executorContext
    );

    // Clean malformed LaTeX from executor response
    const cleanedExecutorResponse = this.cleanMalformedLatex(executorResponse);

    // Extract code blocks from executor's response
    const codeBlocks = this.extractSymPyCode(executorResponse);
    console.log(`📝 Found ${codeBlocks.length} code blocks to execute`);

    // Combine all code blocks into one script to maintain variable context
    let combinedCode = '';
    const executionResults: string[] = [];

    if (codeBlocks.length > 0) {
      // Merge all code blocks, ensuring imports are at the top
      const imports = new Set<string>();
      const codeLines: string[] = [];

      for (const block of codeBlocks) {
        const lines = block.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
            imports.add(trimmed);
          } else if (trimmed) {
            codeLines.push(line);
          }
        }
      }

      // Build the combined code
      combinedCode = Array.from(imports).join('\n') + '\n\n' + codeLines.join('\n');

      console.log(`\n🔧 Executing combined code:\n${combinedCode}`);

      try {
        const result = await this.executeSymPyCalculation(combinedCode);
        executionResults.push(`📊 Wyniki wszystkich kroków:\n${result}`);
      } catch (error) {
        const errorMsg = `❌ Błąd wykonania: ${error instanceof Error ? error.message : String(error)}`;
        executionResults.push(errorMsg);
      }
    }

    // Add execution results to the executor's response content (use cleaned version)
    let finalExecutorContent = cleanedExecutorResponse;

    if (executionResults.length > 0 && !executionResults[0].includes('❌')) {
      // Append results summary to the executor's message
      const resultsText = executionResults[0].replace('📊 Wyniki wszystkich kroków:\n', '');
      finalExecutorContent += `\n\n---\n**WYNIKI WYKONANIA:**\n${resultsText}\n\n**ODPOWIEDŹ:** Wynik podany powyżej.`;
    }

    // Create executor message with tool results
    const executorMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: finalExecutorContent,
      agentName: 'Agent Wykonawczy',
      timestamp: new Date(),
      toolResults: executionResults.map((result, idx) => ({
        toolCallId: `sympy-${idx}`,
        toolName: 'sympy_calculate',
        result,
        isError: result.includes('❌'),
      })),
    };
    this.conversationHistory.push(executorMsg);
    newMessages.push(executorMsg);
    if (onMessageCallback) onMessageCallback(executorMsg);

    console.log('✅ Two-agent processing complete');
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
}
