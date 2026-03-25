/**
 * Server-side solve pipeline.
 *
 * Runs the full multi-agent pipeline in one process so that
 * dd-trace / LLM Observability sees a single workflow span
 * containing every LLM call as a nested child span.
 *
 * Streams progress back via SSE.
 */

import tracer from 'dd-trace';
import OpenAI from 'openai';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const llmobs = tracer.llmobs;

// ── Load prompts ──────────────────────────────────────────────────────

const prompts = JSON.parse(readFileSync(join(__dirname, 'prompts.json'), 'utf8'));

// ── LLM client ────────────────────────────────────────────────────────

const LLM_BASE_URL = process.env.LLM_API_URL
  ? `${process.env.LLM_API_URL}/v1`
  : 'http://localhost:8011/v1';

const LLM_API_KEY = process.env.LLM_API_KEY || 'no-key';
const MODEL = process.env.LLM_MODEL || prompts.model?.default || 'bielik';

function createClient() {
  return new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL });
}

// ── Helper: call LLM inside an llmobs span ────────────────────────────

async function llmCall(name, systemPrompt, messages, opts = {}) {
  const { maxTokens = 500, temperature = 0.2 } = opts;

  return llmobs.trace({
    kind: 'llm',
    name,
    modelName: MODEL,
    modelProvider: 'vllm',
  }, async () => {
    const allMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const client = createClient();
    const result = await client.chat.completions.create({
      model: MODEL,
      messages: allMessages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });

    const output = result.choices?.[0]?.message?.content || '';

    llmobs.annotate({
      inputData: allMessages.map(m => ({ role: m.role, content: m.content })),
      outputData: [{ role: 'assistant', content: output }],
      metadata: { temperature, max_tokens: maxTokens },
      metrics: {
        input_tokens: result.usage?.prompt_tokens,
        output_tokens: result.usage?.completion_tokens,
        total_tokens: result.usage?.total_tokens,
      },
    });

    return output;
  });
}

// ── Helper: strip <think> blocks ──────────────────────────────────────

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ── Helper: extract python code ───────────────────────────────────────

function extractPythonCode(text) {
  const fenceMatch = text.match(/```python\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const plainMatch = text.match(/```\s*([\s\S]*?)```/);
  if (plainMatch) return plainMatch[1].trim();
  // If the whole response looks like code
  if (text.includes('from sympy') || text.includes('import sympy')) {
    return text.trim();
  }
  return null;
}

// ── Helper: extract JSON from classifier response ─────────────────────

function extractJSON(text) {
  // Try fenced
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Try outermost braces
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch {}
  }
  return null;
}

// ── Helper: call SymPy via MCP proxy ──────────────────────────────────

const MCP_PORT = process.env.MCP_PORT || 3001;

async function callSymPy(code) {
  return llmobs.trace({ kind: 'tool', name: 'sympy_calculate' }, async () => {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        name: 'sympy_calculate',
        arguments: { expression: code },
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: MCP_PORT,
        path: '/tools/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 60000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const content = data.content?.[0]?.text || data.result?.content?.[0]?.text || body;
            llmobs.annotate({
              inputData: code,
              outputData: content,
            });
            resolve(content);
          } catch (e) {
            resolve(body);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('SymPy timeout')); });
      req.write(postData);
      req.end();
    });
  });
}

// ── Guardrail (standalone, reusable) ──────────────────────────────────

export async function checkGuardrail(userMessage) {
  return llmobs.trace({ kind: 'task', name: 'guardrail' }, async () => {
    const raw = await llmCall('guardrail', prompts.guardrail, [
      { role: 'user', content: userMessage },
    ], {
      maxTokens: prompts.agents.guardrail.max_tokens,
      temperature: prompts.agents.guardrail.temperature,
    });

    const answer = stripThink(raw).toUpperCase();
    const valid = !answer.includes('NIE');
    return {
      valid,
      reason: valid ? null : 'Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.',
    };
  });
}

// ── Main solve function ───────────────────────────────────────────────

export async function solve(userMessage, sessionId, onStep) {
  const send = (step, agentName, content, extra = {}) => {
    if (onStep) onStep({ step, agentName, content, ...extra });
  };

  return llmobs.trace({ kind: 'workflow', name: 'formulo.solve', sessionId }, async () => {

    // Guardrail already passed via /api/guardrail before reaching here

    // ── Step 1: Classifier ─────────────────────────────────────────

    send('classifier', 'Klasyfikator', 'Klasyfikuję zadanie...');

    const classifierRaw = await llmCall('classifier', prompts.classifier, [
      { role: 'user', content: userMessage },
    ], {
      maxTokens: prompts.agents.classifier.max_tokens,
      temperature: prompts.agents.classifier.temperature,
    });

    const classification = extractJSON(stripThink(classifierRaw));
    const problemType = classification?.type || 'general';
    const confidence = classification?.confidence || 0;
    const mcOptions = classification?.mc_options;
    const isMultipleChoice = !!mcOptions;

    send('classifier_done', 'Klasyfikator', JSON.stringify(classification), {
      problemType, confidence,
    });

    // ── Step 3: Analytical Agent ───────────────────────────────────

    send('analytical', 'Agent Analityczny', 'Planuję rozwiązanie...');

    const analyticalRaw = await llmCall('analytical', prompts.analytical, [
      { role: 'user', content: userMessage },
    ], {
      maxTokens: prompts.agents.analytical.max_tokens,
      temperature: prompts.agents.analytical.temperature,
    });

    const analyticalPlan = stripThink(analyticalRaw);
    send('analytical_done', 'Agent Analityczny', analyticalPlan);

    // ── Step 4: Executor Agent (SymPy code generation + execution)

    send('executor', 'Agent Wykonawczy', 'Generuję kod SymPy...');

    const executorPrompt = isMultipleChoice
      ? prompts.executor_sympy_mc
      : prompts.executor_sympy;

    const executorContext = [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: analyticalPlan },
      { role: 'user', content: 'Napisz kod SymPy rozwiazujacy to zadanie.' },
    ];

    let sympyResult = null;
    let executorCode = null;
    let executorOutput = null;
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let executorRaw;

      if (attempt === 0) {
        executorRaw = await llmCall('executor', executorPrompt, executorContext, {
          maxTokens: prompts.agents.executor.max_tokens,
          temperature: prompts.agents.executor.temperature,
        });
      } else {
        // Retry with error feedback
        const retryMessages = [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: analyticalPlan },
          {
            role: 'user',
            content: `Kod SymPy zwrocil blad:\n${executorOutput}\n\nPopraw kod. Pamietaj: print("ODPOWIEDZ:", wynik)`,
          },
        ];
        executorRaw = await llmCall(`executor_retry_${attempt}`, executorPrompt, retryMessages, {
          maxTokens: prompts.agents.executor.max_tokens,
          temperature: 0.1 + attempt * 0.05,
        });
      }

      executorCode = extractPythonCode(stripThink(executorRaw));

      if (!executorCode) {
        executorOutput = 'Nie znaleziono kodu Python w odpowiedzi.';
        continue;
      }

      send('executor_code', 'Agent Wykonawczy', executorCode, { attempt });

      // Execute via SymPy
      try {
        executorOutput = await callSymPy(executorCode);

        // Check for ODPOWIEDZ in output
        if (executorOutput && executorOutput.includes('ODPOWIEDZ:')) {
          sympyResult = executorOutput;
          break;
        }
        // Check for errors
        if (executorOutput && (executorOutput.includes('Error') || executorOutput.includes('Traceback'))) {
          send('executor_error', 'Agent Wykonawczy', executorOutput, { attempt });
          continue;
        }
        // Got output but no ODPOWIEDZ marker
        sympyResult = executorOutput;
        break;
      } catch (err) {
        executorOutput = `SymPy error: ${err.message}`;
        send('executor_error', 'Agent Wykonawczy', executorOutput, { attempt });
      }
    }

    const hasResult = !!sympyResult;
    send('executor_done', 'Agent Wykonawczy', sympyResult || executorOutput || 'Brak wyniku', {
      hasResult,
    });

    // ── Step 5: Summary Agent ──────────────────────────────────────

    send('summary', 'Agent Podsumowujący', 'Tworzę wyjaśnienie...');

    const summaryContext = [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: analyticalPlan },
    ];

    if (hasResult) {
      summaryContext.push(
        { role: 'user', content: 'Napisz kod SymPy rozwiazujacy to zadanie.' },
        { role: 'assistant', content: `\`\`\`python\n${executorCode}\n\`\`\`` },
        { role: 'user', content: `Wynik narzedzia:\n${sympyResult}` },
      );
    } else {
      summaryContext.push({
        role: 'user',
        content: 'Kod SymPy nie zadziałał. Rozwiąż zadanie analitycznie i wytłumacz krok po kroku.',
      });
    }

    const summaryRaw = await llmCall('summary', prompts.summary, summaryContext, {
      maxTokens: prompts.agents.summary.max_tokens,
      temperature: prompts.agents.summary.temperature,
    });

    const summary = stripThink(summaryRaw);
    send('summary_done', 'Agent Podsumowujący', summary);

    return {
      success: true,
      classification,
      analyticalPlan,
      executorCode,
      sympyResult,
      summary,
    };
  });
}
