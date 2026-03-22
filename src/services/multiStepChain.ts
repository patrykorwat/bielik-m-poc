/**
 * Multi-Step Extraction Chain (Level 3) — Sequential extraction for complex problems.
 *
 * For problems too complex for a single extraction, we break them into steps:
 *   Step 1: Extract raw values from the problem text
 *   Step 2: Classify the mathematical method needed
 *   Step 3: Build deterministic computation from extracted values + method
 *
 * This replaces the three-agent pipeline (Analytical→Executor→Summary) with a
 * more controlled extraction→compute pipeline where the LLM never writes code.
 */

import { LLMAgent } from './mlxAgent.js';
import { MCPClientBrowser } from './mcpClientBrowser.js';
import { extractJSON } from './classifierService.js';
import {
  ExtractionTemplate,
  matchTemplate,
  buildExtractionSystemPrompt,
} from './extractionTemplates.js';
import { logDebug, logVerbose, logWarn } from './logger';

// ============================================================
// Types
// ============================================================

export interface ChainStep {
  name: string;
  prompt: string;
  response?: string;
  extractedValues?: Record<string, any>;
}

export interface ChainResult {
  success: boolean;
  answer?: string;
  code?: string;
  output?: string;
  error?: string;
  steps: ChainStep[];
  templateUsed?: string;
}

// ============================================================
// Step 1: Extract values from problem (LLM call)
// ============================================================

async function extractValues(
  question: string,
  template: ExtractionTemplate,
  llmAgent: LLMAgent,
  maxTokens: number = 400,
): Promise<{ values: Record<string, any> | null; raw: string }> {
  const systemPrompt = buildExtractionSystemPrompt(template);

  logDebug(`[extractValues] Template: ${template.id}, maxTokens: ${maxTokens}`);
  logDebug(`[extractValues] System prompt length: ${systemPrompt.length}`);

  const response = await llmAgent.execute(
    systemPrompt,
    [{ role: 'user', content: question }],
    { maxTokens, temperature: 0.1 }
  );

  logVerbose(`[extractValues] Raw LLM response (first 500 chars): ${response.substring(0, 500)}`);

  // Strip <think> blocks
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  logVerbose(`[extractValues] Cleaned response (first 500 chars): ${cleaned.substring(0, 500)}`);

  // Extract JSON
  const parsed = extractJSON(cleaned);

  if (parsed) {
    logVerbose(`[extractValues] Parsed JSON:`, JSON.stringify(parsed));
  } else {
    logWarn(`[extractValues] FAILED to parse JSON from cleaned response`);
  }

  return { values: parsed, raw: cleaned };
}

// ============================================================
// Step 2: Build and execute code
// ============================================================

async function executeTemplate(
  template: ExtractionTemplate,
  values: Record<string, any>,
  mcpClient: MCPClientBrowser,
  sanitizeCode: (code: string) => string,
  mcOptions?: Record<string, string>,
): Promise<{ success: boolean; answer?: string; code: string; output: string }> {
  // Build code from template + extracted values
  let code = template.buildCode(values, mcOptions);

  logDebug(`[executeTemplate] Template: ${template.id}, values:`, JSON.stringify(values));
  logVerbose(`[executeTemplate] Generated code:\n${code}`);

  // Sanitize
  code = sanitizeCode(code);

  // Execute via MCP
  try {
    const result = await mcpClient.callTool('sympy_calculate', {
      expression: code,
    });

    let output = '';
    if (result.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'text') {
          output += item.text;
        }
      }
    }

    // Check for errors
    const isError = result.isError ||
      output.includes('Traceback') ||
      output.includes('Error:') ||
      output.includes('SyntaxError') ||
      output.includes('NameError') ||
      output.includes('TypeError');

    logDebug(`[executeTemplate] Output: ${output.substring(0, 300)}, isError: ${isError}`);

    if (isError) {
      return { success: false, code, output, answer: undefined };
    }

    // Extract answer
    const answerMatch = output.match(/ODPOWIEDZ:\s*(.+)/i);
    const answer = answerMatch ? answerMatch[1].trim() : null;

    return { success: !!answer, answer: answer || undefined, code, output };
  } catch (err) {
    return {
      success: false,
      code,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================
// Main Chain Executor
// ============================================================

export async function runExtractionChain(
  question: string,
  llmAgent: LLMAgent,
  mcpClient: MCPClientBrowser,
  sanitizeCode: (code: string) => string,
  options?: {
    classifiedType?: string;
    mcOptions?: Record<string, string>;
    maxTokens?: number;
  }
): Promise<ChainResult> {
  const steps: ChainStep[] = [];

  // Step 1: Match a template
  logDebug(`[runExtractionChain] classifiedType=${options?.classifiedType}, question length=${question.length}`);
  const template = matchTemplate(question, options?.classifiedType);

  if (!template) {
    logWarn(`[runExtractionChain] No template matched (threshold=2). Question first 200 chars: ${question.substring(0, 200)}`);
    return {
      success: false,
      error: 'No matching extraction template found',
      steps,
    };
  }

  logDebug(`[runExtractionChain] Matched template: ${template.id} (${template.name})`);

  steps.push({
    name: 'Template Match',
    prompt: `Matched template: ${template.id} (${template.name})`,
  });

  // Step 2: Extract values via LLM
  const { values, raw } = await extractValues(
    question,
    template,
    llmAgent,
    options?.maxTokens || 400,
  );

  steps.push({
    name: 'Value Extraction',
    prompt: template.extractionPrompt,
    response: raw,
    extractedValues: values || undefined,
  });

  if (!values) {
    return {
      success: false,
      error: 'Failed to extract values from problem',
      steps,
      templateUsed: template.id,
    };
  }

  // Step 3: Build and execute code
  const execResult = await executeTemplate(
    template,
    values,
    mcpClient,
    sanitizeCode,
    options?.mcOptions,
  );

  steps.push({
    name: 'Computation',
    prompt: `Template: ${template.id}, Code length: ${execResult.code.length}`,
    response: execResult.output,
  });

  return {
    success: execResult.success,
    answer: execResult.answer,
    code: execResult.code,
    output: execResult.output,
    steps,
    templateUsed: template.id,
  };
}

// ============================================================
// Multi-step chain for very complex problems
// Uses multiple LLM calls to progressively extract information
// ============================================================

export async function runMultiStepChain(
  question: string,
  llmAgent: LLMAgent,
  mcpClient: MCPClientBrowser,
  sanitizeCode: (code: string) => string,
  options?: {
    mcOptions?: Record<string, string>;
    maxTokens?: number;
  }
): Promise<ChainResult> {
  const steps: ChainStep[] = [];

  // Step 1: Ask Bielik to identify what type of problem and what values are given
  const classifyPrompt = `Przeanalizuj zadanie matematyczne i wyodrębnij:
1. Typ zadania (jedno z: potegi, logarytmy, rownanie_kwadratowe, nierownosc, ciag_arytmetyczny, ciag_geometryczny, prawdopodobienstwo, trygonometria, geometria_analityczna, geometria_przestrzenna, pochodna, styczna, dowod, funkcja)
2. Wszystkie dane liczbowe podane w zadaniu
3. Co jest szukane

Odpowiedz TYLKO JSON:
{
  "problem_type": "<typ>",
  "given_values": {"<nazwa>": "<wartość>", ...},
  "find": "<co szukane>",
  "method_hint": "<krótki opis metody>"
}`;

  const classifyResponse = await llmAgent.execute(
    classifyPrompt,
    [{ role: 'user', content: question }],
    { maxTokens: 300, temperature: 0.1 }
  );

  const cleanedClassify = classifyResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const classifyResult = extractJSON(cleanedClassify);

  steps.push({
    name: 'Problem Analysis',
    prompt: classifyPrompt,
    response: cleanedClassify,
    extractedValues: classifyResult || undefined,
  });

  if (!classifyResult) {
    return { success: false, error: 'Failed to analyze problem', steps };
  }

  // Step 2: Try to match a specific template based on analysis
  const template = matchTemplate(question, classifyResult.problem_type);

  if (template) {
    // Use template-based extraction
    const { values, raw } = await extractValues(question, template, llmAgent, options?.maxTokens || 400);

    steps.push({
      name: 'Template Extraction',
      prompt: template.extractionPrompt,
      response: raw,
      extractedValues: values || undefined,
    });

    if (values) {
      const execResult = await executeTemplate(template, values, mcpClient, sanitizeCode, options?.mcOptions);
      steps.push({
        name: 'Template Execution',
        prompt: `Template: ${template.id}`,
        response: execResult.output,
      });

      if (execResult.success) {
        return {
          success: true,
          answer: execResult.answer,
          code: execResult.code,
          output: execResult.output,
          steps,
          templateUsed: template.id,
        };
      }
    }
  }

  // Step 3: Fallback — build simple SymPy from extracted values
  // This is a "guided generation" where we tell Bielik exactly what to compute
  const givenValues = classifyResult.given_values || {};
  const methodHint = classifyResult.method_hint || '';
  const findWhat = classifyResult.find || '';

  const guidedPrompt = `Masz następujące dane z zadania:
${JSON.stringify(givenValues, null, 2)}

Metoda: ${methodHint}
Szukane: ${findWhat}

Napisz MINIMALNY kod SymPy (max 10 linii) który oblicza szukaną wartość.
Używaj WYŁĄCZNIE:
- from sympy import *
- symbols(), Rational(), sqrt(), sin(), cos(), tan(), log(), pi
- solve(), simplify(), expand(), diff()
- print("ODPOWIEDZ:", wynik)

WAŻNE: Użyj zmiennych liczbowych, NIE symboli. Podstaw wartości bezpośrednio.
Odpowiedz WYŁĄCZNIE kodem Python, bez tekstu.`;

  const guidedResponse = await llmAgent.execute(
    guidedPrompt,
    [{ role: 'user', content: question }],
    { maxTokens: options?.maxTokens || 500, temperature: 0.1 }
  );

  const cleanedGuided = guidedResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Extract code from response
  let code = cleanedGuided;
  const codeMatch = cleanedGuided.match(/```(?:python)?\s*([\s\S]*?)```/);
  if (codeMatch) {
    code = codeMatch[1].trim();
  }

  // Ensure it has import
  if (!code.includes('from sympy')) {
    code = 'from sympy import *\n' + code;
  }

  code = sanitizeCode(code);

  steps.push({
    name: 'Guided Code Generation',
    prompt: guidedPrompt,
    response: cleanedGuided,
  });

  // Execute
  try {
    const result = await mcpClient.callTool('sympy_calculate', { expression: code });
    let output = '';
    if (result.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'text') output += item.text;
      }
    }

    const isError = result.isError || output.includes('Traceback') || output.includes('Error:');
    const answerMatch = output.match(/ODPOWIEDZ:\s*(.+)/i);
    const answer = answerMatch ? answerMatch[1].trim() : null;

    steps.push({
      name: 'Execution',
      prompt: code,
      response: output,
    });

    return {
      success: !isError && !!answer,
      answer: answer || undefined,
      code,
      output,
      steps,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      steps,
    };
  }
}
