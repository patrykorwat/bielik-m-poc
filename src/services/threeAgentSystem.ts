import { MLXAgent } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';
import { LeanProverServiceBrowser } from './leanProverService.browser';
import { RAGService } from './ragService';
import prompts from '../../prompts.json';

export type LLMProvider = 'mlx';
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
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
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
  private mlxAgent: MLXAgent;
  private mcpClient: MCPClient | null = null;
  private leanClient: LeanProverServiceBrowser | null = null;
  private conversationHistory: Message[] = [];
  private proverBackend: ProverBackend;
  private availableTools: MCPTool[] = [];
  private leanAvailable: boolean = false;
  private ragService: RAGService;

  constructor(
    proverBackend: ProverBackend = 'both',
    mlxConfig: MLXConfig
  ) {
    this.proverBackend = proverBackend;

    if (!mlxConfig) {
      throw new Error('MLX config is required');
    }
    this.mlxAgent = new MLXAgent(mlxConfig);

    // Initialize RAG service (port 3003)
    this.ragService = new RAGService();

    // Initialize Lean client (for verification only)
    if (proverBackend === 'lean' || proverBackend === 'both') {
      this.leanClient = new LeanProverServiceBrowser();
    }
  }

  /**
   * Connect to MCP server (SymPy) — always needed
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
   * Connect to Lean Prover backend (optional — for verification only)
   */
  async connectLean(proxyUrl: string = 'http://localhost:3002'): Promise<void> {
    if (this.proverBackend === 'sympy') {
      console.log('⏩ Skipping Lean connection (SymPy-only mode)');
      return;
    }

    try {
      if (!this.leanClient) {
        this.leanClient = new LeanProverServiceBrowser(proxyUrl);
      }

      const available = await this.leanClient.isAvailable();
      this.leanAvailable = available;

      if (available) {
        console.log('🎯 Lean Prover available (will be used for verification)');
      } else {
        console.warn('⚠️ Lean Prover not available — verification disabled');
      }
    } catch (error) {
      console.warn('Lean Prover not available:', error);
      this.leanAvailable = false;
    }
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

  /**
   * Execute a single agent turn via MLX
   */
  private async executeAgentTurn(
    agentName: string,
    systemPrompt: string,
    contextMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const maxTokens = options?.maxTokens || 2048;
    const temperature = options?.temperature ?? 0.3;

    console.log(`🤖 [${agentName}] Calling MLX (maxTokens=${maxTokens}, temp=${temperature})...`);

    const content = await this.mlxAgent.execute(systemPrompt, contextMessages, {
      maxTokens,
      temperature,
    });

    // Remove <think> blocks from Bielik responses
    let cleanContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    cleanContent = cleanContent.replace(/<think>[\s\S]*/g, '').trim();
    cleanContent = cleanContent.replace(/<\/?think>/g, '').trim();

    console.log(`✅ [${agentName}] Response received`);
    return cleanContent;
  }

  /**
   * Determine if a problem would benefit from formal Lean verification.
   * This does NOT affect solving — Executor always uses SymPy.
   * Lean is only used to verify the solution afterward.
   */
  private couldBenefitFromVerification(problem: string): boolean {
    const keywords = [
      'dowód', 'udowodnij', 'wykaż', 'prove', 'proof',
      'theorem', 'twierdzenie', 'lemma', 'lemat',
      'indukcja', 'induction',
      'dla każdego', 'forall', 'istnieje', 'exists',
      'pokaż, że', 'pokaż że', 'uzasadnij',
    ];
    const lowerProblem = problem.toLowerCase();
    return keywords.some(keyword => lowerProblem.includes(keyword));
  }

  /**
   * Execute SymPy calculation via MCP proxy
   */
  private async executeSymPyCalculation(code: string): Promise<string> {
    if (!this.mcpClient) {
      throw new Error('MCP client not connected');
    }

    console.log('🔧 Executing SymPy calculation...');

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
   * Verify a solution with Lean Prover (post-solve verification only)
   */
  private async verifyWithLean(problem: string, solution: string): Promise<string> {
    if (!this.leanClient || !this.leanAvailable) {
      throw new Error('Lean Prover not available');
    }

    console.log('🎯 Verifying solution with Lean Prover...');

    try {
      const result = await this.leanClient.proveFromProblem(problem, solution);

      if (result.success && result.verificationDetails?.verified) {
        return `✅ **Rozwiązanie zweryfikowane przez Lean Prover**

Lean potwierdził poprawność struktury logicznej rozwiązania.

${result.output ? `**Output Lean:**\n\`\`\`\n${result.output}\n\`\`\`` : ''}`;
      } else {
        const errors = result.verificationDetails?.errors?.join('\n') || '';
        return `⚠️ **Lean wykrył problemy w rozwiązaniu:**

${errors}
${result.output || ''}
${result.error || ''}`;
      }
    } catch (error) {
      console.error('❌ Lean verification failed:', error);
      return `❌ **Błąd weryfikacji Lean:** ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Clean malformed LaTeX from response
   */
  private cleanMalformedLatex(text: string): string {
    let cleaned = text;

    // Convert common LaTeX to readable text
    cleaned = cleaned.replace(/\\d?frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
    cleaned = cleaned.replace(/\\sqrt\{([^}]*)\}/g, 'sqrt($1)');
    cleaned = cleaned.replace(/\\boxed\{([^}]*)\}/g, '$1');
    cleaned = cleaned.replace(/\\(left|right|cdot|times|text|mathrm|quad|,)/g, '');
    cleaned = cleaned.replace(/\^{(\w)}/g, '^$1');
    cleaned = cleaned.replace(/_{(\w)}/g, '_$1');

    // Remove dollar signs
    cleaned = cleaned.replace(/\$\$/g, '');
    cleaned = cleaned.replace(/\$/g, '');

    // Remove LaTeX delimiters
    cleaned = cleaned.replace(/\\\(/g, '');
    cleaned = cleaned.replace(/\\\)/g, '');
    cleaned = cleaned.replace(/\\\[/g, '');
    cleaned = cleaned.replace(/\\\]/g, '');

    // Clean up artifacts
    cleaned = cleaned.replace(/^\s*\d+\s*$/gm, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.replace(/\\([a-zA-Z]+)/g, '$1');

    return cleaned.trim();
  }

  /**
   * Sanitize Python/SymPy code before execution
   */
  private sanitizeCode(code: string): string {
    let lines = code.split('\n');

    // 1. Remove assert statements
    lines = lines.filter(line => !line.trim().startsWith('assert '));

    // 2. Remove duplicate variable definitions
    const definedVars = new Set<string>();
    const symbolDefRegex = /^(\w+)\s*=\s*symbols?\(/;
    lines = lines.filter(line => {
      const match = line.trim().match(symbolDefRegex);
      if (match) {
        const varName = match[1];
        if (definedVars.has(varName)) return false;
        definedVars.add(varName);
      }
      return true;
    });

    // 3. Remove duplicate imports
    const seenImports = new Set<string>();
    lines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
        if (seenImports.has(trimmed)) return false;
        seenImports.add(trimmed);
      }
      return true;
    });

    // 4. Fix ^ → ** for exponentiation
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      return line
        .replace(/(\w)\^(\w)/g, '$1**$2')
        .replace(/\)\^(\w)/g, ')**$1')
        .replace(/(\w)\^\(/g, '$1**(');
    });

    // 5. Filter out single-letter "imports" (Bielik hallucination)
    lines = lines.map(line => {
      const importMatch = line.match(/^(from sympy import .+)/);
      if (importMatch) {
        const parts = line.split(',').map(p => p.trim());
        const filtered = parts.filter(p => {
          if (p.startsWith('from ')) return true;
          if (/^[a-z]$/i.test(p)) return false;
          if (['R', 'x', 'y', 'z', 'a', 'b', 'c', 'n', 'm', 'k', 't'].includes(p)) return false;
          return true;
        });
        return filtered.join(', ');
      }
      return line;
    });

    // 6. Fix wrong SymPy names
    const importFixes: Record<string, string> = {
      'Simplify': 'simplify',
      'Greater': 'Gt',
      'Less': 'Lt',
      'GreaterEqual': 'Ge',
      'LessEqual': 'Le',
    };
    lines = lines.map(line => {
      for (const [wrong, correct] of Object.entries(importFixes)) {
        if (line.includes(wrong)) {
          line = line.replace(new RegExp(wrong, 'g'), correct);
        }
      }
      return line;
    });

    // 7. Fix Pi → pi
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      return line.replace(/\bPi\b/g, 'pi');
    });

    // 8. Ensure print statement exists
    const hasPrint = lines.some(line => line.trim().startsWith('print(') || line.trim().startsWith('print ('));
    if (!hasPrint) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const assignMatch = lines[i].trim().match(/^(\w+)\s*=/);
        if (assignMatch && !lines[i].trim().startsWith('#') && !lines[i].trim().startsWith('from ') && !lines[i].trim().startsWith('import ')) {
          lines.push(`print("ODPOWIEDZ:", ${assignMatch[1]})`);
          break;
        }
      }
    }

    return lines.join('\n').trim();
  }

  /**
   * Extract first valid code block from response
   */
  private extractCode(response: string): string[] {
    const pythonMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response);
    if (pythonMatch) return [pythonMatch[1].trim()];

    const plainMatch = /```\s*\n([\s\S]*?)\n```/.exec(response);
    if (plainMatch) {
      const code = plainMatch[1].trim();
      if (code.includes('sympy') || code.includes('import') || code.includes('print')) {
        return [code];
      }
    }

    return [];
  }

  /**
   * Extract first Lean code block from response
   */
  private extractLeanCode(response: string): string | null {
    const leanMatch = /```lean\s*\n([\s\S]*?)\n```/.exec(response);
    return leanMatch ? leanMatch[1].trim() : null;
  }

  /**
   * Truncate response after first code block
   */
  private truncateAfterFirstCodeBlock(response: string): string {
    const match = response.match(/([\s\S]*?```python\s*\n[\s\S]*?\n```)/);
    if (match) return match[1].trim();
    const plainMatch = response.match(/([\s\S]*?```\s*\n[\s\S]*?\n```)/);
    if (plainMatch) return plainMatch[1].trim();
    return response;
  }

  /**
   * Format RAG results for user display (not for agent prompt)
   */
  private formatRAGForDisplay(results: any[]): string {
    if (!results.length) return 'Brak pasujących informacji w bazie wiedzy.';

    const lines: string[] = ['**Znaleziono pasujące informacje w bazie wiedzy:**\n'];

    // Group by source
    const methods = results.filter(r => r.source === 'methods' && r.score > 0.15);
    const examples = results.filter(r => r.source === 'dataset' && r.score > 0.2);
    const informator = results.filter(r => r.source === 'informator' && r.score > 0.2);

    if (methods.length > 0) {
      lines.push('**Metody matematyczne:**');
      methods.slice(0, 2).forEach((m, idx) => {
        lines.push(`${idx + 1}. **${m.title}** (relevance: ${(m.score * 100).toFixed(0)}%)`);
        if (m.tips) lines.push(`   💡 ${m.tips.substring(0, 150)}`);
      });
      lines.push('');
    }

    if (examples.length > 0) {
      lines.push('**Podobne zadania z matur:**');
      examples.slice(0, 2).forEach((e, idx) => {
        lines.push(`${idx + 1}. ${e.title} (relevance: ${(e.score * 100).toFixed(0)}%)`);
      });
      lines.push('');
    }

    if (informator.length > 0) {
      lines.push('**Kontekst egzaminacyjny:**');
      informator.slice(0, 1).forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i.title}`);
        if (i.tips) lines.push(`   ${i.tips.substring(0, 200)}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get agent context from conversation history
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
   * Try to fix code based on error message, return fixed code or same code if no fix found
   */
  private tryFixCode(code: string, errorMsg: string): string {
    let fixedCode = code;

    // Fix 1: NameError — add missing symbol definition
    const nameErrorMatch = errorMsg.match(/NameError: name '(\w+)' is not defined/);
    if (nameErrorMatch) {
      const missingVar = nameErrorMatch[1];
      const lines = fixedCode.split('\n');
      let insertIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('from ') || lines[i].trim().startsWith('import ')) {
          insertIdx = i + 1;
        }
      }
      lines.splice(insertIdx, 0, `${missingVar} = symbols('${missingVar}', real=True)`);
      fixedCode = lines.join('\n');
    }

    // Fix 2: IndexError on solve()[0]
    if (errorMsg.includes('IndexError: list index out of range')) {
      fixedCode = fixedCode.replace(
        /(\w+)\s*=\s*solve\(([^)]+)\)\[0\]/g,
        '_sols = solve($2)\n$1 = _sols[0] if _sols else None'
      );
    }

    // Fix 3: 'And'/'Or' object not iterable
    if (errorMsg.includes("'And' object") || errorMsg.includes("'Or' object")) {
      fixedCode = fixedCode.replace(
        /for\s+(\w+)\s+in\s+(\w+)/g,
        'for $1 in ([$2] if not hasattr($2, "__iter__") else $2)'
      );
    }

    // Fix 4: 'bool' object has no attribute 'subs'
    if (errorMsg.includes("'bool' object has no attribute 'subs'")) {
      fixedCode = fixedCode.replace(/(\w+)\s*=\s*(.+?)\s*==\s*(.+)/g, '$1 = Eq($2, $3)');
    }

    // Fix 5: tuple/dict indexing with symbol
    if (errorMsg.includes('tuple indices must be integers') || errorMsg.includes('list indices must be integers')) {
      fixedCode = fixedCode.replace(/(\w+)\[(\w+)\](?!\s*if)/g, '$1[0]');
    }

    return fixedCode;
  }

  /**
   * Execute SymPy code with auto-retry on failure
   */
  private async executeWithRetry(code: string, maxRetries: number = 3): Promise<string> {
    let currentCode = code;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeSymPyCalculation(currentCode);
        return result; // Success
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️ Attempt ${attempt + 1} failed:`, errorMsg.substring(0, 120));

        if (attempt >= maxRetries) break;

        const fixedCode = this.tryFixCode(currentCode, errorMsg);
        if (fixedCode === currentCode) {
          console.warn('⚠️ No fix found, giving up retries.');
          break;
        }

        console.log('📤 Retrying with fixed code...');
        currentCode = fixedCode;
      }
    }

    throw lastError;
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
    onMessageCallback?: (message: Message) => void
  ): Promise<Message[]> {
    console.log('🎯 Processing with multi-agent system:', userMessage);

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

    // Check if problem might benefit from Lean verification (doesn't affect solving)
    const shouldVerify = this.couldBenefitFromVerification(userMessage)
      && this.leanAvailable
      && (this.proverBackend === 'lean' || this.proverBackend === 'both');

    // Detect MC questions
    const isMultipleChoice = /Opcje:|[A-D]\)/.test(userMessage);

    console.log(`📋 Problem analysis:`);
    console.log(`   MC question: ${isMultipleChoice}`);
    console.log(`   Lean verification: ${shouldVerify ? 'yes' : 'no'}`);
    console.log(`   Executor: always SymPy`);

    // ═══════════════════════════════════════════════════════════════════
    // RAG: Wzbogacenie kontekstem z bazy wiedzy
    // ═══════════════════════════════════════════════════════════════════
    let ragContext = '';
    let ragResults: any[] = [];
    try {
      ragResults = await this.ragService.query(userMessage, 5);
      if (ragResults.length > 0) {
        ragContext = this.ragService.formatContextForAgent(ragResults);
        console.log(`📚 RAG: ${ragResults.length} wyników znalezionych`);

        // Dodaj wiadomość RAG do konwersacji (wyświetlana użytkownikowi)
        const ragDisplayMsg = this.formatRAGForDisplay(ragResults);
        const ragMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: ragDisplayMsg,
          agentName: '📚 Baza Wiedzy',
          timestamp: new Date(),
        };
        this.conversationHistory.push(ragMsg);
        newMessages.push(ragMsg);
        if (onMessageCallback) onMessageCallback(ragMsg);
      }
    } catch (err) {
      console.warn('⚠️ RAG unavailable (continuing without):', err);
    }

    // ═══════════════════════════════════════════════════════════════════
    // AGENT 1: Analytical — plan the solution
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== AGENT 1: Analytical ===');

    const analyticalPrompt = ragContext
      ? `${prompts.analytical}\n${ragContext}`
      : prompts.analytical;

    const analyticalContext = this.getAgentContext();
    const analyticalResponse = await this.executeAgentTurn(
      'Agent Analityczny',
      analyticalPrompt,
      analyticalContext,
      { maxTokens: prompts.agents.analytical.max_tokens, temperature: prompts.agents.analytical.temperature }
    );

    const analyticalMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: this.cleanMalformedLatex(analyticalResponse),
      agentName: 'Agent Analityczny',
      timestamp: new Date(),
    };
    this.conversationHistory.push(analyticalMsg);
    newMessages.push(analyticalMsg);
    if (onMessageCallback) onMessageCallback(analyticalMsg);

    // ═══════════════════════════════════════════════════════════════════
    // AGENT 2: Executor — always SymPy
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== AGENT 2: Executor (SymPy) ===');

    // Choose MC or standard executor prompt
    const executorPrompt = isMultipleChoice && (prompts as any).executor_sympy_mc
      ? (prompts as any).executor_sympy_mc
      : prompts.executor_sympy;

    if (isMultipleChoice) {
      console.log('📋 MC question — using MC executor prompt');
    }

    const executorContext = this.getAgentContext();
    const executorResponse = await this.executeAgentTurn(
      'Agent Wykonawczy',
      executorPrompt,
      executorContext,
      { maxTokens: prompts.agents.executor.max_tokens, temperature: prompts.agents.executor.temperature }
    );

    // Truncate after first code block (Bielik often duplicates)
    const truncatedExecutorResponse = this.truncateAfterFirstCodeBlock(executorResponse);
    const cleanedExecutorResponse = this.cleanMalformedLatex(truncatedExecutorResponse);

    let finalExecutorContent = cleanedExecutorResponse;
    const executionResults: string[] = [];
    const codeBlocks = this.extractCode(executorResponse);

    console.log(`📝 Found ${codeBlocks.length} code blocks to execute`);

    if (codeBlocks.length > 0 && this.mcpClient) {
      const combinedCode = this.sanitizeCode(codeBlocks[0]);
      console.log('📤 Code sent to MCP sympy_calculate:', combinedCode);

      try {
        const result = await this.executeWithRetry(combinedCode);
        executionResults.push(`📊 Wyniki wykonania:\n${result}`);

        // Remove code blocks from displayed content (shown in toolCalls instead)
        finalExecutorContent = finalExecutorContent.replace(/```python[\s\S]*?```/g, '');
        finalExecutorContent = finalExecutorContent.replace(/```[\s\S]*?```/g, '');
        finalExecutorContent += `\n\n---\n**WYNIKI WYKONANIA:**\n${result}`;
      } catch (error) {
        const errorMsg = `❌ Błąd wykonania: ${error instanceof Error ? error.message : String(error)}`;
        executionResults.push(errorMsg);
        finalExecutorContent = finalExecutorContent.replace(/```python[\s\S]*?```/g, '');
        finalExecutorContent = finalExecutorContent.replace(/```[\s\S]*?```/g, '');
        finalExecutorContent += `\n\n---\n**BŁĄD WYKONANIA:**\n${errorMsg}`;
      }
    } else if (codeBlocks.length === 0) {
      console.warn('⚠️ No code blocks found in executor response');
    }

    const executorMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: finalExecutorContent,
      agentName: 'Agent Wykonawczy',
      timestamp: new Date(),
      toolCalls: codeBlocks.length > 0 ? [{
        id: 'sympy-exec-1',
        name: 'sympy_calculate',
        arguments: { expression: codeBlocks[0] }
      }] : undefined,
      toolResults: executionResults.map((result, idx) => ({
        toolCallId: `exec-${idx}`,
        toolName: 'sympy_calculate',
        result,
        isError: result.includes('❌'),
      })),
    };
    this.conversationHistory.push(executorMsg);
    newMessages.push(executorMsg);
    if (onMessageCallback) onMessageCallback(executorMsg);

    // ═══════════════════════════════════════════════════════════════════
    // AGENT 3: Summary — explain the solution step by step
    // ═══════════════════════════════════════════════════════════════════
    const hasResults = executionResults.length > 0 && !executionResults.some(r => r.includes('❌'));

    if (hasResults) {
      console.log('\n=== AGENT 3: Summary ===');

      const summaryContext = this.getAgentContext();
      const summaryResponse = await this.executeAgentTurn(
        'Agent Podsumowujący',
        prompts.summary,
        summaryContext,
        { maxTokens: prompts.agents.summary.max_tokens, temperature: prompts.agents.summary.temperature }
      );

      const summaryMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: this.cleanMalformedLatex(summaryResponse),
        agentName: 'Agent Podsumowujący',
        timestamp: new Date(),
      };
      this.conversationHistory.push(summaryMsg);
      newMessages.push(summaryMsg);
      if (onMessageCallback) onMessageCallback(summaryMsg);
    }

    // ═══════════════════════════════════════════════════════════════════
    // AGENT 4: Lean Verifier (optional — only for proof-type problems)
    // ═══════════════════════════════════════════════════════════════════
    if (shouldVerify && hasResults) {
      console.log('\n=== AGENT 4: Lean Verifier ===');

      // Step 4a: Use formalizer prompt to translate solution to Lean code
      const formalizerPrompt = (prompts as any).formalizer_lean || prompts.executor_lean;
      const formalizerConfig = (prompts.agents as any).formalizer || prompts.agents.executor;

      const formalizerContext = this.getAgentContext();
      const formalizerResponse = await this.executeAgentTurn(
        'Agent Weryfikujący',
        formalizerPrompt,
        formalizerContext,
        { maxTokens: formalizerConfig.max_tokens, temperature: formalizerConfig.temperature }
      );

      const cleanedFormalizerResponse = this.cleanMalformedLatex(formalizerResponse);
      const leanCode = this.extractLeanCode(formalizerResponse) || cleanedFormalizerResponse;

      // Step 4b: Verify the Lean code with Lean Prover
      let leanVerification = '';
      const leanToolCalls: ToolCall[] = [];
      const leanToolResults: ToolResult[] = [];

      if (this.leanClient && this.leanAvailable) {
        try {
          console.log('🎯 Sending to Lean Prover for verification...');

          leanToolCalls.push({
            id: 'lean-verify-1',
            name: 'lean_prover_verify',
            arguments: {
              problem: userMessage.substring(0, 200),
              proof: leanCode.substring(0, 500),
            },
          });

          const leanResult = await this.verifyWithLean(userMessage, leanCode);
          leanVerification = `\n\n---\n**Weryfikacja Lean Prover:**\n${leanResult}`;

          leanToolResults.push({
            toolCallId: 'lean-verify-1',
            toolName: 'lean_prover_verify',
            result: leanResult,
            isError: leanResult.includes('❌') || leanResult.includes('⚠️'),
          });
        } catch (error) {
          console.warn('Lean verification failed:', error);
          const errorMsg = `Błąd weryfikacji: ${error instanceof Error ? error.message : String(error)}`;
          leanVerification = `\n\n---\n**Weryfikacja Lean Prover:**\n${errorMsg}`;

          leanToolResults.push({
            toolCallId: 'lean-verify-1',
            toolName: 'lean_prover_verify',
            result: errorMsg,
            isError: true,
          });
        }
      }

      const verifierMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: cleanedFormalizerResponse + leanVerification,
        agentName: 'Agent Weryfikujący',
        timestamp: new Date(),
        toolCalls: leanToolCalls.length > 0 ? leanToolCalls : undefined,
        toolResults: leanToolResults.length > 0 ? leanToolResults : undefined,
      };
      this.conversationHistory.push(verifierMsg);
      newMessages.push(verifierMsg);
      if (onMessageCallback) onMessageCallback(verifierMsg);
    }

    console.log('✅ Processing complete');
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
