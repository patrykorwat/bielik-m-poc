/**
 * Solver Router — Routes classified problems through deterministic solvers to MCP execution.
 *
 * Pipeline: ClassificationResult → buildSolverCode() → MCP execute → extract answer
 */

import { ClassificationResult, SolverResult, ProblemType } from './classifierTypes.js';
import { buildSolverCode } from './deterministicSolvers.js';
import { MCPClientBrowser } from './mcpClientBrowser.js';

// ============================================================
// Answer extraction from SymPy output
// ============================================================

function extractAnswer(output: string): string | null {
  // Pattern 1: "ODPOWIEDZ: value"
  const answerMatch = output.match(/ODPOWIEDZ:\s*(.+)/i);
  if (answerMatch) {
    return answerMatch[1].trim();
  }

  // Pattern 2: Last non-empty line
  const lines = output.trim().split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    return lines[lines.length - 1].trim();
  }

  return null;
}

// ============================================================
// Code sanitization (lightweight — the heavy one is in threeAgentSystem)
// ============================================================

function lightSanitize(code: string): string {
  // Fix common issues in deterministic code
  let fixed = code;

  // Ensure 'from sympy import *' is present
  if (!fixed.includes('from sympy')) {
    fixed = 'from sympy import *\n' + fixed;
  }

  // Replace ^ with ** (in case params contain it)
  fixed = fixed.replace(/(\w)\^(\w)/g, '$1**$2');
  fixed = fixed.replace(/(\))\^(\()/g, '$1**$2');
  fixed = fixed.replace(/(\))\^(\w)/g, '$1**$2');
  fixed = fixed.replace(/(\w)\^(\()/g, '$1**$2');

  // Fix Rational notation
  fixed = fixed.replace(/(\d+)\/(\d+)/g, (_match, a, b) => {
    // Don't replace if inside a string or comment
    return `Rational(${a}, ${b})`;
  });

  return fixed;
}

// ============================================================
// Main router function
// ============================================================

export async function routeAndSolve(
  classification: ClassificationResult,
  mcpClient: MCPClientBrowser,
  sanitizeCode?: (code: string) => string,
): Promise<SolverResult> {
  try {
    // Step 1: Build SymPy code from classification
    let code = buildSolverCode(classification);

    // Step 2: Light sanitization
    code = lightSanitize(code);

    // Save clean code for display before wrapping with boilerplate
    const displayCode = code;

    // Step 3: Apply heavy sanitization if available (from threeAgentSystem)
    if (sanitizeCode) {
      code = sanitizeCode(code);
    }

    // Step 4: Execute via MCP
    const result = await mcpClient.callTool('sympy_calculate', {
      expression: code,
    });

    // Step 5: Extract output
    let output = '';
    if (result.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'text') {
          output += item.text;
        }
      }
    }

    // Step 6: Check for errors or garbage output/code
    const garbageOutputPatterns = [
      'Nieobslugiwane',
      'TODO',
      'undefined',
      'See computation above',
      'Unsupported',
    ];

    // Detect empty/meaningless answers like "ODPOWIEDZ: []", "ODPOWIEDZ: {}", "ODPOWIEDZ: None", "ODPOWIEDZ: "
    const emptyAnswerPatterns = [
      /ODPOWIEDZ:\s*\[\s*\]/i,
      /ODPOWIEDZ:\s*\{\s*\}/i,
      /ODPOWIEDZ:\s*None\s*$/im,
      /ODPOWIEDZ:\s*EmptySet/i,
      /ODPOWIEDZ:\s*$/im,
    ];
    const hasEmptyAnswer = emptyAnswerPatterns.some(p => p.test(output));
    const hasOutputGarbage = garbageOutputPatterns.some(p => output.includes(p));

    // Also check the generated code for signs the solver produced nonsense
    const garbageCodePatterns = [
      "symbols('undefined'",
      'symbols("undefined"',
      "= undefined",
      'f = undefined',
      'print("ODPOWIEDZ: TODO"',
      "print('ODPOWIEDZ: TODO'",
    ];

    // Detect when executor solves for a variable not present in the equation
    // e.g. solve(Eq(x - y - 2, 0), r) where r is not in the equation
    const solveForWrongVar = code.match(/solve\s*\(\s*(?:Eq\s*\()?([^)]+)\)\s*,\s*(\w+)/);
    if (solveForWrongVar) {
      const eqPart = solveForWrongVar[1];
      const solveVar = solveForWrongVar[2];
      // If the variable being solved for doesn't appear in the equation expression
      if (!eqPart.includes(solveVar)) {
        return {
          code,
          displayCode,
          output,
          solverType: classification.type,
          success: false,
          error: `Solver solved for '${solveVar}' which is not in the equation`,
        };
      }
    }
    const hasCodeGarbage = garbageCodePatterns.some(p => code.includes(p));

    const isError = result.isError ||
      output.includes('Traceback') ||
      output.includes('Error:') ||
      output.includes('SyntaxError') ||
      output.includes('NameError') ||
      output.includes('TypeError') ||
      hasOutputGarbage ||
      hasCodeGarbage ||
      hasEmptyAnswer;

    if (isError) {
      return {
        code,
        displayCode,
        output,
        solverType: classification.type,
        success: false,
        error: output.substring(0, 500),
      };
    }

    // Step 7: Extract answer
    const answer = extractAnswer(output);

    return {
      code,
      displayCode,
      output,
      answer: answer || undefined,
      solverType: classification.type,
      success: !!answer,
    };
  } catch (err) {
    return {
      code: '',
      solverType: classification.type,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================
// Retry with modified params
// ============================================================

export async function routeAndSolveWithRetry(
  classification: ClassificationResult,
  mcpClient: MCPClientBrowser,
  sanitizeCode?: (code: string) => string,
  maxRetries: number = 2,
): Promise<SolverResult> {
  let lastResult = await routeAndSolve(classification, mcpClient, sanitizeCode);

  if (lastResult.success) {
    return lastResult;
  }

  // Retry with small modifications
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[SolverRouter] Retry ${attempt}/${maxRetries} for ${classification.type}`);

    // Modify classification slightly for retry
    const modified = { ...classification };

    if (attempt === 1) {
      // Try with GENERAL type as fallback (uses expression directly)
      if (classification.type !== ProblemType.GENERAL) {
        modified.type = ProblemType.GENERAL;
        modified.params = {
          description: classification.rawQuestion,
          expression: (classification.params as any).expression || undefined,
        };
      }
    }

    lastResult = await routeAndSolve(modified, mcpClient, sanitizeCode);
    if (lastResult.success) {
      return lastResult;
    }
  }

  return lastResult;
}

// ============================================================
// Exports
// ============================================================

export { extractAnswer, lightSanitize };
