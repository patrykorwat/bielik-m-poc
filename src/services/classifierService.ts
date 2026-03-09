/**
 * Classifier Service — Extract structured JSON from LLM classification of math problems.
 *
 * Calls the 11B model with a classifier prompt, extracts JSON with problem type + params.
 * Robust parsing handles markdown fences, partial JSON, and common LLM output quirks.
 */

import { LLMAgent } from './mlxAgent.js';
import {
  ProblemType,
  ClassificationResult,
  CLASSIFIER_CONFIDENCE_THRESHOLD,
} from './classifierTypes.js';

// ============================================================
// JSON Extraction from LLM output
// ============================================================

function extractJSON(text: string): Record<string, any> | null {
  // Strategy 1: Look for JSON in ```json ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch { /* continue */ }
  }

  // Strategy 2: Find the outermost { ... } block
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.substring(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Try fixing common issues
          const fixed = candidate
            .replace(/'/g, '"')                          // single → double quotes
            .replace(/,\s*}/g, '}')                      // trailing commas
            .replace(/,\s*]/g, ']')                      // trailing commas in arrays
            .replace(/(\w+):/g, '"$1":')                 // unquoted keys
            .replace(/""/g, '"');                         // double-double quotes fix
          try {
            return JSON.parse(fixed);
          } catch { /* continue searching */ }
        }
        start = -1;
      }
    }
  }

  // Strategy 3: Try the entire text as JSON
  try {
    return JSON.parse(text.trim());
  } catch { /* give up */ }

  return null;
}

// ============================================================
// LaTeX → SymPy conversion for LLM params
// ============================================================

function latexToSymPy(expr: string): string {
  if (!expr || typeof expr !== 'string') return String(expr || '0');
  let s = expr.trim();
  // Remove LaTeX wrappers
  s = s.replace(/\$/g, '').replace(/\\,/g, '');
  // Remove assignment (T(t) = ... → just the RHS)
  if (s.includes('=') && !s.includes('==') && !s.includes('!=') && !s.includes('<=') && !s.includes('>=')) {
    const parts = s.split('=');
    if (parts.length === 2) {
      const lhs = parts[0].trim();
      const rhs = parts[1].trim();
      if (/^[A-Za-z_]\w*(\([^)]*\))?$/.test(lhs) && rhs.length > 0) {
        s = rhs;
      }
    }
  }
  // LaTeX → Python
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)');
  s = s.replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)');
  s = s.replace(/\\sqrt\s+(\d+)/g, 'sqrt($1)');
  s = s.replace(/\\pi/g, 'pi').replace(/\\infty/g, 'oo').replace(/\\cdot/g, '*');
  s = s.replace(/\\ln/g, 'log').replace(/\\log/g, 'log');
  s = s.replace(/\\sin/g, 'sin').replace(/\\cos/g, 'cos').replace(/\\tan/g, 'tan');
  s = s.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  s = s.replace(/\\[a-zA-Z]+/g, '');
  // Fix implicit multiplication: 2x → 2*x, 3sin → 3*sin
  s = s.replace(/(\d)([a-zA-Z(])/g, '$1*$2');
  // ^ → **
  s = s.replace(/\^/g, '**');
  // (a)(b) → (a)*(b)
  s = s.replace(/\)\(/g, ')*(');
  // log_base(x) → log(x, base)
  s = s.replace(/log_(\d+)\(([^)]+)\)/g, 'log($2, $1)');
  s = s.replace(/log_\{(\d+)\}\(([^)]+)\)/g, 'log($2, $1)');
  // (a)/(b) with pure numbers → Rational
  s = s.replace(/\((\d+)\)\/\((\d+)\)/g, 'Rational($1, $2)');
  return s.trim();
}

function sanitizeParams(params: Record<string, any>): Record<string, any> {
  const exprKeys = new Set([
    'expression', 'equation', 'function_expr', 'lhs', 'rhs', 'approach', 'point',
    'tangent_point', 'domain_start', 'domain_end', 'eval_point',
    'a1', 'd', 'q', 'n', 'an', 'sum', 'p', 'favorable_outcomes', 'total_outcomes',
  ]);

  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && exprKeys.has(k)) {
      result[k] = latexToSymPy(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = sanitizeParams(v);
    } else if (Array.isArray(v)) {
      result[k] = v.map(item =>
        typeof item === 'string' ? latexToSymPy(item) :
        (item && typeof item === 'object' ? sanitizeParams(item) : item)
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ============================================================
// Validate and normalize classification result
// ============================================================

function normalizeType(raw: string): ProblemType {
  const normalized = raw.toLowerCase().trim().replace(/[-\s]/g, '_');

  // Direct match
  if (Object.values(ProblemType).includes(normalized as ProblemType)) {
    return normalized as ProblemType;
  }

  // Fuzzy matching for common variations
  const aliases: Record<string, ProblemType> = {
    'granica': ProblemType.LIMIT,
    'limes': ProblemType.LIMIT,
    'pochodna': ProblemType.DERIVATIVE,
    'styczna': ProblemType.DERIVATIVE,
    'tangent': ProblemType.DERIVATIVE,
    'derivative_tangent': ProblemType.DERIVATIVE,
    'trygonometria': ProblemType.TRIG_EQUATION,
    'trig': ProblemType.TRIG_EQUATION,
    'wielomian': ProblemType.POLYNOMIAL_ROOTS,
    'polynomial': ProblemType.POLYNOMIAL_ROOTS,
    'logarytm': ProblemType.LOGARITHM,
    'log': ProblemType.LOGARITHM,
    'prawdopodobienstwo': ProblemType.PROBABILITY,
    'probability_bernoulli': ProblemType.PROBABILITY,
    'kombinatoryka': ProblemType.COMBINATORICS,
    'ciag_arytmetyczny': ProblemType.SEQUENCE_ARITHMETIC,
    'arithmetic': ProblemType.SEQUENCE_ARITHMETIC,
    'ciag_geometryczny': ProblemType.SEQUENCE_GEOMETRIC,
    'geometric': ProblemType.SEQUENCE_GEOMETRIC,
    'sequence': ProblemType.SEQUENCE_ARITHMETIC,
    'parametr': ProblemType.PARAMETRIC_EQUATION,
    'parametric': ProblemType.PARAMETRIC_EQUATION,
    'geometria_analityczna': ProblemType.GEOMETRY_ANALYTIC,
    'analytic': ProblemType.GEOMETRY_ANALYTIC,
    'stereometria': ProblemType.GEOMETRY_SOLID,
    'solid': ProblemType.GEOMETRY_SOLID,
    'bryla': ProblemType.GEOMETRY_SOLID,
    'pole': ProblemType.GEOMETRY_AREA,
    'area': ProblemType.GEOMETRY_AREA,
    'optymalizacja': ProblemType.OPTIMIZATION,
    'optimize': ProblemType.OPTIMIZATION,
    'nierownosc': ProblemType.INEQUALITY,
    'dowod': ProblemType.PROOF,
    'proof': ProblemType.PROOF,
    'funkcja': ProblemType.FUNCTION_PROPERTIES,
    'function': ProblemType.FUNCTION_PROPERTIES,
    'ogolne': ProblemType.GENERAL,
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  // Partial match
  for (const [alias, type] of Object.entries(aliases)) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return type;
    }
  }

  return ProblemType.GENERAL;
}

function validateClassification(raw: Record<string, any>, question: string): ClassificationResult {
  const type = normalizeType(raw.type || raw.problem_type || raw.category || 'general');
  const confidence = typeof raw.confidence === 'number'
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0.5;  // default if missing

  const rawParams = raw.params || raw.parameters || raw;
  const params = sanitizeParams(rawParams);

  // Detect MC from question text
  const isMultipleChoice = /\b[ABCD]\.\s/.test(question) || /opcj[aei]/i.test(question);

  let mcOptions: { A: string; B: string; C: string; D: string } | undefined;
  if (isMultipleChoice) {
    // Try to extract from raw classification
    if (raw.mc_options || raw.options) {
      const opts = raw.mc_options || raw.options;
      mcOptions = {
        A: String(opts.A || opts.a || ''),
        B: String(opts.B || opts.b || ''),
        C: String(opts.C || opts.c || ''),
        D: String(opts.D || opts.d || ''),
      };
    } else {
      // Try to extract from question text
      mcOptions = extractMCOptionsFromQuestion(question);
    }
  }

  return {
    type,
    params: params as any,
    confidence,
    rawQuestion: question,
    isMultipleChoice,
    mcOptions,
  };
}

function extractMCOptionsFromQuestion(question: string): { A: string; B: string; C: string; D: string } | undefined {
  const options: Record<string, string> = {};

  // Pattern: "A. value" or "A) value"
  const pattern = /([ABCD])[.)]\s*(.+?)(?=\s*[ABCD][.)]\s|$)/gs;
  let match;
  while ((match = pattern.exec(question)) !== null) {
    options[match[1]] = match[2].trim();
  }

  if (options.A && options.B && options.C && options.D) {
    return options as { A: string; B: string; C: string; D: string };
  }

  // Pattern: "$A$. value" or LaTeX-wrapped
  const latexPattern = /\$?([ABCD])\$?[.)]\s*\$?(.+?)\$?(?=\s*\$?[ABCD]\$?[.)]\s|$)/gs;
  while ((match = latexPattern.exec(question)) !== null) {
    options[match[1]] = match[2].trim()
      .replace(/^\$/, '').replace(/\$$/, '')  // strip dollar signs
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)')
      .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
      .replace(/\\cdot/g, '*')
      .replace(/\\pi/g, 'pi');
  }

  if (options.A && options.B && options.C && options.D) {
    return options as { A: string; B: string; C: string; D: string };
  }

  return undefined;
}

// ============================================================
// Main classifier function
// ============================================================

export async function classifyProblem(
  question: string,
  classifierPrompt: string,
  llmAgent: LLMAgent,
  ragContext?: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<ClassificationResult> {
  // Build the user message with optional RAG context
  let userMessage = question;
  if (ragContext) {
    userMessage = `${ragContext}\n\n--- ZADANIE ---\n${userMessage}`;
  }

  // Call LLM
  const response = await llmAgent.execute(
    classifierPrompt,
    [{ role: 'user', content: userMessage }],
    {
      maxTokens: options?.maxTokens || 400,
      temperature: options?.temperature || 0.1,
    }
  );

  // Strip <think> blocks if present
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Extract JSON
  const parsed = extractJSON(cleaned);

  if (!parsed) {
    console.warn('[Classifier] Failed to extract JSON from response:', cleaned.substring(0, 200));
    return {
      type: ProblemType.GENERAL,
      params: { description: question },
      confidence: 0.0,  // Will trigger fallback
      rawQuestion: question,
      isMultipleChoice: /\b[ABCD]\.\s/.test(question),
    };
  }

  return validateClassification(parsed, question);
}

// ============================================================
// Check if classification should use fallback
// ============================================================

export function shouldUseFallback(classification: ClassificationResult): boolean {
  if (classification.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
    return true;
  }
  if (classification.type === ProblemType.PROOF) {
    return true;
  }
  if (classification.type === ProblemType.GENERAL && classification.confidence < 0.8) {
    return true;
  }
  return false;
}

// ============================================================
// Exports for testing
// ============================================================

export {
  extractJSON,
  normalizeType,
  validateClassification,
  extractMCOptionsFromQuestion,
};
