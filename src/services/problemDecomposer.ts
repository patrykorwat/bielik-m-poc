/**
 * Problem Decomposer — Divide & Conquer for complex math tasks
 *
 * Philosophy: Bielik 11B can't solve a complex 5-step problem in one shot,
 * but CAN solve each individual step. This module:
 *
 * 1. DECOMPOSE: LLM splits problem into 2-5 ordered sub-tasks
 * 2. ROUTE: Each sub-task goes through classifier → extraction chain → solver
 * 3. AGGREGATE: Combine sub-results into the final answer
 *
 * Each sub-task is a self-contained mini-problem with:
 * - Clear input (given values or results from previous steps)
 * - Clear operation (one mathematical operation)
 * - Clear expected output type (number, expression, boolean)
 */

import { LLMAgent } from './mlxAgent';
import { MCPClientBrowser } from './mcpClientBrowser';
import { classifyProblem, shouldUseFallback } from './classifierService';
import { routeAndSolveWithRetry } from './solverRouter';
import { runExtractionChain, runMultiStepChain, ChainResult } from './multiStepChain';
import { ClassificationResult } from './classifierTypes';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubTask {
  id: number;
  description: string;        // Polish, self-contained mini-problem
  sympy_formula?: string;     // Direct SymPy formula (preferred over description)
  operation: string;           // e.g. "solve_equation", "compute_value", "substitute"
  depends_on: number[];        // IDs of sub-tasks whose results are needed
  expected_output: string;     // e.g. "number", "expression", "set", "boolean"
}

export interface SubTaskResult {
  subTaskId: number;
  success: boolean;
  answer?: string;
  code?: string;
  output?: string;
  error?: string;
  pipeline?: string;           // which pipeline solved it
}

export interface DecompositionResult {
  success: boolean;
  subTasks: SubTask[];
  subResults: SubTaskResult[];
  finalAnswer?: string;
  error?: string;
  totalSteps: number;
  stepsCompleted: number;
}

// ─── Decomposition Prompt ───────────────────────────────────────────────────

const DECOMPOSITION_SYSTEM_PROMPT = `Rozbij zadanie na 2-4 PROSTYCH pod-zadań. Każde pod-zadanie = JEDEN wzór SymPy.

KRYTYCZNE ZASADY:
1. W "description" ZAWSZE podaj KONKRETNY WZÓR MATEMATYCZNY (np. "Oblicz binomial(5,3)" NIE "Oblicz liczbę sposobów")
2. W "sympy_formula" podaj DOKŁADNY kod SymPy (1 linia) z KONKRETNYMI LICZBAMI
3. OSTATNIE pod-zadanie = formuła łącząca wyniki: "WYNIK_1 * WYNIK_2 - WYNIK_3"
4. Maksymalnie 3 kroki! Im mniej kroków, tym lepiej.

⚠️ TYPOWE BŁĘDY — UNIKAJ:
- Liczby n-cyfrowe: 0 NIE MOŻE być pierwszą cyfrą!
  → Gdy odejmujesz przypadki z 0 na początku: 0 jest JUŻ WYBRANE jako jedna z cyfr parzystych,
    więc zostaje C(k-1, m-1) wyborów pozostałych parzystych, NIE C(k, m)!
  → BŁĄD: C(5,3)*C(5,2)*4! = 2400 | DOBRZE: C(5,3)*C(4,1)*4! = 960
- NIE rozbijaj na >3 kroki — każdy dodatkowy krok = ryzyko błędu
- NIE rób osobnego kroku na factorial(5) — wstaw go do formuły końcowej

FORMA — TYLKO JSON, nic więcej:

PRZYKŁAD 1 — Kombinatoryka z cyframi:
Zadanie: Ile jest 5-cyfrowych liczb z 3 nieparzyste i 2 parzyste cyfry bez powtórzeń?
{
  "subtasks": [
    {"id": 1, "description": "Wybór 3 nieparzystych z 5: binomial(5,3)", "sympy_formula": "binomial(5, 3)", "depends_on": [], "expected_output": "number"},
    {"id": 2, "description": "Wybór 2 parzystych z 5: binomial(5,2)", "sympy_formula": "binomial(5, 2)", "depends_on": [], "expected_output": "number"},
    {"id": 3, "description": "Wszystkie permutacje minus przypadki z 0 na początku: WYNIK_1*WYNIK_2*factorial(5) - WYNIK_1*binomial(4,1)*factorial(4)", "sympy_formula": "WYNIK_1 * WYNIK_2 * factorial(5) - WYNIK_1 * binomial(4, 1) * factorial(4)", "depends_on": [1, 2], "expected_output": "number"}
  ]
}

PRZYKŁAD 2 — Geometria:
Zadanie: Oblicz pole trójkąta o bokach 3, 4, 5
{
  "subtasks": [
    {"id": 1, "description": "Półobwód: (3+4+5)/2", "sympy_formula": "(3+4+5)/2", "depends_on": [], "expected_output": "number"},
    {"id": 2, "description": "Pole Herona: sqrt(WYNIK_1*(WYNIK_1-3)*(WYNIK_1-4)*(WYNIK_1-5))", "sympy_formula": "sqrt(WYNIK_1*(WYNIK_1-3)*(WYNIK_1-4)*(WYNIK_1-5))", "depends_on": [1], "expected_output": "number"}
  ]
}

PRZYKŁAD 3 — Ciąg geometryczny:
Zadanie: a1=2, q=3, oblicz S_8
{
  "subtasks": [
    {"id": 1, "description": "Suma: 2*(3**8-1)/(3-1)", "sympy_formula": "2*(3**8 - 1)/(3 - 1)", "depends_on": [], "expected_output": "number"}
  ]
}

WAŻNE:
- "sympy_formula" = GOTOWY wzór SymPy z KONKRETNYMI LICZBAMI
- Użyj WYNIK_1, WYNIK_2 itd. gdy krok zależy od poprzedniego
- Ostatni krok MUSI dać JEDNĄ liczbę = odpowiedź
- MYŚL O WARUNKACH BRZEGOWYCH (0 na początku, ujemne wartości, dzielenie przez 0)`;

// ─── Main Class ─────────────────────────────────────────────────────────────

export class ProblemDecomposer {
  private llmAgent: LLMAgent;
  private mcpClient: MCPClientBrowser;
  private sanitizeCode: (code: string) => string;
  private classifierPrompt: string;

  constructor(
    llmAgent: LLMAgent,
    mcpClient: MCPClientBrowser,
    sanitizeCode: (code: string) => string,
    classifierPrompt: string,
  ) {
    this.llmAgent = llmAgent;
    this.mcpClient = mcpClient;
    this.sanitizeCode = sanitizeCode;
    this.classifierPrompt = classifierPrompt;
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────

  async decompose(
    problem: string,
    ragContext?: string,
    onStepComplete?: (step: number, total: number, result: SubTaskResult) => void,
  ): Promise<DecompositionResult> {
    console.log('✂️ ProblemDecomposer: Starting decomposition...');

    // Step 1: LLM decomposes the problem
    const subTasks = await this.decomposeProblem(problem, ragContext);

    if (!subTasks || subTasks.length === 0) {
      return {
        success: false,
        subTasks: [],
        subResults: [],
        error: 'Failed to decompose problem into sub-tasks',
        totalSteps: 0,
        stepsCompleted: 0,
      };
    }

    console.log(`📋 Decomposed into ${subTasks.length} sub-tasks`);

    // Step 2: Solve each sub-task in dependency order
    const subResults: SubTaskResult[] = [];
    const resultMap = new Map<number, string>(); // id → answer

    for (const task of subTasks) {
      // Inject results from dependencies into both description and sympy_formula
      let taskDescription = task.description;
      let taskFormula = task.sympy_formula || '';
      for (const depId of task.depends_on) {
        const depResult = resultMap.get(depId);
        if (depResult) {
          const pattern = new RegExp(`WYNIK_${depId}`, 'g');
          taskDescription = taskDescription.replace(pattern, depResult);
          taskFormula = taskFormula.replace(pattern, depResult);
        } else {
          console.warn(`⚠️ Dependency ${depId} not resolved for task ${task.id}`);
        }
      }

      // Create a resolved copy of the task with injected values
      const resolvedTask: SubTask = {
        ...task,
        description: taskDescription,
        sympy_formula: taskFormula || undefined,
      };

      console.log(`🔧 Solving sub-task ${task.id}/${subTasks.length}: ${taskFormula || taskDescription.substring(0, 80)}...`);

      // Route through pipeline
      const result = await this.solveSubTask(taskDescription, resolvedTask);
      subResults.push(result);

      if (result.success && result.answer) {
        resultMap.set(task.id, result.answer);
        console.log(`✅ Sub-task ${task.id} solved: ${result.answer}`);
      } else {
        console.log(`❌ Sub-task ${task.id} failed: ${result.error || 'no answer'}`);
        // Don't abort — try to continue with what we have
      }

      if (onStepComplete) {
        onStepComplete(task.id, subTasks.length, result);
      }
    }

    // Step 3: Extract final answer from the last successful sub-task
    const completedCount = subResults.filter(r => r.success).length;
    const lastTask = subTasks[subTasks.length - 1];
    let finalAnswer = resultMap.get(lastTask.id);

    // Step 4: Verify via deterministic brute-force (NO LLM needed!)
    if (finalAnswer) {
      // Try deterministic verification first (pattern-based, no LLM)
      const deterministicAnswer = await this.deterministicBruteForce(problem);
      if (deterministicAnswer) {
        if (deterministicAnswer !== finalAnswer) {
          console.log(`🔍 Deterministic brute-force: formuła=${finalAnswer}, brute-force=${deterministicAnswer} → używam brute-force`);
          finalAnswer = deterministicAnswer;
        } else {
          console.log(`✅ Deterministic brute-force potwierdza: ${finalAnswer}`);
        }
      } else {
        // Fallback: LLM-generated brute-force
        const verifiedAnswer = await this.verifyWithBruteForce(problem, finalAnswer, ragContext);
        if (verifiedAnswer && verifiedAnswer !== finalAnswer) {
          console.log(`🔍 LLM brute-force: formuła=${finalAnswer}, brute-force=${verifiedAnswer} → używam brute-force`);
          finalAnswer = verifiedAnswer;
        } else if (verifiedAnswer) {
          console.log(`✅ LLM brute-force potwierdza: ${finalAnswer}`);
        }
      }
    }

    // Step 5: Substitution verification for equation/algebraic problems
    // Catches cases where decomposition incorrectly simplifies equations
    if (finalAnswer) {
      const substitutionOk = await this.verifyBySubstitution(problem, finalAnswer, subTasks);
      if (substitutionOk === false) {
        console.log(`❌ Substitution verification FAILED for answer: ${finalAnswer}`);
        finalAnswer = undefined;
      }
    }

    return {
      success: !!finalAnswer,
      subTasks,
      subResults,
      finalAnswer,
      totalSteps: subTasks.length,
      stepsCompleted: completedCount,
    };
  }

  // ─── Decompose Problem via LLM ────────────────────────────────────────

  private async decomposeProblem(problem: string, ragContext?: string): Promise<SubTask[]> {
    try {
      const userPrompt = ragContext
        ? `Kontekst:\n${ragContext}\n\nZadanie do rozbicia:\n${problem}`
        : `Zadanie do rozbicia:\n${problem}`;

      const response = await this.llmAgent.execute(
        DECOMPOSITION_SYSTEM_PROMPT,
        [{ role: 'user', content: userPrompt }],
        { maxTokens: 600, temperature: 0.15 },
      );

      // Parse JSON from response
      const parsed = this.parseDecompositionJSON(response);
      if (!parsed || !parsed.subtasks || parsed.subtasks.length === 0) {
        console.warn('⚠️ Failed to parse decomposition response');
        return [];
      }

      // Validate and clean
      const subTasks: SubTask[] = parsed.subtasks
        .filter((t: any) => t.id && (t.description || t.sympy_formula))
        .map((t: any) => ({
          id: Number(t.id),
          description: String(t.description || t.sympy_formula || ''),
          sympy_formula: t.sympy_formula ? String(t.sympy_formula) : undefined,
          operation: String(t.operation || 'compute_value'),
          depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(Number) : [],
          expected_output: String(t.expected_output || 'number'),
        }));

      // Topological sort to respect dependencies
      return this.topologicalSort(subTasks);
    } catch (error) {
      console.error('❌ Decomposition failed:', error);
      return [];
    }
  }

  // ─── Route Sub-Task Through Pipeline ──────────────────────────────────

  private async solveSubTask(description: string, task: SubTask): Promise<SubTaskResult> {
    const baseResult: SubTaskResult = {
      subTaskId: task.id,
      success: false,
    };

    try {
      // ═══ ATTEMPT 0: Direct formula execution (BEST — no LLM needed) ═══
      // If the decomposer provided a sympy_formula, execute it directly
      if (task.sympy_formula) {
        const formulaResult = await this.executeFormula(task.sympy_formula);
        if (formulaResult) {
          return {
            ...baseResult,
            success: true,
            answer: formulaResult.answer,
            code: formulaResult.code,
            output: formulaResult.output,
            pipeline: 'direct_formula',
          };
        }
        console.log(`  ⚠️ Direct formula failed, trying classifier...`);
      }

      // ═══ ATTEMPT 1: Classify and route through deterministic solver ═══
      const classification = await this.classifySubTask(description);

      if (classification && !shouldUseFallback(classification)) {
        console.log(`  📊 Classified as: ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);

        const solverResult = await routeAndSolveWithRetry(
          classification,
          this.mcpClient,
          this.sanitizeCode,
          2,
        );

        if (solverResult.success && solverResult.answer) {
          return {
            ...baseResult,
            success: true,
            answer: solverResult.answer,
            code: solverResult.code,
            output: solverResult.output,
            pipeline: 'deterministic_solver',
          };
        }
      }

      // ═══ ATTEMPT 2: Extraction chain ═══
      const chainResult = await this.tryExtractionChain(description, classification);
      if (chainResult?.success && chainResult.answer) {
        return {
          ...baseResult,
          success: true,
          answer: chainResult.answer,
          code: chainResult.code,
          output: chainResult.output,
          pipeline: 'extraction_chain',
        };
      }

      // ═══ ATTEMPT 3: Multi-step chain ═══
      const multiResult = await this.tryMultiStepChain(description);
      if (multiResult?.success && multiResult.answer) {
        return {
          ...baseResult,
          success: true,
          answer: multiResult.answer,
          code: multiResult.code,
          output: multiResult.output,
          pipeline: 'multi_step_chain',
        };
      }

      // ═══ ATTEMPT 4: Direct LLM code generation ═══
      const directResult = await this.tryDirectCodeGeneration(description, task);
      if (directResult) {
        return {
          ...baseResult,
          success: true,
          answer: directResult.answer,
          code: directResult.code,
          output: directResult.output,
          pipeline: 'direct_code',
        };
      }

      return {
        ...baseResult,
        error: 'All solving attempts failed for sub-task',
      };

    } catch (error) {
      return {
        ...baseResult,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ─── Direct Formula Execution (no LLM needed!) ─────────────────────

  private async executeFormula(
    formula: string,
  ): Promise<{ answer: string; code: string; output: string } | null> {
    try {
      // Detect if formula contains solve/solveset (needs different handling)
      const hasSolve = /\b(solve|solveset|nsolve)\s*\(/.test(formula);
      const hasMultiLine = formula.includes('\n') || formula.includes(';');

      let code: string;
      if (hasMultiLine) {
        // Multi-line formula: execute as-is with imports
        code = formula.startsWith('from sympy') ? formula : `from sympy import *\n${formula}`;
        if (!code.includes('print(')) {
          code += `\nprint("ODPOWIEDZ:", wynik)`;
        }
      } else if (hasSolve) {
        // solve() returns a list; extract first element
        code = `from sympy import *\n_result = ${formula}\nwynik = _result[0] if isinstance(_result, list) and len(_result) > 0 else _result\nprint("ODPOWIEDZ:", wynik)`;
      } else {
        // Simple expression evaluation
        code = `from sympy import *\nwynik = ${formula}\nprint("ODPOWIEDZ:", wynik)`;
      }
      const sanitized = this.sanitizeCode(code);

      console.log(`  🧮 Executing formula: ${formula.substring(0, 60)}`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: sanitized,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for errors
      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        console.log(`  ⚠️ Formula execution error: ${output.substring(0, 80)}`);
        return null;
      }

      // Extract answer
      const answerMatch = /ODPOWIED[ZŹ]:\s*(.+)/i.exec(output);
      const answer = answerMatch ? answerMatch[1].trim() : null;

      if (!answer || answer.toLowerCase() === 'none') return null;

      return { answer, code: sanitized, output };
    } catch {
      return null;
    }
  }

  // ─── Pipeline Helpers ─────────────────────────────────────────────────

  private async classifySubTask(description: string): Promise<ClassificationResult | null> {
    try {
      return await classifyProblem(
        description,
        this.classifierPrompt,
        this.llmAgent,
        undefined,
        { maxTokens: 500, temperature: 0.1 },
      );
    } catch {
      return null;
    }
  }

  private async tryExtractionChain(
    description: string,
    classification?: ClassificationResult | null,
  ): Promise<ChainResult | null> {
    try {
      const result = await runExtractionChain(
        description,
        this.llmAgent,
        this.mcpClient,
        this.sanitizeCode,
        { classifiedType: classification?.type },
      );
      return result.success ? result : null;
    } catch {
      return null;
    }
  }

  private async tryMultiStepChain(description: string): Promise<ChainResult | null> {
    try {
      const result = await runMultiStepChain(
        description,
        this.llmAgent,
        this.mcpClient,
        this.sanitizeCode,
      );
      return result.success ? result : null;
    } catch {
      return null;
    }
  }

  private async tryDirectCodeGeneration(
    description: string,
    _task: SubTask,
  ): Promise<{ answer: string; code: string; output: string } | null> {
    try {
      const codePrompt = `Napisz JEDEN krótki blok kodu Python/SymPy (max 8 linii) który rozwiąże to pod-zadanie.
ZASADY:
- from sympy import *
- Podstaw KONKRETNE wartości liczbowe (nie symbole)
- Ostatnia linia: print("ODPOWIEDZ:", wynik)
- NIE pisz wyjaśnień, TYLKO kod w bloku \`\`\`python ... \`\`\`

Pod-zadanie: ${description}`;

      const response = await this.llmAgent.execute(
        'Jestes kompilatorem SymPy. Odpowiadasz WYLACZNIE blokiem kodu Python.',
        [{ role: 'user', content: codePrompt }],
        { maxTokens: 400, temperature: 0.1 },
      );

      // Extract code
      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);

      if (!codeMatch) return null;

      let code = codeMatch[1].trim();
      code = this.sanitizeCode(code);

      // Ensure print statement
      if (!code.includes('print(')) {
        const lastAssign = code.match(/(\w+)\s*=\s*[^=]/g);
        if (lastAssign) {
          const varName = lastAssign[lastAssign.length - 1].split('=')[0].trim();
          code += `\nprint("ODPOWIEDZ:", ${varName})`;
        }
      }

      // Execute
      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for errors
      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        return null;
      }

      // Extract answer
      const answerMatch = /ODPOWIED[ZŹ]:\s*(.+)/i.exec(output);
      const answer = answerMatch ? answerMatch[1].trim() : null;

      if (!answer || answer.toLowerCase() === 'none') return null;

      return { answer, code, output };
    } catch {
      return null;
    }
  }

  // ─── Deterministic Brute-Force (NO LLM!) ─────────────────────────────────

  /**
   * Generate and run brute-force verification code WITHOUT the LLM.
   * Detects common problem patterns and creates enumeration code from templates.
   */
  private async deterministicBruteForce(problem: string): Promise<string | null> {
    const text = problem.toLowerCase();

    // ═══ PATTERN 1: Digit counting — "ile jest n-cyfrowych liczb z k odd i m even" ═══
    const digitCountCode = this.detectDigitCountingProblem(text, problem);
    if (digitCountCode) {
      return this.runVerificationCode(digitCountCode);
    }

    // Future patterns can be added here:
    // PATTERN 2: Arrangement problems
    // PATTERN 3: Selection problems
    // etc.

    return null;
  }

  /**
   * Detect digit-counting problems and generate enumeration code.
   * Patterns:
   * - "n-cyfrowych liczb" with constraints on odd/even digits
   * - "w zapisie dziesiętnym" with digit constraints
   * - "nie powtarza się cyfra" (no repeating digits)
   */
  private detectDigitCountingProblem(textLower: string, _original: string): string | null {
    // Must mention digits/numbers
    const isDigitProblem = /cyfr|cyfrowe|cyfrowych|zapisie dziesi[eę]tnym|liczb\w* naturaln/.test(textLower);
    if (!isDigitProblem) return null;

    // Check for "no repeating digits" constraint
    const noRepeats = /nie powt[aó]rza|różn\w* cyfr|bez powt[oó]rzeń|r[oó]żnych cyfr/.test(textLower);

    // Extract odd/even digit counts
    // "dokładnie trzy cyfry są nieparzyste i dokładnie dwie cyfry są parzyste"
    // "3 cyfry nieparzyste i 2 parzyste"
    const polishNumbers: Record<string, number> = {
      'jedno': 1, 'jeden': 1, 'jedna': 1,
      'dwie': 2, 'dwa': 2, 'dwóch': 2, 'dwu': 2,
      'trzy': 3, 'trzech': 3,
      'cztery': 4, 'czterech': 4,
      'pięć': 5, 'pięciu': 5,
    };

    let nOdd: number | null = null;
    let nEven: number | null = null;

    // Pattern: "[number] cyfr/y [są/jest] nieparzyst[ych/e]"
    const oddMatch = textLower.match(
      /(?:dokładnie\s+)?(\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)\s+(?:cyfr\w*)\s+(?:s[aą]\s+)?nieparzyst/
    );
    const evenMatch = textLower.match(
      /(?:dokładnie\s+)?(\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)\s+(?:cyfr\w*)\s+(?:s[aą]\s+)?parzyst/
    );

    if (oddMatch) {
      nOdd = polishNumbers[oddMatch[1]] ?? parseInt(oddMatch[1]);
    }
    if (evenMatch) {
      nEven = polishNumbers[evenMatch[1]] ?? parseInt(evenMatch[1]);
    }

    // Also try reverse pattern: "nieparzyste cyfry" before count
    if (nOdd === null) {
      const oddMatch2 = textLower.match(/nieparzyst\w*\s+(?:cyfr\w*).*?(\d+)/);
      if (oddMatch2) nOdd = parseInt(oddMatch2[1]);
    }
    if (nEven === null) {
      const evenMatch2 = textLower.match(/parzyst\w*\s+(?:cyfr\w*).*?(\d+)/);
      if (evenMatch2) nEven = parseInt(evenMatch2[1]);
    }

    // Need both counts to proceed
    if (nOdd === null || nEven === null) return null;
    if (nOdd < 1 || nOdd > 5 || nEven < 0 || nEven > 5) return null;

    const totalDigits = nOdd + nEven;
    if (totalDigits < 1 || totalDigits > 9) return null;

    console.log(`🎯 Detected digit-counting problem: ${totalDigits} digits, ${nOdd} odd, ${nEven} even, noRepeats=${noRepeats}`);

    // Generate Python enumeration code
    const code = `from itertools import permutations, combinations
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

    return code;
  }

  private async runVerificationCode(code: string): Promise<string | null> {
    try {
      console.log(`🔍 Running deterministic brute-force verification...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        console.log(`  ⚠️ Deterministic verification error: ${output.substring(0, 100)}`);
        return null;
      }

      const match = /WERYFIKACJA:\s*(\d+)/i.exec(output);
      if (!match) return null;

      const num = parseInt(match[1]);
      if (isNaN(num)) return null;

      console.log(`  ✅ Deterministic result: ${num}`);
      return String(num);
    } catch (error) {
      console.log(`  ⚠️ Deterministic verification error: ${error}`);
      return null;
    }
  }

  // ─── Brute-Force Verification (LLM-based fallback) ───────────────────

  private async verifyWithBruteForce(
    problem: string,
    formulaAnswer: string,
    ragContext?: string,
  ): Promise<string | null> {
    try {
      // Only verify pure integer answers (counting/combinatorics problems)
      // NEVER verify symbolic answers (sqrt, pi, fractions) — brute-force makes no sense for continuous math
      if (/sqrt|pi|[*\/^]|[a-zA-Z]{2,}/.test(formulaAnswer)) {
        console.log(`  ⏭️ Skipping brute-force verification for symbolic answer: ${formulaAnswer}`);
        return null;
      }
      const numericAnswer = parseFloat(formulaAnswer);
      if (isNaN(numericAnswer) || numericAnswer < 0 || numericAnswer > 1_000_000) {
        return null; // Skip verification for non-numeric or huge answers
      }
      // Must be an integer — brute-force counting only makes sense for whole numbers
      if (!Number.isInteger(numericAnswer)) {
        console.log(`  ⏭️ Skipping brute-force verification for non-integer: ${formulaAnswer}`);
        return null;
      }

      const verifyPrompt = `Napisz KRÓTKI kod Python (max 15 linii) który BRUTE-FORCE (przez wyliczenie/iterację) sprawdzi odpowiedź na to zadanie.

ZASADY:
- Użyj itertools (permutations, combinations, product) do wyliczenia WSZYSTKICH przypadków
- Zlicz te które spełniają warunki
- NIE używaj wzorów kombinatorycznych — WYLICZ przez pętlę!
- Ostatnia linia: print("WERYFIKACJA:", count)
- TYLKO kod w bloku \`\`\`python ... \`\`\`

Zadanie: ${problem}
${ragContext ? `Kontekst: ${ragContext}` : ''}

Odpowiedź z formuły: ${formulaAnswer} — sprawdź czy to poprawne przez wyliczenie.`;

      const response = await this.llmAgent.execute(
        'Jesteś programistą Python. Piszesz WYŁĄCZNIE krótki kod brute-force do weryfikacji odpowiedzi. TYLKO kod, bez wyjaśnień.',
        [{ role: 'user', content: verifyPrompt }],
        { maxTokens: 500, temperature: 0.1 },
      );

      // Extract code
      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);

      if (!codeMatch) return null;

      let code = codeMatch[1].trim();
      code = this.sanitizeCode(code);

      // Ensure it has the verification print
      if (!code.includes('WERYFIKACJA')) {
        // Try to add it
        const lastVar = code.match(/(\w+)\s*=\s*(?:len|sum|count)/g);
        if (lastVar) {
          const varName = lastVar[lastVar.length - 1].split('=')[0].trim();
          code += `\nprint("WERYFIKACJA:", ${varName})`;
        }
      }

      console.log(`🔍 Running brute-force verification...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for errors
      if (/Error:|Traceback|SyntaxError|NameError|MemoryError|Timeout/i.test(output)) {
        console.log(`  ⚠️ Brute-force verification failed: ${output.substring(0, 80)}`);
        return null;
      }

      // Extract verified answer
      const verifyMatch = /WERYFIKACJA:\s*(\d+)/i.exec(output);
      if (!verifyMatch) return null;

      const verifiedNum = parseInt(verifyMatch[1]);
      if (isNaN(verifiedNum)) return null;

      return String(verifiedNum);
    } catch (error) {
      console.log(`  ⚠️ Brute-force verification error: ${error}`);
      return null;
    }
  }

  // ─── Substitution Verification ──────────────────────────────────────────

  /**
   * Verify the final answer by substituting it back into the original equation.
   * Returns true if verification passes or is not applicable,
   * false if the answer provably does NOT satisfy the original problem,
   * null if verification could not be performed.
   */
  private async verifyBySubstitution(
    problem: string,
    finalAnswer: string,
    _subTasks: SubTask[],
  ): Promise<boolean | null> {
    try {
      // Only verify equation/algebraic problems where substitution makes sense
      const textLower = problem.toLowerCase();
      const isEquationProblem =
        /równani[ea]|rozwiąż|wyznacz|znajdź.*spełniaj|=/.test(textLower) ||
        /suma.*równ[ae]|iloczyn.*równ[ae]|wyrażeni[ea]/.test(textLower);

      if (!isEquationProblem) {
        return null; // Not an equation problem, skip
      }

      // Skip if answer is a simple number (counting problems verified elsewhere)
      const isSimpleNumber = /^\d+$/.test(finalAnswer.trim());
      if (isSimpleNumber) {
        return null;
      }

      // Skip if answer looks like a multiple-choice letter
      if (/^[A-D]\.?$/.test(finalAnswer.trim())) {
        return null;
      }

      console.log(`🔬 Running substitution verification for: ${finalAnswer.substring(0, 60)}`);

      const verifyPrompt = `Mam zadanie i proponowaną odpowiedź. Napisz KRÓTKI kod SymPy (max 12 linii) który SPRAWDZI czy odpowiedź jest poprawna przez podstawienie do oryginalnego równania.

ZASADY:
- from sympy import *
- Podstaw odpowiedź do ORYGINALNEGO równania/wyrażenia
- Sprawdź czy równanie jest spełnione (simplify powinno dać 0 lub True)
- Jeśli odpowiedź to rozwiązanie parametryczne (np. zbiór punktów), podstaw losowe wartości parametrów i sprawdź
- Ostatnia linia: print("WERYFIKACJA:", "TAK" if wynik_ok else "NIE")
- TYLKO kod w bloku \`\`\`python ... \`\`\`

Zadanie: ${problem}

Proponowana odpowiedź: ${finalAnswer}

Sprawdź czy ta odpowiedź faktycznie spełnia warunki zadania.`;

      const response = await this.llmAgent.execute(
        'Jesteś weryfikatorem matematycznym. Piszesz WYŁĄCZNIE kod SymPy do sprawdzenia poprawności odpowiedzi przez podstawienie. TYLKO kod, bez wyjaśnień.',
        [{ role: 'user', content: verifyPrompt }],
        { maxTokens: 500, temperature: 0.1 },
      );

      // Extract code
      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);

      if (!codeMatch) {
        console.log(`  ⚠️ Could not extract verification code`);
        return null;
      }

      let code = codeMatch[1].trim();
      code = this.sanitizeCode(code);

      // Ensure it has the verification print
      if (!code.includes('WERYFIKACJA')) {
        return null;
      }

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for execution errors
      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        console.log(`  ⚠️ Substitution verification error: ${output.substring(0, 100)}`);
        return null; // Cannot verify, don't reject the answer
      }

      const verifyMatch = /WERYFIKACJA:\s*(TAK|NIE)/i.exec(output);
      if (!verifyMatch) {
        console.log(`  ⚠️ Could not parse verification result from: ${output.substring(0, 80)}`);
        return null;
      }

      const passed = verifyMatch[1].toUpperCase() === 'TAK';
      console.log(`  ${passed ? '✅' : '❌'} Substitution verification: ${verifyMatch[1]}`);
      return passed;
    } catch (error) {
      console.log(`  ⚠️ Substitution verification error: ${error}`);
      return null; // On error, don't reject the answer
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  private parseDecompositionJSON(response: string): any {
    // Remove <think> blocks
    let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Try JSON from code fence
    const jsonFence = /```json\s*\n([\s\S]*?)\n```/.exec(cleaned);
    if (jsonFence) {
      try { return JSON.parse(jsonFence[1]); } catch { /* continue */ }
    }

    // Try raw JSON
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        // Fix common LLM JSON issues
        let fixed = jsonMatch[0]
          .replace(/,\s*([}\]])/g, '$1')       // trailing commas
          .replace(/'/g, '"')                    // single quotes
          .replace(/(\w+):/g, '"$1":')           // unquoted keys
          .replace(/""/g, '"');                   // double-doubled quotes
        return JSON.parse(fixed);
      } catch {
        // Last resort: try original
        try { return JSON.parse(jsonMatch[0]); } catch { /* give up */ }
      }
    }

    return null;
  }

  private topologicalSort(tasks: SubTask[]): SubTask[] {
    const sorted: SubTask[] = [];
    const visited = new Set<number>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    const visit = (id: number) => {
      if (visited.has(id)) return;
      visited.add(id);
      const task = taskMap.get(id);
      if (!task) return;
      for (const depId of task.depends_on) {
        visit(depId);
      }
      sorted.push(task);
    };

    for (const task of tasks) {
      visit(task.id);
    }

    return sorted;
  }
}
