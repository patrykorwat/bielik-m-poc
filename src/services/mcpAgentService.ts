import Anthropic from '@anthropic-ai/sdk';
import { MLXAgent } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';

export type LLMProvider = 'claude' | 'mlx';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
      // Try to find <tool_call> tag format (Claude-style)
      const toolCallMatch = content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
      if (toolCallMatch) {
        const parsed = JSON.parse(toolCallMatch[1]);
        if (parsed.name) {
          return {
            id: crypto.randomUUID(),
            name: parsed.name,
            arguments: parsed.arguments || {},
          };
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
        console.log(`🔧 Executing tool: ${toolCall.name}`, toolCall.arguments);
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

        console.log(`✅ Tool result:`, textContent);
      } catch (error) {
        console.error(`❌ Tool execution failed:`, error);
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
    console.log('🎯 Processing user message:', userMessage);

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
      console.log(`\n🔄 Iteration ${iteration}/${maxIterations}`);

      let assistantContent = '';
      let toolCalls: ToolCall[] = [];

      if (this.provider === 'claude' && this.client) {
        // Claude with native tool support
        const messages = this.conversationHistory
          .filter(msg => msg.role !== 'system')
          .map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));

        const claudeTools = this.convertToolsForClaude();

        const systemPrompt = `Jesteś ekspertem matematycznym z dostępem do narzędzi SymPy do wykonywania symbolicznych obliczeń matematycznych.

Twoja rola:
- Analizuj problemy matematyczne podane przez użytkownika
- Używaj dostępnych narzędzi SymPy do wykonywania precyzyjnych obliczeń
- Wyjaśniaj kroki i wyniki w sposób zrozumiały
- Odpowiadaj po polsku

Gdy potrzebujesz wykonać obliczenia symboliczne (całki, pochodne, równania, uproszczenia, itp.), użyj odpowiedniego narzędzia.`;

        const requestParams: any = {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: systemPrompt,
          messages,
        };

        if (claudeTools.length > 0) {
          requestParams.tools = claudeTools;
        }

        console.log('🤖 Calling Claude API with tools:', claudeTools.map(t => t.name));
        const response = await this.client.messages.create(requestParams);

        console.log('✅ Claude response:', response);

        // Process response content
        for (const block of response.content) {
          if (block.type === 'text') {
            assistantContent += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, any>,
            });
          }
        }

        // If no content and no tool calls, stop
        if (!assistantContent && toolCalls.length === 0) {
          break;
        }

        // Save assistant message
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent || '(używam narzędzi...)',
          timestamp: new Date(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
        this.conversationHistory.push(assistantMsg);
        newMessages.push(assistantMsg);
        if (onMessageCallback) onMessageCallback(assistantMsg);

        // Execute tool calls if any
        if (toolCalls.length > 0) {
          const toolResults = await this.executeToolCalls(toolCalls);

          // Add tool results as a user message for Claude
          const toolResultsContent = toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: tr.result,
            is_error: tr.isError,
          }));

          this.conversationHistory.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: JSON.stringify(toolResultsContent),
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
        const systemPrompt = `Jesteś ekspertem matematycznym z dostępem do narzędzi SymPy do wykonywania symbolicznych obliczeń matematycznych.

Twoja rola:
- Analizuj problemy matematyczne podane przez użytkownika
- Używaj dostępnych narzędzi SymPy do wykonywania precyzyjnych obliczeń
- Wyjaśniaj kroki i wyniki w sposób zrozumiały
- Odpowiadaj po polsku
${this.generateToolDescriptionsForMLX()}`;

        const messages = this.conversationHistory
          .filter(msg => msg.role === 'user' || msg.role === 'assistant')
          .map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));

        console.log('🤖 Calling MLX with tool descriptions');
        assistantContent = await this.mlxAgent.execute(systemPrompt, messages);

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

    console.log('✅ Processing complete. Messages:', newMessages.length);
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
