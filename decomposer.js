/**
 * Problem Decomposer: breaks complex math problems into 2-4 sub-tasks,
 * solves each via direct SymPy formula execution, then aggregates results.
 *
 * Accepts pipeline helpers (llmCall, callSymPy, etc.) as arguments so it
 * stays decoupled from the rest of the pipeline internals.
 */

const DECOMPOSITION_SYSTEM_PROMPT = `Rozbij zadanie na 2-4 PROSTYCH pod-zadań. Każde pod-zadanie = JEDEN wzór SymPy.

KRYTYCZNE ZASADY:
1. W "description" ZAWSZE podaj KONKRETNY WZÓR MATEMATYCZNY (np. "Oblicz binomial(5,3)" NIE "Oblicz liczbę sposobów")
2. W "sympy_formula" podaj DOKŁADNY kod SymPy (1 linia) z KONKRETNYMI LICZBAMI
3. OSTATNIE pod-zadanie = formuła łącząca wyniki: "WYNIK_1 * WYNIK_2 - WYNIK_3"
4. Maksymalnie 3 kroki! Im mniej kroków, tym lepiej.

⚠️ TYPOWE BŁĘDY:
- Liczby n-cyfrowe: 0 NIE MOŻE być pierwszą cyfrą!
- NIE rozbijaj na >3 kroki
- NIE rób osobnego kroku na factorial(5)

FORMA — TYLKO JSON, nic więcej:

PRZYKŁAD 1 — Kombinatoryka z cyframi:
Zadanie: Ile jest 5-cyfrowych liczb z 3 nieparzyste i 2 parzyste cyfry bez powtórzeń?
{
  "subtasks": [
    {"id": 1, "description": "Wybór 3 nieparzystych z 5: binomial(5,3)", "sympy_formula": "binomial(5, 3)", "depends_on": [], "expected_output": "number"},
    {"id": 2, "description": "Wybór 2 parzystych z 5: binomial(5,2)", "sympy_formula": "binomial(5, 2)", "depends_on": [], "expected_output": "number"},
    {"id": 3, "description": "Permutacje minus 0 na początku: WYNIK_1*WYNIK_2*factorial(5) - WYNIK_1*binomial(4,1)*factorial(4)", "sympy_formula": "WYNIK_1 * WYNIK_2 * factorial(5) - WYNIK_1 * binomial(4, 1) * factorial(4)", "depends_on": [1, 2], "expected_output": "number"}
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

WAŻNE:
- "sympy_formula" = GOTOWY wzór SymPy z KONKRETNYMI LICZBAMI
- Użyj WYNIK_1, WYNIK_2 gdy krok zależy od poprzedniego
- Ostatni krok MUSI dać JEDNĄ liczbę = odpowiedź`;

// ── JSON parsing (tolerant of LLM quirks) ─────────────────────────────

function parseDecompositionJSON(response) {
  let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const jsonFence = /```json\s*\n([\s\S]*?)\n```/.exec(cleaned);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1]); } catch { /* continue */ }
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      let fixed = jsonMatch[0]
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/""/g, '"');
      return JSON.parse(fixed);
    } catch {
      try { return JSON.parse(jsonMatch[0]); } catch { /* give up */ }
    }
  }
  return null;
}

// ── Topological sort ──────────────────────────────────────────────────

function topologicalSort(tasks) {
  const sorted = [];
  const visited = new Set();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task) return;
    for (const depId of task.depends_on) {
      visit(depId);
    }
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }
  return sorted;
}

// ── Execute a single SymPy formula ────────────────────────────────────

async function executeFormula(formula, callSymPy) {
  try {
    const hasSolve = /\b(solve|solveset|nsolve)\s*\(/.test(formula);
    const hasMultiLine = formula.includes('\n') || formula.includes(';');

    let code;
    if (hasMultiLine) {
      code = formula.startsWith('from sympy') ? formula : `from sympy import *\n${formula}`;
      if (!code.includes('print(')) code += `\nprint("ODPOWIEDZ:", wynik)`;
    } else if (hasSolve) {
      code = `from sympy import *\n_result = ${formula}\nwynik = _result[0] if isinstance(_result, list) and len(_result) > 0 else _result\nprint("ODPOWIEDZ:", wynik)`;
    } else {
      code = `from sympy import *\nwynik = ${formula}\nprint("ODPOWIEDZ:", wynik)`;
    }

    console.log(`  🧮 Executing formula: ${formula.substring(0, 60)}`);

    const output = await callSymPy(code);

    if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) {
      console.log(`  ⚠️ Formula execution error: ${output.substring(0, 80)}`);
      return null;
    }

    const answerMatch = /ODPOWIED[ZŹ]:\s*(.+)/i.exec(output);
    const answer = answerMatch ? answerMatch[1].trim() : null;

    if (!answer || answer.toLowerCase() === 'none') return null;

    return { answer, code, output };
  } catch {
    return null;
  }
}

// ── Solve a sub-task via direct code generation (LLM fallback) ────────

async function solveSubTaskViaLLM(description, llmCall, callSymPy, extractPythonCode, stripThink) {
  try {
    const codePrompt = `Napisz JEDEN krótki blok kodu Python/SymPy (max 8 linii) który rozwiąże to pod-zadanie.
ZASADY:
- from sympy import *
- Podstaw KONKRETNE wartości liczbowe (nie symbole)
- Ostatnia linia: print("ODPOWIEDZ:", wynik)
- NIE pisz wyjaśnień, TYLKO kod w bloku \`\`\`python ... \`\`\`

Pod-zadanie: ${description}`;

    const response = await llmCall('decompose_subtask',
      'Jestes kompilatorem SymPy. Odpowiadasz WYLACZNIE blokiem kodu Python.',
      [{ role: 'user', content: codePrompt }],
      { maxTokens: 400, temperature: 0.1 },
    );

    const code = extractPythonCode(stripThink(response));
    if (!code) return null;

    const output = await callSymPy(code);

    if (/Error:|Traceback|SyntaxError|NameError/i.test(output)) return null;

    const answerMatch = /ODPOWIED[ZŹ]:\s*(.+)/i.exec(output);
    const answer = answerMatch ? answerMatch[1].trim() : null;

    if (!answer || answer.toLowerCase() === 'none') return null;

    return { answer, code, output };
  } catch {
    return null;
  }
}

// ── Main decompose function ───────────────────────────────────────────

export async function decompose(problem, ragContext, llmCall, callSymPy, extractPythonCode, stripThink) {
  console.log('✂️ Decomposer: Starting decomposition...');

  const empty = {
    success: false,
    subTasks: [],
    subResults: [],
    error: 'Decomposition failed',
    totalSteps: 0,
    stepsCompleted: 0,
  };

  // Step 1: LLM decomposes the problem
  try {
    const userPrompt = ragContext
      ? `Kontekst:\n${ragContext}\n\nZadanie do rozbicia:\n${problem}`
      : `Zadanie do rozbicia:\n${problem}`;

    const response = await llmCall('decompose', DECOMPOSITION_SYSTEM_PROMPT, [
      { role: 'user', content: userPrompt },
    ], { maxTokens: 600, temperature: 0.15 });

    const parsed = parseDecompositionJSON(response);
    if (!parsed?.subtasks?.length) {
      console.warn('⚠️ Failed to parse decomposition response');
      return { ...empty, error: 'Failed to parse decomposition JSON' };
    }

    const subTasks = topologicalSort(
      parsed.subtasks
        .filter(t => t.id && (t.description || t.sympy_formula))
        .map(t => ({
          id: Number(t.id),
          description: String(t.description || t.sympy_formula || ''),
          sympy_formula: t.sympy_formula ? String(t.sympy_formula) : undefined,
          depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(Number) : [],
          expected_output: String(t.expected_output || 'number'),
        }))
    );

    console.log(`📋 Decomposed into ${subTasks.length} sub-tasks`);

    // Step 2: Solve each sub-task in dependency order
    const subResults = [];
    const resultMap = new Map();

    for (const task of subTasks) {
      // Inject results from dependencies
      let taskFormula = task.sympy_formula || '';
      let taskDescription = task.description;
      for (const depId of task.depends_on) {
        const depResult = resultMap.get(depId);
        if (depResult) {
          const pattern = new RegExp(`WYNIK_${depId}`, 'g');
          taskDescription = taskDescription.replace(pattern, depResult);
          taskFormula = taskFormula.replace(pattern, depResult);
        }
      }

      console.log(`🔧 Sub-task ${task.id}/${subTasks.length}: ${taskFormula || taskDescription.substring(0, 80)}...`);

      let result = null;

      // Try direct formula first
      if (taskFormula) {
        result = await executeFormula(taskFormula, callSymPy);
        if (result) result.pipeline = 'direct_formula';
      }

      // Fallback to LLM code generation
      if (!result) {
        result = await solveSubTaskViaLLM(taskDescription, llmCall, callSymPy, extractPythonCode, stripThink);
        if (result) result.pipeline = 'llm_code';
      }

      if (result) {
        resultMap.set(task.id, result.answer);
        subResults.push({ subTaskId: task.id, success: true, ...result });
        console.log(`✅ Sub-task ${task.id} solved: ${result.answer}`);
      } else {
        subResults.push({ subTaskId: task.id, success: false, error: 'All attempts failed' });
        console.log(`❌ Sub-task ${task.id} failed`);
      }
    }

    // Step 3: Final answer from last sub-task
    const lastTask = subTasks[subTasks.length - 1];
    const finalAnswer = resultMap.get(lastTask.id);
    const completedCount = subResults.filter(r => r.success).length;

    return {
      success: !!finalAnswer,
      subTasks,
      subResults,
      finalAnswer: finalAnswer || null,
      totalSteps: subTasks.length,
      stepsCompleted: completedCount,
    };
  } catch (error) {
    console.error('❌ Decomposition failed:', error);
    return { ...empty, error: error.message || String(error) };
  }
}
