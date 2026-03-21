import { LLMAgent, LLMProviderType } from './mlxAgent';
import { MCPClientBrowser as MCPClient, MCPTool } from './mcpClientBrowser';
import { LeanProverServiceBrowser } from './leanProverService.browser';
import { LeanProofSolver } from './leanProofSolver';
import { ProblemDecomposer } from './problemDecomposer';
import { RAGService } from './ragService';
import { classifyProblem, shouldUseFallback } from './classifierService';
import { routeAndSolveWithRetry } from './solverRouter';
import { ClassificationResult, SolverResult } from './classifierTypes';
import { runExtractionChain, runMultiStepChain, ChainResult } from './multiStepChain';
import { matchTemplate } from './extractionTemplates';
import prompts from '../../prompts.json';

export type LLMProvider = LLMProviderType;
export type ProverBackend = 'sympy' | 'lean' | 'both';

/**
 * Strip the "=== Uniwersytet ===" types and examples from classifier prompt.
 * Keeps matura-level types and examples, removes university section.
 */
function stripUniversitySection(prompt: string): string {
  // Remove the university types line from "Dostepne typy"
  let result = prompt.replace(/\n=== Uniwersytet ===\n[^\n]*\n/g, '\n');
  // Remove university examples block (from "=== PRZYKLADY UNIWERSYTECKIE ===" to "WAZNE REGULY")
  result = result.replace(/\n=== PRZYKLADY UNIWERSYTECKIE ===[\s\S]*?(?=\nWAZNE REGULY:)/g, '\n');
  return result;
}

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
  private llmAgent: LLMAgent;
  private mcpClient: MCPClient | null = null;
  private leanClient: LeanProverServiceBrowser | null = null;
  private conversationHistory: Message[] = [];
  private proverBackend: ProverBackend;
  private availableTools: MCPTool[] = [];
  private leanAvailable: boolean = false;
  private ragService: RAGService;
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

    // Initialize RAG service (port 3003)
    this.ragService = new RAGService();

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
    console.log(`🔧 classifierMode set to ${enabled}`);
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
   * Connect to Lean Prover backend (required — verification is mandatory)
   */
  async connectLean(proxyUrl: string = 'http://localhost:3002'): Promise<void> {
    if (this.proverBackend === 'sympy') {
      console.log('⏩ Skipping Lean connection (SymPy-only mode)');
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
    console.log('🎯 Lean Prover available (will be used for verification)');
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

    console.log(`🤖 [${agentName}] Calling LLM (maxTokens=${maxTokens}, temp=${temperature})...`);

    const content = await this.llmAgent.execute(systemPrompt, contextMessages, {
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

  // ═══════════════════════════════════════════════════════════════════
  // TEMPLATE SOLVER: Deterministic solvers for known problem patterns
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Try to solve the problem using a deterministic template (no LLM needed).
   * Returns { success, code, output, answer, template } or null if no template matches.
   */
  private async tryTemplateSolver(problemText: string): Promise<{
    success: boolean;
    code: string;
    output: string;
    answer: string;
    template: string;
  } | null> {
    // Pattern 1: Digit counting with odd/even constraints
    const digitParams = this.detectDigitCountingParams(problemText);
    if (digitParams) {
      const code = this.buildDigitCountingSolverCode(digitParams.nOdd, digitParams.nEven);
      return this.executeTemplateSolverCode(code, 'digit_counting');
    }

    // Pattern 2: Triangle optimization/computation (Heron-based, multiple sub-patterns)
    console.log('🔍 Template: checking triangle optimization...');
    const triParams = this.detectTriangleOptimizationParams(problemText);
    console.log('🔍 Template: triParams =', triParams ? JSON.stringify(triParams) : 'null');
    if (triParams) {
      const code = this.buildTriangleOptimizationCode(triParams);
      console.log('🔍 Template: code generated =', code ? `${code.length} chars` : 'null');
      if (code) {
        return this.executeTemplateSolverCode(code, `triangle_${triParams.subtype}`);
      }
    }

    // Pattern 3: Parametric quadratic equation with root relationship
    console.log('🔍 Template: checking parametric quadratic...');
    const quadParams = this.detectParametricQuadraticParams(problemText);
    console.log('🔍 Template: quadParams =', quadParams ? JSON.stringify(quadParams) : 'null');
    if (quadParams) {
      const code = this.buildParametricQuadraticCode(quadParams);
      if (code) {
        console.log('🔍 Template: parametric quadratic code generated =', code.length, 'chars');
        return this.executeTemplateSolverCode(code, `parametric_quadratic`);
      }
    }

    // Pattern 4: Regular tetrahedron + inscribed sphere + cross-section
    console.log('🔍 Template: checking tetrahedron sphere...');
    const tetraParams = this.detectTetrahedronSphereParams(problemText);
    console.log('🔍 Template: tetraParams =', tetraParams ? JSON.stringify(tetraParams) : 'null');
    if (tetraParams) {
      const code = this.buildTetrahedronSphereCode(tetraParams);
      if (code) {
        console.log('🔍 Template: tetrahedron sphere code generated =', code.length, 'chars');
        return this.executeTemplateSolverCode(code, `tetrahedron_sphere`);
      }
    }

    return null;
  }

  private async executeTemplateSolverCode(code: string, template: string): Promise<{
    success: boolean;
    code: string;
    output: string;
    answer: string;
    template: string;
  } | null> {
    try {
      const output = await this.executeSymPyCalculation(code);
      const answerMatch = output.match(/ODPOWIEDZ:\s*(.+)/);
      if (answerMatch) {
        return {
          success: true,
          code,
          output,
          answer: answerMatch[1].trim(),
          template,
        };
      }
    } catch (e) {
      console.error(`❌ Template solver (${template}) execution error:`, e);
      console.error(`❌ Error details:`, e instanceof Error ? e.message : String(e));
    }
    console.log(`🔍 Template solver (${template}): returning null (no ODPOWIEDZ found or error)`);
    return null;
  }

  private detectDigitCountingParams(text: string): { nOdd: number; nEven: number } | null {
    const lower = text.toLowerCase();
    if (!/cyfr|zapisie dziesi[eę]tnym|liczb\w* naturaln/.test(lower)) return null;

    const polishNumbers: Record<string, number> = {
      'jedno': 1, 'jeden': 1, 'jedna': 1,
      'dwie': 2, 'dwa': 2, 'dwóch': 2, 'dwu': 2,
      'trzy': 3, 'trzech': 3,
      'cztery': 4, 'czterech': 4,
      'pięć': 5, 'pięciu': 5,
    };
    const numPat = '(\\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)';

    const oddM = lower.match(new RegExp(`(?:dokładnie\\s+)?${numPat}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?nieparzyst`));
    const evenM = lower.match(new RegExp(`(?:dokładnie\\s+)?${numPat}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?parzyst`));
    if (!oddM || !evenM) return null;

    const nOdd = polishNumbers[oddM[1]] ?? parseInt(oddM[1]);
    const nEven = polishNumbers[evenM[1]] ?? parseInt(evenM[1]);
    if (isNaN(nOdd) || isNaN(nEven)) return null;
    if (nOdd < 1 || nOdd > 5 || nEven < 0 || nEven > 5) return null;

    const total = nOdd + nEven;
    if (total < 1 || total > 9) return null;
    return { nOdd, nEven };
  }

  private buildDigitCountingSolverCode(nOdd: number, nEven: number): string {
    const total = nOdd + nEven;
    const hasZero = nEven > 0;
    let lines = [
      'from sympy import *', '',
      `# Krok 1: Wybór ${nOdd} cyfr nieparzystych z 5 dostępnych (1,3,5,7,9)`,
      `wybor_nieparzystych = binomial(5, ${nOdd})`,
      `print("Wybór ${nOdd} nieparzystych z 5:", wybor_nieparzystych)`, '',
      `# Krok 2: Wybór ${nEven} cyfr parzystych z 5 dostępnych (0,2,4,6,8)`,
      `wybor_parzystych = binomial(5, ${nEven})`,
      `print("Wybór ${nEven} parzystych z 5:", wybor_parzystych)`, '',
      `# Krok 3: Permutacje ${total} wybranych cyfr`,
      `permutacje = factorial(${total})`,
      `print("Permutacje ${total} cyfr:", permutacje)`, '',
      `# Krok 4: Wszystkie liczby bez ograniczeń`,
      `wszystkie = wybor_nieparzystych * wybor_parzystych * permutacje`,
      `print("Wszystkie kombinacje:", wszystkie)`,
    ];
    if (hasZero && total > 1) {
      lines.push(
        '', `# Krok 5: Odejmij przypadki gdy 0 jest na pierwszej pozycji`,
        `# Jeśli 0 jest na początku: 0 jest JUŻ WYBRANE, zostaje binomial(4, ${nEven - 1}) parzystych`,
        `przypadki_z_zerem = wybor_nieparzystych * binomial(4, ${nEven - 1}) * factorial(${total - 1})`,
        `print("Przypadki z 0 na początku:", przypadki_z_zerem)`, '',
        `# Krok 6: Wynik końcowy`,
        `wynik = wszystkie - przypadki_z_zerem`,
      );
    } else {
      lines.push('', `wynik = wszystkie`);
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
  }

  /**
   * Normalize Unicode math symbols (𝑅→R, 𝑎→a, etc.) to plain ASCII for regex matching.
   */
  private normalizeUnicodeMath(text: string): string {
    // Replace Unicode Mathematical Italic/Bold/Script letters with ASCII
    return text.replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => {
      const code = ch.codePointAt(0)!;
      // Mathematical Bold A-Z: U+1D400–U+1D419
      if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(65 + code - 0x1D400);
      // Mathematical Bold a-z: U+1D41A–U+1D433
      if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(97 + code - 0x1D41A);
      // Mathematical Italic A-Z: U+1D434–U+1D44D
      if (code >= 0x1D434 && code <= 0x1D44D) return String.fromCharCode(65 + code - 0x1D434);
      // Mathematical Italic a-z: U+1D44E–U+1D467
      if (code >= 0x1D44E && code <= 0x1D467) return String.fromCharCode(97 + code - 0x1D44E);
      // Mathematical Bold Italic A-Z: U+1D468–U+1D481
      if (code >= 0x1D468 && code <= 0x1D481) return String.fromCharCode(65 + code - 0x1D468);
      // Mathematical Bold Italic a-z: U+1D482–U+1D49B
      if (code >= 0x1D482 && code <= 0x1D49B) return String.fromCharCode(97 + code - 0x1D482);
      // Mathematical digits 0-9 (Bold): U+1D7CE–U+1D7D7
      if (code >= 0x1D7CE && code <= 0x1D7D7) return String.fromCharCode(48 + code - 0x1D7CE);
      return ch;
    });
  }

  private detectTriangleOptimizationParams(text: string): {
    subtype: string;
    [key: string]: any;
  } | null {
    const lower = this.normalizeUnicodeMath(text).toLowerCase();
    const hasTriangle = /tr[oó]jk[aą]t/.test(lower);
    if (!hasTriangle) return null;

    const hasArea = /pol[eua]|area/.test(lower);
    const hasMaximize = /największ|maksymal|najwększ|możliwie największ|najmniejsz/.test(lower);
    const hasCircle = /okr[ęeą]g/.test(lower);
    const hasInscribed = /wpisan/.test(lower);
    const hasIsosceles = /równoramienn/.test(lower);
    const hasPerimeter = /obw[oó]d/.test(lower);

    // --- Sub-pattern C: Direct Heron (given 3 numeric sides) ---
    if (hasArea && !hasMaximize) {
      const sidesM = lower.match(
        /bok(?:ach|i|ów)?\s+(?:o\s+długości(?:ach)?\s+)?(?:\$?(\d+(?:[.,]\d+)?)\$?\s*[,;]\s*\$?(\d+(?:[.,]\d+)?)\$?\s*(?:[,;i]\s*(?:i\s+)?)\$?(\d+(?:[.,]\d+)?)\$?)/
      );
      if (sidesM) {
        const a = parseFloat(sidesM[1].replace(',', '.'));
        const b = parseFloat(sidesM[2].replace(',', '.'));
        const c = parseFloat(sidesM[3].replace(',', '.'));
        if (!isNaN(a) && !isNaN(b) && !isNaN(c) && a + b > c && b + c > a && a + c > b) {
          return { subtype: 'direct_heron', sides: [a, b, c] };
        }
      }
    }

    if (!hasArea) return null;

    // --- Extract perimeter ---
    let perimeterValue: number | null = null;
    let perimeterMult: number | null = null;
    const perimM = lower.match(/obw[oó]d\w*\s+(?:równ\w*\s+|=\s*)?(\d+)/);
    if (perimM) {
      const after = lower.substring(perimM.index! + perimM[0].length);
      if (/^[·*]?\s*r\b|^r\b/.test(after)) {
        perimeterMult = parseInt(perimM[1]);
      } else {
        perimeterValue = parseInt(perimM[1]);
      }
    }

    // --- Extract side ratio ---
    let sideRatio: number | null = null;
    const polishMults: Record<string, number> = {
      'dwukrotnie': 2, 'dwa razy': 2,
      'trzykrotnie': 3, 'trzy razy': 3,
      'czterokrotnie': 4, 'cztery razy': 4,
    };
    for (const [kw, mult] of Object.entries(polishMults)) {
      if (lower.includes(kw)) { sideRatio = mult; break; }
    }
    if (sideRatio === null) {
      const ratioM = lower.match(/(\d+)\s+raz[ey]\s+dłuż/);
      if (ratioM) sideRatio = parseInt(ratioM[1]);
    }

    // --- Sub-pattern A: Inscribed circle ---
    if (hasCircle && hasInscribed && perimeterMult && sideRatio) {
      return { subtype: 'inscribed_circle', perimeterMult, sideRatio, radiusSymbol: 'R', maximize: hasMaximize };
    }
    // --- Sub-pattern B: Isosceles + perimeter ---
    if (hasIsosceles && hasPerimeter && perimeterValue !== null && hasMaximize) {
      return { subtype: 'isosceles_perimeter', perimeter: perimeterValue, maximize: true };
    }
    // --- Sub-pattern D: Perimeter + ratio (no circle) ---
    if (hasPerimeter && sideRatio && perimeterValue !== null && hasMaximize) {
      return { subtype: 'perimeter_ratio', perimeter: perimeterValue, sideRatio, maximize: true };
    }

    return null;
  }

  private buildTriangleOptimizationCode(params: { subtype: string; [key: string]: any }): string | null {
    switch (params.subtype) {
      case 'direct_heron': return this.buildDirectHeronCode(params.sides);
      case 'inscribed_circle': return this.buildInscribedCircleCode(params);
      case 'isosceles_perimeter': return this.buildIsoscelesPerimeterCode(params);
      case 'perimeter_ratio': return this.buildPerimeterRatioCode(params);
      default: return null;
    }
  }

  private buildDirectHeronCode(sides: number[]): string {
    const [a, b, c] = sides;
    return `from sympy import *
a, b, c = Rational('${a}'), Rational('${b}'), Rational('${c}')
print(f"Boki: a={a}, b={b}, c={c}")
assert a+b>c and b+c>a and a+c>b, "Nierówność trójkąta!"
s = (a+b+c)/2
print(f"Półobwód: s={s}")
pole_sq = s*(s-a)*(s-b)*(s-c)
print(f"s(s-a)(s-b)(s-c) = {pole_sq}")
pole = simplify(sqrt(pole_sq))
print(f"Pole = {pole}")
print(f"ODPOWIEDZ: {pole}")
`;
  }

  private buildInscribedCircleCode(params: any): string {
    const k = params.perimeterMult;
    const n = params.sideRatio;
    const R = params.radiusSymbol;
    const n1 = n + 1;
    return `from sympy import *
import warnings
warnings.filterwarnings('ignore')
${R} = symbols('${R}', positive=True)
t = symbols('t', positive=True)
a_expr = ${n}*t*${R}
b_expr = t*${R}
c_expr = (${k}-${n1}*t)*${R}
print("Boki: ${n}t*${R}, t*${R}, (${k}-${n1}t)*${R}")
t_min = Rational(${k}, ${2*n1})
t_max = Rational(${k}, ${2*n})
print("Zakres t: (" + str(t_min) + ", " + str(t_max) + ")")
s = Rational(${k},2)*${R}
Area_sq = expand(s*(s-a_expr)*(s-b_expr)*(s-c_expr))
print("Pole^2 (Heron): " + str(factor(Area_sq)))
abc = a_expr*b_expr*c_expr
eq = simplify(expand(abc**2-16*${R}**2*Area_sq)/${R}**6)
print("Rownanie: " + str(Poly(eq,t).as_expr()) + " = 0")
solutions = solve(eq, t)
valid = []
for sol in solutions:
    try:
        val = sol.evalf()
        if hasattr(val, 'is_real') and val.is_real:
            tv = float(val)
        else:
            cv = complex(val)
            if abs(cv.imag)<1e-8:
                tv = cv.real
            else:
                continue
        if float(t_min)<tv<float(t_max):
            valid.append((tv,sol))
            print("  t=" + str(round(tv,6)) + " ok")
    except: pass
best_area,best_sides=None,None
for tv,ts in valid:
    av,bv,cv=${n}*tv,tv,${k}-${n1}*tv
    sv=${k}/2
    asq=sv*(sv-av)*(sv-bv)*(sv-cv)
    if asq>0:
        area=asq**0.5
        print("  t=" + str(round(tv,6)) + ": boki (" + str(round(av,4)) + "${R}," + str(round(bv,4)) + "${R}," + str(round(cv,4)) + "${R}), Pole=" + str(round(area,6)) + "${R}^2")
        if best_area is None or area>best_area:
            best_area,best_sides=area,(av,bv,cv)
if best_area:
    af,bf,cf=best_sides
    print("")
    print("Trojkat o najwiekszym polu: boki =(" + str(round(af,4)) + "," + str(round(bf,4)) + "," + str(round(cf,4)) + ")*${R}")
    print("Pole = " + str(round(best_area,6)) + "*${R}^2")
    print("ODPOWIEDZ: " + str(round(best_area,6)) + "*${R}^2")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
  }

  private buildIsoscelesPerimeterCode(params: any): string {
    const P = params.perimeter;
    return `from sympy import *
b = symbols('b', positive=True)
a_expr = ${P} - 2*b
print(f"Ramię: b, podstawa: a = ${P} - 2b")
print(f"Dziedzina: b ∈ (${P}/4, ${P}/2)")
h_sq = ${P}*b - Rational(${P**2}, 4)
P_area = Rational(1,2)*(${P}-2*b)*sqrt(h_sq)
P_sq = expand(Rational(1,4)*(${P}-2*b)**2*h_sq)
print(f"P²(b) = {P_sq}")
dP_sq = diff(P_sq, b)
print(f"d(P²)/db = {factor(dP_sq)}")
critical = solve(dP_sq, b)
print(f"Punkty krytyczne: b = {critical}")
best_area,best_b=None,None
for bc in critical:
    bv = float(bc)
    if ${P}/4 < bv < ${P}/2:
        av = float(P_area.subs(b, bc))
        if av > 0 and (best_area is None or av > best_area):
            best_area,best_b = av,bc
if best_b:
    a_val = ${P}-2*best_b
    area_exact = simplify(P_area.subs(b, best_b))
    print(f"Maksimum: b={best_b}, a={a_val}")
    print(f"Pole = {area_exact}")
    print(f"ODPOWIEDZ: {area_exact}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
  }

  private buildPerimeterRatioCode(params: any): string {
    const P = params.perimeter;
    const n = params.sideRatio;
    const n1 = n + 1;
    return `from sympy import *
t = symbols('t', positive=True)
a = ${n}*t
b = t
c = ${P}-${n1}*t
print(f"Boki: ${n}t, t, ${P}-${n1}t")
t_min = Rational(${P},${2*n1})
t_max = Rational(${P},${2*n})
print(f"Zakres: t ∈ ({t_min}, {t_max})")
s = Rational(${P},2)
Area_sq = expand(s*(s-a)*(s-b)*(s-c))
print(f"Pole²(t) = {factor(Area_sq)}")
dA_sq = diff(Area_sq, t)
print(f"d(Pole²)/dt = {factor(dA_sq)}")
critical = solve(dA_sq, t)
print(f"Punkty krytyczne: {critical}")
best_area,best_tc=None,None
for tc in critical:
    try:
        tv = float(tc)
        if float(t_min)<tv<float(t_max):
            asq = float(Area_sq.subs(t, tc))
            if asq>0:
                area=asq**0.5
                sides=(${n}*tv,tv,${P}-${n1}*tv)
                print("  t=" + str(round(tv,4)) + ": boki (" + str(round(sides[0],4)) + "," + str(round(sides[1],4)) + "," + str(round(sides[2],4)) + "), Pole=" + str(round(area,6)))
                if best_area is None or area>best_area:
                    best_area,best_tc=area,tc
    except: pass
if best_tc:
    area_exact = simplify(sqrt(Area_sq.subs(t, best_tc)))
    sides=(${n}*best_tc, best_tc, ${P}-${n1}*best_tc)
    print(f"\\nMaks pole: boki=({sides[0]},{sides[1]},{sides[2]})")
    print(f"Pole = {area_exact}")
    print(f"ODPOWIEDZ: {area_exact}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Pattern 3: Parametric quadratic equation with root relationship
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Convert math text from problem to valid SymPy expression.
   * Handles: implicit multiplication, ^→**, ²→**2, Unicode minus, etc.
   */
  private mathTextToSymPy(expr: string): string {
    let e = expr;
    // Unicode superscripts
    e = e.replace(/²/g, '**2').replace(/³/g, '**3');
    // ^ → **
    e = e.replace(/\^(\d+)/g, '**$1');
    // Unicode minus → -
    e = e.replace(/−/g, '-');
    // Middle dot → *
    e = e.replace(/·/g, '*');
    // Implicit multiplication: digit followed by letter (careful: not inside **)
    e = e.replace(/(\d)([a-zA-Z])/g, '$1*$2');
    // ) followed by letter or (
    e = e.replace(/\)([a-zA-Z(])/g, ')*$1');
    // letter followed by (
    e = e.replace(/([a-zA-Z])\(/g, '$1*(');
    // ) followed by digit
    e = e.replace(/\)(\d)/g, ')*$1');
    // )( → )*(
    e = e.replace(/\)\(/g, ')*(');
    // Clean up any spaces inside expressions
    e = e.replace(/\s+/g, ' ').trim();
    return e;
  }

  private detectParametricQuadraticParams(text: string): {
    eqExpr: string;
    paramName: string;
    varName: string;
    rootMult: number;
  } | null {
    const normalized = this.normalizeUnicodeMath(text);
    const lower = normalized.toLowerCase();

    // Must mention equation or roots
    if (!/równani|rownan|pierwiast|rozwiązan|rozwiazan/.test(lower)) return null;

    // Must have x² pattern
    if (!/x\s*[\^²]\s*2|x\s*\*\*\s*2/.test(lower)) return null;

    // Must mention two real roots/solutions
    if (!/dw[aoóu].*(?:rozwiązan|rozwiazan|pierwiast|rzeczywist)/.test(lower)) return null;

    // Detect parameter name: "parametru m" or "parametr m"
    const paramMatch = lower.match(/parametr\w*\s+([a-z])\b/);
    if (!paramMatch) return null;
    const paramName = paramMatch[1];

    // Detect root relationship: x1 = k*x2
    let rootMult: number | null = null;

    // Direct notation: x1 = 2x2, x1 = 2x^2 (^2 = subscript artifact), x₁ = 2x₂
    const relMatch = normalized.match(/x\s*[\^_]?\s*1\s*=\s*(\d+)\s*[·*]?\s*x/i);
    if (relMatch) {
      rootMult = parseInt(relMatch[1]);
    }

    // Polish: "dwukrotnie", "trzykrotnie"
    if (!rootMult) {
      const polishMults: Record<string, number> = {
        'dwukrotnie': 2, 'trzykrotnie': 3, 'czterokrotnie': 4,
      };
      for (const [kw, mult] of Object.entries(polishMults)) {
        if (lower.includes(kw)) { rootMult = mult; break; }
      }
    }

    if (!rootMult) return null;

    // Extract equation: find "expression_with_x² ... = 0"
    const eqMatch = normalized.match(/([^.;:!?]*x\s*[\^²]\s*2[^.;:!?]*?)\s*=\s*0/i);
    if (!eqMatch) return null;

    let eqText = eqMatch[1].trim();
    // Strip leading text before equation starts (find first digit, minus, or open paren)
    eqText = eqText.replace(/^.*?(?=[\d(]|−|-)/i, '');

    // Convert to SymPy
    const eqExpr = this.mathTextToSymPy(eqText);
    if (!eqExpr) return null;

    // Verify it contains both x and the parameter
    if (!eqExpr.includes('x') || !eqExpr.includes(paramName)) return null;

    return { eqExpr, paramName, varName: 'x', rootMult };
  }

  private buildParametricQuadraticCode(params: {
    eqExpr: string;
    paramName: string;
    varName: string;
    rootMult: number;
  }): string | null {
    const { eqExpr, paramName, varName, rootMult } = params;
    const k = rootMult;
    const k1 = k + 1;

    return `from sympy import *

${paramName} = symbols('${paramName}', real=True)
${varName} = symbols('${varName}', real=True)

# Krok 1: Rownanie kwadratowe
eq_expr = ${eqExpr}
print("Rownanie: " + str(expand(eq_expr)) + " = 0")

# Krok 2: Wspolczynniki a, b, c
a_coeff = eq_expr.coeff(${varName}, 2)
b_coeff = eq_expr.coeff(${varName}, 1)
c_coeff = eq_expr.coeff(${varName}, 0)
print("a = " + str(a_coeff) + ", b = " + str(b_coeff) + ", c = " + str(c_coeff))

# Krok 3: Wyroznik
delta = expand(b_coeff**2 - 4*a_coeff*c_coeff)
print("Delta = " + str(delta))

# Krok 4: Warunek na pierwiastki: ${varName}1 = ${k}*${varName}2
# Wzory Viete'a:
#   ${varName}1 + ${varName}2 = -b/a  =>  ${k1}*${varName}2 = -b/a
#   ${varName}1 * ${varName}2 = c/a   =>  ${k}*${varName}2^2 = c/a
print("")
print("Wzory Viete'a z warunkiem ${varName}1 = ${k}*${varName}2:")
${varName}2_expr = -b_coeff / (a_coeff * ${k1})
print("  ${varName}2 = -b/(a*${k1}) = " + str(simplify(${varName}2_expr)))

# Z iloczynu: ${k}*${varName}2^2 = c/a
vieta_eq = simplify(${k} * ${varName}2_expr**2 - c_coeff / a_coeff)
vieta_eq_poly = simplify(vieta_eq * a_coeff * ${k1}**2)
print("  Rownanie: " + str(expand(vieta_eq_poly)) + " = 0")

# Krok 5: Rozwiazanie wzgledem ${paramName}
${paramName}_solutions = solve(vieta_eq, ${paramName})
print("")
print("Rozwiazania ${paramName}: " + str(${paramName}_solutions))

# Krok 6: Sprawdzenie delta > 0 dla kazdego ${paramName}
valid_${paramName} = []
for ${paramName}_val in ${paramName}_solutions:
    d = delta.subs(${paramName}, ${paramName}_val)
    ${varName}2_val = ${varName}2_expr.subs(${paramName}, ${paramName}_val)
    ${varName}1_val = ${k} * ${varName}2_val
    if d > 0:
        valid_${paramName}.append(${paramName}_val)
        print("${paramName} = " + str(${paramName}_val) + ": delta = " + str(d) + " > 0")
        print("  ${varName}1 = " + str(${varName}1_val) + ", ${varName}2 = " + str(${varName}2_val))
    else:
        print("${paramName} = " + str(${paramName}_val) + ": delta = " + str(d) + " <= 0, odrzucamy")

if len(valid_${paramName}) == 1:
    print("ODPOWIEDZ: ${paramName} = " + str(valid_${paramName}[0]))
elif len(valid_${paramName}) > 1:
    print("ODPOWIEDZ: ${paramName} in " + str(set(valid_${paramName})))
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
  }

  // ─── Pattern 4: Regular Tetrahedron + Inscribed Sphere + Cross-Section ───

  private detectTetrahedronSphereParams(text: string): {
    edgeLength: number;
    volNum: number | null;
    volDen: number | null;
    hasPlane: boolean;
    findWhat: string;
  } | null {
    const normalized = this.normalizeUnicodeMath(text);
    const lower = normalized.toLowerCase();

    // Must mention tetrahedron (regular)
    if (!/czworo[sś]cian|tetraed/.test(lower)) return null;

    // Must be regular (equal edges or "foremny")
    if (!/kraw[eę]d[zź].*(?:równ|takiej samej|jednakow|d[lł]ugo[sś])|foremnr?y/.test(lower)
        && !/(?:równ|takiej samej|jednakow).*kraw[eę]d[zź]/.test(lower)
        && !/wszystkie\s+kraw/.test(lower)) return null;

    // Extract edge length
    let edge: number | null = null;
    const edgeMatch = normalized.match(/d[lł]ugo[sś][ctć]\w*\s+(\d+(?:[.,]\d+)?)/);
    if (edgeMatch) {
      edge = parseFloat(edgeMatch[1].replace(',', '.'));
    }
    if (!edge) {
      const edgeMatch2 = normalized.match(/kraw[eę]d[zź]\w*\s+.*?(\d+(?:[.,]\d+)?)/);
      if (edgeMatch2) edge = parseFloat(edgeMatch2[1].replace(',', '.'));
    }
    if (!edge || edge <= 0) return null;

    // Extract volume fraction (optional — not all problems have a cross-section)
    let volNum: number | null = null;
    let volDen: number | null = null;

    const fracMatch = normalized.match(/\\frac\{(\d+)\}\{(\d+)\}/);
    if (fracMatch) {
      volNum = parseInt(fracMatch[1]);
      volDen = parseInt(fracMatch[2]);
    }
    if (!volNum) {
      const plainFrac = lower.match(/(\d+)\s*[\/]\s*(\d+)/);
      if (plainFrac) {
        const n = parseInt(plainFrac[1]);
        const d = parseInt(plainFrac[2]);
        if (n > 0 && d > 0 && n < d) { volNum = n; volDen = d; }
      }
    }

    const hasPlane = /p[lł]aszczyzn|przekr[oó]j|dzieli|r[oó]wnole[gł]/.test(lower);
    const hasSphere = /kul[aeioy]|sfery|spher/.test(lower);

    // Determine what to find
    let findWhat = 'all'; // compute everything, let SymPy pick the answer

    if (hasPlane && hasSphere && /odleg[lł]o[sś][cć].*[sś]rodk/.test(lower)) {
      findWhat = 'distance_center_to_plane';
    } else if (hasPlane && hasSphere && /odleg[lł]o[sś]/.test(lower)) {
      findWhat = 'distance_center_to_plane';
    } else if (/promie[nń]\w*\s+kul\w*\s+wpisan/.test(lower) || /kul\w*\s+wpisan\w*.*promie/.test(lower)) {
      findWhat = 'inradius';
    } else if (/promie[nń]\w*\s+kul\w*\s+opisan/.test(lower) || /kul\w*\s+opisan\w*.*promie/.test(lower)) {
      findWhat = 'circumradius';
    } else if (/obj[eę]to[sś][cć]\w*\s+kul/.test(lower) || /kul\w*.*obj[eę]to[sś]/.test(lower)) {
      findWhat = 'sphere_volume';
    } else if (/pol[eua]\s+(?:powierzchni|czworo)/.test(lower)) {
      findWhat = 'surface_area';
    } else if (/pol[eua]\s+(?:pod|przek|tr[oó]jk)/.test(lower)) {
      findWhat = 'base_area';
    } else if (/wysoko[sś][cć]/.test(lower) && !hasPlane) {
      findWhat = 'height';
    } else if (/obj[eę]to[sś][cć]/.test(lower) && !hasPlane) {
      findWhat = 'volume';
    } else if (/obj[eę]to[sś][cć].*[sś]ci[eę]t/.test(lower) || /ostros[lł]up\w*\s+[sś]ci[eę]t/.test(lower)) {
      findWhat = 'frustum_volume';
    } else if (hasPlane && /pol[eua]\s+przek/.test(lower)) {
      findWhat = 'cross_section_area';
    } else if (hasSphere) {
      findWhat = 'all_sphere';
    }

    // Must have sphere OR some geometric question to be worth solving
    if (!hasSphere && findWhat === 'all') {
      // Basic tetrahedron question without sphere — still useful
      if (!/wysoko|obj[eę]to|pol[eua]|przek[aą]tn|promie/.test(lower)) return null;
    }

    console.log(`🔍 Tetrahedron: edge=${edge}, vol=${volNum}/${volDen}, plane=${hasPlane}, find=${findWhat}`);

    return { edgeLength: edge, volNum, volDen, hasPlane, findWhat };
  }

  private buildTetrahedronSphereCode(params: {
    edgeLength: number;
    volNum: number | null;
    volDen: number | null;
    hasPlane: boolean;
    findWhat: string;
  }): string | null {
    const { edgeLength, volNum, volDen, hasPlane, findWhat } = params;

    // Build cross-section block only if we have a plane with volume ratio
    const planeBlock = (hasPlane && volNum && volDen) ? `
# === Przekroj plaszczyzna rownoleglej do podstawy ===
vol_ratio = Rational(${volNum}, ${volDen})
print("Stosunek objetosci malego ostroslupa =", vol_ratio)
k_scale = cbrt(vol_ratio)
print("Wspolczynnik skali k =", simplify(k_scale))

# Maly ostroslup od wierzcholka: wysokosc = k*h
small_h = k_scale * h
plane_height = h - small_h
plane_height = simplify(plane_height)
print("Plaszczyzna pi na wysokosci", plane_height, "od podstawy")

# Krawedz przekroju
cross_edge = k_scale * a
cross_area = sqrt(3) / 4 * cross_edge**2
cross_area = simplify(cross_area)
print("Krawedz przekroju =", simplify(cross_edge))
print("Pole przekroju =", cross_area)

# Objetosc ostroslupa scietego = V_total - V_small
V_small = vol_ratio * V
V_frustum = V - V_small
print("Objetosc malego ostroslupa =", simplify(V_small))
print("Objetosc ostroslupa scietego =", simplify(V_frustum))

# Odleglosc srodka kuli wpisanej od plaszczyzny
dist_S_plane = Abs(r_in - plane_height)
dist_S_plane = simplify(dist_S_plane)
dist_S_plane = radsimp(dist_S_plane)
print("Odleglosc srodka kuli od plaszczyzny =", dist_S_plane)
` : '';

    // Build answer block based on findWhat
    let answerBlock: string;
    switch (findWhat) {
      case 'distance_center_to_plane':
        answerBlock = `answer = dist_S_plane`;
        break;
      case 'inradius':
        answerBlock = `answer = r_in`;
        break;
      case 'circumradius':
        answerBlock = `answer = R_out`;
        break;
      case 'sphere_volume':
        answerBlock = `answer = V_sphere_in`;
        break;
      case 'surface_area':
        answerBlock = `answer = S_total`;
        break;
      case 'base_area':
        answerBlock = `answer = S_face`;
        break;
      case 'height':
        answerBlock = `answer = h`;
        break;
      case 'volume':
        answerBlock = `answer = V`;
        break;
      case 'frustum_volume':
        answerBlock = `answer = V_frustum`;
        break;
      case 'cross_section_area':
        answerBlock = `answer = cross_area`;
        break;
      default:
        // For 'all' or 'all_sphere' — print everything, use last relevant
        if (hasPlane && volNum && volDen) {
          answerBlock = `answer = dist_S_plane`;
        } else {
          answerBlock = `answer = r_in`;
        }
        break;
    }

    return `from sympy import *

a = Integer(${edgeLength})
print("=== Czworoscian foremny, krawedz a =", a, "===")
print()

# === Podstawowe wielkosci ===
# Wysokosc
h = a * sqrt(6) / 3
print("Wysokosc h =", simplify(h))

# Pole jednej sciany (trojkat rownoboczny)
S_face = sqrt(3) / 4 * a**2
S_face = simplify(S_face)
print("Pole sciany =", S_face)

# Pole calkowite (4 sciany)
S_total = 4 * S_face
S_total = simplify(S_total)
print("Pole powierzchni calkowitej =", S_total)

# Objetosc
V = a**3 * sqrt(2) / 12
V = simplify(V)
print("Objetosc V =", V)

# === Kula wpisana ===
# r = a*sqrt(6)/12 = h/4
r_in = a * sqrt(6) / 12
r_in = simplify(r_in)
print()
print("Promien kuli wpisanej r =", r_in)
print("Srodek kuli na wysokosci r =", r_in, "od podstawy (= h/4)")

V_sphere_in = Rational(4, 3) * pi * r_in**3
V_sphere_in = simplify(V_sphere_in)
print("Objetosc kuli wpisanej =", V_sphere_in)

# === Kula opisana ===
# R = a*sqrt(6)/4 = 3r = 3h/4
R_out = a * sqrt(6) / 4
R_out = simplify(R_out)
print()
print("Promien kuli opisanej R =", R_out)

V_sphere_out = Rational(4, 3) * pi * R_out**3
V_sphere_out = simplify(V_sphere_out)
print("Objetosc kuli opisanej =", V_sphere_out)

# Stosunek R/r = 3
print("R/r =", simplify(R_out / r_in))
${planeBlock}
# === ODPOWIEDZ ===
print()
${answerBlock}
print("ODPOWIEDZ:", radsimp(simplify(answer)))
`;
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

    // 5a. Strip unavailable modules
    lines = lines.filter(line => {
      const t = line.trim();
      if (t.startsWith('import matplotlib') || t.startsWith('from matplotlib')) return false;
      if (t.startsWith('import scipy') || t.startsWith('from scipy')) return false;
      if (t.startsWith('import numpy') || t.startsWith('from numpy')) return false;
      if (t.startsWith('plt.')) return false;
      return true;
    });

    // 5b. Proactive fix: Piecewise chained comparisons → And()
    // Python disallows chained comparisons in Piecewise conditions: -6 <= x < 0 → And(-6 <= x, x < 0)
    lines = lines.map(line => {
      if (line.includes('Piecewise') || line.includes('piecewise')) {
        // Replace chained comparisons: NUM <= VAR < NUM → And(NUM <= VAR, VAR < NUM)
        line = line.replace(
          /(-?\d+\.?\d*)\s*(<=?)\s*(\w+)\s*(<|<=)\s*(-?\d+\.?\d*)/g,
          'And($1 $2 $3, $3 $4 $5)'
        );
        // Also handle: NUM < VAR <= NUM
        line = line.replace(
          /(-?\d+\.?\d*)\s*(<|<=)\s*(\w+)\s*(<=?)\s*(-?\d+\.?\d*)/g,
          'And($1 $2 $3, $3 $4 $5)'
        );
      }
      return line;
    });

    // 5c. Proactive fix: implicit multiplication (3BC → 3*BC, 3x → 3*x)
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      // Fix digit followed directly by uppercase letter (3BC → 3*BC, 4AB → 4*AB)
      line = line.replace(/(\d)([A-Z]{2,})/g, '$1*$2');
      // Fix digit followed by single lowercase letter that's likely a variable (3x → 3*x)
      // Only when NOT part of a longer identifier (3x but not 3x_val), and not hex like 0x
      line = line.replace(/(\d)([a-z])(?![a-zA-Z0-9_])/g, (match, digit, letter, offset, str) => {
        // Don't fix hex literals (0x...), or inside function names
        if (digit === '0' && letter === 'x') return match;
        // Don't fix if preceded by a letter (part of identifier like var3x)
        if (offset > 0 && /[a-zA-Z_]/.test(str[offset - 1])) return match;
        return digit + '*' + letter;
      });
      return line;
    });

    // 5d. Proactive fix: _N M log notation → log(M, N)
    // Model writes: a = _5 4 meaning log₅(4), or _12 80 meaning log₁₂(80)
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
      // Pattern: _NUMBER SPACE NUMBER (standalone or in assignment)
      line = line.replace(/\b_(\d+)\s+(\d+)\b/g, 'log($2, $1)');
      return line;
    });

    // 5e. Proactive fix: cos**2(x) → cos(x)**2, sin**2(x) → sin(x)**2, tan**2(x) → tan(x)**2
    // Model writes cos**2(x) thinking it means cos²(x), but Python sees int**2 then call
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      // Fix: cos**2(x) → cos(x)**2, handles any power and any trig function
      line = line.replace(/\b(sin|cos|tan|cot|sec|csc)\*\*(\d+)\(([^)]+)\)/g, '$1($3)**$2');
      return line;
    });

    // 5g. Proactive fix: solve(eq)**[0] → solve(eq)[0] (typo: ** before index)
    lines = lines.map(line => {
      // Fix )**[N] → )[N] — model writes **[ instead of just [
      line = line.replace(/\)\*\*\[(\d+)\]/g, ')[$1]');
      return line;
    });

    // 5f. Proactive fix: Polish text in code → remove or translate
    lines = lines.filter(line => {
      const trimmed = line.trim();
      // Remove lines starting with Polish keywords that are syntax errors
      if (/^(jeśli|jesli|więc|wiec|zatem|czyli|ponieważ|poniewaz)\s/i.test(trimmed)) return false;
      return true;
    });
    // Translate Polish for/in loops: "dla X w Y:" → "for X in Y:"
    lines = lines.map(line => {
      line = line.replace(/\bdla\s+(.+?)\s+w\s+(.+?):/g, 'for $1 in $2:');
      return line;
    });

    // 5h. Proactive fix: lambdify(..., 'numpy') → direct SymPy computation
    // numpy is not available; lambdify with 'numpy' fails. Replace with 'math' or remove lambdify.
    lines = lines.map(line => {
      // Replace lambdify(x, expr, 'numpy') → lambdify(x, expr, 'math')
      line = line.replace(/lambdify\(([^,]+),\s*([^,]+),\s*['"]numpy['"]\)/g, 'lambdify($1, $2, "math")');
      return line;
    });

    // 5i-pre. Proactive fix: Interval.open_left/open_right don't exist → Interval(a, b, left_open=True)
    lines = lines.map(line => {
      line = line.replace(/Interval\.open_left\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, left_open=True)');
      line = line.replace(/Interval\.open_right\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, right_open=True)');
      line = line.replace(/Interval\.open\(([^,]+),\s*([^)]+)\)/g, 'Interval.open($1, $2)');
      // Single-arg versions: Interval.open_left(a) → Interval(a, oo, left_open=True)
      line = line.replace(/Interval\.open_left\(([^)]+)\)/g, 'Interval($1, oo, left_open=True)');
      line = line.replace(/Interval\.open_right\(([^)]+)\)/g, 'Interval(-oo, $1, right_open=True)');
      return line;
    });

    // 5i. Proactive fix: format(sympy_expr, '.Nf') → format(float(sympy_expr), '.Nf')
    // SymPy Rational/Integer don't support format specifiers; wrap in float()
    lines = lines.map(line => {
      line = line.replace(/format\((\w+),\s*(['"][^'"]+['"])\)/g, 'format(float($1), $2)');
      return line;
    });

    // 6. Fix wrong SymPy names
    const importFixes: Record<string, string> = {
      'Simplify': 'simplify',
      'Greater': 'Gt',
      'Less': 'Lt',
      'GreaterEqual': 'Ge',
      'LessEqual': 'Le',
      'Power': 'Pow',
      'Discrimant': 'discriminant',
      'Discriminant': 'discriminant',
    };
    lines = lines.map(line => {
      for (const [wrong, correct] of Object.entries(importFixes)) {
        if (line.includes(wrong)) {
          line = line.replace(new RegExp(wrong, 'g'), correct);
        }
      }
      return line;
    });

    // 7. Fix Pi → pi, Infinity → oo, math.* → sympy
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      line = line.replace(/\bPi\b/g, 'pi');
      line = line.replace(/\bInfinity\b/g, 'oo');
      line = line.replace(/\bmath\.sqrt\b/g, 'sqrt');
      line = line.replace(/\bmath\.pi\b/g, 'pi');
      line = line.replace(/\bmath\.e\b/g, 'E');
      line = line.replace(/\bmath\.log\b/g, 'log');
      line = line.replace(/\bmath\.sin\b/g, 'sin');
      line = line.replace(/\bmath\.cos\b/g, 'cos');
      // S.Interval → Interval (S registry doesn't have Interval)
      line = line.replace(/\bS\.Interval\b/g, 'Interval');
      // S.Reals → Reals, S.Integers → Integers etc.
      line = line.replace(/\bS\.Reals\b/g, 'Reals');
      line = line.replace(/\bS\.Integers\b/g, 'Integers');
      return line;
    });

    // 7a0. Fix C(n, k) → binomial(n, k) to avoid SymPy Symbol conflict
    // Model writes C(n, k) thinking it's combinatorial, but SymPy C() is reserved
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
      // Replace C(expr, expr) → binomial(expr, expr) — only when C is standalone (not part of word)
      line = line.replace(/\bC\(([^,]+),\s*([^)]+)\)/g, 'binomial($1, $2)');
      return line;
    });

    // 7a. Fix .simplify() method → simplify() function call
    // Handles: expr.simplify(), (complex_expr).simplify(), wynik.simplify()
    lines = lines.map(line => {
      if (line.includes('.simplify()')) {
        const assignMatch = line.match(/^(\s*\w+\s*=\s*)(.+)\.simplify\(\)\s*$/);
        if (assignMatch) {
          // Assignment: var = EXPR.simplify() → var = simplify(EXPR)
          line = `${assignMatch[1]}simplify(${assignMatch[2]})`;
        } else {
          // Standalone or in-expression: var.simplify() → simplify(var)
          line = line.replace(/(\w+)\.simplify\(\)/g, 'simplify($1)');
          // Handle (...).simplify() → just keep the closing paren
          line = line.replace(/\)\.simplify\(\)/g, ')');
        }
      }
      return line;
    });

    // 7b. Fix .evalf() → N()
    lines = lines.map(line => {
      return line.replace(/(\w+)\.evalf\(\)/g, 'N($1)');
    });

    // 7c. Fix Interval.from_ends(a, b) → Interval(a, b)
    lines = lines.map(line => {
      return line.replace(/Interval\.from_ends\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2)');
    });

    // 7d. Fix float() wrapping symbolic expressions → float(N(expr))
    lines = lines.map(line => {
      if (line.includes('float(')) {
        // Replace float(wynik) → float(N(wynik))
        line = line.replace(/float\(wynik\)/g, 'float(N(wynik))');
        // Replace float(val) → float(N(val))
        line = line.replace(/float\(val\)/g, 'float(N(val))');
      }
      return line;
    });

    // 7e. Fix truth-value testing of symbolic comparisons → wrap in bool()
    lines = lines.map(line => {
      const trimmed = line.trim();
      // Pattern: if/elif/while <symbolic_expr> > 0 or <symbolic_expr> < 0
      if ((trimmed.startsWith('if ') || trimmed.startsWith('elif ') || trimmed.startsWith('while '))
          && /\.\w+\([^)]*\)\s*[<>]=?\s*\d/.test(trimmed)) {
        // Wrap the condition in bool()
        line = line.replace(/(if|elif|while)\s+(.+?):/g, '$1 bool($2):');
      }
      return line;
    });

    // 7f. Fix Eq() with single argument → Eq(expr, 0)
    // Check for Eq() with single arg (no top-level comma within parens)
    lines = lines.map(line => {
      if (line.includes('Eq(')) {
        const eqMatch = line.match(/\bEq\(/);
        if (eqMatch) {
          const start = eqMatch.index! + eqMatch[0].length;
          let depth = 1;
          let pos = start;
          let hasComma = false;

          while (pos < line.length && depth > 0) {
            if (line[pos] === '(') {
              depth++;
            } else if (line[pos] === ')') {
              depth--;
            } else if (line[pos] === ',' && depth === 1) {
              hasComma = true;
              break;
            }
            pos++;
          }

          if (!hasComma && depth === 0) {
            const inner = line.substring(start, pos - 1);
            line = line.substring(0, eqMatch.index!) + `Eq(${inner}, 0)` + line.substring(pos);
          }
        }
      }
      return line;
    });

    // 7f. Remove input() calls
    lines = lines.filter(line => !line.includes('input('));

    // 7c. Fix bare math expressions with = that should be Eq()
    // Only catches: `<math expr> = <value>` where LHS has math operators (+,-,*,/) but NO function calls
    // e.g. `a**2 + b**2 = 0` → `eq_expr = Eq(a**2 + b**2, 0)`
    // Skips: `n = symbols(...)`, `result = solve(...)`, keyword args, +=/-= operators, etc.
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
      if (trimmed.startsWith('if ') || trimmed.startsWith('elif ') || trimmed.startsWith('while ') || trimmed.startsWith('return ')) return line;
      if (trimmed.includes('==') || trimmed.includes('Eq(')) return line;
      // Skip augmented assignment operators: +=, -=, *=, /=, **=
      if (/[+\-*\/]=/.test(trimmed)) return line;
      // Skip for/in loops
      if (trimmed.startsWith('for ')) return line;
      // Skip any line with function calls — parens followed by content is almost always a call
      if (/\w+\(/.test(trimmed)) return line;
      // Match: <expr with math ops> = <value>
      // LHS must contain +, -, or ** (actual math, not just parens)
      const badEqMatch = trimmed.match(/^([^=]+[+\-]|[^=]+\*\*[^=]*)\s*=\s*(\S.*)$/);
      if (badEqMatch) {
        const lhs = badEqMatch[1].replace(/\s*=?\s*$/, '').trim();
        const rhs = badEqMatch[2].trim();
        // Extra safety: skip if RHS looks like a function call
        if (/^\w+\(/.test(rhs)) return line;
        const indent = line.match(/^(\s*)/)?.[1] || '';
        return `${indent}eq_expr = Eq(${lhs}, ${rhs})`;
      }
      return line;
    });

    // 7g. Strip non-ASCII / unicode characters from code (≠, ≥, ≤, →, etc.)
    // Model sometimes outputs Polish unicode or math symbols that cause SyntaxError
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return line; // allow unicode in comments
      // Replace common math unicode with Python equivalents
      line = line.replace(/≠/g, '!=');
      line = line.replace(/≥/g, '>=');
      line = line.replace(/≤/g, '<=');
      line = line.replace(/→/g, '');
      line = line.replace(/×/g, '*');
      line = line.replace(/÷/g, '/');
      line = line.replace(/·/g, '*');
      line = line.replace(/²/g, '**2');
      line = line.replace(/³/g, '**3');
      line = line.replace(/√/g, 'sqrt');
      line = line.replace(/π/g, 'pi');
      line = line.replace(/∞/g, 'oo');
      // Strip any remaining non-ASCII that would cause SyntaxError (except in strings)
      // Only strip if not inside quotes
      if (!trimmed.startsWith('"') && !trimmed.startsWith("'") && !trimmed.includes('print(')) {
        line = line.replace(/[^\x00-\x7F]/g, '');
      }
      return line;
    });

    // 7h. Fix Relational arithmetic: inequality = expr <= val; inequality = inequality - x
    // Relational objects (LessThan, GreaterThan, etc.) don't support arithmetic.
    // Rewrite: `ineq = lhs <= rhs; ineq = ineq - expr` → use solve() directly
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
      // Detect: variable = relational_variable OP expr (where OP is +,-,*,/)
      // This pattern is always wrong — you can't do arithmetic on a Relational
      // Fix by rewriting the comparison itself
      const relArithMatch = trimmed.match(/^(\w+)\s*=\s*(\w+)\s*([+\-*/])\s*(.+)$/);
      if (relArithMatch) {
        const [, lhs, rhs_var, , ] = relArithMatch;
        // Only fix if lhs == rhs_var (same variable, like: inequality = inequality - 3*x)
        if (lhs === rhs_var) {
          const indent = line.match(/^(\s*)/)?.[1] || '';
          return `${indent}# ${trimmed}  # REMOVED: cannot do arithmetic on Relational`;
        }
      }
      return line;
    });

    // 7i. Fix N(expr).round(n) → round(float(N(expr)), n) for symbolic expressions
    lines = lines.map(line => {
      // Pattern: N(expr).round(n) → round(float(N(expr)), n)
      line = line.replace(/N\(([^)]+)\)\.round\((\d+)\)/g, 'round(float(N($1)), $2)');
      // Pattern: expr.round(n) → round(float(N(expr)), n) when not on a plain number
      line = line.replace(/(\w+)\.round\((\d+)\)/g, (match, varName, digits) => {
        // Don't replace if it's a plain Python float/int method
        if (['result', 'wynik', 'answer', 'odpowiedz', 'T_new_rounded'].includes(varName)) {
          return `round(float(N(${varName})), ${digits})`;
        }
        return match;
      });
      return line;
    });

    // 8. Fix truncated code
    {
      const lastLine = lines[lines.length - 1]?.trim() || '';
      const codeStr = lines.join('\n');
      const openParens = (codeStr.match(/\(/g) || []).length;
      const closeParens = (codeStr.match(/\)/g) || []).length;

      const isTruncated = (
        lastLine.endsWith(',') || lastLine.endsWith('(') || lastLine.endsWith('+') ||
        lastLine.endsWith('*') || lastLine.endsWith('-') || lastLine.endsWith('=') ||
        lastLine.endsWith('.') || lastLine.endsWith('\\') ||
        (openParens > closeParens + 1)
      );

      if (isTruncated && lines.length > 3) {
        while (lines.length > 3) {
          const ll = lines[lines.length - 1].trim();
          if (ll.endsWith(',') || ll.endsWith('(') || ll.endsWith('+') ||
              ll.endsWith('*') || ll.endsWith('-') || ll.endsWith('=') ||
              ll.endsWith('.') || ll === '') {
            lines.pop();
          } else {
            break;
          }
        }
      }

      const finalCode = lines.join('\n');
      const op = (finalCode.match(/\(/g) || []).length;
      const cp = (finalCode.match(/\)/g) || []).length;
      const ob = (finalCode.match(/\[/g) || []).length;
      const cb = (finalCode.match(/\]/g) || []).length;

      if (op > cp) {
        lines[lines.length - 1] += ')'.repeat(op - cp);
      }
      if (ob > cb) {
        lines[lines.length - 1] += ']'.repeat(ob - cb);
      }
    }

    // 9. Ensure print statement exists
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

    // 10. Fix evaluate(expr, x=val) → expr.subs(x, val)
    // Bielik sometimes generates evaluate() which doesn't exist in SymPy
    lines = lines.map(line => {
      return line.replace(
        /evaluate\(([^,]+),\s*(\w+)\s*=\s*([^)]+)\)/g,
        '($1).subs($2, $3)'
      );
    });

    // 11. Safe solve()[index] guard — prevent IndexError on empty solution lists
    lines = lines.map(line => {
      const solveIndexMatch = line.match(/^(\s*)(\w+)\s*=\s*solve\(([^)]*)\)\[(\d+)\]/);
      if (solveIndexMatch) {
        const [, indent, varName, solveArgs, idx] = solveIndexMatch;
        return `${indent}_tmp_sol = solve(${solveArgs})\n${indent}${varName} = _tmp_sol[${idx}] if len(_tmp_sol) > ${idx} else None`;
      }
      return line;
    });

    // 12. Fix sympify([(a,b), ...]) → just [(a,b), ...]
    // SymPy's sympify doesn't handle list-of-tuples well
    lines = lines.map(line => {
      return line.replace(
        /sympify\(\[(\([^)]+\)(?:,\s*\([^)]+\))*)\]\)/g,
        '[$1]'
      );
    });

    // 13. Fix Symbol-not-callable: detect Symbol('f') then f(...) usage
    // Replace with Function('f') when the symbol is later called as a function
    {
      const symbolDefs = new Map<string, number>();
      lines.forEach((line, idx) => {
        const symMatch = line.match(/(\w+)\s*=\s*Symbol\s*\(\s*['"](\w+)['"]\s*\)/);
        if (symMatch) {
          symbolDefs.set(symMatch[1], idx);
        }
      });
      for (const [name, defIdx] of symbolDefs) {
        // Check if this symbol name is used as a function call later
        const isCalledAsFunction = lines.some((line, idx) =>
          idx > defIdx && new RegExp(`\\b${name}\\s*\\(`).test(line) && !line.trim().startsWith('#')
        );
        if (isCalledAsFunction) {
          lines[defIdx] = lines[defIdx].replace(
            /Symbol\s*\(\s*(['"])\w+\1\s*\)/,
            `Function('${name}')`
          );
          // Ensure Function is imported
          const hasImportFunction = lines.some(l => l.includes('Function') && (l.includes('from sympy') || l.includes('import')));
          if (!hasImportFunction) {
            const importIdx = lines.findIndex(l => l.trim().startsWith('from sympy'));
            if (importIdx >= 0) {
              lines[importIdx] = lines[importIdx].replace(
                /from sympy import (.+)/,
                'from sympy import $1, Function'
              );
            }
          }
        }
      }
    }

    // 14. Global try/except safety net — ensures code ALWAYS produces output
    // This MUST be the last transformation step
    {
      const codeStr = lines.join('\n');
      // Only wrap if the code doesn't already have a top-level try block
      if (!codeStr.match(/^try\s*:/m)) {
        const indentedLines = lines.map(line => line === '' ? '' : '    ' + line);
        const wrappedCode = [
          '_odpowiedz_printed = False',
          '_orig_print = print',
          'def _tracking_print(*args, **kwargs):',
          '    global _odpowiedz_printed',
          '    _orig_print(*args, **kwargs)',
          '    if args and str(args[0]).startswith("ODPOWIEDZ:"):',
          '        _odpowiedz_printed = True',
          'print = _tracking_print',
          'try:',
          ...indentedLines,
          'except Exception as _e:',
          '    print(f"Error: {str(_e)[:200]}")',
          'finally:',
          '    if not _odpowiedz_printed:',
          '        _local_vars = dict(locals())',
          '        for _v in ["wynik", "result", "odpowiedz", "answer", "rozwiazanie", "pole", "objetosc", "obwod"]:',
          '            if _v in _local_vars and _local_vars[_v] is not None:',
          '                _orig_print(f"ODPOWIEDZ: {_local_vars[_v]}")',
          '                break',
        ];
        lines = wrappedCode;
      }
    }

    return lines.join('\n').trim();
  }

  /**
   * Extract first valid code block from response (v3 — fenceless support)
   */
  private extractCode(response: string): string[] {
    // 1. Standard markdown fences
    const pythonMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response);
    if (pythonMatch) return [pythonMatch[1].trim()];

    const plainMatch = /```\s*\n([\s\S]*?)\n```/.exec(response);
    if (plainMatch) {
      const code = plainMatch[1].trim();
      if (code.includes('sympy') || code.includes('import') || code.includes('print')) {
        return [code];
      }
    }

    // 2. Fenceless extraction: find consecutive Python-like lines
    // (common with FP16 Bielik on remote APIs that ignore fence instructions)
    const lines = response.split('\n');
    const pyLines: string[] = [];
    let inBlock = false;

    for (const line of lines) {
      const stripped = line.trim();
      const isPy = (
        stripped.startsWith('from ') ||
        stripped.startsWith('import ') ||
        stripped.startsWith('print(') ||
        stripped.startsWith('#') ||
        /^[a-zA-Z_]\w*\s*=\s*/.test(stripped) ||
        /^(?:for |if |elif |else:|while |try:|except |def |return |with )/.test(stripped) ||
        /^(?:wynik|opcja_|result|answer)/.test(stripped) ||
        (stripped === '' && inBlock)
      );

      if (isPy) {
        pyLines.push(line);
        inBlock = true;
      } else if (inBlock && stripped === '') {
        pyLines.push(line); // allow one blank line
      } else {
        // End of block — if we have enough, stop
        const nonEmpty = pyLines.filter(l => l.trim()).length;
        if (nonEmpty >= 3) break;
        if (!inBlock) {
          pyLines.length = 0; // reset
        } else {
          break;
        }
      }
    }

    // Filter and validate
    const codeLines = pyLines.filter(l => l.trim());
    if (codeLines.length >= 3) {
      const hasImport = codeLines.some(l => l.includes('import') || l.includes('from '));
      const hasCompute = codeLines.some(l => /[=+\-*/()]/.test(l));
      if (hasImport || hasCompute) {
        let code = pyLines.join('\n').trim();
        // Remove trailing blank lines
        while (code.endsWith('\n')) {
          code = code.replace(/\n\s*$/, '');
        }
        return [code];
      }
    }

    return [];
  }

  /**
   * Generate fallback SymPy code from analytical response when executor fails to produce code.
   * Extracts mathematical expressions and equations from LaTeX/text and builds a simple script.
   */
  private generateFallbackCode(analyticalResponse: string, executorResponse: string, question: string): string | null {
    // Combine all text to mine for math expressions
    const allText = `${analyticalResponse}\n${executorResponse}\n${question}`;

    // Try to detect key math operations from analytical plan
    const lines: string[] = ['from sympy import *'];
    const symbols = new Set<string>();

    // Extract variable names from the text (x, y, a, b, n, m, k, t, r, p, q)
    const varMatches = allText.match(/\b([xyzabcnmktpqr])\b/g);
    if (varMatches) {
      for (const v of new Set(varMatches)) {
        if (!['i', 'e'].includes(v)) { // skip 'i' (imaginary) and 'e' (Euler)
          symbols.add(v);
        }
      }
    }

    if (symbols.size === 0) symbols.add('x');
    const symbolList = [...symbols];
    lines.push(`${symbolList.join(', ')} = symbols('${symbolList.join(' ')}', real=True)`);

    // Try to extract equations from LaTeX
    const equations: string[] = [];

    // Match LaTeX equations: \( ... \), $...$, or plain text equations with =
    const latexPatterns = [
      /\\\((.+?)\\\)/g,                    // \( ... \)
      /\$\$(.+?)\$\$/g,                    // $$ ... $$
      /\$(.+?)\$/g,                        // $ ... $
    ];

    for (const pattern of latexPatterns) {
      let m;
      while ((m = pattern.exec(allText)) !== null) {
        const expr = m[1].trim();
        // Only take equations (contain =) that aren't too long
        if (expr.includes('=') && expr.length < 200) {
          equations.push(expr);
        }
      }
    }

    // Convert basic LaTeX to SymPy
    const latexToSympy = (latex: string): string => {
      let s = latex;
      s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)');
      s = s.replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)');
      s = s.replace(/\\sqrt\[(\d+)\]\{([^}]+)\}/g, 'root($2, $1)');
      s = s.replace(/\\pi\b/g, 'pi');
      s = s.replace(/\\cdot/g, '*');
      s = s.replace(/\\times/g, '*');
      s = s.replace(/\\left\(/g, '(');
      s = s.replace(/\\right\)/g, ')');
      s = s.replace(/\\left\[/g, '[');
      s = s.replace(/\\right\]/g, ']');
      s = s.replace(/\^{(\d+)}/g, '**$1');
      s = s.replace(/\^(\d)/g, '**$1');
      s = s.replace(/\\log_\{?(\d+)\}?\s*/g, 'log($1, ');  // crude
      s = s.replace(/\\ln\b/g, 'log');
      s = s.replace(/\\sin\b/g, 'sin');
      s = s.replace(/\\cos\b/g, 'cos');
      s = s.replace(/\\tan\b/g, 'tan');
      s = s.replace(/\\infty/g, 'oo');
      s = s.replace(/\\le\b/g, '<=');
      s = s.replace(/\\ge\b/g, '>=');
      s = s.replace(/\\neq\b/g, '!=');
      s = s.replace(/\\[a-zA-Z]+/g, ''); // strip remaining LaTeX commands
      return s.trim();
    };

    // If we found equations, build a solve script
    if (equations.length > 0) {
      const eq = latexToSympy(equations[0]);
      const parts = eq.split('=').map(p => p.trim());
      if (parts.length === 2 && parts[0] && parts[1]) {
        lines.push(`eq = Eq(${parts[0]}, ${parts[1]})`);
        lines.push(`wynik = solve(eq, ${symbolList[0]})`);
        lines.push('print("ODPOWIEDZ:", wynik)');
        return lines.join('\n');
      }
    }

    // Try to detect key SymPy function from analytical response
    const sympyHint = analyticalResponse.match(/SymPy:\s*(.+)/i);
    if (sympyHint) {
      const hint = sympyHint[1].trim();
      // If it mentions specific functions, try to build code
      if (hint.includes('solve')) {
        lines.push(`# Based on analytical hint: ${hint}`);
        lines.push(`wynik = ${hint}`);
        lines.push('print("ODPOWIEDZ:", wynik)');
        return lines.join('\n');
      }
    }

    // Cannot generate meaningful fallback
    return null;
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
    if (!results.length) return '';

    const lines: string[] = [];

    // Only show methods (teaching value) — not dataset matches (no answer leaking)
    const methods = results.filter(r => r.source === 'methods' && r.score > 0.15);

    if (methods.length > 0) {
      lines.push('**Metoda rozwiązania:**');
      methods.slice(0, 2).forEach((m) => {
        lines.push(`• **${m.title}**`);
        if (m.tips) lines.push(`  💡 ${m.tips.substring(0, 120)}`);
      });
    }

    if (!lines.length) return '';
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

    // Fix 3: 'And'/'Or' object — not iterable or not subscriptable
    if (errorMsg.includes("'And' object") || errorMsg.includes("'Or' object")) {
      fixedCode = fixedCode.replace(
        /for\s+(\w+)\s+in\s+(\w+)/g,
        'for $1 in ([$2] if not hasattr($2, "__iter__") else $2)'
      );
      // Fix subscripting: solve()[0] when result is And/Or
      fixedCode = fixedCode.replace(
        /(\w+)\s*=\s*solve\(([^)]+)\)\[(\d+)\]/g,
        '_raw = solve($2)\n$1 = _raw.args[$3] if hasattr(_raw, "args") and not isinstance(_raw, list) else (_raw[$3] if isinstance(_raw, list) else _raw)'
      );
      if (errorMsg.includes('not subscriptable')) {
        fixedCode = fixedCode.replace(
          /(\w+)\[(\d+)\]/g,
          '($1.args[$2] if hasattr($1, "args") else $1[$2])'
        );
      }
    }

    // Fix 4: 'bool' object has no attribute 'subs'
    if (errorMsg.includes("'bool' object has no attribute 'subs'")) {
      fixedCode = fixedCode.replace(/(\w+)\s*=\s*(.+?)\s*==\s*(.+)/g, '$1 = Eq($2, $3)');
    }

    // Fix 5: tuple/dict indexing with symbol
    if (errorMsg.includes('tuple indices must be integers') || errorMsg.includes('list indices must be integers')) {
      fixedCode = fixedCode.replace(/(\w+)\[(\w+)\](?!\s*if)/g, '$1[0]');
    }

    // Fix 6: SyntaxError "cannot assign to expression" — bare `expr = value` should be Eq()
    if (errorMsg.includes('cannot assign to expression') || errorMsg.includes("Maybe you meant '=='")) {
      const lines = fixedCode.split('\n');
      fixedCode = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
        if (trimmed.includes('==') || trimmed.includes('Eq(')) return line;
        if (/\w+\(/.test(trimmed)) return line; // skip function calls
        const badEq = trimmed.match(/^([^=]+[+\-]|[^=]+\*\*[^=]*)\s*=\s*(\S.*)$/);
        if (badEq) {
          const lhs = badEq[1].replace(/\s*=?\s*$/, '').trim();
          const rhs = badEq[2].trim();
          if (/^\w+\(/.test(rhs)) return line;
          const indent = line.match(/^(\s*)/)?.[1] || '';
          return `${indent}eq_expr = Eq(${lhs}, ${rhs})`;
        }
        return line;
      }).join('\n');
    }

    // Fix 7: SympifyError / LaTeX in code
    if (errorMsg.includes('SympifyError') || errorMsg.includes('could not parse')) {
      fixedCode = fixedCode
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)')
        .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
        .replace(/\\pi\b/g, 'pi')
        .replace(/\\cdot/g, '*')
        .replace(/\\left\(/g, '(')
        .replace(/\\right\)/g, ')');
    }

    // Fix 8: TypeError — Symbol object cannot be interpreted as integer
    if (errorMsg.includes("'Symbol' object cannot be interpreted as an integer")) {
      fixedCode = fixedCode.replace(/range\((\w+)\)/g, 'range(int($1))');
    }

    // Fix 9: AttributeError — missing or wrong method names
    if (errorMsg.includes("has no attribute 'evalf'")) {
      fixedCode = fixedCode.replace(/(\w+)\.evalf\(\)/g, 'N($1)');
    }
    if (errorMsg.includes("has no attribute 'simplify'")) {
      fixedCode = fixedCode.replace(/(\w+)\.simplify\(\)/g, 'simplify($1)');
    }
    if (errorMsg.includes("'float' object has no attribute 'subs'") ||
        errorMsg.includes("'Float' object has no attribute 'subs'")) {
      fixedCode = fixedCode.replace(/(\w+)\s*=\s*float\(([^)]+)\)/g, '$1 = S($2)');
    }

    // Fix 9a: cannot import name — model hallucinated a SymPy name
    const importNameMatch = errorMsg.match(/cannot import name '(\w+)' from/);
    if (importNameMatch) {
      const badName = importNameMatch[1];
      const renames: Record<string, string> = {
        'Power': 'Pow', 'Logarithm': 'log', 'Sine': 'sin', 'Cosine': 'cos',
        'Tangent': 'tan', 'ArcSin': 'asin', 'ArcCos': 'acos', 'ArcTan': 'atan',
      };
      if (renames[badName]) {
        fixedCode = fixedCode.replace(new RegExp(`\\b${badName}\\b`, 'g'), renames[badName]);
      } else {
        // Remove bad import, ensure wildcard
        fixedCode = fixedCode.replace(new RegExp(`from sympy import.*\\b${badName}\\b,?\\s*`, 'g'), (match) => {
          const remaining = match.replace(badName, '').replace(/,\s*,/g, ',').replace(/import\s*,/, 'import ').replace(/,\s*$/, '');
          return remaining.includes('import ') ? remaining : '';
        });
        if (!fixedCode.includes('from sympy import *')) {
          fixedCode = 'from sympy import *\n' + fixedCode;
        }
      }
    }

    // Fix 10: ZeroDivisionError — replace /0 with /S(0)
    if (errorMsg.includes('ZeroDivisionError')) {
      fixedCode = fixedCode.replace(/\/\s*0\b/g, '/ S(0)');
    }

    // Fix 11: Interval.from_ends → Interval
    if (errorMsg.includes("has no attribute 'from_ends'")) {
      fixedCode = fixedCode.replace(/Interval\.from_ends\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2)');
    }

    // Fix 12: Cannot convert expression to float → wrap in N()
    if (errorMsg.includes('Cannot convert expression to float')) {
      fixedCode = fixedCode.replace(/float\((\w+)\)/g, 'float(N($1))');
    }

    // Fix 13: unsupported operand type for -: 'And'/'Or'/'Equality'/'Add'
    if (errorMsg.includes("unsupported operand type(s) for -:") &&
        (errorMsg.includes("'And'") || errorMsg.includes("'Or'") ||
         errorMsg.includes("'Equality'") || errorMsg.includes("'Add'"))) {
      fixedCode = fixedCode.replace(
        /if simplify\(wynik - val\) == 0:/g,
        'if str(wynik) == str(val) or (hasattr(wynik, "equals") and wynik.equals(val)):'
      );
      fixedCode = fixedCode.replace(
        /if simplify\(N\(wynik\) - N\(val\)\) == 0/g,
        'if str(N(wynik)) == str(N(val))'
      );
    }

    // Fix 14: cannot determine truth value of Relational → wrap in bool()
    if (errorMsg.includes('cannot determine truth value of Relational')) {
      fixedCode = fixedCode.replace(/if\s+(.+?)\s*([<>]=?)\s*(\d+)\s*:/g, 'if bool($1 $2 $3):');
    }

    // Fix 15: could not convert string to float → use N() wrapper
    if (errorMsg.includes('could not convert string to float')) {
      fixedCode = fixedCode.replace(/float\((\w+)\)/g, 'float(N($1))');
    }

    // Fix 16: object is not callable — 'Symbol', 'Add', 'Float', etc.
    if (errorMsg.includes('object is not callable')) {
      if (fixedCode.includes('combinations(') && !fixedCode.includes('from itertools')) {
        fixedCode = 'from itertools import combinations, permutations\n' + fixedCode;
      }
      if (fixedCode.includes('intersect(') || fixedCode.includes('.intersect(')) {
        fixedCode = fixedCode.replace(/intersect\(([^,]+),\s*([^)]+)\)/g, 'Intersection($1, $2)');
      }
      const symbolCallMatch = errorMsg.match(/(\w+)\(/);
      if (symbolCallMatch) {
        const funcName = symbolCallMatch[1];
        if (fixedCode.includes(`${funcName} = symbols`)) {
          fixedCode = fixedCode.replace(new RegExp(`^.*${funcName}\\s*=\\s*symbols.*$`, 'gm'), '');
        }
      }
    }

    // Fix 17: Any object not subscriptable
    if (errorMsg.includes('not subscriptable')) {
      fixedCode = fixedCode.replace(
        /(\w+)\s*=\s*solve\(([^)]+)\)\[(\d+)\]/g,
        '_sol = solve($2)\n$1 = _sol[$3] if isinstance(_sol, list) else _sol'
      );
      fixedCode = fixedCode.replace(
        /(\w+)\[(\d+)\]/g,
        '($1[$2] if isinstance($1, (list, tuple)) else $1)'
      );
    }

    // Fix 18: 'list' object has no attribute 'subs'
    if (errorMsg.includes("'list' object has no attribute 'subs'")) {
      fixedCode = fixedCode.replace(
        /(\w+)\.subs\(/g,
        '($1[0] if isinstance($1, list) else $1).subs('
      );
    }

    // Fix 19: div() used as division
    if (errorMsg.includes('ComputationFailed') && fixedCode.includes('div(')) {
      fixedCode = fixedCode.replace(/\bdiv\(([^,]+),\s*([^)]+)\)/g, 'Rational($1, $2)');
    }

    // Fix 20: unsupported operand with 'str' (MC comparing numeric with string options)
    if (errorMsg.includes("'str'") && errorMsg.includes('unsupported operand')) {
      fixedCode = fixedCode.replace(
        /abs\(float\(N\((\w+)\[?\d?\]?\)\) - float\(N\(val[^)]*\)\)\)/g,
        'abs(float(N($1[0] if isinstance($1, list) else $1)) - float(N(val))) if not isinstance(val, str) else float("inf")'
      );
      fixedCode = fixedCode.replace(
        /simplify\((\w+) - val\) == 0/g,
        '(str($1) == str(val) if isinstance(val, str) else simplify($1 - val) == 0)'
      );
    }

    // Fix 22a: cos**2(x) → cos(x)**2 — 'int' object is not callable
    if (errorMsg.includes("'int' object is not callable") || errorMsg.includes("'float' object is not callable")) {
      fixedCode = fixedCode.replace(/(sin|cos|tan|cot|sec|csc)\*\*(\d+)\(([^)]+)\)/g, '$1($3)**$2');
    }

    // Fix 22b: 'LessThan'/'GreaterThan' object is not iterable
    if (errorMsg.includes('is not iterable') &&
        (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan') ||
         errorMsg.includes('StrictLessThan') || errorMsg.includes('StrictGreaterThan'))) {
      fixedCode = fixedCode.replace(
        /for\s+(\w+)\s+in\s+(solutions?\w*|results?\w*|sols?\w*):/g,
        'for $1 in ([$2] if not isinstance($2, (list, tuple, set)) else $2):'
      );
      fixedCode = fixedCode.replace(
        /\(float\((\w+)\[0\]\),\s*float\((\w+)\[1\]\)\)/g,
        '(float($1.lhs if hasattr($1, "lhs") else $1[0]), float($1.rhs if hasattr($1, "rhs") else $1[1]))'
      );
    }

    // Fix 22c: Chained comparison in Piecewise: -6 <= x < 0 → And(-6 <= x, x < 0)
    if (errorMsg.includes('Piecewise') || errorMsg.includes('chained comparison') ||
        (errorMsg.includes('TypeError') && fixedCode.includes('Piecewise'))) {
      fixedCode = fixedCode.replace(
        /(-?\d+\.?\d*)\s*(<=?)\s*(\w+)\s*(<=?)\s*(-?\d+\.?\d*)/g,
        'And($1 $2 $3, $3 $4 $5)'
      );
    }

    // Fix 22d: 'And' object has no attribute 'lhs'/'rhs'
    if (errorMsg.includes("has no attribute 'lhs'") || errorMsg.includes("has no attribute 'rhs'")) {
      fixedCode = fixedCode.replace(
        /(\w+)\.lhs/g,
        '($1.args[0].lhs if hasattr($1, "args") and hasattr($1.args[0], "lhs") else $1.lhs if hasattr($1, "lhs") else $1)'
      );
      fixedCode = fixedCode.replace(
        /(\w+)\.rhs/g,
        '($1.args[0].rhs if hasattr($1, "args") and hasattr($1.args[0], "rhs") else $1.rhs if hasattr($1, "rhs") else $1)'
      );
    }

    // Fix 22e: .subs(x == value) → .subs(x, value)
    if (errorMsg.includes('not subscriptable') || errorMsg.includes('cannot determine truth') ||
        errorMsg.includes('new pairs or an iterable of (old, new) tuples') ||
        fixedCode.match(/\.subs\(\w+\s*==\s*[^,)]+\)/)) {
      fixedCode = fixedCode.replace(
        /\.subs\((\w+)\s*==\s*([^)]+)\)/g,
        '.subs($1, $2)'
      );
      // Also fix .subs({x: val}) when it fails — convert dict subs to chained .subs(x, val)
      // Fix .subs(Eq(x, val)) → .subs(x, val)
      fixedCode = fixedCode.replace(
        /\.subs\(Eq\((\w+),\s*([^)]+)\)\)/g,
        '.subs($1, $2)'
      );
    }

    // Fix 22f: No output — add print statement
    if (errorMsg.includes('produced no output') || errorMsg.includes('no output')) {
      if (!fixedCode.includes('print(')) {
        const lines = fixedCode.split('\n');
        const lastAssign = [...lines].reverse().find(l => /^\s*\w+\s*=/.test(l) && !l.includes('symbols('));
        if (lastAssign) {
          const varName = lastAssign.match(/^\s*(\w+)\s*=/)?.[1];
          if (varName) {
            fixedCode += `\nprint("ODPOWIEDZ:", ${varName})`;
          }
        } else {
          fixedCode += '\nprint("ODPOWIEDZ:", result if "result" in dir() else wynik if "wynik" in dir() else "BRAK")';
        }
      }
    }

    // Fix 22g: line() lowercase → Line() from geometry
    if (errorMsg.includes("'Symbol' object is not callable") && fixedCode.includes('line(')) {
      fixedCode = fixedCode.replace(/\bline\(/g, 'Line(');
      if (!fixedCode.includes('from sympy.geometry')) {
        fixedCode = 'from sympy.geometry import *\n' + fixedCode;
      }
    }

    // Fix 22h: KeyError on variable name or integer — solve() may return dict
    if (errorMsg.includes('KeyError:')) {
      const keyMatch = errorMsg.match(/KeyError:\s*(\w+)/);
      if (keyMatch) {
        const badKey = keyMatch[1];
        if (/^\d+$/.test(badKey)) {
          // KeyError: 0 — solve() returned dict, not list
          fixedCode = fixedCode.replace(
            /(\w+)\[0\]/g,
            '(list($1.values())[0] if isinstance($1, dict) else $1[0])'
          );
          fixedCode = fixedCode.replace(
            /(\w+)\[1\]/g,
            '(list($1.values())[1] if isinstance($1, dict) else $1[1])'
          );
        } else {
          fixedCode = fixedCode.replace(
            new RegExp(`(\\w+)\\[${badKey}\\]`, 'g'),
            `($1[Symbol('${badKey}')] if Symbol('${badKey}') in $1 else ($1[0] if isinstance($1, (list, tuple)) else $1))`
          );
        }
      }
    }

    // Fix 22i: 'tuple' object has no attribute 'subs'
    if (errorMsg.includes("'tuple' object has no attribute 'subs'")) {
      fixedCode = fixedCode.replace(
        /\(([^,]+),\s*([^)]+)\)\.subs\(/g,
        '$2.subs('
      );
    }

    // Fix 22j: 'Float' object is not subscriptable — solve() returned dict with scalar values
    // e.g. solution[a1] returns Float, then code tries solution[a1][0] or solution[a1][d]
    if (errorMsg.includes("'Float' object is not subscriptable") || errorMsg.includes("'Integer' object is not subscriptable") || errorMsg.includes("'Rational' object is not subscriptable")) {
      // Replace solution[var][anything] with solution[var] — double indexing on scalar
      fixedCode = fixedCode.replace(/(\w+\[\w+\])\[\w+\]/g, '$1');
      // Also replace result[0][0] patterns
      fixedCode = fixedCode.replace(/(\w+)\[0\]\[0\]/g, '$1[0]');
    }

    // Fix 22k: 'StrictLessThan'/'LessThan'/'GreaterThan' not subscriptable
    // solve() for inequalities returns Relational, not a list — only replace solve-result vars
    if (errorMsg.includes("object is not subscriptable") && (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan') || errorMsg.includes('StrictLessThan') || errorMsg.includes('StrictGreaterThan'))) {
      fixedCode = fixedCode.replace(/\b(solution|solutions|rozwiazanie|rozwiązanie|result|results|sol|wynik|answer|roots|rozwiazania|rozwiązania|rozwiązanie_uproszczone|uproszczone_rozwiązanie)\[0\]/g, '$1');
    }

    // Fix 22l: object of type 'StrictLessThan' has no len()
    if (errorMsg.includes("has no len()") && (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan'))) {
      // Replace len(solution) checks with hasattr or type checks
      fixedCode = fixedCode.replace(/if\s+len\((\w+)\)/g, 'if hasattr($1, "__iter__") and len(list($1.args))');
      // Replace len(result) == 1 patterns
      fixedCode = fixedCode.replace(/len\((\w+)\)\s*==\s*(\d+)/g, 'hasattr($1, "__iter__") and len(list($1.args)) == $2');
    }

    // Fix 22m: 'BooleanAtom not allowed in this context' or BooleanTrue/BooleanFalse
    // Happens when passing True/False equality result to N() or float()
    if (errorMsg.includes('BooleanAtom') || errorMsg.includes('BooleanTrue') || errorMsg.includes('BooleanFalse')) {
      // Replace N(val) where val might be boolean → check with bool() first
      fixedCode = fixedCode.replace(/float\(N\((\w+)\)\)/g, 'float($1) if not isinstance($1, (bool, BooleanTrue, BooleanFalse)) else (1.0 if $1 else 0.0)');
    }

    // Fix 22n: 'Symbol' object is not callable — model declares variable then calls it as function
    // Common case: distance = symbols('distance') then distance(A, B)
    // Also: model uses non-existent functions like Pochhammer
    if (errorMsg.includes("'Symbol' object is not callable")) {
      // Replace distance(A, B) with sqrt((A[0]-B[0])**2 + (A[1]-B[1])**2) for Point-like args
      fixedCode = fixedCode.replace(
        /\bdistance\(([^,]+),\s*([^)]+)\)/g,
        'sqrt(($1[0]-$2[0])**2 + ($1[1]-$2[1])**2)'
      );
      // Replace Pochhammer(base, arg) with log(arg, base) — model often confuses log notation
      fixedCode = fixedCode.replace(
        /\bPochhammer\((\d+),\s*(\d+)\)/g,
        'log($2, $1)'
      );
    }

    // Fix 22o: 'Add'/'Mul' object has no attribute 'zero'/'coeffs'
    // Model calls nonexistent methods on SymPy expressions
    if (errorMsg.includes("has no attribute 'zero'")) {
      fixedCode = fixedCode.replace(/\.zero\(\)/g, '');
    }
    if (errorMsg.includes("has no attribute 'coeffs'")) {
      fixedCode = fixedCode.replace(/\.coeffs\b/g, '.as_coefficients_dict()');
    }

    // Fix 22p: 'Piecewise'/'Function' object has no attribute 'range'/'zeros'/etc
    // .range() doesn't exist on Piecewise — remove the call, let LLM retry handle it
    if (errorMsg.includes("has no attribute 'range'")) {
      // Comment out the line with .range() so code continues
      fixedCode = fixedCode.replace(/^(.*\.range\(\).*)$/gm, '# $1  # .range() not available');
    }

    // Fix 22q: 'Symbol' object is not callable — f(x) where f is a symbol
    // Different from 22n: here model defines f = symbols('f') then uses f(x)
    if (errorMsg.includes("'Symbol' object is not callable") && fixedCode.includes("symbols('f')")) {
      // Replace f = symbols('f') ... f(expr) with Function('f') pattern
      fixedCode = fixedCode.replace(/(\w+)\s*=\s*symbols\('f'\)/, "f = Function('f')(x)");
    }

    // Fix 22r-pre: 'Or'/'And' object has no attribute 'intersection' — use Intersection() function
    if (errorMsg.includes("has no attribute 'intersection'")) {
      fixedCode = fixedCode.replace(
        /(\w+)\.intersection\((\w+)\)/g,
        'Intersection($1, $2)'
      );
    }

    // Fix 22r-pre2: cannot unpack non-iterable Integer/Float — solve() returned dict, not list of tuples
    if (errorMsg.includes('cannot unpack non-iterable') && (errorMsg.includes('Integer') || errorMsg.includes('Float') || errorMsg.includes('Rational'))) {
      // Pattern: a_value, d_value = solutions[0] where solutions is a dict
      fixedCode = fixedCode.replace(
        /(\w+),\s*(\w+)\s*=\s*(\w+)\[0\]/g,
        '_vals = list($3.values()) if isinstance($3, dict) else $3[0] if isinstance($3, list) else ($3,)\n$1, $2 = _vals[0], _vals[1] if len(_vals) > 1 else _vals[0]'
      );
    }

    // Fix 22r: 'NoneType' — solve() returned None, wrap solve() in safety
    if (errorMsg.includes("'NoneType'") && (errorMsg.includes('unsupported operand') || errorMsg.includes('not subscriptable') || errorMsg.includes('not iterable'))) {
      // Wrap solve() results with safety: if None → []
      fixedCode = fixedCode.replace(
        /(\w+)\s*=\s*solve\(([^)]+)\)(\[(\d+)\])?/g,
        (_match, varName, args, indexPart, idx) => {
          if (indexPart) {
            return `_tmp = solve(${args})\n${varName} = _tmp[${idx}] if _tmp else 0`;
          }
          return `${varName} = solve(${args}) or []`;
        }
      );
    }

    // Fix 22s: Interval.open_left/open_right don't exist
    if (errorMsg.includes("has no attribute 'open_left'") || errorMsg.includes("has no attribute 'open_right'")) {
      fixedCode = fixedCode.replace(/Interval\.open_left\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, left_open=True)');
      fixedCode = fixedCode.replace(/Interval\.open_right\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, right_open=True)');
      fixedCode = fixedCode.replace(/Interval\.open_left\(([^)]+)\)/g, 'Interval($1, oo, left_open=True)');
      fixedCode = fixedCode.replace(/Interval\.open_right\(([^)]+)\)/g, 'Interval(-oo, $1, right_open=True)');
    }

    // Fix 21: Equality.__new__() missing argument → Eq() needs 2 args
    if (errorMsg.includes("Equality.__new__() missing")) {
      // Find Eq(...) with only one arg (no comma at top level)
      const fixEqOneArg = (code: string): string => {
        let result = '';
        let i = 0;

        while (i < code.length) {
          if (code.substring(i, i + 3) === 'Eq(' && (i === 0 || !/\w/.test(code[i - 1]))) {
            // Find matching close paren
            let depth = 1;
            let j = i + 3;
            while (j < code.length && depth > 0) {
              if (code[j] === '(') {
                depth++;
              } else if (code[j] === ')') {
                depth--;
              }
              j++;
            }

            const inner = code.substring(i + 3, j - 1);

            // Check if there's a comma at top-level
            let d = 0;
            let hasComma = false;
            for (const ch of inner) {
              if (ch === '(') d++;
              else if (ch === ')') d--;
              else if (ch === ',' && d === 0) {
                hasComma = true;
                break;
              }
            }

            if (!hasComma) {
              result += `Eq(${inner}, 0)`;
            } else {
              result += code.substring(i, j);
            }
            i = j;
          } else {
            result += code[i];
            i++;
          }
        }

        return result;
      };

      fixedCode = fixEqOneArg(fixedCode);
    }

    // Fix 22t: "Relational cannot be used in Mul" — model multiplied/compared a Relational object
    // Common pattern: if simplify(delta.subs(m, sol)) > 0: — fails because subs() returns Relational
    // Or: condition_delta * something
    if (errorMsg.includes('Relational cannot be used in')) {
      // Fix: if expr > 0 → if (expr).is_positive or if bool(expr > 0)
      fixedCode = fixedCode.replace(
        /if\s+(simplify\([^)]+\))\s*([<>]=?)\s*(\d+):/g,
        'if bool($1 $2 $3):'
      );
      // General fix: wrap relational comparisons with symbolic expressions in bool()
      fixedCode = fixedCode.replace(
        /if\s+([^:]+?)\s*([<>]=?)\s*(\d+)\s*:/g,
        (match, expr, op, val) => {
          if (expr.includes('bool(')) return match; // already wrapped
          return `if bool(${expr} ${op} ${val}):`;
        }
      );
    }

    // Fix 22u: .subs(Eq(...)) or .subs(prosta) where prosta = Eq(y, expr) → .subs(y, expr)
    if (errorMsg.includes('old: new pairs') || errorMsg.includes('old, new') || errorMsg.includes('should be a dictionary')) {
      // Fix .subs(Eq(var, expr)) → .subs(var, expr)
      fixedCode = fixedCode.replace(
        /\.subs\(Eq\((\w+),\s*([^)]+)\)\)/g,
        '.subs($1, $2)'
      );
      // Fix .subs(variable_holding_Eq) → need to extract from Eq
      // Common pattern: prosta = Eq(y, x+1); expr.subs(prosta)
      // Replace: .subs(prosta) → .subs(y, prosta.rhs) if prosta is likely an Eq
      const eqVars: string[] = [];
      const lines = fixedCode.split('\n');
      for (const line of lines) {
        const m = line.match(/(\w+)\s*=\s*Eq\((\w+),/);
        if (m) eqVars.push(m[1]);
      }
      for (const eqVar of eqVars) {
        const re = new RegExp(`\\.subs\\(${eqVar}\\)`, 'g');
        fixedCode = fixedCode.replace(re, `.subs(${eqVar}.lhs, ${eqVar}.rhs)`);
      }
    }

    // Fix 22v: "Cannot round symbolic expression" — N(expr).round() on symbolic
    if (errorMsg.includes('Cannot round symbolic')) {
      fixedCode = fixedCode.replace(
        /N\(([^)]+)\)\.round\((\d+)\)/g,
        'round(float(N($1)), $2)'
      );
      // Also fix: expr.round(N) where expr is a variable
      fixedCode = fixedCode.replace(
        /(\w+)\.round\((\d+)\)/g,
        'round(float(N($1)), $2)'
      );
    }

    // Fix 22w: unsupported operand type for -/+/*: 'LessThan'/'GreaterThan'/etc and Mul/int
    // Pattern: inequality = x**2 - 4 <= 3*x; inequality = inequality - 3*x + 4
    if (errorMsg.includes('unsupported operand type') &&
        (errorMsg.includes("'LessThan'") || errorMsg.includes("'GreaterThan'") ||
         errorMsg.includes("'StrictLessThan'") || errorMsg.includes("'StrictGreaterThan'") ||
         errorMsg.includes("'NegativeOne'"))) {
      // Find lines doing arithmetic on a relational, comment them out
      const fixLines = fixedCode.split('\n');
      for (let i = 0; i < fixLines.length; i++) {
        const t = fixLines[i].trim();
        // Pattern: var = var OP expr (where var was previously a Relational)
        if (/^\w+\s*=\s*\w+\s*[+\-*/]\s*.+/.test(t)) {
          const m = t.match(/^(\w+)\s*=\s*(\w+)\s*[+\-*/]/);
          if (m && m[1] === m[2]) {
            fixLines[i] = `# ${t}  # SKIP: Relational arithmetic`;
          }
        }
      }
      fixedCode = fixLines.join('\n');
      // Also, if error involves NegativeOne and str, it's likely MC option comparison
      if (errorMsg.includes("'NegativeOne'") && errorMsg.includes("'str'")) {
        fixedCode = fixedCode.replace(
          /(\w+)\s*-\s*['"]([^'"]+)['"]/g,
          'str($1) == "$2"'
        );
      }
    }

    // Fix 22x: 'StrictLessThan'/'LessThan' object is not iterable
    // Pattern: for x in solve(inequality): where solve returned a Relational
    if (errorMsg.includes('not iterable') &&
        (errorMsg.includes("'StrictLessThan'") || errorMsg.includes("'LessThan'") ||
         errorMsg.includes("'GreaterThan'") || errorMsg.includes("'StrictGreaterThan'"))) {
      // Fix: solve(inequality) should use solveset or reduce_inequalities
      fixedCode = fixedCode.replace(
        /solve\(([^,)]+\s*[<>]=?\s*[^,)]+)\)/g,
        'solve($1)'
      );
      // Wrap in list() for iteration safety
      fixedCode = fixedCode.replace(
        /for\s+(\w+)\s+in\s+solve\(([^)]+)\):/g,
        '_sol = solve($2)\nfor $1 in (_sol if hasattr(_sol, "__iter__") else [_sol]):'
      );
    }

    // Fix 22y: SympifyError on list/tuple — solve() returned list, passed to sympify
    if (errorMsg.includes('SympifyError')) {
      // Often: Sympify of [(x, y)] — result of solve was a list of tuples
      fixedCode = fixedCode.replace(
        /sympify\((\w+)\)/g,
        '$1  # removed sympify() wrapper'
      );
    }

    return fixedCode;
  }

  /**
   * Execute SymPy code with auto-retry on failure
   */
  /**
   * Check if output looks like it contains an error rather than a real answer.
   */
  private isOutputSuspicious(stdout: string): string | null {
    const trimmed = stdout.trim();
    const errorPatterns = [
      /Traceback \(most recent/i,
      /Error:/i,
      /object is not (callable|subscriptable|iterable)/i,
      /cannot determine truth value/i,
      /unsupported operand type/i,
      /has no attribute/i,
      /invalid syntax/i,
      /not defined/i,
    ];
    for (const pat of errorPatterns) {
      if (pat.test(trimmed)) {
        return `Output contains error: ${trimmed.substring(0, 120)}`;
      }
    }
    if (/^(?:ODPOWIEDZ:\s*)?None\s*$/i.test(trimmed)) {
      return 'Output is None';
    }
    return null;
  }

  private async executeWithRetry(code: string, maxRetries: number = 3): Promise<string> {
    let currentCode = code;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeSymPyCalculation(currentCode);

        // Check if output looks like an error (code ran but produced error text)
        const suspicion = this.isOutputSuspicious(result);
        if (suspicion && attempt < maxRetries) {
          console.warn(`⚠️ Attempt ${attempt + 1}: ${suspicion}`);
          const fixedCode = this.tryFixCode(currentCode, result);
          if (fixedCode !== currentCode) {
            console.log('📤 Retrying with fix for suspicious output...');
            currentCode = fixedCode;
            continue;
          }
          // No fix — return as-is (might still be valid)
          return result;
        }

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

  // ═══════════════════════════════════════════════════════════════════
  // Input Guardrail — validates user input before processing
  // ═══════════════════════════════════════════════════════════════════

  private static readonly INPUT_MAX_LENGTH = 2000;
  private static readonly INPUT_MIN_LENGTH = 3;

  private static readonly PROMPT_INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
    /forget\s+(all\s+)?(your\s+)?(instructions?|prompts?|rules?)/i,
    /you\s+are\s+now\s+(a|an)\b/i,
    /zapomnij\s+(wszystkie\s+)?(instrukcje|polecenia|zasady)/i,
    /ignoruj\s+(wszystkie\s+)?(poprzednie\s+)?(instrukcje|polecenia|zasady)/i,
    /jestes\s+teraz\b/i,
    /system\s*prompt/i,
    /\bDAN\s*mode\b/i,
    /\bjailbreak\b/i,
    /act\s+as\s+(a\s+)?(?!math|calculator|tutor)/i,
    /pretend\s+(you\s+are|to\s+be)\b/i,
  ];

  private validateInputRules(message: string): { valid: boolean; reason?: string } {
    const trimmed = message.trim();

    if (trimmed.length < ThreeAgentOrchestrator.INPUT_MIN_LENGTH) {
      return { valid: false, reason: 'Wiadomość jest zbyt krótka. Wpisz treść zadania matematycznego.' };
    }

    if (trimmed.length > ThreeAgentOrchestrator.INPUT_MAX_LENGTH) {
      return { valid: false, reason: `Wiadomość jest zbyt długa (${trimmed.length} znaków, limit: ${ThreeAgentOrchestrator.INPUT_MAX_LENGTH}). Skróć treść zadania.` };
    }

    for (const pattern of ThreeAgentOrchestrator.PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { valid: false, reason: 'Jestem asystentem matematycznym. Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.' };
      }
    }

    return { valid: true };
  }

  private async validateInputLLM(message: string): Promise<{ valid: boolean; reason?: string }> {
    const guardrailPrompt = (prompts as any).guardrail;
    if (!guardrailPrompt) {
      return { valid: true }; // fail-open: no guardrail prompt configured
    }

    try {
      const agentConfig = (prompts as any).agents?.guardrail || {};
      const response = await this.llmAgent.execute(
        guardrailPrompt,
        [{ role: 'user', content: message }],
        {
          maxTokens: agentConfig.max_tokens || 50,
          temperature: agentConfig.temperature || 0.1,
        }
      );

      const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim().toUpperCase();
      if (cleaned.includes('NIE')) {
        return { valid: false, reason: 'To nie wygląda na zadanie matematyczne. Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.' };
      }

      return { valid: true }; // TAK or unrecognized → pass (fail-open)
    } catch (err) {
      console.warn('⚠️ Guardrail LLM check failed (fail-open):', err);
      return { valid: true }; // fail-open
    }
  }

  async validateInput(message: string): Promise<{ valid: boolean; reason?: string }> {
    // Layer 1: Rule-based checks (fast, no LLM)
    const rulesResult = this.validateInputRules(message);
    if (!rulesResult.valid) {
      console.log(`🛡️ Guardrail (rules): BLOCKED — ${rulesResult.reason}`);
      return rulesResult;
    }

    // Layer 2: LLM-based check (is this a math question?)
    const llmResult = await this.validateInputLLM(message);
    if (!llmResult.valid) {
      console.log(`🛡️ Guardrail (LLM): BLOCKED — ${llmResult.reason}`);
      return llmResult;
    }

    console.log('🛡️ Guardrail: PASSED');
    return { valid: true };
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
    console.log(`🎯 Processing with multi-agent system (classifierMode=${this.classifierMode}):`, userMessage);

    // === Parse #UNI=ON/OFF toggle ===
    const uniMatch = userMessage.match(/^#UNI\s*=\s*(ON|OFF)\b/im);
    const universityEnabled = uniMatch ? uniMatch[1].toUpperCase() === 'ON' : ((prompts as any).features?.university_level ?? true);
    // Strip the #UNI tag from the message so LLM doesn't see it
    if (uniMatch) {
      userMessage = userMessage.replace(/^#UNI\s*=\s*(ON|OFF)\s*/im, '').trim();
      console.log(`🎓 University mode: ${universityEnabled ? 'ON' : 'OFF'} (from #UNI tag)`);
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
    // Input Guardrail — validate before expensive pipeline steps
    // ═══════════════════════════════════════════════════════════════════
    const guardrailResult = await this.validateInput(userMessage);
    if (!guardrailResult.valid) {
      const blockedMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: guardrailResult.reason || 'Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.',
        agentName: '🛡️ Guardrail',
        timestamp: new Date(),
      };
      this.conversationHistory.push(blockedMsg);
      newMessages.push(blockedMsg);
      if (onMessageCallback) onMessageCallback(blockedMsg);
      return newMessages;
    }

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
    const problemCategories = this.ragService.detectCategories(userMessage);
    if (problemCategories.length > 0) {
      console.log(`🏷️ Detected problem categories: ${problemCategories.join(' + ')}`);
    }
    try {
      ragResults = await this.ragService.query(userMessage, 5);
      if (ragResults.length > 0) {
        ragContext = this.ragService.formatContextForAgent(ragResults, problemCategories.length > 0 ? problemCategories : null);
        console.log(`📚 RAG: ${ragResults.length} wyników znalezionych`);

        // Dodaj wiadomość RAG do konwersacji (wyświetlana użytkownikowi)
        const ragDisplayMsg = this.formatRAGForDisplay(ragResults);
        if (ragDisplayMsg) {
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
      }
    } catch (err) {
      console.warn('⚠️ RAG unavailable (continuing without):', err);
    }

    // If RAG returned nothing but we detected categories, still inject strategies
    if (!ragContext && problemCategories.length > 0) {
      ragContext = this.ragService.formatContextForAgent([], problemCategories);
      if (ragContext) {
        console.log(`📚 Injecting category strategies (no RAG results) for: ${problemCategories.join(' + ')}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEMPLATE SOLVER: Deterministic, no LLM needed (highest priority)
    // ═══════════════════════════════════════════════════════════════════
    if (this.mcpClient) {
      console.log('🔍 Checking template solver...');
      try {
        const templateResult = await this.tryTemplateSolver(userMessage);
        console.log('🔍 Template solver result:', templateResult ? `matched=${templateResult.template}, success=${templateResult.success}` : 'no match');
        if (templateResult && templateResult.success) {
          console.log(`✅ Template solver matched: ${templateResult.template}, answer: ${templateResult.answer}`);

        // Show template solver code & output
        const templateMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `**Metoda:** Template solver (${templateResult.template})\n\n\`\`\`python\n${templateResult.code}\n\`\`\`\n\n---\n**WYNIKI:**\n${templateResult.output}`,
          agentName: '🎯 Template Solver',
          timestamp: new Date(),
          toolCalls: [{
            id: 'template-exec-1',
            name: 'sympy_calculate',
            arguments: { expression: templateResult.code }
          }],
          toolResults: [{
            toolCallId: 'template-exec-1',
            toolName: 'sympy_calculate',
            result: templateResult.output,
            isError: false,
          }],
        };
        this.conversationHistory.push(templateMsg);
        newMessages.push(templateMsg);
        if (onMessageCallback) onMessageCallback(templateMsg);

        // Generate summary with Agent Podsumowujący
        try {
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
        } catch (err) {
          console.warn('⚠️ Summary generation failed:', err);
        }

        return newMessages;
      }
      } catch (templateErr) {
        console.error('❌ Template solver top-level error:', templateErr);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // LEAN PRIMARY SOLVER: Route proof tasks through Lean BEFORE three-agent
    // ═══════════════════════════════════════════════════════════════════
    const isProofProblem = this.couldBenefitFromVerification(userMessage);
    if (isProofProblem && this.leanAvailable && this.leanClient) {
      console.log('🎯 Proof problem detected — trying Lean primary solver...');

      try {
        const solver = new LeanProofSolver(this.leanClient, this.llmAgent);
        const proofResult = await solver.solveProof(userMessage, ragContext || undefined);

        if (proofResult.success) {
          console.log('✅ Lean proof successful!');

          const leanMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `**Dowód zweryfikowany przez Lean 4** (${proofResult.attempt})\n\n\`\`\`lean\n${proofResult.leanCode}\n\`\`\`\n\n${proofResult.output}`,
            agentName: '🎯 Lean Prover',
            timestamp: new Date(),
          };
          this.conversationHistory.push(leanMsg);
          newMessages.push(leanMsg);
          if (onMessageCallback) onMessageCallback(leanMsg);

          // Extract answer from Lean output or provide confirmation
          const answerMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `ODPOWIEDZ: Dowód przeprowadzony i zweryfikowany formalnie.`,
            agentName: '📊 Wynik',
            timestamp: new Date(),
          };
          this.conversationHistory.push(answerMsg);
          newMessages.push(answerMsg);
          if (onMessageCallback) onMessageCallback(answerMsg);

          return newMessages;
        } else {
          console.log('⚠️ Lean proof failed, falling through to three-agent pipeline...');
        }
      } catch (leanError) {
        console.warn('⚠️ Lean solver error (continuing to three-agent):', leanError);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CLASSIFIER MODE: Skip Agent 1+2, use deterministic solver instead
    // ═══════════════════════════════════════════════════════════════════
    console.log(`🔧 CLASSIFIER CHECK: classifierMode=${this.classifierMode}, mcpClient=${!!this.mcpClient}`);
    if (this.classifierMode && this.mcpClient) {
      console.log('\n=== CLASSIFIER MODE ===');

      try {
        // Step 1: Classify the problem
        const classifierPromptRaw = (prompts as any).classifier || '';
        const classifierPromptText = universityEnabled
          ? classifierPromptRaw
          : stripUniversitySection(classifierPromptRaw);
        const classification: ClassificationResult = await classifyProblem(
          userMessage,
          classifierPromptText,
          this.llmAgent,
          ragContext || undefined,
          { maxTokens: (prompts.agents as any).classifier?.max_tokens || 500, temperature: (prompts.agents as any).classifier?.temperature || 0.1, enableUniversity: universityEnabled }
        );

        console.log(`🏷️ Classification: type=${classification.type}, confidence=${classification.confidence}, MC=${classification.isMultipleChoice}`);

        console.log(`🔍 Klasyfikator: typ=${classification.type}, pewność=${(classification.confidence * 100).toFixed(0)}%`);

        // Step 2: Check if we should use fallback (old pipeline)
        if (!shouldUseFallback(classification)) {
          // Step 3: Route through deterministic solver
          const solverResult: SolverResult = await routeAndSolveWithRetry(
            classification,
            this.mcpClient,
            (code: string) => this.sanitizeCode(code),
            2
          );

          console.log(`📊 Solver result: success=${solverResult.success}, answer=${solverResult.answer}`);

          // ═══ VERIFY numeric answer with deterministic brute-force ═══
          if (solverResult.success && solverResult.answer) {
            const verified = await this.verifyNumericAnswer(userMessage, solverResult.answer);
            if (verified !== solverResult.answer) {
              solverResult.answer = verified;
              solverResult.output = (solverResult.output || '') + `\n\n🔍 Weryfikacja brute-force: ${verified}`;
            }
          }

          // Only show solver result to the user if it succeeded.
          // If it failed, try the extraction chain first — don't scare the user with errors.
          if (solverResult.success) {
            const solverContent = `\`\`\`python\n${solverResult.code}\n\`\`\`\n\n---\n**WYNIKI WYKONANIA:**\n${solverResult.output}`;

            const solverMsg: Message = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: solverContent,
              agentName: 'Agent Wykonawczy (deterministyczny)',
              timestamp: new Date(),
              toolCalls: [{
                id: 'classifier-exec-1',
                name: 'sympy_calculate',
                arguments: { expression: solverResult.code }
              }],
              toolResults: [{
                toolCallId: 'classifier-exec-1',
                toolName: 'sympy_calculate',
                result: solverResult.output || '',
                isError: false,
              }],
            };
            this.conversationHistory.push(solverMsg);
            newMessages.push(solverMsg);
            if (onMessageCallback) onMessageCallback(solverMsg);
          }

          // Step 4: Summary agent (same as old pipeline) — only if solver succeeded
          if (solverResult.success) {
            console.log('\n=== AGENT 3: Summary (classifier mode) ===');
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

            // Done — skip old pipeline
            return newMessages;
          }

          // Deterministic solver FAILED — try extraction chain before old pipeline
          console.log('⚠️ Deterministic solver failed, trying extraction chain...');
          if (this.mcpClient) {
            try {
              const chainResult: ChainResult = await runExtractionChain(
                userMessage,
                this.llmAgent,
                this.mcpClient,
                (code: string) => this.sanitizeCode(code),
                {
                  classifiedType: classification.type,
                  mcOptions: (classification.mcOptions as Record<string, string>) || undefined,
                  maxTokens: 400,
                }
              );

              if (chainResult.success && chainResult.answer) {
                const chainContent = `**Metoda:** ${chainResult.templateUsed || 'extraction'}\n\n\`\`\`python\n${chainResult.code}\n\`\`\`\n\n---\n**WYNIKI:**\n${chainResult.output}`;
                const chainMsg: Message = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: chainContent,
                  agentName: 'Agent Ekstrakcyjny (fallback)',
                  timestamp: new Date(),
                };
                this.conversationHistory.push(chainMsg);
                newMessages.push(chainMsg);
                if (onMessageCallback) onMessageCallback(chainMsg);

                // Summary agent for the extraction fallback
                console.log('\n=== AGENT 3: Summary (extraction fallback) ===');
                const fallbackSummaryContext = this.getAgentContext();
                const fallbackSummaryResponse = await this.executeAgentTurn(
                  'Agent Podsumowujący',
                  prompts.summary,
                  fallbackSummaryContext,
                  { maxTokens: prompts.agents.summary.max_tokens, temperature: prompts.agents.summary.temperature }
                );

                const fallbackSummaryMsg: Message = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: this.cleanMalformedLatex(fallbackSummaryResponse),
                  agentName: 'Agent Podsumowujący',
                  timestamp: new Date(),
                };
                this.conversationHistory.push(fallbackSummaryMsg);
                newMessages.push(fallbackSummaryMsg);
                if (onMessageCallback) onMessageCallback(fallbackSummaryMsg);

                return newMessages;
              }
            } catch { /* fall through */ }
          }

          // Both failed — fall through to old pipeline
          console.log('⚠️ Both classifier solver and extraction chain failed, using old pipeline');
        } else {
          console.log(`⚠️ Classifier confidence too low (${classification.confidence}) or proof type — falling back to extraction chain`);

          // ═══════════════════════════════════════════════════════════════
          // LEVEL 2+3: EXTRACTION CHAIN — try before old pipeline
          // Bielik extracts values, templates compute deterministically
          // ═══════════════════════════════════════════════════════════════
          if (this.mcpClient) {
            try {
              console.log('\n=== EXTRACTION CHAIN (Level 2+3) ===');
              const hasTemplate = matchTemplate(userMessage, classification.type);

              if (hasTemplate) {
                console.log(`📋 Template matched: ${hasTemplate.id}`);
              }

              const chainResult: ChainResult = hasTemplate
                ? await runExtractionChain(
                    userMessage,
                    this.llmAgent,
                    this.mcpClient,
                    (code: string) => this.sanitizeCode(code),
                    {
                      classifiedType: classification.type,
                      mcOptions: (classification.mcOptions as Record<string, string>) || undefined,
                      maxTokens: 400,
                    }
                  )
                : await runMultiStepChain(
                    userMessage,
                    this.llmAgent,
                    this.mcpClient,
                    (code: string) => this.sanitizeCode(code),
                    {
                      mcOptions: (classification.mcOptions as Record<string, string>) || undefined,
                      maxTokens: 500,
                    }
                  );

              console.log(`📊 Extraction chain: success=${chainResult.success}, template=${chainResult.templateUsed || 'multi-step'}, answer=${chainResult.answer}`);

              if (chainResult.success && chainResult.answer) {
                // ═══ VERIFY numeric answer ═══
                const verifiedChain = await this.verifyNumericAnswer(userMessage, chainResult.answer);
                if (verifiedChain !== chainResult.answer) {
                  chainResult.answer = verifiedChain;
                  chainResult.output = (chainResult.output || '') + `\n\n🔍 Weryfikacja brute-force: ${verifiedChain}`;
                }

                // Show extraction chain result
                const chainContent = `**Metoda:** ${chainResult.templateUsed || 'multi-step extraction'}\n\n\`\`\`python\n${chainResult.code}\n\`\`\`\n\n---\n**WYNIKI:**\n${chainResult.output}`;

                const chainMsg: Message = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: chainContent,
                  agentName: 'Agent Ekstrakcyjny',
                  timestamp: new Date(),
                  toolCalls: [{
                    id: 'extraction-exec-1',
                    name: 'sympy_calculate',
                    arguments: { expression: chainResult.code || '' }
                  }],
                  toolResults: [{
                    toolCallId: 'extraction-exec-1',
                    toolName: 'sympy_calculate',
                    result: chainResult.output || '',
                    isError: false,
                  }],
                };
                this.conversationHistory.push(chainMsg);
                newMessages.push(chainMsg);
                if (onMessageCallback) onMessageCallback(chainMsg);

                // Summary agent
                console.log('\n=== AGENT 3: Summary (extraction chain) ===');
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

                return newMessages;
              } else {
                console.log('⚠️ Extraction chain failed, falling back to old pipeline');
              }
            } catch (chainError) {
              console.warn('⚠️ Extraction chain error, falling back to old pipeline:', chainError);
            }
          }
        }
      } catch (classifierError) {
        console.warn('⚠️ Classifier failed, falling back to old pipeline:', classifierError);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ALSO TRY EXTRACTION CHAIN even when classifier mode is off
    // (for non-classifier deployments)
    // Skip if classifier path already produced extraction results
    // ═══════════════════════════════════════════════════════════════════
    const alreadyHasExtraction = newMessages.some(m => m.agentName?.includes('Ekstrakcyjny'));
    if (!alreadyHasExtraction && this.mcpClient && matchTemplate(userMessage)) {
      try {
        console.log('\n=== EXTRACTION CHAIN (no classifier) ===');
        const chainResult: ChainResult = await runExtractionChain(
          userMessage,
          this.llmAgent,
          this.mcpClient,
          (code: string) => this.sanitizeCode(code),
          { maxTokens: 400 }
        );

        if (chainResult.success && chainResult.answer) {
          // ═══ VERIFY numeric answer ═══
          const verifiedNC = await this.verifyNumericAnswer(userMessage, chainResult.answer);
          if (verifiedNC !== chainResult.answer) {
            chainResult.answer = verifiedNC;
            chainResult.output = (chainResult.output || '') + `\n\n🔍 Weryfikacja brute-force: ${verifiedNC}`;
          }

          const chainContent = `**Metoda:** ${chainResult.templateUsed || 'extraction'}\n\n\`\`\`python\n${chainResult.code}\n\`\`\`\n\n---\n**WYNIKI:**\n${chainResult.output}`;

          const chainMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: chainContent,
            agentName: 'Agent Ekstrakcyjny',
            timestamp: new Date(),
          };
          this.conversationHistory.push(chainMsg);
          newMessages.push(chainMsg);
          if (onMessageCallback) onMessageCallback(chainMsg);

          // Summary
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

          return newMessages;
        }
      } catch { /* fall through to old pipeline */ }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DECOMPOSITION: Divide & Conquer — break complex problem into solvable parts
    // ═══════════════════════════════════════════════════════════════════
    if (this.mcpClient) {
      console.log('\n=== DIVIDE & CONQUER: Decomposing problem ===');

      try {
        const classifierPromptRaw2 = (prompts as any).classifier || '';
        const classifierPromptText = universityEnabled
          ? classifierPromptRaw2
          : stripUniversitySection(classifierPromptRaw2);
        const decomposer = new ProblemDecomposer(
          this.llmAgent,
          this.mcpClient,
          (code: string) => this.sanitizeCode(code),
          classifierPromptText,
        );

        // Show decomposition start to user
        const decompStartMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '🔪 Rozbijam zadanie na prostsze pod-zadania...',
          agentName: '🔪 Dekompozycja',
          timestamp: new Date(),
        };
        this.conversationHistory.push(decompStartMsg);
        newMessages.push(decompStartMsg);
        if (onMessageCallback) onMessageCallback(decompStartMsg);

        const decompResult = await decomposer.decompose(
          userMessage,
          ragContext || undefined,
          (step, total, result) => {
            // Callback for each solved sub-task
            const stepStatus = result.success ? '✅' : '❌';
            const stepMsg: Message = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `${stepStatus} Krok ${step}/${total}: ${result.answer || result.error || 'brak wyniku'} [${result.pipeline || '?'}]`,
              agentName: '🔪 Dekompozycja',
              timestamp: new Date(),
            };
            this.conversationHistory.push(stepMsg);
            newMessages.push(stepMsg);
            if (onMessageCallback) onMessageCallback(stepMsg);
          },
        );

        if (decompResult.success && decompResult.finalAnswer) {
          console.log(`✅ Decomposition succeeded: ${decompResult.stepsCompleted}/${decompResult.totalSteps} steps, answer: ${decompResult.finalAnswer}`);

          // Show final decomposition result
          const stepsDetail = decompResult.subResults
            .map((r, i) => {
              const task = decompResult.subTasks[i];
              const status = r.success ? '✅' : '❌';
              return `${status} ${task?.description?.substring(0, 60) || `Krok ${r.subTaskId}`}: **${r.answer || r.error || '?'}**`;
            })
            .join('\n');

          const decompResultMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `**Rozwiązanie metodą dekompozycji** (${decompResult.stepsCompleted}/${decompResult.totalSteps} kroków):\n\n${stepsDetail}\n\nODPOWIEDZ: ${decompResult.finalAnswer}`,
            agentName: '📊 Wynik (Dekompozycja)',
            timestamp: new Date(),
          };
          this.conversationHistory.push(decompResultMsg);
          newMessages.push(decompResultMsg);
          if (onMessageCallback) onMessageCallback(decompResultMsg);

          return newMessages;
        } else {
          console.log(`⚠️ Decomposition failed (${decompResult.stepsCompleted}/${decompResult.totalSteps}), falling through to Agent pipeline...`);
        }
      } catch (decompError) {
        console.warn('⚠️ Decomposition error, falling through to Agent pipeline:', decompError);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // AGENT 1: Analytical — plan the solution (legacy fallback)
    // ═══════════════════════════════════════════════════════════════════
    console.log(`⚠️ FALLING THROUGH TO 3-AGENT PIPELINE (classifierMode=${this.classifierMode}, mcpClient=${!!this.mcpClient})`);
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
    let executorPrompt = isMultipleChoice && (prompts as any).executor_sympy_mc
      ? (prompts as any).executor_sympy_mc
      : prompts.executor_sympy;

    // Add strict instruction to start with code immediately
    executorPrompt = `WAZNE: Jestes kompilatorem. Twoja odpowiedz to WYLACZNIE blok kodu Python.\nNIE pisz tekstu. NIE pisz wyjasnien. NIE uzywaj LaTeX.\nOdpowiedz MUSI zaczynac sie od \`\`\`python i konczyc na \`\`\`.\n\n${executorPrompt}`;

    // Inject SymPy hints from RAG into executor prompt
    {
      const sympyHints = this.ragService.formatSymPyHints(ragResults, problemCategories.length > 0 ? problemCategories : null);
      if (sympyHints) {
        executorPrompt = `${executorPrompt}\n${sympyHints}`;
        console.log('📚 RAG SymPy hints injected into executor prompt');
      }
    }

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
    let codeBlocks = this.extractCode(executorResponse);

    console.log(`📝 Found ${codeBlocks.length} code blocks to execute`);

    // ── No-code retry: if executor produced no code, re-prompt with stricter instruction ──
    if (codeBlocks.length === 0 && this.mcpClient) {
      console.warn('⚠️ No code in executor response — retrying with stricter prompt...');

      const retryCodePrompt = `ODPOWIEDZ TYLKO KODEM PYTHON. Zadanie:\n${userMessage}\n\nPlan:\n${analyticalResponse}\n\n\`\`\`python\nfrom sympy import *\n`;

      try {
        const retryExecResponse = await this.executeAgentTurn(
          'Agent Wykonawczy (code-retry)',
          retryCodePrompt,
          [{ role: 'user', content: userMessage }],
          { maxTokens: prompts.agents.executor.max_tokens, temperature: 0.1 }
        );

        const retryBlocks = this.extractCode(retryExecResponse);
        if (retryBlocks.length > 0) {
          codeBlocks = retryBlocks;
          console.log('✅ Code retry succeeded — got code on 2nd attempt');
          const retryTruncated = this.truncateAfterFirstCodeBlock(retryExecResponse);
          finalExecutorContent = this.cleanMalformedLatex(retryTruncated);
        } else {
          console.warn('⚠️ Code retry also produced no code — trying fallback generation...');

          // Last resort: generate simple code from analytical response + question
          const fallbackCode = this.generateFallbackCode(analyticalResponse, executorResponse, userMessage);
          if (fallbackCode) {
            codeBlocks = [fallbackCode];
            console.log('🔧 Fallback code generated from analytical response');
          }
        }
      } catch (retryErr) {
        console.warn('⚠️ Code retry failed:', retryErr);

        // Still try fallback
        const fallbackCode = this.generateFallbackCode(analyticalResponse, executorResponse, userMessage);
        if (fallbackCode) {
          codeBlocks = [fallbackCode];
          console.log('🔧 Fallback code generated from analytical response');
        }
      }
    }

    // ── Aggressive LLM retry loop: keep calling Bielik until SymPy succeeds ──
    const MAX_LLM_RETRIES = 3; // up to 3 full LLM re-generations on failure
    if (codeBlocks.length > 0 && this.mcpClient) {
      let currentCode = codeBlocks[0];
      let executionSuccess = false;
      let lastErrorMsg = '';

      for (let llmAttempt = 0; llmAttempt <= MAX_LLM_RETRIES; llmAttempt++) {
        const sanitizedCode = this.sanitizeCode(currentCode);
        console.log(`📤 [Attempt ${llmAttempt + 1}/${MAX_LLM_RETRIES + 1}] Code sent to MCP sympy_calculate:`, sanitizedCode.substring(0, 120));

        try {
          const result = await this.executeWithRetry(sanitizedCode);

          // Check if result looks like an error that leaked through
          const suspicion = this.isOutputSuspicious(result);
          if (suspicion && llmAttempt < MAX_LLM_RETRIES) {
            console.warn(`⚠️ Attempt ${llmAttempt + 1}: Suspicious output — ${suspicion}`);
            lastErrorMsg = suspicion;
            // Fall through to LLM re-generation below
          } else {
            // Success (or last attempt — accept what we have)
            executionResults.push(`📊 Wyniki wykonania:\n${result}`);
            finalExecutorContent = finalExecutorContent.replace(/```python[\s\S]*?```/g, '');
            finalExecutorContent = finalExecutorContent.replace(/```[\s\S]*?```/g, '');
            const retryLabel = llmAttempt > 0 ? ` (LLM retry #${llmAttempt})` : '';
            finalExecutorContent += `\n\n---\n**WYNIKI WYKONANIA${retryLabel}:**\n${result}`;
            executionSuccess = true;
            if (llmAttempt > 0) console.log(`✅ LLM retry #${llmAttempt} succeeded!`);
            break;
          }
        } catch (error) {
          lastErrorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`⚠️ Attempt ${llmAttempt + 1} failed:`, lastErrorMsg.substring(0, 120));
        }

        // ── Re-generate code via LLM ──
        if (llmAttempt < MAX_LLM_RETRIES) {
          try {
            const shortError = lastErrorMsg.replace(/^.*?Error:\s*/i, '').substring(0, 150);
            const failedCode = currentCode.substring(0, 600);

            // Alternate between fix-retry (attempt 1) and fresh generation (attempt 2+)
            let retryPrompt: string;
            if (llmAttempt === 0) {
              // First retry: ask to fix the specific error
              retryPrompt = `Ten kod Python ZWROCIL BLAD. Napraw go i zwroc TYLKO poprawiony kod.\n\nBLAD: ${shortError}\n\nKOD Z BLEDEM:\n\`\`\`python\n${failedCode}\n\`\`\`\n\nZwroc TYLKO poprawiony kod w bloku \`\`\`python. ZERO tekstu poza kodem.`;
            } else {
              // Subsequent retries: generate fresh code from scratch with the problem description
              retryPrompt = `Napisz od nowa kod SymPy rozwiazujacy to zadanie. Poprzednie proby nie dzialaly.\n\nZADANIE: ${userMessage}\n\nPLAN ROZWIAZANIA:\n${analyticalResponse.substring(0, 300)}\n\nOSTATNI BLAD: ${shortError}\n\nNapisz PROSTY, DZIALAJACY kod. Unikaj zlozonych konstrukcji.\n\`\`\`python\nfrom sympy import *\n`;
            }

            // Add RAG hints
            if (ragResults.length > 0) {
              const retryHint = this.ragService.formatRetryHint(ragResults);
              if (retryHint) retryPrompt += `\n${retryHint}`;
            }

            console.log(`🔄 LLM retry #${llmAttempt + 1}: re-calling Executor${llmAttempt === 0 ? ' (fix mode)' : ' (fresh generation)'}`);

            const retryResponse = await this.executeAgentTurn(
              `Agent Wykonawczy (retry-${llmAttempt + 1})`,
              retryPrompt,
              [{ role: 'user', content: userMessage }],
              { maxTokens: prompts.agents.executor.max_tokens, temperature: 0.1 + llmAttempt * 0.05 }
            );

            const retryCodeBlocks = this.extractCode(retryResponse);
            if (retryCodeBlocks.length > 0) {
              currentCode = retryCodeBlocks[0];
              console.log(`📝 Got new code from LLM retry #${llmAttempt + 1}`);
              // Update displayed content
              const retryTruncated = this.truncateAfterFirstCodeBlock(retryResponse);
              finalExecutorContent = this.cleanMalformedLatex(retryTruncated);
            } else {
              console.warn(`⚠️ LLM retry #${llmAttempt + 1} produced no code — trying fallback generation...`);
              const fallbackCode = this.generateFallbackCode(analyticalResponse, '', userMessage);
              if (fallbackCode) {
                currentCode = fallbackCode;
                console.log('🔧 Using fallback-generated code');
              } else {
                // No code at all — break out
                break;
              }
            }
          } catch (retryError) {
            console.warn(`⚠️ LLM retry #${llmAttempt + 1} call failed:`, retryError);
            break;
          }
        }
      }

      if (!executionSuccess) {
        const errorMsg = `❌ Błąd wykonania (po ${MAX_LLM_RETRIES + 1} próbach): ${lastErrorMsg}`;
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

    // ═══ VERIFY legacy pipeline answer with deterministic brute-force ═══
    if (executionResults.length > 0 && !executionResults.some(r => r.includes('❌'))) {
      const lastResult = executionResults[executionResults.length - 1];
      const odpMatch = /ODPOWIED[ZŹ]:\s*(\S+)/i.exec(lastResult);
      if (odpMatch) {
        const legacyAnswer = odpMatch[1].trim();
        const verifiedLegacy = await this.verifyNumericAnswer(userMessage, legacyAnswer);
        if (verifiedLegacy !== legacyAnswer) {
          // Replace answer in execution results and executor content
          const correctionNote = `\n\n🔍 Weryfikacja brute-force: ${verifiedLegacy} (korekta z ${legacyAnswer})`;
          executionResults.push(correctionNote);
          finalExecutorContent += correctionNote;
          // Also fix in conversation history so summary agent sees correct answer
          const execMsg = this.conversationHistory[this.conversationHistory.length - 1];
          if (execMsg && execMsg.agentName === 'Agent Wykonawczy') {
            execMsg.content += correctionNote;
          }
        }
      }
    }

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

  // ═══ Deterministic Brute-Force Verification ══════════════════════════
  // Verifies numeric answers for known problem patterns WITHOUT using LLM.
  // Currently supports: digit-counting combinatorics problems.

  private async verifyNumericAnswer(problem: string, answer: string): Promise<string> {
    try {
      // Only verify numeric answers
      const num = parseFloat(answer);
      if (isNaN(num) || num < 0 || num > 1_000_000) return answer;

      const code = this.generateDigitCountingVerification(problem);
      if (!code) return answer;

      if (!this.mcpClient) return answer;

      console.log(`🔍 Running deterministic verification for answer: ${answer}`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|SyntaxError/i.test(output)) {
        console.log(`  ⚠️ Verification code error: ${output.substring(0, 80)}`);
        return answer;
      }

      const match = /WERYFIKACJA:\s*(\d+)/i.exec(output);
      if (!match) return answer;

      const verified = match[1];
      if (verified !== answer) {
        console.log(`🔍 Verification override: formula=${answer} → brute-force=${verified}`);
        return verified;
      }

      console.log(`✅ Verification confirms: ${answer}`);
      return answer;
    } catch (error) {
      console.log(`  ⚠️ Verification error: ${error}`);
      return answer;
    }
  }

  private generateDigitCountingVerification(problem: string): string | null {
    const text = problem.toLowerCase();

    // Must mention digits/numbers
    if (!/cyfr|cyfrowe|cyfrowych|zapisie dziesi[eę]tnym|liczb\w* naturaln/.test(text)) return null;

    const noRepeats = /nie powt[aó]rza|różn\w* cyfr|bez powt[oó]rzeń|r[oó]żnych cyfr/.test(text);

    const polishNumbers: Record<string, number> = {
      'jedno': 1, 'jeden': 1, 'jedna': 1,
      'dwie': 2, 'dwa': 2, 'dwóch': 2, 'dwu': 2,
      'trzy': 3, 'trzech': 3,
      'cztery': 4, 'czterech': 4,
      'pięć': 5, 'pięciu': 5,
    };

    const numPattern = '(\\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)';

    const oddMatch = text.match(
      new RegExp(`(?:dokładnie\\s+)?${numPattern}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?nieparzyst`)
    );
    const evenMatch = text.match(
      new RegExp(`(?:dokładnie\\s+)?${numPattern}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?parzyst`)
    );

    let nOdd: number | null = oddMatch ? (polishNumbers[oddMatch[1]] ?? parseInt(oddMatch[1])) : null;
    let nEven: number | null = evenMatch ? (polishNumbers[evenMatch[1]] ?? parseInt(evenMatch[1])) : null;

    if (nOdd === null || nEven === null) return null;
    if (nOdd < 1 || nOdd > 5 || nEven < 0 || nEven > 5) return null;

    const totalDigits = nOdd + nEven;
    if (totalDigits < 1 || totalDigits > 9) return null;

    console.log(`🎯 Detected digit-counting: ${totalDigits} digits, ${nOdd} odd, ${nEven} even, noRepeats=${noRepeats}`);

    return `from itertools import permutations, combinations
odd_digits = [1, 3, 5, 7, 9]
even_digits = [0, 2, 4, 6, 8]
count = 0
for o in combinations(odd_digits, ${nOdd}):
    for e in combinations(even_digits, ${nEven}):
        digits = list(o) + list(e)
        ${noRepeats ? '# no repeats guaranteed by combinations' : 'if len(set(digits)) < len(digits): continue'}
        for p in permutations(digits):
            if ${totalDigits > 1 ? 'p[0] != 0' : 'True'}:
                count += 1
print("WERYFIKACJA:", count)`;
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
