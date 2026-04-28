#!/usr/bin/env node

/**
 * Heroku Startup Wrapper
 *
 * Single entry point that:
 * 1. Serves the Vite SPA from dist/
 * 2. Spawns MCP proxy + RAG service as child processes
 * 3. Exposes /api/solve (SSE) as the single public API endpoint
 *
 * MCP proxy and RAG are internal only, accessed by solve-pipeline.js via localhost.
 *
 * Uses only built-in Node modules + express (already a dependency).
 */

import express from 'express';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 5000;
const MCP_PORT = process.env.MCP_PORT || 3001;
const LEAN_PORT = process.env.LEAN_PROXY_PORT || 3002;
const RAG_PORT = process.env.RAG_PORT || 3003;

const app = express();
const children = [];

// ── HTTPS redirect (Heroku sets x-forwarded-proto) ────────────────────

app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.hostname}${req.url}`);
  }
  next();
});

// ── Child process spawning ──────────────────────────────────────────────

function spawnChild(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) console.log(`[${label}] ${trimmed}`);
    }
  });
  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) console.error(`[${label}] ${trimmed}`);
    }
  });
  child.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code}`);
  });

  children.push(child);
  return child;
}

// Start MCP proxy
console.log(`Starting MCP proxy on localhost:${MCP_PORT}...`);
spawnChild('mcp-proxy', 'node', ['mcp-proxy-server.js'], {
  MCP_PORT: String(MCP_PORT),
});

// Start Lean proxy
console.log(`Starting Lean proxy on localhost:${LEAN_PORT}...`);
spawnChild('lean-proxy', 'node', ['lean-proxy-server.js'], {
  LEAN_PROXY_PORT: String(LEAN_PORT),
});

// Start RAG service
console.log(`Starting RAG service on localhost:${RAG_PORT}...`);
const pythonCmd = existsSync(join(__dirname, 'rag_service', 'venv', 'bin', 'python3'))
  ? join(__dirname, 'rag_service', 'venv', 'bin', 'python3')
  : 'python3';
spawnChild('rag', pythonCmd, [join(__dirname, 'rag_service', 'main.py')], {
  RAG_PORT: String(RAG_PORT),
  RAG_HOST: '127.0.0.1',
});

let bot_active = false;
let bot_status = 'not_started';
let bot_pid = null;

// Start Discord bot (optional — only if DISCORD_TOKEN is set)
if (process.env.DISCORD_TOKEN) {
  console.log('Starting Discord bot...');
  const botChild = spawnChild('discord-bot', 'node', ['discord-bot.js']);
  bot_active = true;
  bot_status = 'spawned';
  bot_pid = botChild.pid;
  botChild.on('exit', (code) => {
    bot_status = `exited(${code})`;
    bot_active = false;
  });
} else {
  console.log('DISCORD_TOKEN not set — skipping Discord bot');
  bot_status = 'no_token';
}

// Give child processes a moment to start
await new Promise((resolve) => setTimeout(resolve, 5000));

// ── Lean health check (critical service) ────────────────────────────

let leanHealthy = false;

async function checkLeanHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${LEAN_PORT}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.leanInstalled === true;
  } catch { return false; }
}

// Check lean on startup with retries (lean toolchain download can be slow)
async function waitForLean(maxAttempts = 10, intervalMs = 5000) {
  for (let i = 1; i <= maxAttempts; i++) {
    leanHealthy = await checkLeanHealth();
    if (leanHealthy) {
      console.log('✓ Lean 4 is healthy and ready');
      return true;
    }
    console.log(`⏳ Lean health check ${i}/${maxAttempts} failed, retrying in ${intervalMs / 1000}s...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.error('✗ Lean 4 is NOT available. Proof verification will be unavailable.');
  return false;
}

// Stan pre-warm dwoch ciezkich zaleznosci, expose przez /api/status zeby UI
// moglo pokazac banner "model sie rozkreca" podczas cold startu.
const warmState = {
  lean: { status: 'cold', startedAt: null, readyAt: null, durationSec: null },
  bedrock: { status: 'cold', startedAt: null, readyAt: null, durationSec: null },
};

// 👇 NEW: Wrap the blocking code so it runs in the background
(async () => {
  // Give child processes a moment to start
  await new Promise((resolve) => setTimeout(resolve, 3000));
  // Wait for the Lean proxy to report healthy
  const isLeanReady = await waitForLean();

  if (isLeanReady) {
    console.log("🔥 Pre-warming Lean toolchain + Mathlib.Tactic (loaduje olean files do OS cache)...");
    warmState.lean.status = 'warming';
    warmState.lean.startedAt = Date.now();
    try {
      // Wczytujemy import Mathlib.Tactic w tle zaraz po starcie kontenera.
      // Pierwszy realny request uzytkownika juz nie ladowal bedzie olean files
      // z dysku (sa w OS file cache po pre-warm).
      const prewarmCode = [
        'import Mathlib.Tactic',
        '',
        'theorem _prewarm (x : Real) : x^2 - 4 * x + 5 ≥ 1 := by',
        '  nlinarith [sq_nonneg (x - 2)]'
      ].join('\n');

      const prewarmStart = Date.now();
      await fetch(`http://127.0.0.1:${LEAN_PORT}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: prewarmCode }),
        signal: AbortSignal.timeout(360000),
      });
      const prewarmSec = Math.round((Date.now() - prewarmStart) / 1000);
      warmState.lean.status = 'warm';
      warmState.lean.readyAt = Date.now();
      warmState.lean.durationSec = prewarmSec;
      console.log(`✅ Lean pre-warming z Mathlib.Tactic gotowe w ${prewarmSec}s.`);
    } catch (err) {
      console.error("⚠️ Lean pre-warm ping failed:", err.message);
      warmState.lean.status = 'cold';
    }
  }
})();

// Bedrock pre-warm i keep-alive (osobny background task niezalezny od Lean)
(async () => {
  if (!process.env.BEDROCK_MODEL_ARN) {
    console.log("ℹ️ BEDROCK_MODEL_ARN nieustawiony, pomijam Bedrock pre-warm.");
    warmState.bedrock.status = 'disabled';
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const { createLLMClient } = await import('./bedrock-bielik/llm-client.mjs');
  const client = createLLMClient({
    bedrockModelArn: process.env.BEDROCK_MODEL_ARN,
    bedrockRegion: process.env.BEDROCK_REGION || 'us-east-1',
    defaultModelName: 'speakleash/Bielik-11B-v3.0-Instruct',
  });

  async function pingBedrock() {
    return client.chat.completions.create({
      messages: [{ role: 'user', content: '1' }],
      max_tokens: 5,
      temperature: 0.1,
    });
  }

  console.log("🔥 Pre-warming Bedrock model (cold start moze trwac 5-10 min, retry shim ogarnia)...");
  warmState.bedrock.status = 'warming';
  warmState.bedrock.startedAt = Date.now();
  try {
    const start = Date.now();
    await pingBedrock();
    const sec = Math.round((Date.now() - start) / 1000);
    warmState.bedrock.status = 'warm';
    warmState.bedrock.readyAt = Date.now();
    warmState.bedrock.durationSec = sec;
    console.log(`✅ Bedrock pre-warming gotowe w ${sec}s.`);
  } catch (err) {
    console.error("⚠️ Bedrock pre-warm failed:", err?.message);
    warmState.bedrock.status = 'cold';
  }

  // Keep-alive co 4 min zeby model nie wpadal w idle podczas demo.
  // Bedrock CMI wyladowuje model po ~5 min bezczynnosci, wiec 4 min zapewnia warm.
  setInterval(async () => {
    try {
      await pingBedrock();
      if (warmState.bedrock.status !== 'warm') {
        warmState.bedrock.status = 'warm';
        warmState.bedrock.readyAt = Date.now();
        console.log('✅ Bedrock keep-alive: model warm');
      }
    } catch (err) {
      if (warmState.bedrock.status === 'warm') {
        console.warn('⚠️ Bedrock keep-alive failed, model moze byc cold:', err?.message);
        warmState.bedrock.status = 'cold';
      }
    }
  }, 4 * 60 * 1000);
})();
// 👆

// Periodic lean health monitoring (every 60s)
setInterval(async () => {
  const was = leanHealthy;
  leanHealthy = await checkLeanHealth();
  if (was && !leanHealthy) console.error('✗ Lean 4 became unhealthy!');
  if (!was && leanHealthy) console.log('✓ Lean 4 recovered');
}, 60000);

// ── Routes (MCP + RAG are internal only, accessed via localhost) ────────

// Health endpoint
app.get('/health', (req, res) => {
  const status = leanHealthy ? 'ok' : 'degraded';
  const httpCode = leanHealthy ? 200 : 503;
  res.status(httpCode).json({
    status,
    leanHealthy,
    services: {
      mcp: `http://127.0.0.1:${MCP_PORT}`,
      lean: `http://127.0.0.1:${LEAN_PORT}`,
      rag: `http://127.0.0.1:${RAG_PORT}`,
    },
    bot: {
      active: bot_active,
      status: bot_status,
      pid: bot_pid,
    },
  });
});

// Status endpoint dla UI - mowi czy ciezkie zaleznosci sa juz warm.
// Frontend pokaze banner "model sie rozkreca" podczas warming.
app.get('/api/status', (req, res) => {
  const elapsed = (s) => s.startedAt && !s.readyAt
    ? Math.round((Date.now() - s.startedAt) / 1000)
    : null;
  res.json({
    lean: {
      status: warmState.lean.status,
      durationSec: warmState.lean.durationSec,
      elapsedSec: elapsed(warmState.lean),
    },
    bedrock: {
      status: warmState.bedrock.status,
      durationSec: warmState.bedrock.durationSec,
      elapsedSec: elapsed(warmState.bedrock),
    },
  });
});

// ── Formula reference (serves mathematical_methods.json) ─────────────

let formulasCache = null;

// Map category IDs from mathematical_methods.json to education levels
const CATEGORY_LEVEL = {
  algebra_expressions:      'matura_podstawowa',
  equations_inequalities:   'matura_podstawowa',
  functions:                'matura_podstawowa',
  sequences_series:         'matura_podstawowa',
  trigonometry:             'matura_podstawowa',
  plane_geometry:           'podstawowa',
  solid_geometry:           'matura_rozszerzona',
  analytic_geometry:        'matura_rozszerzona',
  combinatorics_probability:'matura_rozszerzona',
  proofs_reasoning:         'matura_rozszerzona',
  number_theory:            'studia',
  derivatives_calculus:     'studia',
  special_techniques:       'matura_rozszerzona',
  exam_strategy:            'matura_podstawowa',
};

const LEVEL_ORDER = ['podstawowa', 'matura_podstawowa', 'matura_rozszerzona', 'studia'];
const LEVEL_LABELS = {
  podstawowa: 'Szkoła podstawowa',
  matura_podstawowa: 'Matura podstawowa',
  matura_rozszerzona: 'Matura rozszerzona',
  studia: 'Studia',
};

app.get('/api/formulas', (req, res) => {
  if (!formulasCache) {
    try {
      // Load SymPy method reference (mathematical_methods.json)
      const raw = readFileSync(join(__dirname, 'docs', 'mathematical_methods.json'), 'utf8');
      const data = JSON.parse(raw);
      const methodCategories = (data.categories || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        name_en: cat.name_en,
        level: CATEGORY_LEVEL[cat.id] || 'matura_podstawowa',
        type: 'methods',
        methods: (cat.methods || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description,
          sympy_functions: m.sympy_functions,
          when_to_use: m.when_to_use,
          worked_example: m.worked_example ? {
            problem: m.worked_example.problem,
            common_pitfalls: m.worked_example.common_pitfalls,
          } : null,
        })),
      }));

      // Load CKE matura formula reference (matura-formulas.json)
      const ckeRaw = readFileSync(join(__dirname, 'docs', 'matura-formulas.json'), 'utf8');
      const ckeData = JSON.parse(ckeRaw);
      const ckeCategories = (ckeData.sections || []).map(sec => ({
        id: sec.id,
        name: sec.name,
        name_en: '',
        level: sec.level,
        type: 'formulas',
        methods: (sec.formulas || []).map(f => ({
          id: f.id,
          name: f.name,
          description: f.latex ? `$${f.latex}$` : '',
          sympy_functions: [],
          when_to_use: '',
          worked_example: null,
          latex: f.latex || '',
        })),
      }));

      const allCategories = [...ckeCategories, ...methodCategories];

      formulasCache = LEVEL_ORDER.map(level => ({
        level,
        label: LEVEL_LABELS[level],
        categories: allCategories.filter(c => c.level === level),
      }));
    } catch (err) {
      console.error('[formulas] Failed to load:', err.message);
      return res.status(500).json({ error: 'Failed to load formulas' });
    }
  }
  res.json({ levels: formulasCache });
});

// ── Server-side solve pipeline (SSE) ──────────────────────────────────

import { solve } from './solve-pipeline.js';

// In-memory session store: keeps last N messages per sessionId
// Entries expire after 12 hours of inactivity
const sessionStore = new Map(); // sessionId -> { messages: [{role, content}], lastAccess: Date }
const SESSION_MAX_MESSAGES = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSessionHistory(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) return [];
  session.lastAccess = Date.now();
  return session.messages.slice(-SESSION_MAX_MESSAGES);
}

function addToSession(sessionId, role, content) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const session = sessionStore.get(sessionId);
  session.lastAccess = Date.now();
  session.messages.push({ role, content });
  // Keep only the last N messages
  if (session.messages.length > SESSION_MAX_MESSAGES * 2) {
    session.messages = session.messages.slice(-SESSION_MAX_MESSAGES);
  }
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionStore) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, 10 * 60 * 1000);

const solveJsonParser = express.json({ limit: '50kb' });

// ── Rate limiting for /api/solve ────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const rateLimitStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function rateLimitSolve(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - entry.count));

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Przekroczono limit zapytań. Spróbuj ponownie za godzinę.',
      retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000)
    });
  }
  next();
}

app.post('/api/solve', rateLimitSolve, solveJsonParser, async (req, res) => {
  const { message, sessionId: clientSessionId, consent } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  const sessionId = clientSessionId || randomUUID();
  const hasConsent = consent === 'all';

  // Get conversation history for this session, then record user message
  const chatHistory = getSessionHistory(sessionId);
  addToSession(sessionId, 'user', message);
  const shareId = randomUUID().replace(/-/g, '').slice(0, 8);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Collect steps for the share cache
  const collectedSteps = [];

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await solve(message, sessionId, (step) => {
      collectedSteps.push(step);
      sendSSE('step', step);
    }, chatHistory);

    // Include shareId in the done event so the client can reference it
    sendSSE('done', { ...result, shareId });

    // Record a short summary of the response in session history
    const summaryStep = collectedSteps.find(s => s.step === 'summary_done' && s.content);
    if (summaryStep) {
      // Keep only first 300 chars to avoid bloating session memory
      addToSession(sessionId, 'assistant', summaryStep.content.slice(0, 300));
    }

    // Save to Postgres (fire and forget, don't block SSE close)
    const shareMessages = collectedSteps
      .filter(s => s.step?.endsWith('_done') && !s.blocked && s.agentName !== 'Guardrail' && s.agentName !== 'Klasyfikator')
      .map(s => ({ role: 'assistant', content: s.content, agentName: s.agentName }));
    if (shareMessages.length > 0) {
      shareMessages.unshift({ role: 'user', content: message });
      saveShare(shareId, message, shareMessages);
    }

    // Persist full session to database if user consented to cookies
    if (hasConsent) {
      persistSession(sessionId);
    }
  } catch (err) {
    console.error('[solve] Pipeline error:', err);
    sendSSE('error', { error: err.message || 'Pipeline failed' });
  }

  res.end();
});

// ── CKE Quiz API (daily challenge, quiz, and checking) ──────────────────

// Helper: simple day-based hash function for consistent daily seeding
function dayHash(dateStr) {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = ((hash << 5) - hash) + dateStr.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// In-memory cache for loaded datasets
let quizCache = {
  podstawowa: null,
  rozszerzona: null,
};

// Load all JSON files from a dataset directory
function loadDataset(level) {
  if (quizCache[level]) return quizCache[level];

  const datasetPath = join(__dirname, 'datasets', level);
  const questions = [];

  try {
    const files = readdirSync(datasetPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const raw = readFileSync(join(datasetPath, file), 'utf8');
      const data = JSON.parse(raw);
      questions.push(...data);
    }
    quizCache[level] = questions;
    return questions;
  } catch (err) {
    console.error(`[quiz] Failed to load ${level} dataset:`, err.message);
    return [];
  }
}

// Topic keyword mapping for filtering
const TOPIC_KEYWORDS = {
  logarytmy: ['log', 'logarytm'],
  potegi: ['potęg', 'poteg', 'wykładni', 'wykladni'],
  rownania: ['równan', 'rownan', 'rozwiąż', 'rozwiaz'],
  nierownosci: ['nierównoś', 'nierownosc', 'nierówno'],
  trygonometria: ['sin', 'cos', 'tg', 'ctg', 'trygonometr', 'sinusa', 'cosinusa'],
  ciagi: ['ciąg', 'ciag', 'arytmetycz', 'geometrycz'],
  prawdopodobienstwo: ['prawdopodobień', 'prawdopodobien', 'losow', 'losowania'],
  geometria: ['trójkąt', 'trojkat', 'okrąg', 'okrag', 'pole', 'obwód', 'obwod', 'prostokąt', 'prostopadło', 'graniastosłup', 'ostrosłup', 'walec', 'stożek'],
  funkcje: ['funkcj', 'dziedzin', 'przebieg', 'monotoniczno', 'wartość funkcji'],
  pochodne: ['pochodn', 'stycznej', 'ekstremu', 'ekstremum', 'minimum funkcji', 'maximum funkcji'],
};

// Check if question text matches a topic (case-insensitive, diacritics-aware)
function matchesTopic(questionText, topic) {
  const keywords = TOPIC_KEYWORDS[topic];
  if (!keywords) return false;
  const lowerText = questionText.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

// ── GET /api/daily-challenge
app.get('/api/daily-challenge', (req, res) => {
  try {
    const questions = loadDataset('podstawowa');

    // Filter to only MC questions (that have options)
    const mcQuestions = questions.filter(q => q.options !== null && q.options !== undefined);

    if (mcQuestions.length === 0) {
      return res.status(404).json({ error: 'No multiple-choice questions available' });
    }

    // Get today's date for seeding
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const seed = dayHash(today);

    // Pick one question deterministically
    const question = mcQuestions[seed % mcQuestions.length];

    // Generate a simple hint based on the question
    let hint = 'Przeczytaj pytanie uważnie i sprawdź wszystkie opcje odpo wiedzi.';
    if (question.question.toLowerCase().includes('log')) {
      hint = 'Wspomnienie: log_a(b) = c oznacza a^c = b';
    } else if (question.question.toLowerCase().includes('sin') || question.question.toLowerCase().includes('cos')) {
      hint = 'Zastosuj wzory trygonometryczne.';
    }

    res.json({
      question: question.question,
      options: question.options,
      metadata: {
        year: question.metadata.year,
        level: question.metadata.level,
        task_number: question.metadata.task_number,
      },
      hint,
    });
  } catch (err) {
    console.error('[daily-challenge] Error:', err.message);
    res.status(500).json({ error: 'Failed to load daily challenge' });
  }
});

// ── GET /api/quiz
app.get('/api/quiz', (req, res) => {
  try {
    const level = (req.query.level || 'podstawowa').toLowerCase();
    const count = Math.min(parseInt(req.query.count || '5', 10), 10);
    const topic = req.query.topic ? req.query.topic.toLowerCase() : null;

    if (level !== 'podstawowa' && level !== 'rozszerzona') {
      return res.status(400).json({ error: 'level must be "podstawowa" or "rozszerzona"' });
    }

    const questions = loadDataset(level);

    if (questions.length === 0) {
      return res.status(404).json({ error: `No questions found for level ${level}` });
    }

    // Filter based on level type
    let filtered = questions;
    if (level === 'podstawowa') {
      filtered = filtered.filter(q => q.options !== null && q.options !== undefined);
    }

    // Filter by topic if specified
    if (topic && topic !== 'wszystkie tematy') {
      const byTopic = filtered.filter(q => matchesTopic(q.question, topic));
      if (byTopic.length > 0) {
        filtered = byTopic;
      }
      // Jeśli brak pytań dla tematu w tym poziomie, zwróć losowe pytania z całego poziomu
      // (nie 404 — lepszy UX niż błąd)
    }

    // Shuffle using a simple seeded random
    const seed = Math.random();
    filtered.sort(() => 0.5 - seed);

    // Take the requested count
    const selected = filtered.slice(0, count);

    // Generate unique IDs and prepare response
    const responseQuestions = selected.map((q, idx) => ({
      id: idx,
      question: q.question,
      options: q.options,
      correct_answer: q.answer,
      metadata: {
        year: q.metadata.year,
        level: q.metadata.level,
        task_number: q.metadata.task_number,
      },
    }));

    // Collect all available topics from the dataset
    const availableTopics = Object.keys(TOPIC_KEYWORDS).filter(topic =>
      questions.some(q => matchesTopic(q.question, topic))
    );

    // Sprawdź czy temat był dostępny w tym poziomie
    const topicKey = topic ? topic.toLowerCase() : null;
    const topicAvailable = !topicKey || topicKey === 'wszystkie tematy' ||
      questions.some(q => matchesTopic(q.question, topicKey));

    res.json({
      questions: responseQuestions,
      availableTopics,
      topicAvailable,
    });
  } catch (err) {
    console.error('[quiz] Error:', err.message);
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

// ── POST /api/quiz/check
const quizCheckParser = express.json({ limit: '10kb' });
app.post('/api/quiz/check', quizCheckParser, (req, res) => {
  try {
    const { answers } = req.body || {};

    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an array' });
    }

    const results = [];
    let score = 0;

    for (const submission of answers) {
      const { year, level, task_number, answer: userAnswer } = submission;

      // Find matching question in dataset
      const dataset = loadDataset(level === 1 ? 'podstawowa' : 'rozszerzona');
      const question = dataset.find(
        q => q.metadata.year === year && q.metadata.task_number === task_number
      );

      if (!question) {
        results.push({
          correct: false,
          correctAnswer: null,
          question: `Question not found (year: ${year}, task: ${task_number})`,
        });
        continue;
      }

      // Compare answers (case-insensitive)
      const isCorrect = userAnswer.toLowerCase() === question.answer.toLowerCase();
      if (isCorrect) score++;

      results.push({
        correct: isCorrect,
        correctAnswer: question.answer,
        question: question.question,
      });
    }

    res.json({
      results,
      score,
      total: answers.length,
    });
  } catch (err) {
    console.error('[quiz/check] Error:', err.message);
    res.status(500).json({ error: 'Failed to check answers' });
  }
});

// ── GET /api/practice — suggest similar CKE problems based on topic ────
app.get('/api/practice', (req, res) => {
  try {
    const topic = (req.query.topic || '').toLowerCase();
    const count = Math.min(parseInt(req.query.count || '3', 10), 5);
    const excludeText = (req.query.exclude || '').toLowerCase();

    // Load both datasets
    const podstawowa = loadDataset('podstawowa');
    const rozszerzona = loadDataset('rozszerzona');
    const all = [...podstawowa, ...rozszerzona];

    // Filter by topic if provided
    let pool = all;
    if (topic && TOPIC_KEYWORDS[topic]) {
      const topicMatched = all.filter(q => matchesTopic(q.question, topic));
      if (topicMatched.length >= count) {
        pool = topicMatched;
      }
    }

    // Only MC questions (with options)
    pool = pool.filter(q => q.options != null);

    // Exclude questions too similar to the original
    if (excludeText) {
      const excludeWords = new Set(excludeText.split(/\s+/).filter(w => w.length > 4));
      pool = pool.filter(q => {
        const qWords = q.question.toLowerCase().split(/\s+/).filter(w => w.length > 4);
        const overlap = qWords.filter(w => excludeWords.has(w)).length;
        return qWords.length === 0 || overlap / qWords.length < 0.5;
      });
    }

    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const selected = pool.slice(0, count).map(q => ({
      question: q.question,
      options: q.options,
      answer: q.answer,
      metadata: q.metadata,
    }));

    res.json({ topic, problems: selected });
  } catch (err) {
    console.error('[practice] Error:', err.message);
    res.status(500).json({ error: 'Failed to load practice suggestions' });
  }
});

// ── POST /api/ocr (Tesseract OCR + LLM cleanup) ───────────────────────

const ocrJsonParser = express.json({ limit: '5mb' });
app.post('/api/ocr', rateLimitSolve, ocrJsonParser, async (req, res) => {
  const tmpBase = join(tmpdir(), `formulo-ocr-${Date.now()}`);
  const tmpImg = `${tmpBase}.img`;

  try {
    const { image: base64Input } = req.body || {};

    if (!base64Input) {
      return res.status(400).json({ error: 'image is required' });
    }

    // Strip data URI prefix if present (e.g., "data:image/png;base64,")
    let base64Data = base64Input;
    const dataUriMatch = base64Input.match(/^data:[a-zA-Z0-9/+-]+;base64,(.+)$/);
    if (dataUriMatch) {
      base64Data = dataUriMatch[1];
    }

    // Write image to temp file
    const imgBuffer = Buffer.from(base64Data, 'base64');
    writeFileSync(tmpImg, imgBuffer);

    // Run Tesseract OCR (pol + eng, math-friendly PSM 6)
    let rawText = '';
    try {
      const { stdout } = await execFileAsync('tesseract', [
        tmpImg, 'stdout',
        '-l', 'pol+eng',
        '--psm', '6',
        '--oem', '1',
      ], { timeout: 30000 });
      rawText = stdout.trim();
    } catch (tessErr) {
      console.error('[ocr] Tesseract failed:', tessErr.message);
      // Check if tesseract is installed
      if (tessErr.code === 'ENOENT') {
        return res.status(503).json({
          error: 'Tesseract OCR nie jest zainstalowany. Dodaj buildpack heroku-community/apt z pakietem tesseract-ocr tesseract-ocr-pol.',
        });
      }
      return res.status(500).json({ error: 'OCR failed' });
    }

    if (!rawText) {
      return res.status(422).json({ error: 'Nie udało się odczytać tekstu ze zdjęcia. Spróbuj lepszego zdjęcia.' });
    }

    // Pass raw OCR text through the existing LLM to clean up math notation
    const LLM_BASE = process.env.LLM_API_URL
      ? `${process.env.LLM_API_URL}/v1`
      : 'http://localhost:8011/v1';
    const LLM_KEY = process.env.LLM_API_KEY || 'no-key';
    const LLM_MODEL = process.env.LLM_MODEL || 'speakleash/Bielik-11B-v3.0-Instruct';

    try {
      const llmRes = await fetch(`${LLM_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          temperature: 0.1,
          max_tokens: 800,
          messages: [
            {
              role: 'system',
              content: 'Jestes korektorem tekstu matematycznego. Dostajesz surowy tekst z OCR (Tesseract). Popraw bledy rozpoznawania, przywroc poprawna notacje matematyczna. Nie dodawaj komentarzy. Zwroc TYLKO poprawiony tekst zadania.',
            },
            {
              role: 'user',
              content: `Popraw ten tekst z OCR:\n\n${rawText}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (llmRes.ok) {
        const llmData = await llmRes.json();
        const cleaned = llmData.choices?.[0]?.message?.content?.trim();
        if (cleaned) {
          return res.json({ text: cleaned });
        }
      }
      // If LLM cleanup fails, return raw Tesseract output
      console.warn('[ocr] LLM cleanup failed, returning raw OCR text');
    } catch (llmErr) {
      console.warn('[ocr] LLM cleanup unavailable:', llmErr.message);
    }

    // Fallback: return raw Tesseract text without LLM cleanup
    return res.json({ text: rawText });
  } catch (err) {
    console.error('[ocr] Unexpected error:', err.message);
    res.status(500).json({ error: 'OCR processing failed' });
  } finally {
    // Cleanup temp file
    try { unlinkSync(tmpImg); } catch { /* ignore */ }
  }
});

// ── SEO static pages (served before SPA fallback) ─────────────────────

const seoPath = join(__dirname, 'seo', 'pages');
app.use('/zadania', express.static(join(seoPath, 'zadania'), { extensions: ['html'] }));
app.use('/tematy', express.static(join(seoPath, 'tematy'), { extensions: ['html'] }));

// Legal pages
const legalPath = join(seoPath, 'legal');
app.get('/polityka-prywatnosci', (_req, res) => res.sendFile(join(legalPath, 'polityka-prywatnosci.html')));
app.get('/cookies', (_req, res) => res.sendFile(join(legalPath, 'cookies.html')));
app.get('/regulamin', (_req, res) => res.sendFile(join(legalPath, 'regulamin.html')));
app.get('/o-nas', (_req, res) => res.sendFile(join(seoPath, 'o-nas.html')));

app.get('/sitemap.xml', (_req, res) => {
  res.sendFile(join(__dirname, 'seo', 'sitemap.xml'));
});
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://formulo.pl/sitemap.xml`);
});

// ── Shared solution cache (permalinks, Postgres) ────────────────────

const SHARE_SHORT_TTL_HOURS = 24;
const SHARE_EXTENDED_TTL_DAYS = 60;

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ...(process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('@db:')
        ? {}
        : { ssl: { rejectUnauthorized: false } })
    })
  : null;

if (pool) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      messages JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `).then(() =>
    // Migration: add expires_at if table existed before this column was introduced
    pool.query(`ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {})
  ).then(() =>
    // Backfill: set expires_at for any old rows that have NULL (24h from created_at)
    pool.query(`UPDATE shares SET expires_at = created_at + INTERVAL '24 hours' WHERE expires_at IS NULL`).catch(() => {})
  ).then(() =>
    pool.query(`CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at)`)
  ).then(() => {
    console.log('[shares] Postgres table ready');
  }).catch(err => console.error('[shares] Table init error:', err.message));

  // Cleanup expired entries on startup and every hour
  const cleanupExpired = () => {
    pool.query('DELETE FROM shares WHERE expires_at < NOW()')
      .then(res => { if (res.rowCount > 0) console.log(`[shares] Cleaned up ${res.rowCount} expired entries`); })
      .catch(err => console.error('[shares] Cleanup error:', err.message));
  };
  setTimeout(cleanupExpired, 5000);
  setInterval(cleanupExpired, 3600000);
  // ── Consent events table ────────────────────────────────────────────
  pool.query(`
    CREATE TABLE IF NOT EXISTS consent_events (
      id SERIAL PRIMARY KEY,
      choice TEXT NOT NULL,
      user_agent TEXT,
      referrer TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => {
    console.log('[consent] Postgres table ready');
  }).catch(err => console.error('[consent] Table init error:', err.message));

  // ── Persistent sessions table (saved when user accepts cookies) ────
  pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => {
    console.log('[sessions] Postgres table ready');
  }).catch(err => console.error('[sessions] Table init error:', err.message));
} else {
  console.warn('[shares] DATABASE_URL not set, permalink sharing disabled');
}

// Persist session to Postgres (called after each successful solve if user consented)
async function persistSession(sessionId) {
  if (!pool) return;
  const session = sessionStore.get(sessionId);
  if (!session || session.messages.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO sessions (id, messages, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET messages = $2, updated_at = NOW()`,
      [sessionId.slice(0, 64), JSON.stringify(session.messages)]
    );
  } catch (err) {
    console.error('[sessions] Persist error:', err.message);
  }
}

// Called by the solve pipeline after a successful response
async function saveShare(id, question, messages) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO shares (id, question, messages, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${SHARE_SHORT_TTL_HOURS} hours')
       ON CONFLICT (id) DO UPDATE SET messages = $3, expires_at = NOW() + INTERVAL '${SHARE_SHORT_TTL_HOURS} hours'`,
      [id, question, JSON.stringify(messages)]
    );
  } catch (err) {
    console.error('[shares] Save error:', err.message);
  }
}

// Extend lifespan to 60 days (triggered by user clicking "share")
app.post('/api/share/:id/extend', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE shares SET expires_at = NOW() + INTERVAL '${SHARE_EXTENDED_TTL_DAYS} days' WHERE id = $1 AND expires_at > NOW()`,
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Solution not found or expired' });
    }
    res.json({ url: `/s/${req.params.id}` });
  } catch (err) {
    console.error('[shares] Extend error:', err.message);
    res.status(500).json({ error: 'Failed to extend' });
  }
});

// Share full conversation from a session
const shareSessionParser = express.json({ limit: '200kb' });
app.post('/api/share/session', shareSessionParser, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  const { sessionId, messages: clientMessages } = req.body || {};
  if (!sessionId && !clientMessages) {
    return res.status(400).json({ error: 'sessionId or messages required' });
  }

  try {
    // Use client-provided messages (the full rendered conversation from the UI)
    const conversationMessages = Array.isArray(clientMessages)
      ? clientMessages.map(m => ({
          role: String(m.role || 'user'),
          content: String(m.content || ''),
          agentName: m.agentName || undefined,
        })).filter(m => m.content)
      : [];

    if (conversationMessages.length === 0) {
      return res.status(400).json({ error: 'No messages to share' });
    }

    const shareId = randomUUID().replace(/-/g, '').slice(0, 8);
    const firstUserMsg = conversationMessages.find(m => m.role === 'user');
    const question = firstUserMsg ? firstUserMsg.content.slice(0, 200) : 'Konwersacja';

    await pool.query(
      `INSERT INTO shares (id, question, messages, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${SHARE_EXTENDED_TTL_DAYS} days')`,
      [shareId, question, JSON.stringify(conversationMessages)]
    );

    res.json({ url: `/s/${shareId}` });
  } catch (err) {
    console.error('[shares] Session share error:', err.message);
    res.status(500).json({ error: 'Failed to share' });
  }
});

// Fetch a shared solution
app.get('/api/share/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sharing not available' });
  try {
    const { rows } = await pool.query(
      'SELECT question, messages, created_at, expires_at FROM shares WHERE id = $1 AND expires_at > NOW()',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Solution not found or expired' });
    }
    res.json({
      question: rows[0].question,
      messages: rows[0].messages,
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    console.error('[shares] Get error:', err.message);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// ── Consent tracking ───────────────────────────────────────────────────

const consentParser = express.json({ limit: '10kb' });

app.post('/api/consent', consentParser, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  const { choice } = req.body || {};
  if (!choice || !['all', 'necessary'].includes(choice)) {
    return res.status(400).json({ error: 'choice must be "all" or "necessary"' });
  }
  try {
    await pool.query(
      `INSERT INTO consent_events (choice, user_agent, referrer) VALUES ($1, $2, $3)`,
      [choice, (req.headers['user-agent'] || '').slice(0, 500), (req.headers['referer'] || '').slice(0, 500)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[consent] Save error:', err.message);
    res.status(500).json({ error: 'Failed to save consent' });
  }
});

// ── Retrieve a persisted session ────────────────────────────────────────

app.get('/api/session/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const { rows } = await pool.query(
      'SELECT messages, created_at, updated_at FROM sessions WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({
      messages: rows[0].messages,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    console.error('[sessions] Get error:', err.message);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// ── Static SPA serving ──────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');

// Serve static assets at root
app.use(express.static(distPath));

// SPA fallback — all non-file routes serve index.html
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

// ── Start server ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Heroku wrapper listening on port ${PORT}`);
  console.log(`   SPA:  http://localhost:${PORT}/`);
  console.log(`   MCP:  internal only (localhost:${MCP_PORT})`);
  console.log(`   RAG:  internal only (localhost:${RAG_PORT})`);
  console.log(`   BOT:  active: ${bot_active}`);
  console.log(`   ENV:  DISCORD_TOKEN=${process.env.DISCORD_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`   ENV:  DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID ? process.env.DISCORD_CHANNEL_ID : 'MISSING'}`);
  console.log(`   ENV:  LLM_API_URL=${process.env.LLM_API_URL || 'MISSING'}`);
  console.log(`   ENV:  LLM_API_KEY=${process.env.LLM_API_KEY ? 'set' : 'MISSING'}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down child processes...`);
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
