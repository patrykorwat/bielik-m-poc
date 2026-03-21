#!/usr/bin/env node

/**
 * Discord Bot for Formulo
 *
 * Uses the SAME classifier + deterministic solver pipeline as the web UI.
 * Compiled TS modules are imported from dist-server/.
 *
 * Pipeline:
 *   1. Classifier (regex + LLM) → classification JSON
 *   2. Deterministic solver → SymPy code (no LLM needed)
 *   3. Execute SymPy via MCP proxy
 *   4. Summary agent (LLM) for explanation
 *   Fallback: 3-agent pipeline if classifier fails
 *
 * Environment variables:
 *   DISCORD_TOKEN        - Bot token from Discord Developer Portal (required)
 *   DISCORD_CHANNEL_ID   - Channel ID to monitor (required)
 *   MCP_PROXY_URL        - MCP proxy base URL (default: http://localhost:3001)
 *   RAG_URL              - RAG service base URL (default: http://localhost:3003)
 *   LLM_API_URL          - LLM endpoint URL (forwarded to /llm-proxy)
 *   LLM_API_KEY          - API key for LLM
 *   LLM_MODEL            - Model name (default: bielik-11b-v3.0)
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Import shared modules (compiled from TypeScript) ────────────────────────
import { classifyProblem, shouldUseFallback } from './dist-server/services/classifierService.js';
import { buildSolverCode } from './dist-server/services/deterministicSolvers.js';
import { LLMAgent } from './dist-server/services/mlxAgent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const MCP_PROXY_URL = process.env.MCP_PROXY_URL || 'http://localhost:3001';
const RAG_URL = process.env.RAG_URL || 'http://localhost:3003';
const LLM_API_URL = process.env.LLM_API_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.VITE_REMOTE_MODEL || 'speakleash/Bielik-11B-v3.0-Instruct';

if (!DISCORD_TOKEN) {
  console.error('[discord-bot] DISCORD_TOKEN is required');
  process.exit(1);
}
if (!DISCORD_CHANNEL_ID) {
  console.error('[discord-bot] DISCORD_CHANNEL_ID is required');
  process.exit(1);
}

// ── Load prompts ──────────────────────────────────────────────────────────────

const promptsPath = join(__dirname, 'prompts.json');
let prompts;
try {
  prompts = JSON.parse(readFileSync(promptsPath, 'utf8'));
} catch (err) {
  console.error('[discord-bot] Failed to load prompts.json:', err.message);
  process.exit(1);
}

const ANALYTICAL_PROMPT = prompts.analytical;
const EXECUTOR_PROMPT = prompts.executor_sympy;
const SUMMARY_PROMPT = prompts.summary;
const CLASSIFIER_PROMPT = prompts.classifier || '';

const AGENT_CONFIG = prompts.agents || {};
const ANALYTICAL_MAX_TOKENS = AGENT_CONFIG.analytical?.max_tokens || 350;
const ANALYTICAL_TEMP = AGENT_CONFIG.analytical?.temperature ?? 0.2;
const EXECUTOR_MAX_TOKENS = AGENT_CONFIG.executor?.max_tokens || 900;
const EXECUTOR_TEMP = AGENT_CONFIG.executor?.temperature ?? 0.15;
const SUMMARY_MAX_TOKENS = AGENT_CONFIG.summary?.max_tokens || 500;
const SUMMARY_TEMP = AGENT_CONFIG.summary?.temperature ?? 0.2;
const CLASSIFIER_MAX_TOKENS = AGENT_CONFIG.classifier?.max_tokens || 800;
const CLASSIFIER_TEMP = AGENT_CONFIG.classifier?.temperature ?? 0.1;

const UNIVERSITY_ENABLED = prompts.features?.university_level ?? true;

// ── Create shared LLMAgent instance ──────────────────────────────────────────

const llmAgent = new LLMAgent({
  provider: 'remote',
  baseUrl: LLM_API_URL,
  model: LLM_MODEL,
  temperature: 0.7,
  maxTokens: 4096,
  apiKey: LLM_API_KEY || undefined,
});

// ── ServerOrchestrator ───────────────────────────────────────────────────────

class ServerOrchestrator {
  constructor() {
    this.mcpProxyUrl = MCP_PROXY_URL;
    this.ragUrl = RAG_URL;
  }

  /**
   * Query RAG service for similar problems / math methods.
   */
  async queryRAG(problem) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${this.ragUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: problem, k: 3 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return '';

      const data = await res.json();
      const results = data.results || [];
      if (results.length === 0) return '';

      return results
        .map((r) => {
          const parts = [`[${r.category}] ${r.title}`, r.content];
          if (r.sympy_hint) parts.push(`SymPy: ${r.sympy_hint}`);
          if (r.tips) parts.push(`Wskazówki: ${r.tips}`);
          return parts.join('\n');
        })
        .join('\n\n---\n\n');
    } catch {
      return '';
    }
  }

  /**
   * Call LLM via the MCP proxy /llm-proxy endpoint.
   */
  async callLLM(systemPrompt, messages, maxTokens, temperature) {
    const payload = {
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: maxTokens,
      temperature,
    };

    const body = { payload };

    if (!LLM_API_URL) {
      throw new Error('LLM_API_URL is not configured');
    }
    if (LLM_API_KEY) {
      body.apiKey = LLM_API_KEY;
    }
    body.targetUrl = `${LLM_API_URL}/v1/chat/completions`;

    const res = await fetch(`${this.mcpProxyUrl}/llm-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM proxy error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return content;
  }

  /**
   * Execute Python SymPy code via MCP proxy /tools/call.
   */
  async callSympy(code) {
    try {
      const res = await fetch(`${this.mcpProxyUrl}/tools/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'sympy_calculate',
          arguments: { code },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return { output: '', error: `Tool call failed: ${err}` };
      }

      const result = await res.json();
      const text = result.content?.map((c) => c.text || '').join('\n') || '';
      if (result.isError) {
        return { output: '', error: text };
      }
      return { output: text, error: null };
    } catch (err) {
      return { output: '', error: err.message };
    }
  }

  /**
   * Extract Python code block from LLM response.
   */
  extractCode(text) {
    const match = text.match(/```python\n([\s\S]*?)```/);
    return match ? match[1].trim() : null;
  }

  /**
   * Run the full pipeline — CLASSIFIER + DETERMINISTIC SOLVER first, then 3-agent fallback.
   * Uses the SAME classifyProblem() and buildSolverCode() as the web UI.
   */
  async solve(problem, onProgress) {
    // Step 0: RAG retrieval
    await onProgress('🔍 Szukam podobnych zadań...');
    const ragContext = await this.queryRAG(problem);

    // ═══════════════════════════════════════════════════════════════════
    // CLASSIFIER PIPELINE — same logic as ThreeAgentOrchestrator
    // ═══════════════════════════════════════════════════════════════════
    try {
      await onProgress('🏷️ Klasyfikuję problem...');

      // Use shared classifyProblem() from compiled TS
      const classification = await classifyProblem(
        problem,
        CLASSIFIER_PROMPT,
        llmAgent,
        ragContext || undefined,
        {
          maxTokens: CLASSIFIER_MAX_TOKENS,
          temperature: CLASSIFIER_TEMP,
          enableUniversity: UNIVERSITY_ENABLED,
        }
      );

      console.log(`[discord-bot] Classification: type=${classification.type}, confidence=${classification.confidence}`);

      if (!shouldUseFallback(classification)) {
        // Use shared buildSolverCode() from compiled TS
        const solverCode = buildSolverCode(classification);

        if (solverCode && solverCode !== '# No solver available for this type') {
          await onProgress(`🧮 Deterministyczny solver: ${classification.type}...`);
          console.log(`[discord-bot] Running deterministic solver for ${classification.type}`);

          // Execute via MCP (same as web UI uses)
          const { output, error } = await this.callSympy(solverCode);

          if (!error && output) {
            const answerMatch = output.match(/ODPOWIEDZ:\s*(.+)/);

            if (answerMatch) {
              console.log(`[discord-bot] ✅ Deterministic answer: ${answerMatch[1]}`);

              // Summary agent with deterministic result
              await onProgress('📝 Przygotowuję wyjaśnienie...');
              const summaryUserMessage =
                `ZADANIE: ${problem}\n\n` +
                `KLASYFIKACJA: ${classification.type} (pewność: ${Math.round((classification.confidence || 0) * 100)}%)\n\n` +
                `KOD SYMPY:\n\`\`\`python\n${solverCode}\n\`\`\`\n\n` +
                `WYNIK SYMPY:\n${output}\n\n` +
                `Wytłumacz rozwiązanie krok po kroku.`;

              const summaryResponse = await this.callLLM(
                SUMMARY_PROMPT,
                [{ role: 'user', content: summaryUserMessage }],
                SUMMARY_MAX_TOKENS,
                SUMMARY_TEMP,
              );

              return {
                analytical: `🏷️ Klasyfikacja: **${classification.type}** (pewność: ${Math.round((classification.confidence || 0) * 100)}%)\n📐 Deterministyczny solver — bez generowania kodu przez LLM.`,
                sympy: output,
                summary: summaryResponse,
              };
            }
          }

          // Solver execution failed — log and fall through
          console.log(`[discord-bot] ⚠️ Deterministic solver failed: ${error || 'no ODPOWIEDZ'}`);
        }
      } else {
        console.log(`[discord-bot] ⚠️ Classifier suggests fallback (type=${classification.type}, confidence=${classification.confidence})`);
      }
    } catch (classifierError) {
      console.error('[discord-bot] ⚠️ Classifier pipeline error:', classifierError.message);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FALLBACK: 3-agent LLM pipeline (same as before)
    // ═══════════════════════════════════════════════════════════════════
    console.log('[discord-bot] Using 3-agent fallback pipeline');

    await onProgress('⚙️ Analizuję problem (3-agent fallback)...');

    const analyticalUserMessage = ragContext
      ? `STRATEGIE Z BAZY WIEDZY:\n${ragContext}\n\nZADANIE: ${problem}`
      : `ZADANIE: ${problem}`;

    const analyticalResponse = await this.callLLM(
      ANALYTICAL_PROMPT,
      [{ role: 'user', content: analyticalUserMessage }],
      ANALYTICAL_MAX_TOKENS,
      ANALYTICAL_TEMP,
    );

    await onProgress('🧮 Wykonuję obliczenia...');

    const executorUserMessage = `ZADANIE: ${problem}\n\nPLAN ANALITYCZNY:\n${analyticalResponse}\n\nNapisz kod SymPy.`;

    const executorResponse = await this.callLLM(
      EXECUTOR_PROMPT,
      [{ role: 'user', content: executorUserMessage }],
      EXECUTOR_MAX_TOKENS,
      EXECUTOR_TEMP,
    );

    let sympyOutput = '';
    let lastError = '';
    let currentCode = this.extractCode(executorResponse);
    let currentExecutorResponse = executorResponse;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!currentCode) {
        lastError = 'Brak bloku kodu Python w odpowiedzi modelu.';
        break;
      }

      const { output, error } = await this.callSympy(currentCode);

      if (!error) {
        sympyOutput = output;
        break;
      }

      lastError = error;
      console.log(`[discord-bot] SymPy attempt ${attempt} failed: ${error}`);

      if (attempt < 3) {
        const fixMessage = `KOD PYTHON:\n\`\`\`python\n${currentCode}\n\`\`\`\n\nBŁĄD:\n${error}\n\nPopraw kod i wróć TYLKO poprawiony blok \`\`\`python.`;
        const fixResponse = await this.callLLM(
          EXECUTOR_PROMPT,
          [
            { role: 'user', content: executorUserMessage },
            { role: 'assistant', content: currentExecutorResponse },
            { role: 'user', content: fixMessage },
          ],
          EXECUTOR_MAX_TOKENS,
          EXECUTOR_TEMP,
        );
        currentCode = this.extractCode(fixResponse);
        currentExecutorResponse = fixResponse;
      }
    }

    const sympyResult = sympyOutput || `(Błąd SymPy: ${lastError})`;

    await onProgress('📝 Przygotowuję wyjaśnienie...');

    const summaryUserMessage =
      `ZADANIE: ${problem}\n\n` +
      `PLAN ANALITYCZNY:\n${analyticalResponse}\n\n` +
      `WYNIK SYMPY:\n${sympyResult}\n\n` +
      `Wytłumacz rozwiązanie krok po kroku.`;

    const summaryResponse = await this.callLLM(
      SUMMARY_PROMPT,
      [{ role: 'user', content: summaryUserMessage }],
      SUMMARY_MAX_TOKENS,
      SUMMARY_TEMP,
    );

    return { analytical: analyticalResponse, sympy: sympyResult, summary: summaryResponse };
  }
}

// ── Discord Bot ───────────────────────────────────────────────────────────────

const orchestrator = new ServerOrchestrator();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`[discord-bot] Logged in as ${client.user.tag}`);
  console.log(`[discord-bot] Monitoring channel: ${DISCORD_CHANNEL_ID}`);
  console.log(`[discord-bot] Classifier pipeline: ENABLED (shared with web UI)`);
});

/**
 * Split a long string into chunks ≤ maxLen characters, breaking on newlines.
 */
function splitMessage(text, maxLen = 1990) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Only respond when the bot is mentioned
  if (!message.mentions.has(client.user)) return;

  // Strip the mention from the message to get the actual problem
  const problem = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!problem) return;

  console.log(`[discord-bot] Received: ${problem.slice(0, 100)}`);

  let progressMsg;
  try {
    progressMsg = await message.channel.send('⏳ Przetwarzam zadanie...');
  } catch (err) {
    console.error('[discord-bot] Failed to send initial message:', err);
    return;
  }

  const onProgress = async (text) => {
    try {
      await progressMsg.edit(text);
    } catch {
      // Ignore edit errors (rate limits, etc.)
    }
  };

  try {
    const { analytical, sympy, summary } = await orchestrator.solve(problem, onProgress);

    try {
      await progressMsg.delete();
    } catch {
      // Ignore
    }

    for (const chunk of splitMessage(`⚙️ **Analiza:**\n${analytical}`)) {
      await message.channel.send(chunk);
    }
    for (const chunk of splitMessage(`🧮 **Wynik SymPy:**\n${sympy}`)) {
      await message.channel.send(chunk);
    }
    for (const chunk of splitMessage(`📝 **Wyjaśnienie:**\n${summary}`)) {
      await message.channel.send(chunk);
    }
  } catch (err) {
    console.error('[discord-bot] Pipeline error:', err);
    try {
      await progressMsg.edit(`❌ Błąd: ${err.message}`);
    } catch {
      // Ignore
    }
  }
});

console.log('[discord-bot] Attempting login...');
console.log(`[discord-bot] DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID}`);
console.log(`[discord-bot] LLM_API_URL: ${LLM_API_URL || 'MISSING'}`);
console.log(`[discord-bot] LLM_API_KEY: ${LLM_API_KEY ? 'set' : 'MISSING'}`);

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[discord-bot] Login failed:', err.message);
  process.exit(1);
});
