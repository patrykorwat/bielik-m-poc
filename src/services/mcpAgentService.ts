import Anthropic from '@anthropic-ai/sdk';
import { MLXAgent } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';
import { logDebug, logVerbose, logError } from './logger';

export type LLMProvider = 'claude' | 'mlx';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[]; // Can be string or array of content blocks for Claude API
  timestamp: Date;
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
 * Single agent with MCP tool calling capabilities
 */
export class MCPAgentOrchestrator {
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
      logDebug('🔌 Connected to MCP server. Available tools:', this.availableTools.map(t => t.name));
    } catch (error) {
      logError('Failed to connect to MCP server:', error);
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
   * Convert MCP tools to Anthropic tool format
   */
  private convertToolsForClaude(): any[] {
    return this.availableTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * Generate tool descriptions for MLX prompt
   */
  private generateToolDescriptionsForMLX(): string {
    if (this.availableTools.length === 0) {
      return '';
    }

    let description = '\n\nDostępne narzędzia matematyczne (format wywołania JSON):\n\n';

    for (const tool of this.availableTools) {
      description += `**${tool.name}**\n`;
      description += `${tool.description}\n`;
      description += `Parametry: ${JSON.stringify(tool.inputSchema.properties, null, 2)}\n`;
      description += `Wymagane: ${tool.inputSchema.required.join(', ')}\n\n`;
    }

    description += '\nAby użyć narzędzia, odpowiedz w formacie JSON:\n';
    description += '```json\n{\n  "tool_call": {\n    "name": "nazwa_narzędzia",\n    "arguments": { "param": "wartość" }\n  }\n}\n```\n';
    description += '\nJeśli nie potrzebujesz narzędzia, odpowiedz normalnie.';

    return description;
  }

  /**
   * Extract tool call from MLX response
   */
  private extractToolCallFromMLX(content: string): ToolCall | null {
    try {
      // Try to find <tool_call> tag format (Claude-style or Bielik Python dict)
      const toolCallMatch = content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
      if (toolCallMatch) {
        let jsonStr = toolCallMatch[1];

        // Convert Python dict syntax to JSON
        // Replace single quotes with double quotes (but preserve escaped quotes)
        jsonStr = jsonStr.replace(/'/g, '"');

        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.name) {
            return {
              id: crypto.randomUUID(),
              name: parsed.name,
              arguments: parsed.arguments || {},
            };
          }
        } catch (error) {
          logError('Failed to parse tool_call:', error, jsonStr);
        }
      }

      // Try to find JSON block in response
      const jsonMatch = content.match(/```json\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.tool_call && parsed.tool_call.name) {
          return {
            id: crypto.randomUUID(),
            name: parsed.tool_call.name,
            arguments: parsed.tool_call.arguments || {},
          };
        }
      }

      // Try to find TOOL_CALL: format (used by Bielik)
      const toolCallTextMatch = content.match(/TOOL_CALL:\s*\n?\s*({[\s\S]*?})\s*(?:\n|$)/);
      if (toolCallTextMatch) {
        const parsed = JSON.parse(toolCallTextMatch[1]);
        if (parsed.name) {
          return {
            id: crypto.randomUUID(),
            name: parsed.name,
            arguments: parsed.arguments || {},
          };
        }
      }

      // Try parsing the whole content as JSON
      const parsed = JSON.parse(content);
      if (parsed.tool_call && parsed.tool_call.name) {
        return {
          id: crypto.randomUUID(),
          name: parsed.tool_call.name,
          arguments: parsed.tool_call.arguments || {},
        };
      }
      // Direct tool call format
      if (parsed.name) {
        return {
          id: crypto.randomUUID(),
          name: parsed.name,
          arguments: parsed.arguments || {},
        };
      }
    } catch (error) {
      // Not a tool call, just regular text
    }
    return null;
  }

  /**
   * Execute tool calls via MCP
   */
  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (!this.mcpClient) {
      throw new Error('MCP client not connected');
    }

    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      try {
        logDebug(`🔧 Executing tool: ${toolCall.name}`, toolCall.arguments);
        const result = await this.mcpClient.callTool(toolCall.name, toolCall.arguments);

        const textContent = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');

        results.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: textContent,
          isError: result.isError,
        });

        logDebug(`✅ Tool result:`, textContent);
      } catch (error) {
        logError(`❌ Tool execution failed:`, error);
        results.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        });
      }
    }

    return results;
  }

  /**
   * Process a user message with tool calling support
   */
  async processMessage(
    userMessage: string,
    onMessageCallback?: (message: Message) => void
  ): Promise<Message[]> {
    logDebug('🎯 Processing user message:', userMessage);

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

    // Agent loop with tool calling
    let maxIterations = 5;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      logDebug(`\n🔄 Iteration ${iteration}/${maxIterations}`);

      let assistantContent = '';
      let toolCalls: ToolCall[] = [];

      if (this.provider === 'claude' && this.client) {
        // Claude with native tool support
        const messages = this.conversationHistory
          .filter(msg => msg.role !== 'system')
          .map(msg => {
            // If content is already an array (e.g., tool results), use it as is
            // Otherwise, convert string content to the format Claude expects
            const content = Array.isArray(msg.content)
              ? msg.content
              : (typeof msg.content === 'string' ? msg.content : String(msg.content));

            return {
              role: msg.role as 'user' | 'assistant',
              content,
            };
          });

        const claudeTools = this.convertToolsForClaude();

        const systemPrompt = `🚨 KRYTYCZNA ZASADA: MUSISZ używać narzędzi do KAŻDEGO obliczenia matematycznego! 🚨

Absolutnie zakazane jest ręczne rozwiązywanie problemów matematycznych. Twoja jedyna rola to:

1. ZAWSZE wywołaj odpowiednie narzędzie SymPy dla każdego kroku obliczeń
2. Czekaj na wynik z narzędzia
3. Dopiero wtedy wyjaśnij wynik użytkownikowi

DOSTĘPNE NARZĘDZIA (używaj ich ZAWSZE):
- sympy_solve - rozwiązywanie równań
- sympy_differentiate - obliczanie pochodnych
- sympy_integrate - całkowanie
- sympy_simplify - upraszczanie wyrażeń
- sympy_expand - rozwijanie wyrażeń
- sympy_factor - faktoryzacja
- sympy_limit - granice
- sympy_calculate - dowolne obliczenia SymPy

WORKFLOW:
1. Przeanalizuj problem
2. Wywołaj narzędzie/narzędzia (OBOWIĄZKOWE!)
3. Użyj wyniku z narzędzia do odpowiedzi
4. Formatuj matematykę używając $ dla inline lub $$ dla display LaTeX
5. Dla finalnych wyników używaj $\boxed{wynik}$ aby je wyróżnić

PRZYKŁAD DOBREJ ODPOWIEDZI:
User: "Rozwiąż x² - 4 = 0"
Assistant: [wywołuje sympy_solve z x**2 - 4]
[otrzymuje wynik: [-2, 2]]
"Rozwiązania równania to $\boxed{x_1 = -2}$ i $\boxed{x_2 = 2}$"

PRZYKŁAD ZŁEJ ODPOWIEDZI (ZABRONIONE):
"Delta wynosi... czyli x = ..." [ręczne obliczenia - NIEDOZWOLONE!]

Odpowiadaj po polsku. NIGDY nie pokazuj ręcznych obliczeń - TYLKO wyniki z narzędzi!`;

        const requestParams: any = {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: systemPrompt,
          messages,
        };

        if (claudeTools.length > 0) {
          requestParams.tools = claudeTools;
        }

        logDebug('🤖 Calling Claude API with tools:', claudeTools.map(t => t.name));
        logVerbose('📤 Request messages:', JSON.stringify(messages, null, 2));

        let response;
        try {
          response = await this.client.messages.create(requestParams);
        } catch (error) {
          logError('❌ Claude API error:', error);
          if (error instanceof Error) {
            logError('Error message:', error.message);
            logVerbose('Error stack:', error.stack);
          }
          throw error;
        }

        logVerbose('✅ Claude response:', response);
        logDebug('📊 Stop reason:', response.stop_reason);
        logVerbose('📝 Content blocks:', response.content);

        // Process response content
        for (const block of response.content) {
          if (block.type === 'text') {
            assistantContent += block.text;
            logVerbose('📄 Found text block:', block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, any>,
            });
            logDebug('🔧 Found tool_use block:', block.name);
          }
        }

        logVerbose('📊 Extracted - assistantContent:', assistantContent);
        logVerbose('🔧 Extracted - toolCalls:', toolCalls);

        // If no content and no tool calls, stop
        if (!assistantContent && toolCalls.length === 0) {
          logDebug('⚠️ No content and no tool calls, breaking loop');
          break;
        }

        // Save assistant message
        // Store the original response.content for API continuity
        // But also extract text for display
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.content, // Store full content array from Claude
          timestamp: new Date(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
        this.conversationHistory.push(assistantMsg);

        // For display callback, send a version with text content
        const displayMsg: Message = {
          ...assistantMsg,
          content: assistantContent || '(używam narzędzi...)',
        };
        newMessages.push(displayMsg);
        if (onMessageCallback) onMessageCallback(displayMsg);

        // Execute tool calls if any
        if (toolCalls.length > 0) {
          const toolResults = await this.executeToolCalls(toolCalls);

          // Update both displayMsg and the message in newMessages with tool results
          displayMsg.toolResults = toolResults;
          // Find and update the message in newMessages array
          const msgInNewMessages = newMessages.find(m => m.id === displayMsg.id);
          if (msgInNewMessages) {
            msgInNewMessages.toolResults = toolResults;
          }

          // Send updated message via callback
          if (onMessageCallback) {
            onMessageCallback({ ...displayMsg });
          }

          // Add tool results as a user message for Claude
          // Claude API expects content to be an array of tool_result objects
          const toolResultsContent = toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: tr.result,
            is_error: tr.isError,
          }));

          this.conversationHistory.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: toolResultsContent, // Store as array, not JSON string
            timestamp: new Date(),
            toolResults,
          });

          // Continue to next iteration to let Claude respond with results
          continue;
        }

        // If response is complete, stop
        if (response.stop_reason === 'end_turn') {
          break;
        }

      } else if (this.provider === 'mlx' && this.mlxAgent) {
        // MLX with prompt-based tool calling
        const systemPrompt = `🚨 KRYTYCZNA ZASADA: MUSISZ używać narzędzi do KAŻDEGO obliczenia matematycznego! 🚨

Absolutnie zakazane jest ręczne rozwiązywanie problemów matematycznych. Twoja jedyna rola to:

1. ZAWSZE wywołaj odpowiednie narzędzie SymPy dla każdego kroku obliczeń
2. Czekaj na wynik z narzędzia
3. Pokaż wynik użytkownikowi z krótkim wyjaśnieniem

PRZYKŁAD PRAWIDŁOWEJ ODPOWIEDZI:
Użytkownik: "Oblicz pochodną x^2"
Ty: TOOL_CALL: sympy_differentiate(expression="x**2", variable="x")
[otrzymujesz wynik: "2*x"]
Ty: "Pochodna x² wynosi 2x"

PRZYKŁAD BŁĘDNEJ ODPOWIEDZI (NIGDY TAK NIE RÓB!):
❌ "Obliczę pochodną krok po kroku: d/dx(x^2) = 2x^(2-1) = 2x"
❌ Długie wyjaśnienia teoretyczne zamiast wywołania narzędzia
❌ Ręczne obliczenia

Format wywołania narzędzia:
TOOL_CALL: nazwa_narzędzia(parametr1="wartość1", parametr2="wartość2")

Wszystkie wyniki matematyczne MUSZĄ być w formacie LaTeX używając \( ... \) dla inline math lub \[ ... \] dla display math.

Dla finalnych wyników używaj \boxed{wynik} aby je wyróżnić.

NIGDY nie używaj surowego tekstu dla matematyki!
✓ Poprawnie: "Pochodna wynosi \( 2x \)" lub "Wynik: \boxed{2x}"
✗ Źle: "Pochodna wynosi 2x"

Odpowiadaj po polsku. NIGDY nie pokazuj ręcznych obliczeń - TYLKO wyniki z narzędzi w LaTeX!

${this.generateToolDescriptionsForMLX()}`;

        const messages = this.conversationHistory
          .filter(msg => msg.role === 'user' || msg.role === 'assistant')
          .map(msg => {
            // For MLX, we need to convert content to string
            let contentStr: string;
            if (Array.isArray(msg.content)) {
              // Extract text from content blocks (for tool results, etc.)
              contentStr = msg.content
                .map(block => {
                  if (typeof block === 'object' && block !== null) {
                    if (block.type === 'text') return block.text || '';
                    if (block.type === 'tool_result') return `Tool result: ${block.content}`;
                    return '';
                  }
                  return String(block);
                })
                .filter(Boolean)
                .join('\n');
            } else {
              contentStr = typeof msg.content === 'string' ? msg.content : String(msg.content);
            }

            return {
              role: msg.role as 'user' | 'assistant',
              content: contentStr,
            };
          });

        logDebug('🤖 Calling MLX with tool descriptions');
        assistantContent = await this.mlxAgent.execute(systemPrompt, messages);

        // Remove <think> blocks from response (Bielik shows reasoning)
        assistantContent = assistantContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Check if response contains a tool call
        const toolCall = this.extractToolCallFromMLX(assistantContent);

        if (toolCall) {
          toolCalls = [toolCall];

          const assistantMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '(używam narzędzi...)',
            timestamp: new Date(),
            toolCalls,
          };
          this.conversationHistory.push(assistantMsg);
          newMessages.push(assistantMsg);
          if (onMessageCallback) onMessageCallback(assistantMsg);

          // Execute tool
          const toolResults = await this.executeToolCalls(toolCalls);

          // Update assistant message with tool results (like Claude does)
          assistantMsg.toolResults = toolResults;
          const msgInNewMessages = newMessages.find(m => m.id === assistantMsg.id);
          if (msgInNewMessages) {
            msgInNewMessages.toolResults = toolResults;
          }

          // Send updated message via callback
          if (onMessageCallback) {
            onMessageCallback({ ...assistantMsg });
          }

          // Add results back to conversation
          const resultsMessage = `Wynik narzędzia ${toolCall.name}:\n${toolResults[0].result}`;
          this.conversationHistory.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: resultsMessage,
            timestamp: new Date(),
            toolResults,
          });

          // Continue to next iteration
          continue;
        }

        // Regular response without tool call
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date(),
        };
        this.conversationHistory.push(assistantMsg);
        newMessages.push(assistantMsg);
        if (onMessageCallback) onMessageCallback(assistantMsg);

        // Stop after regular response
        break;
      }
    }

    logDebug('✅ Processing complete. Messages:', newMessages.length);
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
