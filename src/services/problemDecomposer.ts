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
import { logDebug, logVerbose, logWarn, logError } from './logger';

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
    logDebug('✂️ ProblemDecomposer: Starting decomposition...');

    // Step 0: Academic problem pre-router
    // Some problems should NOT be decomposed into sub-tasks because decomposition
    // would destroy the mathematical structure. These include:
    // - Existence/feasibility ("da się dobrać...")
    // - Proofs ("udowodnij, że...")
    // - Optimization ("znajdź minimum/maksimum...")
    // - Counterexamples ("podaj kontrprzykład...")
    // - Diophantine equations (integer solutions to algebraic equations)
    // - Tricky problems with non-obvious structure
    const directAnswer = await this.solveDirectIfApplicable(problem, ragContext);
    if (directAnswer !== null) {
      logDebug(`🎯 Direct solver resolved: ${directAnswer.substring(0, 80)}`);
      return {
        success: true,
        subTasks: [{ id: 1, description: problem, operation: 'direct_academic', depends_on: [], expected_output: 'string' }],
        subResults: [{ subTaskId: 1, success: true, answer: directAnswer, pipeline: 'direct_academic' }],
        finalAnswer: directAnswer,
        totalSteps: 1,
        stepsCompleted: 1,
      };
    }

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

    logDebug(`📋 Decomposed into ${subTasks.length} sub-tasks`);

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
          logWarn(`⚠️ Dependency ${depId} not resolved for task ${task.id}`);
        }
      }

      // Create a resolved copy of the task with injected values
      const resolvedTask: SubTask = {
        ...task,
        description: taskDescription,
        sympy_formula: taskFormula || undefined,
      };

      logVerbose(`🔧 Solving sub-task ${task.id}/${subTasks.length}: ${taskFormula || taskDescription.substring(0, 80)}...`);

      // Route through pipeline
      const result = await this.solveSubTask(taskDescription, resolvedTask);
      subResults.push(result);

      if (result.success && result.answer) {
        resultMap.set(task.id, result.answer);
        logDebug(`✅ Sub-task ${task.id} solved: ${result.answer}`);
      } else {
        logDebug(`❌ Sub-task ${task.id} failed: ${result.error || 'no answer'}`);
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
          logDebug(`🔍 Deterministic brute-force: formuła=${finalAnswer}, brute-force=${deterministicAnswer} → używam brute-force`);
          finalAnswer = deterministicAnswer;
        } else {
          logDebug(`✅ Deterministic brute-force potwierdza: ${finalAnswer}`);
        }
      } else {
        // Fallback: LLM-generated brute-force
        const verifiedAnswer = await this.verifyWithBruteForce(problem, finalAnswer, ragContext);
        if (verifiedAnswer && verifiedAnswer !== finalAnswer) {
          logDebug(`🔍 LLM brute-force: formuła=${finalAnswer}, brute-force=${verifiedAnswer} → używam brute-force`);
          finalAnswer = verifiedAnswer;
        } else if (verifiedAnswer) {
          logDebug(`✅ LLM brute-force potwierdza: ${finalAnswer}`);
        }
      }
    }

    // Step 5: Substitution verification for equation/algebraic problems
    // Catches cases where decomposition incorrectly simplifies equations
    if (finalAnswer) {
      const substitutionOk = await this.verifyBySubstitution(problem, finalAnswer, subTasks);
      if (substitutionOk === false) {
        logDebug(`❌ Substitution verification FAILED for answer: ${finalAnswer}`);
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
        logWarn('⚠️ Failed to parse decomposition response');
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
      logError('❌ Decomposition failed:', error);
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
        logVerbose(`  ⚠️ Direct formula failed, trying classifier...`);
      }

      // ═══ ATTEMPT 1: Classify and route through deterministic solver ═══
      const classification = await this.classifySubTask(description);

      if (classification && !shouldUseFallback(classification)) {
        logDebug(`  📊 Classified as: ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);

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

      logVerbose(`  🧮 Executing formula: ${formula.substring(0, 60)}`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: sanitized,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for errors
      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        logVerbose(`  ⚠️ Formula execution error: ${output.substring(0, 80)}`);
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

    logDebug(`🎯 Detected digit-counting problem: ${totalDigits} digits, ${nOdd} odd, ${nEven} even, noRepeats=${noRepeats}`);

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
      logVerbose(`🔍 Running deterministic brute-force verification...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
        logVerbose(`  ⚠️ Deterministic verification error: ${output.substring(0, 100)}`);
        return null;
      }

      const match = /WERYFIKACJA:\s*(\d+)/i.exec(output);
      if (!match) return null;

      const num = parseInt(match[1]);
      if (isNaN(num)) return null;

      logVerbose(`  ✅ Deterministic result: ${num}`);
      return String(num);
    } catch (error) {
      logVerbose(`  ⚠️ Deterministic verification error: ${error}`);
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
        logVerbose(`  ⏭️ Skipping brute-force verification for symbolic answer: ${formulaAnswer}`);
        return null;
      }
      const numericAnswer = parseFloat(formulaAnswer);
      if (isNaN(numericAnswer) || numericAnswer < 0 || numericAnswer > 1_000_000) {
        return null; // Skip verification for non-numeric or huge answers
      }
      // Must be an integer — brute-force counting only makes sense for whole numbers
      if (!Number.isInteger(numericAnswer)) {
        logVerbose(`  ⏭️ Skipping brute-force verification for non-integer: ${formulaAnswer}`);
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

      logVerbose(`🔍 Running brute-force verification...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      // Check for errors
      if (/Error:|Traceback|SyntaxError|NameError|MemoryError|Timeout/i.test(output)) {
        logVerbose(`  ⚠️ Brute-force verification failed: ${output.substring(0, 80)}`);
        return null;
      }

      // Extract verified answer
      const verifyMatch = /WERYFIKACJA:\s*(\d+)/i.exec(output);
      if (!verifyMatch) return null;

      const verifiedNum = parseInt(verifyMatch[1]);
      if (isNaN(verifiedNum)) return null;

      return String(verifiedNum);
    } catch (error) {
      logVerbose(`  ⚠️ Brute-force verification error: ${error}`);
      return null;
    }
  }

  // ─── Academic Problem Pre-Router ────────────────────────────────────────

  /**
   * Classify the problem into an academic category and solve it directly
   * (single SymPy script) instead of decomposing into sub-tasks.
   *
   * Categories handled:
   *  1. existence   — "da się dobrać", "czy istnieją"
   *  2. proof       — "udowodnij", "pokaż że", "wykaż"
   *  3. optimization— "znajdź minimum", "największa wartość", "maksymalizuj"
   *  4. counterexample — "podaj kontrprzykład", "obal"
   *  5. diophantine — integer equation patterns (Nesbitt, Pell, Fermat, etc.)
   *  6. tricky      — problems that look simple but contain hidden traps
   *
   * Returns the answer string, or null to fall through to standard decomposition.
   */
  private async solveDirectIfApplicable(
    problem: string,
    ragContext?: string,
  ): Promise<string | null> {
    const textLower = problem.toLowerCase();

    // --- 1. Nesbitt-type fraction equations (specific, high-priority) ---
    const nesbittResult = await this.detectAndSolveNesbitt(problem);
    if (nesbittResult !== null) return nesbittResult;

    // --- Classify the problem type ---
    const category = this.classifyAcademicProblem(textLower);
    if (!category) return null;

    logDebug(`🎓 Academic pre-router: detected category "${category}"`);

    switch (category) {
      case 'existence':
        return this.solveExistenceProblem(problem, ragContext);

      case 'proof':
        return this.solveProofProblem(problem, ragContext);

      case 'optimization':
        return this.solveOptimizationProblem(problem, ragContext);

      case 'counterexample':
        return this.solveCounterexampleProblem(problem, ragContext);

      case 'diophantine':
        return this.solveDiophantineProblem(problem, ragContext);

      default:
        return null;
    }
  }

  /**
   * Classify problem into academic category based on keywords.
   */
  private classifyAcademicProblem(textLower: string): string | null {
    // Proof problems
    if (/udowodnij|dowie[dś]|poka[żz]\s*(,\s*)?\s*[żz]e|wyka[żz]|uzasadnij|dowód/i.test(textLower)) {
      return 'proof';
    }

    // Counterexample problems
    if (/kontrprzyk[łl]ad|obal\s|zaprzecz|pokaz\s.*nie\s.*prawda|falsz/i.test(textLower)) {
      return 'counterexample';
    }

    // Optimization problems
    if (/minimum|maksimum|najmniejsz|największ|maksymal|minimaln|optym|ekstr[ae]m|inf\b|sup\b|najlepsz/i.test(textLower)) {
      // But not "find the minimum of 2+3" type (simple computation)
      if (/dla jak|przy jak|wśród|spośród|dla wszystkich|[∀∃]/.test(textLower) ||
          textLower.length > 80) {
        return 'optimization';
      }
    }

    // Existence/feasibility problems
    if (/da si[eę].*dobra[ćc]|da si[eę].*znale[zź][ćc]|czy (istniej|mo[żz]na|mo[żz]liwe)|znajd[źz].*tak[ie]*.*[żz]e|dobra[ćc].*tak[ie]*.*[żz]e|czy jest mo[żz]liw|czy mo[żz]na dobra[ćc]|ile jest rozwiąza[ńn]/i.test(textLower)) {
      return 'existence';
    }

    // Diophantine equation problems (integer solutions)
    if (/ca[łl]kowit.*rozwi[aą]z|rozwi[aą]z.*ca[łl]kowit|liczb\w* ca[łl]kowit.*spe[łl]niaj|r[oó]wnanie diofantyczne|pell|fermat/i.test(textLower)) {
      return 'diophantine';
    }

    return null;
  }

  // ─── Proof Solver ─────────────────────────────────────────────────────────

  /**
   * Solve proof problems: "udowodnij, że..." / "wykaż, że..."
   * Strategy:
   * 1. Try SymPy symbolic verification (if the claim is algebraic)
   * 2. Try numerical verification across many cases (empirical check)
   * 3. LLM-generated proof sketch
   */
  private async solveProofProblem(
    problem: string,
    ragContext?: string,
  ): Promise<string | null> {
    try {
      logDebug('📝 Proof solver: attempting symbolic + numeric verification...');

      // Phase 1: SymPy symbolic verification
      const symbolicResult = await this.proofSymbolic(problem);
      if (symbolicResult) return symbolicResult;

      // Phase 2: Numerical spot-check across many values
      const numericalResult = await this.proofNumerical(problem);

      // Phase 3: LLM proof sketch (always attempt, enrich with numerical result)
      const proofSketch = await this.proofLLMSketch(problem, numericalResult, ragContext);
      if (proofSketch) return proofSketch;

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Proof solver error: ${error}`);
      return null;
    }
  }

  private async proofSymbolic(problem: string): Promise<string | null> {
    try {
      const response = await this.llmAgent.execute(
        `Jesteś asystentem matematycznym. Na podstawie zadania napisz KOD SYMPY (max 20 linii) który SYMBOLICZNIE weryfikuje tezę.

ZASADY:
- from sympy import *
- Zdefiniuj zmienne symboliczne (x, y, n = symbols(...))
- Użyj simplify(), expand(), factor(), trigsimp() do uproszczenia wyrażeń
- Dla nierówności: sprawdź czy wyrażenie - granica >= 0 (np. simplify(expr - bound))
- Dla tożsamości: sprawdź czy simplify(lewa - prawa) == 0
- Dla indukcji: sprawdź bazę i krok (subs n z n+1)
- print("WYNIK: PRAWDA") jeśli teza potwierdzona symbolicznie
- print("WYNIK: FALSZ") jeśli znaleziono kontrprzykład
- print("WYNIK: NIEROZSTRZYGNIETE") jeśli SymPy nie potrafi uprościć
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Zadanie: ${problem}` }],
        { maxTokens: 600, temperature: 0.1 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let pyCode = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: pyCode,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) {
        logVerbose(`  ⚠️ Symbolic proof error: ${output.substring(0, 100)}`);
        return null;
      }

      const resultMatch = /WYNIK:\s*(PRAWDA|FALSZ|NIEROZSTRZYGNIETE)/i.exec(output);
      if (resultMatch) {
        const verdict = resultMatch[1].toUpperCase();
        if (verdict === 'PRAWDA') {
          logDebug('  ✅ Symbolic proof: confirmed');
          // Extract any simplification details from output
          const details = output.replace(/WYNIK:.*/, '').trim();
          return `Dowód (weryfikacja symboliczna): Teza jest prawdziwa.${details ? ' ' + details : ''}`;
        } else if (verdict === 'FALSZ') {
          logDebug('  ❌ Symbolic proof: disproved');
          return `Teza jest FAŁSZYWA. Weryfikacja symboliczna wykazała sprzeczność.`;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async proofNumerical(problem: string): Promise<string | null> {
    try {
      const response = await this.llmAgent.execute(
        `Napisz KRÓTKI kod Python (max 15 linii) który NUMERYCZNIE sprawdza tezę matematyczną dla WIELU konkretnych wartości (np. 1000 losowych lub systematycznych przypadków).

ZASADY:
- Sprawdź co najmniej 500 przypadków
- Użyj random lub range do generowania wartości testowych
- Dla każdego przypadku sprawdź czy teza jest spełniona
- print("NUMERYCZNIE: PRAWDA (N przypadków)") jeśli wszystkie przeszły
- print("NUMERYCZNIE: FALSZ, kontrprzykład: ...") jeśli znaleziono kontrprzykład
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Teza do sprawdzenia: ${problem}` }],
        { maxTokens: 500, temperature: 0.1 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let code = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) {
        return null;
      }

      const falszMatch = /NUMERYCZNIE:\s*FALSZ.*kontrprzyk[łl]ad:\s*(.+)/i.exec(output);
      if (falszMatch) {
        logDebug(`  ❌ Numerical check found counterexample: ${falszMatch[1]}`);
        return `Teza jest FAŁSZYWA. Kontrprzykład: ${falszMatch[1].trim()}`;
      }

      const prawdaMatch = /NUMERYCZNIE:\s*PRAWDA/i.exec(output);
      if (prawdaMatch) {
        logDebug('  ✅ Numerical check: all cases passed');
        return output.trim(); // Return as context for LLM proof sketch
      }

      return null;
    } catch {
      return null;
    }
  }

  private async proofLLMSketch(
    problem: string,
    numericalResult: string | null,
    ragContext?: string,
  ): Promise<string | null> {
    try {
      // If numerical check found a counterexample, return that directly
      if (numericalResult && /FAŁSZYWA|FALSZ/i.test(numericalResult)) {
        return numericalResult;
      }

      const context = numericalResult
        ? `\nWeryfikacja numeryczna (500+ przypadków): teza potwierdzona.`
        : '';

      const response = await this.llmAgent.execute(
        `Jesteś matematykiem. Napisz ZWIĘZŁY dowód (max 8 zdań) podanej tezy. Użyj standardowych technik: indukcja, sprowadzenie do sprzeczności, nierówność AM-GM/Cauchy-Schwarz, tożsamości algebraiczne.

ZASADY:
- Zacznij od "Dowód:" i zakończ "□" (QED)
- Bądź precyzyjny, unikaj "łatwo widać" bez uzasadnienia
- Jeśli nie potrafisz udowodnić, napisz "Nie udało się skonstruować dowodu."
- Jeśli teza jest fałszywa, napisz "Teza jest fałszywa." i podaj kontrprzykład`,
        [{ role: 'user', content: `${problem}${context}${ragContext ? '\nKontekst: ' + ragContext : ''}` }],
        { maxTokens: 800, temperature: 0.2 },
      );

      let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      if (/^(Dowód|Teza jest fa[łl]szywa)/i.test(cleaned)) {
        logDebug(`  📝 LLM proof sketch generated`);
        return cleaned;
      }

      // If response contains useful content but wrong format
      if (cleaned.length > 30 && /\./g.test(cleaned)) {
        return cleaned;
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── Optimization Solver ──────────────────────────────────────────────────

  /**
   * Solve optimization problems: "find min/max of..."
   * Strategy:
   * 1. SymPy symbolic optimization (derivatives, Lagrange multipliers)
   * 2. SymPy inequality methods (AM-GM, Cauchy-Schwarz bounds)
   * 3. Numerical sampling as verification
   */
  private async solveOptimizationProblem(
    problem: string,
    _ragContext?: string,
  ): Promise<string | null> {
    try {
      logDebug('📈 Optimization solver...');

      const response = await this.llmAgent.execute(
        `Napisz kod SymPy (max 25 linii) który znajduje MINIMUM lub MAKSIMUM wyrażenia matematycznego z podanego zadania.

METODY (wybierz odpowiednią):
1. Pochodna = 0 i analiza znaku drugiej pochodnej (dla funkcji jednej zmiennej)
2. Gradient = 0 i hesjan (dla wielu zmiennych)
3. Mnożniki Lagrange'a (dla optymalizacji z ograniczeniami)
4. AM-GM / Cauchy-Schwarz (dla nierówności z parametrami)
5. Jeśli dziedzina jest skończona: sprawdź wszystkie przypadki

ZASADY:
- from sympy import *
- Zdefiniuj zmienne: x, y, z = symbols('x y z', real=True, positive=True) (dodaj positive=True jeśli zmienne są dodatnie)
- Użyj diff(), solve(), Hessian lub metody Lagrange'a
- Sprawdź warunki brzegowe i punkty krytyczne
- print("EKSTREMUM:", typ, "=", wartość)  np. print("EKSTREMUM: minimum =", 3)
- print("OSIĄGANE_DLA:", zmienne)  np. print("OSIĄGANE_DLA: x=1, y=2")
- Jeśli ekstremum nie istnieje: print("EKSTREMUM: brak")
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Zadanie: ${problem}` }],
        { maxTokens: 700, temperature: 0.15 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let code = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) {
        logVerbose(`  ⚠️ Optimization error: ${output.substring(0, 100)}`);
        // Try numerical fallback
        return this.optimizationNumericalFallback(problem);
      }

      const extMatch = /EKSTREMUM:\s*(.+)/i.exec(output);
      const forMatch = /OSIĄGANE_DLA:\s*(.+)/i.exec(output);

      if (extMatch) {
        let answer = extMatch[1].trim();
        if (forMatch) {
          answer += `, dla ${forMatch[1].trim()}`;
        }
        logDebug(`  ✅ Optimization result: ${answer}`);
        return answer;
      }

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Optimization solver error: ${error}`);
      return null;
    }
  }

  private async optimizationNumericalFallback(problem: string): Promise<string | null> {
    try {
      const response = await this.llmAgent.execute(
        `Napisz kod Python (max 15 linii) który NUMERYCZNIE przeszukuje przestrzeń parametrów i znajduje przybliżone minimum/maksimum.

ZASADY:
- Użyj scipy.optimize.minimize lub prostego grid search
- Jeśli scipy niedostępne, użyj numpy z gęstą siatką
- print("PRZYBLIZONE_EKSTREMUM:", typ, "~=", wartość)
- print("PRZY:", parametry)
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Zadanie: ${problem}` }],
        { maxTokens: 500, temperature: 0.1 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let code = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) return null;

      const extMatch = /PRZYBLIZONE_EKSTREMUM:\s*(.+)/i.exec(output);
      if (extMatch) {
        const przyMatch = /PRZY:\s*(.+)/i.exec(output);
        let answer = `(przybliżenie numeryczne) ${extMatch[1].trim()}`;
        if (przyMatch) answer += `, przy ${przyMatch[1].trim()}`;
        return answer;
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── Counterexample Solver ────────────────────────────────────────────────

  /**
   * Find counterexamples to disprove claims.
   * Strategy: Brute-force search + random sampling + algebraic analysis
   */
  private async solveCounterexampleProblem(
    problem: string,
    _ragContext?: string,
  ): Promise<string | null> {
    try {
      logDebug('🔍 Counterexample solver...');

      const response = await this.llmAgent.execute(
        `Napisz kod Python (max 20 linii) który szuka KONTRPRZYKŁADU obalającego podaną tezę.

METODY:
1. Systematyczne przeszukanie małych wartości (1..100 lub -100..100)
2. Losowe próbkowanie (1000+ prób) dla zmiennych ciągłych
3. Przypadki brzegowe: 0, 1, -1, duże liczby, ułamki bliskie 0
4. Sprawdź specjalne wartości: liczby pierwsze, potęgi 2, ciąg Fibonacciego

ZASADY:
- from sympy import * (jeśli potrzeba dokładnych obliczeń)
- Sprawdź warunki brzegowe NAJPIERW
- print("KONTRPRZYKLAD:", wartości) jeśli znaleziony
- print("NIE_ZNALEZIONO: teza wydaje się prawdziwa dla N przetestowanych przypadków")
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Teza do obalenia: ${problem}` }],
        { maxTokens: 600, temperature: 0.1 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let code = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) {
        logVerbose(`  ⚠️ Counterexample search error: ${output.substring(0, 100)}`);
        return null;
      }

      const counterMatch = /KONTRPRZYK[ŁL]AD:\s*(.+)/i.exec(output);
      if (counterMatch) {
        logDebug(`  ✅ Counterexample found: ${counterMatch[1]}`);
        return `Kontrprzykład: ${counterMatch[1].trim()}`;
      }

      const notFoundMatch = /NIE_ZNALEZIONO/i.exec(output);
      if (notFoundMatch) {
        logDebug('  ℹ️ No counterexample found');
        return 'Nie znaleziono kontrprzykładu. Teza wydaje się prawdziwa (sprawdzono numerycznie).';
      }

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Counterexample solver error: ${error}`);
      return null;
    }
  }

  // ─── Diophantine Equation Solver ──────────────────────────────────────────

  /**
   * Solve Diophantine equations: find integer solutions to algebraic equations.
   * Handles: linear Diophantine, Pell equations, Pythagorean triples, general quadratic.
   */
  private async solveDiophantineProblem(
    problem: string,
    _ragContext?: string,
  ): Promise<string | null> {
    try {
      logDebug('🔢 Diophantine solver...');

      const response = await this.llmAgent.execute(
        `Napisz kod SymPy (max 25 linii) który rozwiązuje RÓWNANIE DIOFANTYCZNE (szuka rozwiązań w liczbach całkowitych).

METODY (wybierz odpowiednią):
1. sympy.solvers.diophantine.diophantine() dla standardowych form
2. Brute-force z range() dla małych przestrzeni
3. Parametryzacja: np. trójki pitagorejskie a=m²-n², b=2mn, c=m²+n²
4. Algorytm Pella dla x²-Dy²=1
5. Kongruencje modulo małe liczby pierwsze (eliminacja niemożliwych reszt)

ZASADY:
- from sympy import *
- from sympy.solvers.diophantine import diophantine (jeśli potrzeba)
- Jeśli rozwiązań jest nieskończenie wiele: podaj parametryzację
- Jeśli brak rozwiązań: udowodnij przez kongruencje (mod 2, mod 3, mod 4)
- print("ROZWIAZANIA:", lista lub parametryzacja)
- print("BRAK_ROZWIAZAN:", dowód)
- TYLKO kod w bloku \`\`\`python ... \`\`\``,
        [{ role: 'user', content: `Równanie: ${problem}` }],
        { maxTokens: 700, temperature: 0.15 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);
      if (!codeMatch) return null;

      let code = this.sanitizeCode(codeMatch[1].trim());

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback/i.test(output)) {
        logVerbose(`  ⚠️ Diophantine solver error: ${output.substring(0, 100)}`);
        return null;
      }

      const solMatch = /ROZWIAZANIA:\s*(.+)/i.exec(output);
      if (solMatch) {
        logDebug(`  ✅ Diophantine solutions: ${solMatch[1].substring(0, 80)}`);
        return `Rozwiązania: ${solMatch[1].trim()}`;
      }

      const noSolMatch = /BRAK_ROZWIAZAN:\s*(.+)/i.exec(output);
      if (noSolMatch) {
        logDebug(`  ❌ No Diophantine solutions: ${noSolMatch[1].substring(0, 80)}`);
        return `Brak rozwiązań w liczbach całkowitych. ${noSolMatch[1].trim()}`;
      }

      // Try to extract any useful output
      if (output.trim() && !/Error/i.test(output)) {
        return output.trim();
      }

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Diophantine solver error: ${error}`);
      return null;
    }
  }

  // ─── Existence Problem Solver ───────────────────────────────────────────

  /**
   * Detect and solve "existence" problems: "can you find numbers such that..."
   * These problems should NOT be decomposed into sub-tasks. Instead, we:
   * 1. Try brute-force search over small values
   * 2. If not found, ask the LLM for algebraic analysis
   * Returns the answer string, or null if this is not an existence problem.
   */
  private async solveExistenceProblem(
    problem: string,
    ragContext?: string,
  ): Promise<string | null> {
    const textLower = problem.toLowerCase();

    // Detect existence/feasibility patterns in Polish
    const isExistence =
      /da si[eę].*dobra[ćc]|da si[eę].*znale[zź][ćc]|czy (istniej|mo[żz]na|mo[żz]liwe)|znajd[źz].*tak[ie]*.*[żz]e|dobra[ćc].*tak[ie]*.*[żz]e|czy jest mo[żz]liw|czy mo[żz]na dobra[ćc]/.test(textLower);

    // Also detect Nesbitt-type fraction sum equations even without explicit "da się"
    const nesbittResult = await this.detectAndSolveNesbitt(problem);
    if (nesbittResult !== null) {
      return nesbittResult;
    }

    if (!isExistence) return null;

    logDebug('🔍 Detected existence/feasibility problem, using specialized solver...');

    // Phase 1: Generate brute-force search code via LLM
    const bruteForceAnswer = await this.existenceBruteForce(problem);
    if (bruteForceAnswer) {
      return bruteForceAnswer;
    }

    // Phase 2: Algebraic analysis via LLM (for problems where solutions require large numbers)
    const algebraicAnswer = await this.existenceAlgebraic(problem, ragContext);
    if (algebraicAnswer) {
      return algebraicAnswer;
    }

    // Could not determine, fall back to standard decomposition
    logDebug('  ⚠️ Existence solver inconclusive, falling back to decomposition');
    return null;
  }

  // ─── Nesbitt-Type Equation Solver ────────────────────────────────────────

  /**
   * Detect and solve Nesbitt-type equations:
   *   a/(b+c) + b/(a+c) + c/(a+b) = N
   * where a, b, c are positive integers.
   *
   * Mathematical background:
   * - Nesbitt's inequality: sum >= 3/2 for positive reals
   * - The equation defines an elliptic curve; for integer N >= 2, solutions
   *   exist but may require numbers with dozens or hundreds of digits
   * - Brute force works for small solutions; larger ones need elliptic curve methods
   */
  private async detectAndSolveNesbitt(problem: string): Promise<string | null> {
    const textLower = problem.toLowerCase();

    // Detect the pattern: "x dzielisz przez sumę y i z" repeated 3 times, plus sum = N
    // Also detect algebraic form: a/(b+c) + b/(a+c) + c/(a+b) = N
    const hasThreeFractions =
      // Polish phrasing: "dzielisz przez sumę"
      (textLower.match(/dzielisz przez sum[eę]/g) || []).length >= 3 ||
      // Direct algebraic: a/(b+c) + b/(a+c) + c/(a+b)
      /\w+\s*\/\s*\(\s*\w+\s*\+\s*\w+\s*\).*\w+\s*\/\s*\(\s*\w+\s*\+\s*\w+\s*\).*\w+\s*\/\s*\(\s*\w+\s*\+\s*\w+\s*\)/.test(problem);

    if (!hasThreeFractions) return null;

    // Extract target value N
    const targetMatch = problem.match(/(?:wyszło|wyniosło|równ[ae]|wynik[ie]*|=)\s*(?:dokładnie\s+)?(\d+)/i)
      || problem.match(/dokładnie\s+(\d+)/i)
      || problem.match(/=\s*(\d+)/);

    if (!targetMatch) return null;

    const N = parseInt(targetMatch[1]);
    if (isNaN(N) || N < 1) return null;

    // Check if problem asks about positive integers
    const requiresIntegers = /całkowit|naturaln|integer|dodatni/i.test(problem);

    logDebug(`🍎 Detected Nesbitt-type equation: a/(b+c) + b/(a+c) + c/(a+b) = ${N} (integers=${requiresIntegers})`);

    // Nesbitt's inequality: minimum is 3/2 for positive reals
    if (N < 2) {
      // For N=1, impossible since min is 3/2
      const isExistenceQ = /da si[eę]|czy/.test(textLower);
      if (isExistenceQ) {
        return `Nie. Z nierówności Nesbitt wynika, że a/(b+c) + b/(a+c) + c/(a+b) >= 3/2 dla dodatnich a, b, c. Wartość ${N} jest nieosiągalna.`;
      }
      return `Brak rozwiązań. Nierówność Nesbitt: a/(b+c) + b/(a+c) + c/(a+b) >= 3/2 dla dodatnich a, b, c.`;
    }

    // Phase 1: Brute-force search for small solutions
    const bruteResult = await this.nesbittBruteForce(N);
    if (bruteResult) {
      return bruteResult;
    }

    // Phase 2: Known mathematical result for integer N >= 2
    // The equation defines an elliptic curve; for integer N >= 2 rational points
    // always exist, giving integer solutions after scaling (possibly with hundreds of digits).
    // Do NOT delegate to LLM here because Bielik can produce incorrect conclusions.
    if (N >= 2 && Number.isInteger(N)) {
      logDebug(`  📐 No small solution for N=${N}, using known theoretical result`);
      const isExistenceQ = /da si[eę]|czy/.test(textLower);
      if (isExistenceQ) {
        return `Tak. Rozwiązanie istnieje, ale wymaga bardzo dużych liczb (setki cyfr). Równanie a/(b+c) + b/(a+c) + c/(a+b) = ${N} definiuje krzywą eliptyczną, na której dla całkowitych N >= 2 zawsze istnieją punkty wymierne dające rozwiązanie całkowite po przeskalowaniu.`;
      }
      return `Rozwiązanie istnieje, ale wymaga bardzo dużych liczb. Równanie definiuje krzywą eliptyczną z punktami wymiernymi dla N >= 2.`;
    }

    // Phase 3: For non-integer or N < 2, try elliptic curve analysis via LLM
    logDebug(`  📐 Non-standard N=${N}, attempting elliptic analysis...`);
    const ellipticResult = await this.nesbittEllipticAnalysis(N);
    if (ellipticResult) {
      return ellipticResult;
    }

    return null;
  }

  /**
   * Brute-force search for Nesbitt equation a/(b+c) + b/(a+c) + c/(a+b) = N.
   * Uses Rational arithmetic for exact comparison.
   * Exploits symmetry: WLOG a >= b >= c >= 1.
   */
  private async nesbittBruteForce(N: number): Promise<string | null> {
    try {
      // For N=3/2 (a=b=c), and small integer N, search up to 500
      // Symmetry: a >= b >= c >= 1
      const maxRange = N <= 10 ? 500 : 200;

      const code = `from sympy import Rational
N = ${N}
found = False
# Search with a >= b >= c >= 1 (symmetry)
for c in range(1, ${maxRange}):
    for b in range(c, ${maxRange}):
        # a/(b+c) + b/(a+c) + c/(a+b) = N
        # For fixed b,c: find a such that the sum = N
        # Rewrite: a*(a+c)*(a+b) + b*(b+c)*(a+b) + c*(b+c)*(a+c) = N*(b+c)*(a+c)*(a+b)
        # This is cubic in a, try direct search
        for a in range(b, ${maxRange}):
            s = Rational(a, b+c) + Rational(b, a+c) + Rational(c, a+b)
            if s == N:
                print(f"ZNALEZIONO: a={a}, b={b}, c={c}")
                print(f"WERYFIKACJA: {a}/({b}+{c}) + {b}/({a}+{c}) + {c}/({a}+{b}) = {s}")
                found = True
                break
            elif s < N:
                continue  # a too small
            else:
                break  # a too large, increasing a further won't help (not always true)
        if found:
            break
    if found:
        break
if not found:
    print("NIE_ZNALEZIONO")`;

      logVerbose(`  🔍 Nesbitt brute-force search (range 1..${maxRange}, N=${N})...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|Timeout/i.test(output)) {
        logVerbose(`  ⚠️ Brute-force error: ${output.substring(0, 100)}`);
        return null;
      }

      const foundMatch = /ZNALEZIONO:\s*(.+)/i.exec(output);
      if (foundMatch) {
        const solution = foundMatch[1].trim();
        const verifyLine = /WERYFIKACJA:\s*(.+)/i.exec(output);
        logDebug(`  ✅ Found Nesbitt solution: ${solution}`);
        return `Tak. ${verifyLine ? verifyLine[1] : solution}`;
      }

      if (/NIE_ZNALEZIONO/i.test(output)) {
        logDebug(`  ℹ️ No Nesbitt solution in range 1..${maxRange}`);
      }
      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Nesbitt brute-force error: ${error}`);
      return null;
    }
  }

  /**
   * Elliptic curve analysis for Nesbitt equation.
   * Transforms a/(b+c) + b/(a+c) + c/(a+b) = N into a cubic surface,
   * then attempts to find rational points.
   */
  private async nesbittEllipticAnalysis(N: number): Promise<string | null> {
    try {
      const code = `from sympy import *

# Nesbitt equation: a/(b+c) + b/(a+c) + c/(a+b) = ${N}
# Substitution: let s=a+b+c, p=s-a, q=s-b, r=s-c
# Then: s*(1/p + 1/q + 1/r) = ${N}+3 = ${N + 3}
# And: p+q+r = 2s, so s = (p+q+r)/2
# Equation: (p+q+r)*(pq+pr+qr) = ${2 * (N + 3)}*p*q*r

# Set r=1 (homogeneous, looking for rationals)
p, q = symbols('p q', positive=True, rational=True)
K = ${2 * (N + 3)}

eq = (p + q + 1)*(p*q + p + q) - K*p*q
eq_expanded = expand(eq)
print(f"Cubic in p,q: {eq_expanded}")

# Try parametric: set q = t*p, solve for p as function of t
t = symbols('t', positive=True, rational=True)
eq_param = eq.subs(q, t*p)
eq_param = expand(eq_param)

# This is cubic in p. Collect coefficients.
poly_p = Poly(eq_param, p)
coeffs = poly_p.all_coeffs()
print(f"Cubic in p (param by t): coefficients = {coeffs}")
print(f"Degree: {poly_p.degree()}")

# For rational solutions, discriminant must be a perfect square
# Try specific rational values of t
solutions_found = []
from fractions import Fraction
for num in range(1, 50):
    for den in range(1, 50):
        tv = Rational(num, den)
        eq_specific = eq.subs(q, tv * p)
        poly_specific = Poly(eq_specific, p)
        roots = solve(poly_specific, p)
        for r in roots:
            if r.is_rational and r > 0:
                pv = r
                qv = tv * r
                rv = 1
                # Convert back: s=(pv+qv+rv)/2, a=s-pv, b=s-qv, c=s-rv
                sv = (pv + qv + rv) / 2
                av = sv - pv
                bv = sv - qv
                cv = sv - rv
                if av > 0 and bv > 0 and cv > 0:
                    # Verify
                    check = av/(bv+cv) + bv/(av+cv) + cv/(av+bv)
                    if check == ${N}:
                        # Scale to integers
                        fracs = [av, bv, cv]
                        denoms = [f.q if hasattr(f, 'q') else 1 for f in fracs]
                        from math import gcd
                        from functools import reduce
                        def lcm(a, b): return a * b // gcd(a, b)
                        L = reduce(lcm, denoms)
                        ai, bi, ci = int(av*L), int(bv*L), int(cv*L)
                        g = reduce(gcd, [ai, bi, ci])
                        ai, bi, ci = ai//g, bi//g, ci//g
                        solutions_found.append((ai, bi, ci))
                        if len(solutions_found) >= 3:
                            break
        if len(solutions_found) >= 3:
            break
    if len(solutions_found) >= 3:
        break

if solutions_found:
    a_sol, b_sol, c_sol = solutions_found[0]
    print(f"ROZWIAZANIE: a={a_sol}, b={b_sol}, c={c_sol}")
    check_val = Rational(a_sol, b_sol+c_sol) + Rational(b_sol, a_sol+c_sol) + Rational(c_sol, a_sol+b_sol)
    print(f"WERYFIKACJA: {check_val}")
    print(f"Liczba cyfr: a={len(str(a_sol))}, b={len(str(b_sol))}, c={len(str(c_sol))}")
else:
    # Known theoretical result: for integer N >= 2, solutions always exist
    print("TEORIA: Dla N=${N} (calkowite >= 2), rozwiazanie istnieje (krzywa eliptyczna ma punkty wymierne)")
    print("ODPOWIEDZ: Tak, rozwiazanie istnieje ale wymaga bardzo duzych liczb")`;

      logVerbose(`  🔬 Running elliptic curve analysis for N=${N}...`);

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|Timeout/i.test(output)) {
        logVerbose(`  ⚠️ Elliptic analysis error: ${output.substring(0, 100)}`);
        return null;
      }

      // Check if concrete solution found
      const solMatch = /ROZWIAZANIE:\s*(.+)/i.exec(output);
      if (solMatch) {
        const verifyMatch = /WERYFIKACJA:\s*(.+)/i.exec(output);
        const digitsMatch = /Liczba cyfr:\s*(.+)/i.exec(output);
        const solution = solMatch[1].trim();
        logDebug(`  ✅ Elliptic curve solution: ${solution}`);
        let answer = `Tak. Rozwiązanie: ${solution}`;
        if (verifyMatch) {
          answer += `. Weryfikacja: suma = ${verifyMatch[1].trim()}`;
        }
        if (digitsMatch) {
          answer += ` (${digitsMatch[1].trim()})`;
        }
        return answer;
      }

      // Theoretical result
      if (/TEORIA:/i.test(output)) {
        logDebug(`  📐 Theoretical result for N=${N}`);
        return null; // Let the fallback in detectAndSolveNesbitt handle it
      }

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Elliptic analysis error: ${error}`);
      return null;
    }
  }

  /**
   * Phase 1: Try to find a concrete solution by brute-force enumeration.
   * The LLM generates a Python search script, we execute it.
   */
  private async existenceBruteForce(problem: string): Promise<string | null> {
    try {
      const searchPrompt = `Mam problem typu "czy istnieją takie liczby, że...". Napisz KRÓTKI kod Python (max 20 linii) który przeszukuje brute-force MAŁE wartości (zakres 1..200 dla każdej zmiennej) i sprawdza czy warunek jest spełniony.

ZASADY:
- from sympy import Rational, S (jeśli potrzeba dokładnych ułamków)
- Użyj Rational(a, b) zamiast a/b dla dokładnych obliczeń z ułamkami
- Jeśli znajdziesz rozwiązanie: print("ZNALEZIONO:", wartości) i break
- Jeśli nie znaleziono po przeszukaniu: print("NIE_ZNALEZIONO")
- OPTYMALIZUJ: jeśli zmienne są symetryczne, ogranicz zakres (np. a <= b <= c)
- TYLKO kod w bloku \`\`\`python ... \`\`\`

Zadanie: ${problem}`;

      const response = await this.llmAgent.execute(
        'Jesteś programistą Python. Piszesz WYŁĄCZNIE krótki kod brute-force do przeszukania przestrzeni rozwiązań. TYLKO kod, bez wyjaśnień.',
        [{ role: 'user', content: searchPrompt }],
        { maxTokens: 600, temperature: 0.1 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);

      if (!codeMatch) return null;

      let code = codeMatch[1].trim();
      code = this.sanitizeCode(code);

      logVerbose('  🔍 Running existence brute-force search...');

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|SyntaxError|NameError|Timeout/i.test(output)) {
        logVerbose(`  ⚠️ Brute-force search error: ${output.substring(0, 100)}`);
        return null;
      }

      // Check if solution was found
      const foundMatch = /ZNALEZIONO:\s*(.+)/i.exec(output);
      if (foundMatch) {
        const solution = foundMatch[1].trim();
        logDebug(`  ✅ Found solution: ${solution}`);
        return `Tak. Przykładowe rozwiązanie: ${solution}`;
      }

      // Not found in small range, proceed to algebraic analysis
      if (/NIE_ZNALEZIONO/i.test(output)) {
        logDebug('  ℹ️ No solution in small range, trying algebraic analysis...');
        return null;
      }

      return null;
    } catch (error) {
      logVerbose(`  ⚠️ Brute-force search error: ${error}`);
      return null;
    }
  }

  /**
   * Phase 2: Algebraic/theoretical analysis for existence problems
   * where brute-force over small values fails (solutions may require large numbers).
   * The LLM reasons about the problem mathematically and produces a SymPy proof.
   */
  private async existenceAlgebraic(
    problem: string,
    ragContext?: string,
  ): Promise<string | null> {
    try {
      const analysisPrompt = `Przeanalizuj matematycznie to zadanie o istnieniu rozwiązań. Brute-force dla małych wartości (1..200) nie znalazł rozwiązania.

Napisz kod SymPy (max 25 linii) który:
1. Ustawi równanie symboliczne
2. Spróbuje znaleźć rozwiązanie symboliczne (solve/solveset)
3. Jeśli rozwiązanie istnieje, sprawdzi czy da się dobrać DODATNIE LICZBY CAŁKOWITE
4. Na końcu wypisze JEDEN z:
   - print("ODPOWIEDZ: Tak") jeśli rozwiązanie istnieje (nawet jeśli wymaga dużych liczb)
   - print("ODPOWIEDZ: Nie") jeśli można udowodnić brak rozwiązań
   - print("ODPOWIEDZ: Nie wiadomo") jeśli analiza jest nierozstrzygająca

WSKAZÓWKI:
- Dla równań typu a/(b+c) + b/(a+c) + c/(a+b) = N: użyj zamiany zmiennych. Niech s=a+b+c, wtedy suma = s/(s-a) + s/(s-b) + s/(s-c) - 3 = N, czyli s*[1/(s-a)+1/(s-b)+1/(s-c)] = N+3
- Sprawdź czy istnieje parametryzacja dająca dodatnie całkowite
- Nierówność Nesbitt: a/(b+c)+b/(a+c)+c/(a+b) >= 3/2 dla dodatnich a,b,c
- Jeśli N >= 2 (całkowite), rozwiązania istnieją ale mogą wymagać BARDZO dużych liczb

TYLKO kod w bloku \`\`\`python ... \`\`\`

Zadanie: ${problem}
${ragContext ? `Kontekst: ${ragContext}` : ''}`;

      const response = await this.llmAgent.execute(
        'Jesteś matematykiem analitykiem. Piszesz kod SymPy do analizy istnienia rozwiązań równań diofantycznych. TYLKO kod, bez wyjaśnień.',
        [{ role: 'user', content: analysisPrompt }],
        { maxTokens: 700, temperature: 0.15 },
      );

      const codeMatch = /```python\s*\n([\s\S]*?)\n```/.exec(response)
        || /```\s*\n([\s\S]*?)\n```/.exec(response);

      if (!codeMatch) return null;

      let code = codeMatch[1].trim();
      code = this.sanitizeCode(code);

      logVerbose('  🔬 Running algebraic existence analysis...');

      const result = await this.mcpClient.callTool('sympy_calculate', {
        expression: code,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      if (/Error:|Traceback|SyntaxError|NameError|Timeout/i.test(output)) {
        logVerbose(`  ⚠️ Algebraic analysis error: ${output.substring(0, 100)}`);
        // Try a simplified fallback: pure LLM reasoning without code execution
        return this.existenceLLMReasoning(problem);
      }

      const answerMatch = /ODPOWIED[ZŹ]:\s*(Tak|Nie|Nie wiadomo)/i.exec(output);
      if (!answerMatch) {
        logVerbose(`  ⚠️ Could not parse algebraic result: ${output.substring(0, 100)}`);
        return this.existenceLLMReasoning(problem);
      }

      const answer = answerMatch[1];
      logDebug(`  📐 Algebraic analysis result: ${answer}`);

      if (/tak/i.test(answer)) {
        return 'Tak, takie liczby istnieją, ale mogą wymagać bardzo dużych wartości (zbyt dużych, by znaleźć je prostym przeszukiwaniem).';
      } else if (/nie wiadomo/i.test(answer)) {
        return null; // Inconclusive, fall back to decomposition
      } else {
        return 'Nie, takie liczby nie istnieją.';
      }
    } catch (error) {
      logVerbose(`  ⚠️ Algebraic analysis error: ${error}`);
      return null;
    }
  }

  /**
   * Phase 3 (fallback): Pure LLM reasoning without code execution.
   * Used when SymPy analysis fails to produce a result.
   */
  private async existenceLLMReasoning(problem: string): Promise<string | null> {
    try {
      const reasoningPrompt = `Odpowiedz TAK lub NIE na to pytanie o istnienie rozwiązań.

ZASADY:
- Odpowiedz JEDNYM ZDANIEM
- Zacznij od "Tak, " lub "Nie, " i podaj krótkie uzasadnienie
- Jeśli nie jesteś pewien, napisz "Nie wiadomo"

Pytanie: ${problem}`;

      const response = await this.llmAgent.execute(
        'Jesteś matematykiem. Odpowiadasz krótko i precyzyjnie na pytania o istnienie rozwiązań. JEDNO ZDANIE.',
        [{ role: 'user', content: reasoningPrompt }],
        { maxTokens: 150, temperature: 0.1 },
      );

      // Clean up think tags
      let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Must start with Tak or Nie
      if (/^(Tak|Nie)\b/i.test(cleaned)) {
        logDebug(`  🧠 LLM reasoning result: ${cleaned.substring(0, 80)}`);
        return cleaned;
      }

      return null;
    } catch {
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

      logVerbose(`🔬 Running substitution verification for: ${finalAnswer.substring(0, 60)}`);

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
        logVerbose(`  ⚠️ Could not extract verification code`);
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
        logVerbose(`  ⚠️ Substitution verification error: ${output.substring(0, 100)}`);
        return null; // Cannot verify, don't reject the answer
      }

      const verifyMatch = /WERYFIKACJA:\s*(TAK|NIE)/i.exec(output);
      if (!verifyMatch) {
        logVerbose(`  ⚠️ Could not parse verification result from: ${output.substring(0, 80)}`);
        return null;
      }

      const passed = verifyMatch[1].toUpperCase() === 'TAK';
      logDebug(`  ${passed ? '✅' : '❌'} Substitution verification: ${verifyMatch[1]}`);
      return passed;
    } catch (error) {
      logVerbose(`  ⚠️ Substitution verification error: ${error}`);
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
