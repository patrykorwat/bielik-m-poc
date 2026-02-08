import Anthropic from '@anthropic-ai/sdk';
import { MLXAgent } from './mlxAgent';

export type LLMProvider = 'claude' | 'mlx';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentName?: string;
  timestamp: Date;
}

export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface MLXConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export class GroupChatOrchestrator {
  private client: Anthropic | null = null;
  private mlxAgent: MLXAgent | null = null;
  private agents: Agent[];
  private conversationHistory: Message[] = [];
  private provider: LLMProvider;

  constructor(
    provider: LLMProvider,
    agents: Agent[],
    apiKey?: string,
    mlxConfig?: MLXConfig
  ) {
    this.provider = provider;
    this.agents = agents;

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
   * Add a user message to the conversation
   */
  addUserMessage(content: string): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    };
    this.conversationHistory.push(message);
    return message;
  }

  /**
   * Get messages for a specific agent's context
   */
  private getAgentContext(agentId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    const agent = this.agents.find(a => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    return this.conversationHistory
      .filter(msg => msg.role !== 'system')
      .map(msg => {
        if (msg.role === 'user') {
          return { role: 'user' as const, content: msg.content.trim() };
        } else {
          // Include which agent sent the message for context
          const prefix = msg.agentName ? `[${msg.agentName}]: ` : '';
          return { role: 'assistant' as const, content: (prefix + msg.content).trim() };
        }
      });
  }

  /**
   * Execute a turn for a specific agent
   */
  async executeAgentTurn(agentId: string): Promise<Message> {
    const agent = this.agents.find(a => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const messages = this.getAgentContext(agentId);
    let content = '';

    if (this.provider === 'claude' && this.client) {
      console.log(`🤖 [${agent.name}] Wysyłanie zapytania do Claude API:`, {
        model: 'claude-haiku-4-5-20251001',
        agent: agent.name,
        systemPrompt: agent.systemPrompt,
        messages: messages,
      });

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: agent.systemPrompt,
        messages,
      });

      console.log(`✅ [${agent.name}] Otrzymano odpowiedź z Claude API:`, response);

      // Extract text content from response
      if (response.content && response.content.length > 0) {
        const firstBlock = response.content[0];
        console.log(`📝 [${agent.name}] Pierwszy blok odpowiedzi:`, firstBlock);
        if (firstBlock.type === 'text') {
          content = firstBlock.text.trim();
          console.log(`📄 [${agent.name}] Treść odpowiedzi (${content.length} znaków):`, content);
        }
      } else {
        console.warn(`⚠️ [${agent.name}] Brak contentu w odpowiedzi!`, response);
      }
    } else if (this.provider === 'mlx' && this.mlxAgent) {
      console.log(`🤖 [${agent.name}] Wysyłanie zapytania do MLX:`, {
        model: this.mlxAgent.getModel(),
        agent: agent.name,
        systemPrompt: agent.systemPrompt,
        messages: messages,
      });

      content = await this.mlxAgent.execute(agent.systemPrompt, messages);

      console.log(`✅ [${agent.name}] Otrzymano odpowiedź z MLX:`, {
        contentLength: content.length,
      });
    } else {
      throw new Error(`Invalid provider configuration: ${this.provider}`);
    }

    const message: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      agentName: agent.name,
      timestamp: new Date(),
    };

    console.log(`💾 [${agent.name}] Zapisano wiadomość:`, message);

    this.conversationHistory.push(message);
    return message;
  }

  /**
   * Orchestrate a round-robin conversation between agents
   */
  async orchestrateConversation(
    userMessage: string,
    rounds: number = 2,
    onMessageCallback?: (message: Message) => void
  ): Promise<Message[]> {
    console.log('🎯 Rozpoczynam orkiestrację konwersacji:', {
      userMessage,
      rounds,
      agentsCount: this.agents.length,
    });

    // Add user message
    const userMsg = this.addUserMessage(userMessage);
    console.log('👤 Dodano wiadomość użytkownika:', userMsg);
    if (onMessageCallback) {
      console.log('📢 Wywołuję callback dla wiadomości użytkownika');
      onMessageCallback(userMsg);
    }

    const newMessages: Message[] = [userMsg];

    // Round-robin between agents
    for (let round = 0; round < rounds; round++) {
      console.log(`\n🔄 === RUNDA ${round + 1}/${rounds} ===`);
      for (const agent of this.agents) {
        console.log(`\n🤖 Tura agenta: ${agent.name}`);
        const agentMessage = await this.executeAgentTurn(agent.id);
        newMessages.push(agentMessage);
        console.log(`📢 Wywołuję callback dla wiadomości agenta ${agent.name}`);
        if (onMessageCallback) onMessageCallback(agentMessage);
      }
    }

    console.log('✅ Orkiestracja zakończona. Łącznie wiadomości:', newMessages.length);
    return newMessages;
  }

  /**
   * Get the full conversation history
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

/**
 * Create mathematical task agents
 */
export function createMathAgents(): Agent[] {
  return [
    {
      id: 'analyzer',
      name: 'Analizator',
      systemPrompt: `Jesteś ekspertem matematycznym specjalizującym się w analizie problemów.
Twoja rola:
- Analizuj problem matematyczny podany przez użytkownika
- Rozbij go na mniejsze kroki
- Zidentyfikuj potrzebne metody i wzory
- Zaproponuj strategię rozwiązania
- Współpracuj z drugim agentem (Kalkulator), który wykona obliczenia

Odpowiadaj krótko i konkretnie po polsku. Nie wykonuj finalnych obliczeń - to rola Kalkulatora.`,
    },
    {
      id: 'calculator',
      name: 'Kalkulator',
      systemPrompt: `Jesteś ekspertem matematycznym specjalizującym się w wykonywaniu obliczeń.
Twoja rola:
- Wykonuj obliczenia matematyczne krok po kroku
- Weryfikuj wyniki
- Wyjaśniaj przeprowadzone operacje
- Współpracuj z Analizatorem, który dostarcza strategię rozwiązania

Odpowiadaj krótko i konkretnie po polsku. Pokaż wszystkie kroki obliczeń.`,
    },
  ];
}
