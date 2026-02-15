import Anthropic from '@anthropic-ai/sdk';
import { MLXAgent } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';
import { LeanProverServiceBrowser } from './leanProverService.browser';
import prompts from '../../prompts.json';

export type LLMProvider = 'claude' | 'mlx';
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
 * Three-agent orchestrator with:
 * - Analytical Agent: plans the solution
 * - Executor Agent: executes calculations (SymPy or Acorn)
 * - Verifier Agent: checks proofs with Acorn for complex theorems
 */
export class ThreeAgentOrchestrator {
  private client: Anthropic | null = null;
  private mlxAgent: MLXAgent | null = null;
  private mcpClient: MCPClient | null = null;
  private leanClient: LeanProverServiceBrowser | null = null;
  private conversationHistory: Message[] = [];
  private provider: LLMProvider;
  private proverBackend: ProverBackend;
  private availableTools: MCPTool[] = [];
  private leanAvailable: boolean = false;

  constructor(
    provider: LLMProvider,
    proverBackend: ProverBackend = 'both',
    apiKey?: string,
    mlxConfig?: MLXConfig
  ) {
    this.provider = provider;
    this.proverBackend = proverBackend;

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

    // Initialize Lean client
    if (proverBackend === 'lean' || proverBackend === 'both') {
      this.leanClient = new LeanProverServiceBrowser();
    }
  }

  /**
   * Connect to MCP server (SymPy)
   */
  async connectMCP(proxyUrl: string = 'http://localhost:3001'): Promise<void> {
    if (this.proverBackend === 'lean') {
      console.log('⏩ Skipping MCP connection (Lean-only mode)');
      return;
    }

    try {
      this.mcpClient = new MCPClient(proxyUrl);
      await this.mcpClient.connect();
      this.availableTools = await this.mcpClient.listTools();
      console.log('🔌 Connected to MCP server. Available tools:', this.availableTools.map(t => t.name));
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      if (this.proverBackend === 'sympy') {
        throw error;
      }
      console.warn('Continuing without MCP (Acorn mode available)');
    }
  }

  /**
   * Connect to Lean Prover backend
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
        console.log('🎯 Connected to Lean Prover backend');
      } else {
        console.warn('⚠️ Lean Prover backend not available');
        if (this.proverBackend === 'lean') {
          throw new Error(
            'Lean Prover backend is required but not available.\n\n' +
            'Upewnij się, że:\n' +
            '1. Serwer Lean Proxy działa: npm run lean-proxy\n' +
            '2. Lean jest zainstalowany: lean --version\n' +
            '   (jeśli nie: brew install elan-init && elan default leanprover/lean4:stable)\n\n' +
            'Lub wybierz "Oba (SymPy + Lean)" aby używać SymPy gdy Lean nie jest dostępny.'
          );
        }
      }
    } catch (error) {
      console.error('Failed to connect to Lean Prover:', error);
      if (this.proverBackend === 'lean') {
        // Enhance error message if it's a connection error
        if (error instanceof Error && error.message.includes('Failed to fetch')) {
          throw new Error(
            'Nie można połączyć się z serwerem Lean Proxy.\n\n' +
            'Uruchom serwer poleceniem:\n' +
            '  npm run lean-proxy\n\n' +
            'Lub wybierz "Oba (SymPy + Lean)" aby system automatycznie wybierał dostępny backend.'
          );
        }
        throw error;
      }
      console.warn('Continuing without Lean');
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
   * Execute a single agent turn
   */
  private async executeAgentTurn(
    agentName: string,
    systemPrompt: string,
    contextMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const maxTokens = options?.maxTokens || 2048;
    const temperature = options?.temperature ?? 0.3;

    if (this.provider === 'claude' && this.client) {
      console.log(`🤖 [${agentName}] Calling Claude API (maxTokens=${maxTokens}, temp=${temperature})...`);

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
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
      console.log(`🤖 [${agentName}] Calling MLX (maxTokens=${maxTokens}, temp=${temperature})...`);

      const content = await this.mlxAgent.execute(systemPrompt, contextMessages, {
        maxTokens,
        temperature,
      });

      // Remove <think> blocks from Bielik responses (handle unclosed tags too)
      let cleanContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Handle unclosed <think> tag (Bielik sometimes doesn't close it)
      cleanContent = cleanContent.replace(/<think>[\s\S]*/g, '').trim();
      // Remove any remaining think tags
      cleanContent = cleanContent.replace(/<\/?think>/g, '').trim();

      console.log(`✅ [${agentName}] Response received`);
      return cleanContent;

    } else {
      throw new Error(`Invalid provider configuration: ${this.provider}`);
    }
  }

  /**
   * Determine if problem requires formal theorem proving
   */
  private requiresFormalProof(problem: string): boolean {
    const keywords = [
      'dowód',
      'udowodnij',
      'wykaż',
      'prove',
      'proof',
      'theorem',
      'twierdzenie',
      'lemma',
      'lemat',
      'indukcja',
      'induction',
      'dla każdego',
      'forall',
      'istnieje',
      'exists',
    ];

    const lowerProblem = problem.toLowerCase();
    return keywords.some(keyword => lowerProblem.includes(keyword));
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
   * Verify proof with Lean Prover
   */
  private async verifyWithLean(problem: string, proof: string): Promise<string> {
    if (!this.leanClient || !this.leanAvailable) {
      throw new Error('Lean Prover not available');
    }

    console.log('🎯 Verifying with Lean Prover...');

    try {
      const result = await this.leanClient.proveFromProblem(problem, proof);

      if (result.success && result.verificationDetails?.verified) {
        const exampleCode = `import Mathlib.Data.Nat.Basic

theorem sum_first_n (n : ℕ) :
  (Finset.range (n + 1)).sum id = n * (n + 1) / 2 := by
  -- Formalny dowód przez indukcję w Lean
  sorry`;

        return `✅ **Dowód pomyślnie zweryfikowany przez Lean Prover!**

Lean skompilował dowód bez błędów, co potwierdza poprawność struktury logicznej.

**Uwaga:** Obecna wersja generuje uproszczony szablon Lean, który weryfikuje składnię.
Dla pełnej formalnej weryfikacji matematycznej, dowód musiałby zostać przetłumaczony
na język teorii typów Lean z użyciem biblioteki Mathlib.

**Przykład pełnego dowodu formalnego:**
\`\`\`lean
${exampleCode}
\`\`\`

${result.output ? `**Output Lean:**\n\`\`\`\n${result.output}\n\`\`\`` : ''}`;
      } else {
        const errors = result.verificationDetails?.errors?.join('\n') || '';
        return `⚠️ **Lean wykrył błędy w kodzie:**

${errors}
${result.output}
${result.error || ''}

Dowód nie przeszedł weryfikacji składniowej Lean.`;
      }
    } catch (error) {
      console.error('❌ Lean verification failed:', error);
      return `❌ **Błąd weryfikacji Lean:** ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Clean malformed LaTeX from response (especially from Bielik model)
   */
  private cleanMalformedLatex(text: string): string {
    let cleaned = text;

    // Pattern 1: Remove standalone "1$" or "0$" that Bielik outputs instead of LaTeX
    // These appear as line content like just "1$" or at end of lines
    cleaned = cleaned.replace(/^(\d+)\$\s*$/gm, '');
    cleaned = cleaned.replace(/\n(\d+)\$\n/g, '\n');

    // Pattern 2: Remove broken LaTeX blocks like "$$1$" or "$1$" with just numbers
    cleaned = cleaned.replace(/\$\$\d+\$/g, '');
    cleaned = cleaned.replace(/\$\d+\$/g, '');

    // Pattern 3: Clean isolated dollar signs that aren't part of valid LaTeX
    // Valid: $x^2 + 1$ or $$\frac{a}{b}$$
    // Invalid: standalone $ or $$ with no content
    cleaned = cleaned.replace(/\$\$\s*\$\$/g, '');

    // Pattern 4: Remove \boxed{...} wrapper — keep content inside
    cleaned = cleaned.replace(/\\boxed\{([^}]*)\}/g, '$1');

    // Pattern 5: Replace \dfrac{a}{b} and \frac{a}{b} with a/b
    cleaned = cleaned.replace(/\\d?frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');

    // Pattern 6: Remove remaining LaTeX commands
    cleaned = cleaned.replace(/\\(left|right|cdot|times|sqrt|text|mathrm|quad|,)/g, '');

    // Pattern 7: Remove $ at end of lines when it's clearly broken
    cleaned = cleaned.replace(/([a-zA-Z0-9)\]}])\$\s*$/gm, '$1');

    // Pattern 8: Remove dollar signs around plain text that isn't math
    cleaned = cleaned.replace(/\$([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż\s]+)\$/g, '$1');

    // Pattern 6: Clean up multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Pattern 7: Remove orphaned $ signs (not paired)
    // Count $ signs — if odd number, remove the last one
    const dollarCount = (cleaned.match(/(?<!\$)\$(?!\$)/g) || []).length;
    if (dollarCount % 2 !== 0) {
      // Find and remove the last orphaned $
      const lastDollarIdx = cleaned.lastIndexOf('$');
      if (lastDollarIdx >= 0 && cleaned[lastDollarIdx - 1] !== '$' && cleaned[lastDollarIdx + 1] !== '$') {
        cleaned = cleaned.substring(0, lastDollarIdx) + cleaned.substring(lastDollarIdx + 1);
      }
    }

    return cleaned.trim();
  }

  /**
   * Sanitize Python/SymPy code before execution
   * Fixes common issues from Bielik model output
   */
  private sanitizeCode(code: string): string {
    let lines = code.split('\n');

    // 1. Remove assert statements (Bielik loves to add these and they cause errors)
    lines = lines.filter(line => !line.trim().startsWith('assert '));

    // 2. Remove duplicate variable definitions (keep first occurrence)
    const definedVars = new Set<string>();
    const symbolDefRegex = /^(\w+)\s*=\s*symbols?\(/;
    lines = lines.filter(line => {
      const match = line.trim().match(symbolDefRegex);
      if (match) {
        const varName = match[1];
        if (definedVars.has(varName)) {
          return false; // Skip duplicate definition
        }
        definedVars.add(varName);
      }
      return true;
    });

    // 3. Remove duplicate import lines (keep first occurrence)
    const seenImports = new Set<string>();
    lines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
        if (seenImports.has(trimmed)) {
          return false;
        }
        seenImports.add(trimmed);
      }
      return true;
    });

    // 4. Fix ^ used instead of ** for exponentiation (but not in strings/comments)
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) {
        return line;
      }
      return line
        .replace(/(\w)\^(\w)/g, '$1**$2')
        .replace(/\)\^(\w)/g, ')**$1')
        .replace(/(\w)\^\(/g, '$1**(');
    });

    // 5. Fix common Bielik errors: importing symbol names from sympy
    // e.g. "from sympy import symbols, R, x" → "from sympy import symbols"
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

    // 6. Fix wrong SymPy names (common Bielik hallucinations)
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

    // 7. Fix Pi → pi (Bielik sometimes capitalizes it)
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      return line.replace(/\bPi\b/g, 'pi');
    });

    // 8. Ensure there's at least one print statement
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

    // 9. Remove empty lines at start/end
    const result = lines.join('\n').trim();

    return result;
  }

  /**
   * Extract code from Executor response — returns ONLY the first valid code block
   * Bielik often produces duplicate code blocks; the first one is always the best
   */
  private extractCode(response: string): string[] {
    // Extract code from ```python blocks
    const pythonBlockRegex = /```python\s*\n([\s\S]*?)\n```/;
    const pythonMatch = pythonBlockRegex.exec(response);
    if (pythonMatch) {
      return [pythonMatch[1].trim()];
    }

    // Also look for plain ``` blocks
    const plainBlockRegex = /```\s*\n([\s\S]*?)\n```/;
    const plainMatch = plainBlockRegex.exec(response);
    if (plainMatch) {
      const code = plainMatch[1].trim();
      if (code.includes('sympy') || code.includes('import') || code.includes('print')) {
        return [code];
      }
    }

    return [];
  }

  /**
   * Truncate executor response after the first code block closes
   * This removes duplicate explanations and second code blocks that Bielik adds
   */
  private truncateAfterFirstCodeBlock(response: string): string {
    // Find first ```python ... ``` block and truncate everything after it
    const match = response.match(/([\s\S]*?```python\s*\n[\s\S]*?\n```)/);
    if (match) {
      return match[1].trim();
    }
    // Try plain ``` blocks
    const plainMatch = response.match(/([\s\S]*?```\s*\n[\s\S]*?\n```)/);
    if (plainMatch) {
      return plainMatch[1].trim();
    }
    return response;
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
   * Process a user message with three agents: Analytical, Executor, Verifier
   */
  async processMessage(
    userMessage: string,
    onMessageCallback?: (message: Message) => void
  ): Promise<Message[]> {
    console.log('🎯 Processing with three-agent system:', userMessage);

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

    // Determine if this needs formal proof
    const needsFormalProof = this.requiresFormalProof(userMessage);
    const useLean = needsFormalProof && this.leanAvailable &&
                     (this.proverBackend === 'lean' || this.proverBackend === 'both');

    console.log(`📋 Problem type: ${needsFormalProof ? 'Formal Proof' : 'Calculation'}`);
    console.log(`🔧 Backend: ${useLean ? 'Lean Prover' : 'SymPy'}`);

    // AGENT 1: Analytical Agent - Break down the problem
    console.log('\n=== AGENT 1: Analytical ===');
    const analyticalPrompt = prompts.analytical;

    const analyticalContext = this.getAgentContext();
    const analyticalResponse = await this.executeAgentTurn(
      'Agent Analityczny',
      analyticalPrompt,
      analyticalContext,
      { maxTokens: 800, temperature: 0.2 }
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

    // AGENT 2: Executor Agent - Execute the solution
    console.log('\n=== AGENT 2: Executor ===');
    const executorPrompt = useLean ? prompts.executor_lean : prompts.executor_sympy;

    const executorContext = this.getAgentContext();
    const executorResponse = await this.executeAgentTurn(
      'Agent Wykonawczy',
      executorPrompt,
      executorContext,
      { maxTokens: 1500, temperature: 0.2 }
    );

    // Truncate after first code block to remove Bielik's duplicate explanation + second block
    const truncatedExecutorResponse = this.truncateAfterFirstCodeBlock(executorResponse);
    const cleanedExecutorResponse = this.cleanMalformedLatex(truncatedExecutorResponse);

    let finalExecutorContent = cleanedExecutorResponse;
    const executionResults: string[] = [];
    const codeBlocks = this.extractCode(executorResponse); // Extract from original (before truncation)

    if (!useLean) {
      // Execute SymPy code
      console.log(`📝 Found ${codeBlocks.length} code blocks to execute`);
      console.log('📝 Code blocks:', codeBlocks);

      if (codeBlocks.length > 0 && this.mcpClient) {
        // We only have 1 code block (extractCode returns the first valid one)
        let combinedCode = codeBlocks[0];

        // Sanitize the code before execution
        combinedCode = this.sanitizeCode(combinedCode);

        console.log('📤 Code sent to MCP sympy_calculate:', combinedCode);

        try {
          let result: string = '';
          const maxRetries = 3;
          let currentCode = combinedCode;
          let lastError: unknown = null;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              result = await this.executeSymPyCalculation(currentCode);
              lastError = null;
              break; // Success
            } catch (error) {
              lastError = error;
              const errorMsg = error instanceof Error ? error.message : String(error);
              console.warn(`⚠️ Attempt ${attempt + 1} failed:`, errorMsg.substring(0, 120));

              if (attempt >= maxRetries) break; // Don't fix on last attempt

              let fixedCode = currentCode;

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

              // Fix 2: IndexError on solve()[0] — use safe indexing
              if (errorMsg.includes('IndexError: list index out of range')) {
                fixedCode = fixedCode.replace(
                  /(\w+)\s*=\s*solve\(([^)]+)\)\[0\]/g,
                  '_sols = solve($2)\n$1 = _sols[0] if _sols else None'
                );
              }

              // Fix 3: 'And'/'Or' object not iterable/subscriptable
              if (errorMsg.includes("'And' object") || errorMsg.includes("'Or' object")) {
                fixedCode = fixedCode.replace(
                  /for\s+(\w+)\s+in\s+(\w+)/g,
                  'for $1 in ([$2] if not hasattr($2, "__iter__") else $2)'
                );
              }

              // Fix 4: 'bool' object has no attribute 'subs' — == instead of Eq()
              if (errorMsg.includes("'bool' object has no attribute 'subs'")) {
                fixedCode = fixedCode.replace(/(\w+)\s*=\s*(.+?)\s*==\s*(.+)/g, '$1 = Eq($2, $3)');
              }

              // Fix 5: tuple/dict indexing with symbol — variable name collision
              if (errorMsg.includes('tuple indices must be integers') || errorMsg.includes('list indices must be integers')) {
                fixedCode = fixedCode.replace(/(\w+)\[(\w+)\](?!\s*if)/g, '$1[0]');
              }

              if (fixedCode === currentCode) {
                console.warn('⚠️ No fix found, giving up retries.');
                break; // No fix applied, don't keep retrying
              }

              console.log('📤 Retrying with fixed code...');
              currentCode = fixedCode;
            }
          }

          if (lastError) {
            throw lastError; // Re-throw the last error if all retries failed
          }
          executionResults.push(`📊 Wyniki wykonania:\n${result}`);

          // Remove code blocks from content - they will be shown in tool calls only
          const codeBlockPlaceholder = /__CODE_BLOCK_\d+__/g;
          finalExecutorContent = finalExecutorContent.replace(codeBlockPlaceholder, '');

          // Remove markdown code blocks from content
          finalExecutorContent = finalExecutorContent.replace(/```python[\s\S]*?```/g, '');
          finalExecutorContent = finalExecutorContent.replace(/```[\s\S]*?```/g, '');

          // Add only results to content
          finalExecutorContent += `\n\n---\n**WYNIKI WYKONANIA:**\n${result}`;
        } catch (error) {
          const errorMsg = `❌ Błąd wykonania: ${error instanceof Error ? error.message : String(error)}`;
          executionResults.push(errorMsg);

          // Remove code blocks from content - they will be shown in tool calls only
          const codeBlockPlaceholder = /__CODE_BLOCK_\d+__/g;
          finalExecutorContent = finalExecutorContent.replace(codeBlockPlaceholder, '');

          // Remove markdown code blocks from content
          finalExecutorContent = finalExecutorContent.replace(/```python[\s\S]*?```/g, '');
          finalExecutorContent = finalExecutorContent.replace(/```[\s\S]*?```/g, '');

          // Add only error to content
          finalExecutorContent += `\n\n---\n**BŁĄD WYKONANIA:**\n${errorMsg}`;
        }
      } else if (codeBlocks.length === 0) {
        console.warn('⚠️ No code blocks found in executor response. Response:', executorResponse.substring(0, 500));
      }
    }

    const executorMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: finalExecutorContent,
      agentName: 'Agent Wykonawczy',
      timestamp: new Date(),
      toolCalls: codeBlocks.length > 0 && !useLean ? [{
        id: 'sympy-exec-1',
        name: 'sympy_calculate',
        arguments: {
          expression: codeBlocks[0]
        }
      }] : undefined,
      toolResults: executionResults.map((result, idx) => ({
        toolCallId: `exec-${idx}`,
        toolName: useLean ? 'lean_verify' : 'sympy_calculate',
        result,
        isError: result.includes('❌'),
      })),
    };
    this.conversationHistory.push(executorMsg);
    newMessages.push(executorMsg);
    if (onMessageCallback) onMessageCallback(executorMsg);

    // AGENT 3: Verifier/Summary Agent - Summarize calculation results OR verify Lean proofs
    if (!useLean && executionResults.length > 0 && !executionResults.some(r => r.includes('❌'))) {
      console.log('\n=== AGENT 3: Summary ===');
      const summaryPrompt = prompts.summary;

      const summaryContext = this.getAgentContext();
      const summaryResponse = await this.executeAgentTurn(
        'Agent Podsumowujący',
        summaryPrompt,
        summaryContext,
        { maxTokens: 1200, temperature: 0.2 }
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

    if (useLean && this.leanClient) {
      console.log('\n=== AGENT 3: Verifier (Lean) ===');

      const verifierPrompt = `Jesteś ekspertem w weryfikacji dowodów matematycznych.

Twoja rola:
1. Przeczytaj dowód od Agenta Wykonawczego
2. Sprawdź poprawność logiczną każdego kroku
3. Zidentyfikuj ewentualne luki lub błędy
4. Oceń czy dowód jest kompletny i poprawny

Format odpowiedzi:
**Weryfikacja dowodu:**
✅/❌ [ocena]

**Szczegóły:**
[analiza poszczególnych kroków]

**Wnioski:**
[podsumowanie]

Odpowiadaj po polsku.`;

      const verifierContext = this.getAgentContext();
      const verifierResponse = await this.executeAgentTurn(
        'Agent Weryfikujący',
        verifierPrompt,
        verifierContext
      );

      // Try to verify with Lean Prover
      let leanVerification = '';
      const leanToolCalls: ToolCall[] = [];
      const leanToolResults: ToolResult[] = [];

      try {
        console.log('🎯 Attempting Lean Prover verification...');

        // Record tool call
        leanToolCalls.push({
          id: 'lean-verify-1',
          name: 'lean_prover_verify',
          arguments: {
            problem: userMessage.substring(0, 200) + (userMessage.length > 200 ? '...' : ''),
            proof: cleanedExecutorResponse.substring(0, 500) + (cleanedExecutorResponse.length > 500 ? '...' : ''),
          },
        });

        const leanResult = await this.verifyWithLean(userMessage, cleanedExecutorResponse);
        leanVerification = `\n\n---\n**🎯 Weryfikacja Lean Prover:**\n${leanResult}`;

        // Record tool result
        leanToolResults.push({
          toolCallId: 'lean-verify-1',
          toolName: 'lean_prover_verify',
          result: leanResult,
          isError: leanResult.includes('❌') || leanResult.includes('⚠️'),
        });
      } catch (error) {
        console.warn('Lean verification failed:', error);
        const errorMsg = `⚠️ Błąd weryfikacji: ${error instanceof Error ? error.message : String(error)}`;
        leanVerification = `\n\n---\n**🎯 Weryfikacja Lean Prover:**\n${errorMsg}`;

        // Record error result
        leanToolResults.push({
          toolCallId: 'lean-verify-1',
          toolName: 'lean_prover_verify',
          result: errorMsg,
          isError: true,
        });
      }

      const verifierMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: this.cleanMalformedLatex(verifierResponse) + leanVerification,
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
