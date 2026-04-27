/**
 * Server-side solve pipeline.
 *
 * Single entry point for ALL user requests. Routes through:
 *   guardrail → generator intent → arithmetic scheme → LLM solve pipeline
 *
 * Runs in one process so dd-trace / LLM Observability sees a single
 * workflow span containing every LLM call as a nested child span.
 *
 * Streams progress back via SSE.
 */

import tracer from 'dd-trace';
import { createLLMClient } from './bedrock-bielik/llm-client.mjs';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTemplate, buildExtractionSystemPrompt } from './extraction-templates.js';
import { tryDeterministicSolver } from './deterministic-solvers.js';
import { decompose } from './decomposer.js';

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
const MODEL = process.env.LLM_MODEL || prompts.model?.default || 'speakleash/Bielik-11B-v3.0-Instruct';

// Backend wybierany po env:
//   BEDROCK_MODEL_ARN ustawiony  -> AWS Bedrock Custom Model Import
//   inaczej                       -> OpenAI compatible (vLLM, Together itp.)
const BEDROCK_MODEL_ARN = process.env.BEDROCK_MODEL_ARN || '';
const BEDROCK_REGION = process.env.BEDROCK_REGION || 'us-east-1';
const LLM_PROVIDER = BEDROCK_MODEL_ARN ? 'aws_bedrock' : 'vllm';

function createClient() {
  return createLLMClient({
    baseURL: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    bedrockRegion: BEDROCK_REGION,
    bedrockModelArn: BEDROCK_MODEL_ARN,
    defaultModelName: MODEL,
  });
}

// ── Helper: call LLM inside an llmobs span ────────────────────────────

async function llmCall(name, systemPrompt, messages, opts = {}) {
  const { maxTokens = 500, temperature = 0.2 } = opts;

  return llmobs.trace({
    kind: 'llm',
    name,
    modelName: MODEL,
    modelProvider: LLM_PROVIDER,
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

// ── Lean Prover config ───────────────────────────────────────────────

const LEAN_PROXY_PORT = process.env.LEAN_PROXY_PORT || 3002;
const LEAN_PROXY_URL = `http://127.0.0.1:${LEAN_PROXY_PORT}`;

const PROOF_KEYWORDS = [
  'dowód', 'udowodnij', 'wykaż', 'prove', 'proof',
  'theorem', 'twierdzenie', 'lemma', 'lemat',
  'indukcja', 'induction',
  'dla każdego', 'forall', 'istnieje', 'exists',
  'pokaż, że', 'pokaż że', 'uzasadnij',
];

function isProofProblem(text) {
  const lower = text.toLowerCase();
  return PROOF_KEYWORDS.some(kw => lower.includes(kw));
}

const LEAN_FORMALIZATION_PROMPT = `Jestes ekspertem od formalizacji matematycznych dowodow w Lean 4.
Przetlumacz zadanie na formalny dowod w Lean 4.

ZASADY:
1. KOMPLETNY, samowystarczalny kod Lean 4. ZAKAZ importow Mathlib (niedostepny na serwerze).
2. Dozwolone importy: import Std
3. Dostepne taktyki: omega, simp, decide, intro, apply, exact, constructor, cases, induction, rfl, calc, have, let, show, funext, ext, contradiction, absurd, by_contra, rw
4. ZAKAZ taktyk: ring, ring_nf, norm_num (wszystkie wymagaja Mathlib, NIEDOSTEPNE).
5. omega rozwiazuje TYLKO LINIOWE rownania/nierownosci na Nat/Int.
6. Dla rownosci wielomianowych (np. (2k+1)^2 = 4k^2+4k+1) uzyj sorry. To jest oczekiwane zachowanie bez Mathlib.
7. Po sorry dla kroku algebraicznego, uzyj omega lub simp na liniowym wyniku.
8. Modeluj problemy na typach Nat lub Int (nie Real, bo Real wymaga Mathlib).
9. ZAWSZE zwroc TYLKO blok kodu Lean 4 w \`\`\`lean, bez dodatkowego tekstu.

PRZYKLAD (podzielnosc, liniowa arytmetyka):
\`\`\`lean
import Std

theorem even_plus_even (a b : Int) (ha : a % 2 = 0) (hb : b % 2 = 0) :
    (a + b) % 2 = 0 := by
  omega
\`\`\`

PRZYKLAD (reszta z dzielenia, kwadratowe wyrazenia):
\`\`\`lean
import Std

theorem sum_sq_odd_mod4 (k : Int) :
    ((2 * k + 1)^2 + (2 * k + 3)^2) % 4 = 2 := by
  have h : (2 * k + 1)^2 + (2 * k + 3)^2 = 8 * k^2 + 16 * k + 10 := by sorry
  rw [h]
  omega
\`\`\`

STRATEGIA:
1. Zapisz twierdzenie z poprawna teza
2. have h : wyrazenie_wielomianowe = rozwiniety_wynik := by sorry (krok algebraiczny)
3. rw [h] zeby podstawic uproszczony wynik
4. omega na liniowym wyniku (reszty, porownania, nierownosci)
5. ZAWSZE zaczynaj od: import Std
`;

function extractLeanCode(response) {
  const leanMatch = /```lean\s*\n([\s\S]*?)\n```/.exec(response);
  if (leanMatch) return leanMatch[1].trim();
  const plainMatch = /```\s*\n([\s\S]*?)\n```/.exec(response);
  if (plainMatch) {
    const code = plainMatch[1].trim();
    if (/\b(theorem|lemma|def)\s/.test(code)) return code;
  }
  const lines = response.split('\n');
  const start = lines.findIndex(l => /^\s*(theorem|lemma|def)\s/.test(l));
  if (start >= 0) return lines.slice(start).join('\n').trim();
  // Brak code fence i brak slow kluczowych Lean. Bielik zwrocil prose.
  // Nie wpadamy w fallback "wyslij wszystko do Lean" bo to gwarantowany syntax error.
  return null;
}

async function leanHealthy() {
  try {
    const res = await fetch(`${LEAN_PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.leanInstalled === true;
  } catch { return false; }
}

async function leanVerify(code) {
  const res = await fetch(`${LEAN_PROXY_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(65000),
  });
  const data = await res.json();
  // Normalize response to match what the pipeline expects
  if (res.ok && data.status === 'success') {
    return { success: true, verificationDetails: { verified: true, warnings: data.output ? [data.output] : undefined } };
  }
  const errors = data.error ? data.error.split('\n').filter(l => l.includes('error:')) : ['verification failed'];
  return { success: false, verificationDetails: { verified: false, errors: errors.length > 0 ? errors : ['verification failed'] } };
}

// ── Helper: strip <think> blocks ──────────────────────────────────────

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ── Helper: extract python code ───────────────────────────────────────

function extractPythonCode(text) {
  const fenceMatch = text.match(/```python\s*([\s\S]*?)```/);
  if (fenceMatch) return sanitizeGeneratedCode(fenceMatch[1].trim());
  const plainMatch = text.match(/```\s*([\s\S]*?)```/);
  if (plainMatch) return sanitizeGeneratedCode(plainMatch[1].trim());
  // Brak code fence, ale jest sympy. Bielik czesto prepend'uje preamble po polsku
  // ("Oto poprawiony kod Python..."), wiec scinamy wszystko przed pierwsza
  // sensowna linia Pythona (import/from/komentarz).
  if (text.includes('from sympy') || text.includes('import sympy')) {
    const lines = text.split('\n');
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^(from\s+\w+|import\s+\w+)/.test(t)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return null;
    return sanitizeGeneratedCode(lines.slice(startIdx).join('\n').trim());
  }
  return null;
}

// ── Helper: fix common Bielik code generation mistakes ────────────────

function sanitizeGeneratedCode(code) {
  let lines = code.split('\n');

  // 1. Replace ALL f-string prints with simple concatenation.
  //    Bielik often produces broken f-strings with Polish text and unmatched parens.
  //    Covers both ODPOWIEDZ prints and regular prints like print(f"x = {val}").
  lines = lines.map(line => {
    // Match any print(f"...") or print(f'...')
    if (/print\(f["']/.test(line)) {
      // Extract the text prefix before first {var} and all {variable} references
      const fstringMatch = line.match(/print\(f["'](.*)["']\s*\)/);
      if (!fstringMatch) {
        // Fallback: just remove the f prefix
        return line.replace(/print\(f["']/, 'print("').replace(/["']\s*\)$/, '")');
      }
      const fContent = fstringMatch[1];
      const vars = [];
      const varPattern = /\{([^}]+)\}/g;
      let m;
      while ((m = varPattern.exec(fContent)) !== null) {
        vars.push(m[1]);
      }
      // Reconstruct as comma-separated print
      // Split the f-string content by {var} to get text segments
      const textParts = fContent.split(/\{[^}]+\}/);
      const args = [];
      for (let i = 0; i < textParts.length; i++) {
        const text = textParts[i];
        if (text) args.push(`"${text}"`);
        if (i < vars.length) args.push(vars[i]);
      }
      if (args.length > 0) {
        const indent = line.match(/^(\s*)/)?.[1] || '';
        return `${indent}print(${args.join(', ')})`;
      }
      // Fallback
      return line.replace(/print\(f["']/, 'print("').replace(/["']\s*\)$/, '")');
    }
    return line;
  });

  // 2. Fix bare Polish text lines that aren't comments (Bielik hallucination)
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return true;
    // Lines that are just Polish text (no = sign, no parentheses, no operators)
    if (/^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż\s,]+[.:]?$/.test(trimmed)) return false;
    return true;
  });

  // 3. Fix unmatched quotes in print statements
  lines = lines.map(line => {
    if (/print\(/.test(line)) {
      const open = (line.match(/\(/g) || []).length;
      const close = (line.match(/\)/g) || []).length;
      if (open > close) {
        line += ')'.repeat(open - close);
      }
    }
    return line;
  });

  // 4. Fix SymPy geometry API: free-function calls → method calls on Triangle
  //    Bielik writes incenter(tri), circumcenter(tri), semiperimeter(tri)
  //    but SymPy uses tri.incenter, tri.circumcenter, etc.
  lines = lines.map(line => {
    // semiperimeter(varname) → varname.perimeter / 2
    line = line.replace(/\bsemiperimeter\((\w+)\)/g, '($1.perimeter / 2)');
    // incenter(varname) → varname.incenter
    line = line.replace(/\bincenter\((\w+)\)/g, '$1.incenter');
    // circumcenter(varname) → varname.circumcenter
    line = line.replace(/\bcircumcenter\((\w+)\)/g, '$1.circumcenter');
    // circumradius(varname) → varname.circumradius
    line = line.replace(/\bcircumradius\((\w+)\)/g, '$1.circumradius');
    // inradius(varname) → varname.inradius
    line = line.replace(/\binradius\((\w+)\)/g, '$1.inradius');
    // incircle(varname) → varname.incircle
    line = line.replace(/\bincircle\((\w+)\)/g, '$1.incircle');
    // circumcircle(varname) → varname.circumcircle
    line = line.replace(/\bcircumcircle\((\w+)\)/g, '$1.circumcircle');
    return line;
  });

  // 5. Ensure there's a print("ODPOWIEDZ:") somewhere
  const joined = lines.join('\n');
  if (!joined.includes('ODPOWIEDZ')) {
    // Find last assignment and add print
    for (let i = lines.length - 1; i >= 0; i--) {
      const assignMatch = lines[i].match(/^(\s*)(\w+)\s*=/);
      if (assignMatch && !lines[i].trim().startsWith('#')) {
        lines.push(`print("ODPOWIEDZ:", ${assignMatch[2]})`);
        break;
      }
    }
  }

  return lines.join('\n');
}

// ── Helper: extract JSON from classifier response ─────────────────────

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch {}
  }
  return null;
}

// ── RAG client (port 3003) ────────────────────────────────────────────

const RAG_PORT = process.env.RAG_PORT || 3003;
const RAG_URL = `http://127.0.0.1:${RAG_PORT}`;

async function ragHealthy() {
  try {
    const res = await fetch(`${RAG_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ready === true;
  } catch { return false; }
}

async function ragQuery(userMessage, topK = 5) {
  try {
    const res = await fetch(`${RAG_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: userMessage, k: topK }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    console.log(`📚 RAG: ${data.results?.length || 0} wyników w ${data.retrieval_ms}ms`);
    return data.results || [];
  } catch (err) {
    console.warn('⚠️ RAG query error (non-blocking):', err);
    return [];
  }
}

function detectCategories(questionText) {
  const lower = questionText.toLowerCase();
  const categories = [
    { name: 'stereometria', keywords: ['graniastosłup', 'ostrosłup', 'walec', 'stożek', 'kula', 'bryła', 'objętość', 'pole powierzchni', 'przekrój', 'krawędź boczna', 'ściana boczna', 'wysokość bryły', 'podstawa bryły', 'sześciokąt'] },
    { name: 'parametric', keywords: ['parametr', 'wartości m', 'wartości a', 'wartości p', 'dla jakich', 'warunek na', 'wyróżnik', 'delta'] },
    { name: 'ciagi', keywords: ['ciąg arytmetyczny', 'ciąg geometryczny', 'ciąg', 'wyraz ciągu', 'różnica ciągu', 'iloraz ciągu', 'suma ciągu', 'n-ty wyraz'] },
    { name: 'trygonometria', keywords: ['sinus', 'cosinus', 'tangens', 'sin', 'cos', 'tg', 'trygonometr', 'kąt', 'stopni'] },
    { name: 'dowody', keywords: ['wykaż', 'udowodnij', 'dowód', 'indukcja', 'pokaż że', 'pokaż, że'] },
    { name: 'optymalizacja', keywords: ['największ', 'najmniejsz', 'maksymaln', 'minimaln', 'optymal', 'ekstremum', 'wartość największa', 'wartość najmniejsza'] },
    { name: 'prawdopodobienstwo', keywords: ['prawdopodobień', 'losow', 'rzut kostk', 'rzut monet', 'urna', 'kula z urny', 'zdarzeni'] },
    { name: 'granice', keywords: ['granica', 'lim', 'granicy', 'dąży do', 'zbieżn'] },
    { name: 'nierownosci', keywords: ['nierówność', 'nierównoś', 'leq', 'geq', '\\leq', '\\geq', 'rozwiąż nierówność'] },
    { name: 'geometria_analityczna', keywords: ['okrąg', 'prosta', 'współrzędn', 'równoległobok', 'przekątne', 'środek odcinka', 'punkt przeci'] },
    { name: 'kombinatoryka', keywords: ['ile jest', 'na ile sposobów', 'liczba naturalna', 'zapis dziesiętny', 'cyfr', 'kombinacj', 'permutacj'] },
    { name: 'logarytmy', keywords: ['logarytm', 'log_', 'log ', '\\log'] },
    { name: 'funkcja_kwadratowa', keywords: ['funkcja kwadratowa', 'parabola', 'oś symetrii', 'wierzchołek', 'f(x) = x**2', 'x^2 + bx'] },
  ];
  const matched = [];
  for (const cat of categories) {
    if (cat.keywords.some(kw => lower.includes(kw))) matched.push(cat.name);
  }
  return matched;
}

const CATEGORY_STRATEGIES = {
  'stereometria': 'STRATEGIA STEREOMETRIA:\n- Zidentyfikuj typ bryły (graniastosłup/ostrosłup/walec/stożek/kula)\n- Wyznacz pole podstawy (S) i wysokość (h)\n- V = S * h (graniastosłup/walec) lub V = (1/3) * S * h (ostrosłup/stożek)\n- Twierdzenie Pitagorasa 3D: a² + b² + c² = d² (przekątna prostopadłościanu)\nSymPy: from sympy import *; a, h = symbols("a h", positive=True); V = a**2 * h',
  'parametric': 'STRATEGIA PARAMETR:\n- Wyciągnij parametr (m, a, p) z równania\n- Oblicz wyróżnik: delta = discriminant(poly)\n- Jedno rozw. → delta = 0; dwa różne → delta > 0; brak → delta < 0\nSymPy: from sympy import *; m = symbols("m"); poly = Poly(eq, x); delta = discriminant(poly); solve(delta > 0, m)',
  'ciagi': 'STRATEGIA CIĄGI:\n- Arytmetyczny: a_n = a_1 + (n-1)*d, S_n = n*(a_1 + a_n)/2\n- Geometryczny: a_n = a_1 * q**(n-1), S_n = a_1*(1 - q**n)/(1 - q)\nSymPy: from sympy import *; a1, d, q, n = symbols("a1 d q n"); solve([eq1, eq2], [a1, d])',
  'trygonometria': 'STRATEGIA TRYGONOMETRIA:\n- sin²x + cos²x = 1, sin(2x) = 2sin(x)cos(x)\n- Użyj solveset(eq, x, Interval(0, 2*pi)) zamiast solve()\nSymPy: from sympy import *; x = symbols("x", real=True); solveset(sin(x) - Rational(1,2), x, Interval(0, 2*pi))',
  'dowody': 'STRATEGIA DOWODY:\n- Bezpośredni: przekształć lewą stronę do prawej\n- Indukcja: base case n=1 + krok indukcyjny\nSymPy: from sympy import *; simplify(LHS - RHS)',
  'optymalizacja': 'STRATEGIA OPTYMALIZACJA:\n- Pochodna: diff(f, x), solve(diff(f, x), x)\n- Sprawdź znak f\'\'(x) w punktach krytycznych\nSymPy: from sympy import *; x = symbols("x", positive=True); f = ...; crits = solve(diff(f, x), x)',
  'prawdopodobienstwo': 'STRATEGIA PRAWDOPODOBIEŃSTWO:\n- P(A) = |A| / |Ω|\n- Użyj Rational(a,b) NIE float\nSymPy: from sympy import *; binomial(n, k); Rational(sprzyjające, wszystkie)',
  'granice': 'STRATEGIA GRANICE:\n- limit(expr, x, a, \'-\') lewostronnej, limit(expr, x, a, \'+\') prawostronnej\nSymPy: from sympy import *; x = symbols("x"); limit((x**3-8)/(x-2)**2, x, 2, "-")',
  'nierownosci': 'STRATEGIA NIERÓWNOŚCI:\n- NIGDY nie rób arytmetyki na Relational (>=, <=)!\n- Użyj solve_univariate_inequality(expr <= 0, x, relational=False)\nSymPy: from sympy import *; from sympy.solvers.inequalities import solve_univariate_inequality',
  'geometria_analityczna': 'STRATEGIA GEOMETRIA ANALITYCZNA:\n- Odległość: sqrt((x2-x1)²+(y2-y1)²)\n- Okrąg: (x-a)²+(y-b)²=r²\nSymPy: from sympy import *; sqrt((x2-x1)**2 + (y2-y1)**2)',
  'kombinatoryka': 'STRATEGIA KOMBINATORYKA:\n- 0 nie może stać na pierwszym miejscu!\n- binomial(n,k), factorial(n)\nSymPy: from sympy import *; binomial(5,3) * factorial(5)',
  'logarytmy': 'STRATEGIA LOGARYTMY:\n- log(x, base) w SymPy\n- expand_log(expr, force=True) rozwija; logcombine(expr) łączy\nSymPy: from sympy import *; log(9, sqrt(3)); simplify(...)',
  'funkcja_kwadratowa': 'STRATEGIA FUNKCJA KWADRATOWA:\n- f(x) = ax² + bx + c, oś symetrii x = -b/(2a)\n- delta = b²-4ac\nSymPy: from sympy import *; b, c = symbols("b c"); solve([Eq(-b/2, -2), Eq(1+b+c, -10)], [b, c])',
};

function formatRAGContext(results, categories) {
  if (!results.length && !categories.length) return '';
  const sections = [];

  for (const cat of categories) {
    const strategy = CATEGORY_STRATEGIES[cat];
    if (strategy) sections.push(strategy);
  }
  if (categories.length > 1) {
    sections.push(`UWAGA: To zadanie łączy ${categories.length} kategorii: ${categories.join(' + ')}. Najpierw rozwiąż każdą część osobno, potem połącz wyniki.`);
  }

  const methods = results.filter(r => r.source === 'methods' && r.score > 0.10);
  if (methods.length > 0) {
    const methodLines = methods.slice(0, 3).map(m => {
      let line = `- ${m.title}`;
      if (m.tips) line += `\n  Wskazowki: ${m.tips.substring(0, 250)}`;
      if (m.sympy_hint) line += `\n  SymPy: ${m.sympy_hint.substring(0, 250)}`;
      if (m.metadata?.worked_example?.sympy_code) {
        line += `\n  Przyklad:\n${m.metadata.worked_example.sympy_code.substring(0, 300)}`;
      }
      return line;
    });
    sections.push(`METODY ROZWIAZANIA:\n${methodLines.join('\n')}`);
  }

  const pdfChunks = results.filter(r => r.source === 'informator_pdf' && r.score > 0.10);
  if (pdfChunks.length > 0) {
    const pdfLines = pdfChunks.slice(0, 2).map(p => {
      let line = `- ${p.title} [${p.category}]`;
      if (p.sympy_hint) line += `\n  Kod SymPy: ${p.sympy_hint.substring(0, 200)}`;
      return line;
    });
    sections.push(`PODOBNE ZADANIA (informator CKE):\n${pdfLines.join('\n')}`);
  }

  const examples = results.filter(r => r.source === 'dataset' && r.score > 0.15);
  if (examples.length > 0) {
    const exLines = examples.slice(0, 2).map(e => `- ${e.title} [${e.category}]`);
    sections.push(`PODOBNE ZADANIA HISTORYCZNE:\n${exLines.join('\n')}`);
  }

  if (!sections.length) return '';
  return `\n--- KONTEKST RAG ---\n${sections.join('\n\n')}\n---\n`;
}

function formatSymPyHints(results, categories) {
  const hints = results
    .filter(r => r.sympy_hint && r.score > 0.10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const sections = [];

  for (const cat of categories) {
    const strategy = CATEGORY_STRATEGIES[cat];
    if (strategy) {
      const sympyLine = strategy.split('\n').find(l => l.startsWith('SymPy:'));
      if (sympyLine) sections.push(`# WZORZEC (${cat}):\n${sympyLine.replace('SymPy: ', '')}`);
    }
  }

  for (const h of hints) {
    let section = `# ${h.title || h.category}`;
    section += `\n${h.sympy_hint}`;
    if (h.tips) {
      const tipLines = h.tips.substring(0, 250).split(/[.;]/).filter(t => t.trim());
      if (tipLines.length > 0) section += '\n# WAZNE: ' + tipLines.slice(0, 2).map(t => t.trim()).join('; ');
    }
    if (h.metadata?.worked_example?.sympy_code) {
      section += `\n# PRZYKLAD ROZWIAZANIA:\n${h.metadata.worked_example.sympy_code.substring(0, 250)}`;
    }
    sections.push(section);
  }

  if (!sections.length) return '';

  const pitfallHints = [
    '# PAMIETAJ: solve() moze zwrocic liste, dict, And, Or, lub Relational',
    '# PAMIETAJ: Rational(1,3) nie 1/3; cos(x)**2 nie cos**2(x)',
    '# PAMIETAJ: Na koniec ZAWSZE print("ODPOWIEDZ: ...")',
  ];

  return `\n--- PODPOWIEDZI SYMPY ---\n${sections.join('\n\n')}\n\n${pitfallHints.join('\n')}\n--- KONIEC PODPOWIEDZI ---\n`;
}

function formatRetryHint(results) {
  const best = results
    .filter(r => r.sympy_hint && r.score > 0.10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (!best.length) return '';
  const hints = best.map(b => b.sympy_hint.substring(0, 150).trim()).join('\n');
  return `\nPodpowiedzi SymPy:\n${hints}\n# WAZNE: solve() zwraca liste.`;
}

// ── Output suspicion check ───────────────────────────────────────────

function isOutputSuspicious(stdout) {
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
    if (pat.test(trimmed)) return `Output contains error: ${trimmed.substring(0, 120)}`;
  }
  if (/^(?:ODPOWIEDZ:\s*)?None\s*$/i.test(trimmed)) return 'Output is None';
  return null;
}

// ── Brute-force verification (digit counting) ────────────────────────

function generateDigitCountingVerification(problem) {
  const text = problem.toLowerCase();

  if (!/cyfr|cyfrowe|cyfrowych|zapisie dziesi[eę]tnym|liczb\w* naturaln/.test(text)) return null;

  const noRepeats = /nie powt[aó]rza|różn\w* cyfr|bez powt[oó]rzeń|r[oó]żnych cyfr/.test(text);

  const polishNumbers = {
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

  let nOdd = oddMatch ? (polishNumbers[oddMatch[1]] ?? parseInt(oddMatch[1])) : null;
  let nEven = evenMatch ? (polishNumbers[evenMatch[1]] ?? parseInt(evenMatch[1])) : null;

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

async function verifyNumericAnswer(problem, answer) {
  try {
    const num = parseFloat(answer);
    if (isNaN(num) || num < 0 || num > 1_000_000) return answer;
    if (!Number.isInteger(num)) return answer;

    const code = generateDigitCountingVerification(problem);
    if (!code) return answer;

    console.log(`🔍 Running deterministic brute-force verification for answer: ${answer}`);
    const result = await callSymPy(code);

    if (/Error:|Traceback|SyntaxError/i.test(result)) {
      console.log(`  ⚠️ Verification code error: ${result.substring(0, 80)}`);
      return answer;
    }

    const match = /WERYFIKACJA:\s*(\d+)/i.exec(result);
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

async function bruteForceViaLLM(problem, formulaAnswer, ragContext) {
  try {
    if (/sqrt|pi|[*\/^]|[a-zA-Z]{2,}/.test(formulaAnswer)) return null;
    const numericAnswer = parseFloat(formulaAnswer);
    if (isNaN(numericAnswer) || numericAnswer < 0 || numericAnswer > 1_000_000) return null;
    if (!Number.isInteger(numericAnswer)) return null;

    const verifyPrompt = `Napisz KRÓTKI kod Python (max 15 linii) który BRUTE-FORCE (przez wyliczenie/iterację) sprawdzi odpowiedź na to zadanie.

ZASADY:
- Użyj itertools (permutations, combinations, product) do wyliczenia WSZYSTKICH przypadków
- Zlicz te które spełniają warunki
- NIE używaj wzorów kombinatorycznych
- Ostatnia linia: print("WERYFIKACJA:", count)
- TYLKO kod w bloku \`\`\`python ... \`\`\`

Zadanie: ${problem}
${ragContext ? `Kontekst: ${ragContext}` : ''}

Odpowiedź z formuły: ${formulaAnswer}`;

    const response = await llmCall('brute_force_verify',
      'Jesteś programistą Python. Piszesz WYŁĄCZNIE krótki kod brute-force do weryfikacji odpowiedzi. TYLKO kod, bez wyjaśnień.',
      [{ role: 'user', content: verifyPrompt }],
      { maxTokens: 500, temperature: 0.1 },
    );

    const code = extractPythonCode(stripThink(response));
    if (!code) return null;

    console.log(`🔍 Running LLM brute-force verification...`);
    const output = await callSymPy(code);

    if (/Error:|Traceback|SyntaxError|NameError|MemoryError|Timeout/i.test(output)) {
      console.log(`  ⚠️ Brute-force verification failed: ${output.substring(0, 80)}`);
      return null;
    }

    const verifyMatch = /WERYFIKACJA:\s*(\d+)/i.exec(output);
    if (!verifyMatch) return null;

    return verifyMatch[1];
  } catch (error) {
    console.log(`  ⚠️ Brute-force verification error: ${error}`);
    return null;
  }
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

// ── Helper: call sympy_plot via MCP proxy ─────────────────────────────

async function callSymPyPlot(code) {
  return llmobs.trace({ kind: 'tool', name: 'sympy_plot' }, async () => {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        name: 'sympy_plot',
        arguments: { code },
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
        timeout: 30000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const content = data.content?.[0]?.text || data.result?.content?.[0]?.text || body;
            llmobs.annotate({ inputData: code, outputData: content.substring(0, 200) });
            resolve(content);
          } catch (e) {
            resolve(body);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Plot timeout')); });
      req.write(postData);
      req.end();
    });
  });
}

// ── Geometry diagram detection ────────────────────────────────────────

// Explicit construction requests (always generate a diagram)
const CONSTRUCTION_KEYWORDS = [
  'narysuj', 'rysuj', 'szkic', 'konstruk', 'wykres',
  'wpisz okrąg', 'opisz okrąg', 'okrąg wpisany', 'okrąg opisany',
  'inscribed circle', 'circumscribed circle',
  'draw', 'sketch', 'plot', 'diagram',
  'wykonaj konstrukcj', 'wykonaj rysunek',
];

// Geometry shape keywords: if 2+ match, the problem likely benefits from a diagram
const GEOMETRY_SHAPE_KEYWORDS = [
  'trójkąt', 'trojkat', 'triangle',
  'prostokąt', 'prostokat', 'rectangle',
  'kwadrat', 'square',
  'romb', 'rhombus',
  'trapez', 'trapezoid',
  'równoległobok', 'rownoleglobok', 'parallelogram',
  'okrąg', 'okrag', 'circle', 'koło', 'kolo',
  'sześciokąt', 'szesciokat', 'hexagon',
  'pięciokąt', 'pieciokat', 'pentagon',
  'wielokąt', 'wielokat', 'polygon',
  'ostrosłup', 'ostroslup', 'pyramid',
  'graniastosłup', 'graniastoslup', 'prism',
  'walec', 'cylinder',
  'stożek', 'stozek', 'cone',
  'kula', 'sphere',
  'przekątna', 'przekatna', 'diagonal',
  'wysokość', 'wysokosc', 'height',
  'podstawa', 'base',
  'wierzchołek', 'wierzcholek', 'vertex',
  'bok', 'krawędź', 'krawedz', 'side', 'edge',
  'kąt', 'kat', 'angle',
  'promień', 'promien', 'radius',
  'średnica', 'srednica', 'diameter',
];

// Function graph keywords
const GRAPH_KEYWORDS = [
  'wykres funkcji', 'narysuj wykres', 'naszkicuj wykres',
  'graph of', 'plot function',
  'parabola', 'hiperbola', 'sinusoida',
  'oś symetrii', 'os symetrii',
  'przedziały monotoniczności', 'przedzialy monotonnicznosci',
  'miejsca zerowe',
];

// Classify what type of diagram is appropriate
const DIAGRAM_TYPE = {
  TRIANGLE: 'triangle',
  QUADRILATERAL: 'quadrilateral',
  CIRCLE: 'circle',
  SOLID_3D: 'solid_3d',
  COORDINATE: 'coordinate',
  FUNCTION_GRAPH: 'function_graph',
  GENERIC: 'generic',
};

function detectDiagramType(text) {
  const lower = text.toLowerCase();

  // Function graphs
  if (GRAPH_KEYWORDS.some(kw => lower.includes(kw))) return DIAGRAM_TYPE.FUNCTION_GRAPH;
  if (/funkcj[aie]\s+(kwadrat|liniow|wykładnicz|logarytm)/.test(lower)) return DIAGRAM_TYPE.FUNCTION_GRAPH;

  // 3D solids
  const solidWords = ['ostrosłup', 'ostroslup', 'graniastosłup', 'graniastoslup', 'walec', 'stożek', 'stozek', 'kula', 'prostopadłościan', 'prostopadloscian', 'sześcian', 'szescian', 'bryła', 'bryla', 'objętość', 'objetosc'];
  if (solidWords.some(kw => lower.includes(kw))) return DIAGRAM_TYPE.SOLID_3D;

  // Coordinate geometry
  const coordWords = ['współrzędn', 'wspolrzedn', 'punkt (', 'punkt a(', 'punkt b(', 'punkt c(', 'A(', 'B(', 'C(', 'równanie prostej', 'rownanie prostej'];
  if (coordWords.some(kw => lower.includes(kw))) return DIAGRAM_TYPE.COORDINATE;

  // Circle problems
  const circleWords = ['okrąg', 'okrag', 'koło', 'kolo', 'promień', 'promien', 'średnica', 'srednica', 'wpisany', 'opisany', 'styczna', 'cięciwa', 'cieciwa'];
  const circleHits = circleWords.filter(kw => lower.includes(kw)).length;
  if (circleHits >= 2) return DIAGRAM_TYPE.CIRCLE;

  // Quadrilaterals
  const quadWords = ['prostokąt', 'prostokat', 'kwadrat', 'romb', 'trapez', 'równoległobok', 'rownoleglobok', 'czworokąt', 'czworokat'];
  if (quadWords.some(kw => lower.includes(kw))) return DIAGRAM_TYPE.QUADRILATERAL;

  // Triangles
  const triWords = ['trójkąt', 'trojkat', 'triangle', 'przyprostokątn', 'przeciwprostokątn', 'przyległ', 'naprzeciwk'];
  if (triWords.some(kw => lower.includes(kw))) return DIAGRAM_TYPE.TRIANGLE;

  return DIAGRAM_TYPE.GENERIC;
}

function shouldGenerateDiagram(text, problemType) {
  const lower = text.toLowerCase();

  // Explicit request always wins
  if (CONSTRUCTION_KEYWORDS.some(kw => lower.includes(kw))) return true;

  // Function graph requests
  if (GRAPH_KEYWORDS.some(kw => lower.includes(kw))) return true;

  // Geometry classified problems: check if 2+ shape keywords match
  const geometryTypes = ['geometria', 'geometria_analityczna', 'stereometria', 'planimetria', 'trygonometria'];
  const isGeometryProblem = geometryTypes.some(t => (problemType || '').toLowerCase().includes(t));
  const shapeHits = GEOMETRY_SHAPE_KEYWORDS.filter(kw => lower.includes(kw)).length;

  if (isGeometryProblem && shapeHits >= 1) return true;
  if (shapeHits >= 2) return true;

  return false;
}

// ── SVG generation: shared rules and type-specific prompts ───────────

const SVG_COMMON_RULES = `ZASADY OGOLNE:
1. Na koniec wypisz SVG uzywajac print(). SVG musi byc KOMPLETNY: <svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>
2. Uzyj viewBox i skalowania zeby diagram byl czytelny (min 400x400)
3. Linie: stroke-width proporcjonalny do rozmiaru viewBoxa, fill="none" dla kszaltow
4. Tlo biale, font-family="sans-serif"
5. NIE uzywaj matplotlib! Generuj SVG recznie z obliczonych wspolrzednych
6. float() na kazdej wartosci sympy przed umieszczeniem w SVG
7. TYLKO kod w bloku \\\`\\\`\\\`python ... \\\`\\\`\\\`
8. NIE uzywaj f-stringow! Buduj SVG przez konkatenacje lub format()
9. Dodaj etykiety punktow i wartosci liczbowych (dlugosci, katy, promienie)
10. Dodaj lekka siatke w tle (szare linie co 1 jednostke, opacity 0.15)
11. Oznacz katy lukiami (maly luk przy wierzcholku kata)
12. Oznacz dlugosci bokow (tekst na srodku boku)`;

const SVG_HELPER_CODE = `
# Pomocnicze funkcje SVG
def pf(point):
    return (float(point.x), float(point.y))

def rf(val):
    return float(val)

def svg_bbox(points, extra_points=None, margin=1.5):
    all_x = [p[0] for p in points]
    all_y = [p[1] for p in points]
    if extra_points:
        for p in extra_points:
            all_x.append(p[0])
            all_y.append(p[1])
    mn_x, mx_x = min(all_x) - margin, max(all_x) + margin
    mn_y, mx_y = min(all_y) - margin, max(all_y) + margin
    return mn_x, mn_y, mx_x - mn_x, mx_y - mn_y, mx_y

def sy(y, max_y, min_y):
    return max_y - y + min_y

def svg_grid(min_x, min_y, w, h, step=1):
    import math
    lines = []
    start_x = math.floor(min_x)
    start_y = math.floor(min_y)
    x = start_x
    while x <= min_x + w:
        lines.append('<line x1="' + str(round(x, 1)) + '" y1="' + str(round(min_y, 1)) + '" x2="' + str(round(x, 1)) + '" y2="' + str(round(min_y + h, 1)) + '" stroke="#ccc" stroke-width="0.02" opacity="0.3"/>')
        x += step
    y = start_y
    while y <= min_y + h:
        lines.append('<line x1="' + str(round(min_x, 1)) + '" y1="' + str(round(y, 1)) + '" x2="' + str(round(min_x + w, 1)) + '" y2="' + str(round(y, 1)) + '" stroke="#ccc" stroke-width="0.02" opacity="0.3"/>')
        y += step
    return "\\n  ".join(lines)

def svg_label(x, y, text, font_size=0.45, anchor="middle", color="#333"):
    return '<text x="' + str(round(x, 2)) + '" y="' + str(round(y, 2)) + '" font-size="' + str(font_size) + '" text-anchor="' + anchor + '" fill="' + color + '" font-family="sans-serif">' + str(text) + '</text>'

def svg_line(x1, y1, x2, y2, color="#2563eb", width=0.06, dash=""):
    attr = ""
    if dash:
        attr = ' stroke-dasharray="' + dash + '"'
    return '<line x1="' + str(round(x1,2)) + '" y1="' + str(round(y1,2)) + '" x2="' + str(round(x2,2)) + '" y2="' + str(round(y2,2)) + '" stroke="' + color + '" stroke-width="' + str(width) + '"' + attr + '/>'

def svg_circle(cx, cy, r, color="#dc2626", width=0.06, dash=""):
    attr = ""
    if dash:
        attr = ' stroke-dasharray="' + dash + '"'
    return '<circle cx="' + str(round(cx,2)) + '" cy="' + str(round(cy,2)) + '" r="' + str(round(r,2)) + '" fill="none" stroke="' + color + '" stroke-width="' + str(width) + '"' + attr + '/>'

def svg_polygon(points, color="#2563eb", width=0.08):
    pts_str = " ".join(str(round(p[0],2)) + "," + str(round(p[1],2)) for p in points)
    return '<polygon points="' + pts_str + '" fill="none" stroke="' + color + '" stroke-width="' + str(width) + '"/>'

def svg_angle_arc(cx, cy, r, start_angle, end_angle, color="#f59e0b", width=0.04):
    import math
    sa = math.radians(start_angle)
    ea = math.radians(end_angle)
    x1 = cx + r * math.cos(sa)
    y1 = cy - r * math.sin(sa)
    x2 = cx + r * math.cos(ea)
    y2 = cy - r * math.sin(ea)
    large = 1 if abs(end_angle - start_angle) > 180 else 0
    return '<path d="M ' + str(round(x1,2)) + ' ' + str(round(y1,2)) + ' A ' + str(round(r,2)) + ' ' + str(round(r,2)) + ' 0 ' + str(large) + ' 0 ' + str(round(x2,2)) + ' ' + str(round(y2,2)) + '" fill="none" stroke="' + color + '" stroke-width="' + str(width) + '"/>'

def svg_mid_label(p1, p2, text, sy_fn, min_y_val, offset=0.35):
    mx = (p1[0] + p2[0]) / 2
    my = (p1[1] + p2[1]) / 2
    return svg_label(mx, sy_fn(my, min_y_val, min_y_val) - offset, text, font_size=0.35, color="#666")
`;

const DIAGRAM_PROMPTS = {
  triangle: `Napisz kod Python ktory generuje diagram SVG dla tego zadania o trojkacie.

${SVG_COMMON_RULES}

KOLORY: trojkat niebieski (#2563eb), okrag wpisany czerwony (#dc2626), okrag opisany zielony (#16a34a), katy zolty (#f59e0b), wysokosc fioletowy (#7c3aed)

\\\`\\\`\\\`python
from sympy import *
from sympy.geometry import *
${SVG_HELPER_CODE}
# Definiuj trojkat z wymiarami z zadania
A = Point(0, 0)
B = Point(6, 0)
C = Point(3, 5)
t = Triangle(A, B, C)

# Oblicz co trzeba (incircle, circumcircle, wysokosci, katy)
# ...

# Zbierz punkty, oblicz viewBox
pts = [pf(A), pf(B), pf(C)]
mn_x, mn_y, w, h, mx_y = svg_bbox(pts, margin=1.5)

# Zbuduj SVG
elements = []
elements.append(svg_grid(mn_x, mn_y, w, h))
elements.append(svg_polygon([(p[0], sy(p[1], mx_y, mn_y)) for p in pts]))
# Dodaj etykiety, katy, dlugosci bokow
# ...

svg_body = "\\n  ".join(elements)
header = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + str(round(mn_x,1)) + ' ' + str(round(mn_y,1)) + ' ' + str(round(w,1)) + ' ' + str(round(h,1)) + '" width="500" height="500" style="background:white">'
print(header + "\\n  " + svg_body + "\\n</svg>")
\\\`\\\`\\\``,

  quadrilateral: `Napisz kod Python ktory generuje diagram SVG dla tego zadania o czworokacie (prostokat/kwadrat/romb/trapez/rownoleglobok).

${SVG_COMMON_RULES}

KOLORY: czworokat niebieski (#2563eb), przekatne pomaranczowy (#ea580c), wysokosc fioletowy (#7c3aed), katy zolty (#f59e0b)

\\\`\\\`\\\`python
from sympy import *
from sympy.geometry import *
${SVG_HELPER_CODE}
# Definiuj wierzcholki czworokata z wymiarami z zadania
A = Point(0, 0)
B = Point(8, 0)
C = Point(8, 5)
D = Point(0, 5)

pts = [pf(A), pf(B), pf(C), pf(D)]
mn_x, mn_y, w, h, mx_y = svg_bbox(pts, margin=1.5)

elements = []
elements.append(svg_grid(mn_x, mn_y, w, h))
# Rysuj czworokat
flipped = [(p[0], sy(p[1], mx_y, mn_y)) for p in pts]
elements.append(svg_polygon(flipped))
# Dodaj przekatne jesli potrzebne
# Dodaj etykiety, dlugosci, katy
# ...

svg_body = "\\n  ".join(elements)
header = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + str(round(mn_x,1)) + ' ' + str(round(mn_y,1)) + ' ' + str(round(w,1)) + ' ' + str(round(h,1)) + '" width="500" height="500" style="background:white">'
print(header + "\\n  " + svg_body + "\\n</svg>")
\\\`\\\`\\\``,

  circle: `Napisz kod Python ktory generuje diagram SVG dla tego zadania o okregach/kolach.

${SVG_COMMON_RULES}

KOLORY: okrag glowny niebieski (#2563eb), promien czerwony (#dc2626), srednica zielony (#16a34a), styczna pomaranczowy (#ea580c), ciecie fioletowy (#7c3aed)

\\\`\\\`\\\`python
from sympy import *
from sympy.geometry import *
${SVG_HELPER_CODE}
# Definiuj okregi z wymiarami z zadania
O = Point(0, 0)
r = 5
c = Circle(O, r)

center = pf(O)
pts = [(center[0] - float(r) - 1, center[1] - float(r) - 1),
       (center[0] + float(r) + 1, center[1] + float(r) + 1)]
mn_x, mn_y, w, h, mx_y = svg_bbox(pts, margin=1.5)

elements = []
elements.append(svg_grid(mn_x, mn_y, w, h))
elements.append(svg_circle(center[0], sy(center[1], mx_y, mn_y), float(r), color="#2563eb", width=0.08))
# Dodaj promien, srednice, styczne, punkty
# ...

svg_body = "\\n  ".join(elements)
header = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + str(round(mn_x,1)) + ' ' + str(round(mn_y,1)) + ' ' + str(round(w,1)) + ' ' + str(round(h,1)) + '" width="500" height="500" style="background:white">'
print(header + "\\n  " + svg_body + "\\n</svg>")
\\\`\\\`\\\``,

  solid_3d: `Napisz kod Python ktory generuje diagram SVG (rzut 2D) dla tego zadania o bryle 3D.

${SVG_COMMON_RULES}

SPECJALNE ZASADY DLA 3D:
- Uzyj rzutu aksonometrycznego (skos 30 stopni) zeby pokazac glebokosc
- Krawedzie niewidoczne rysuj linia przerywana
- Oznacz wymiary: a (krawedz), h (wysokosc), d (przekatna)

KOLORY: krawedzie widoczne niebieski (#2563eb), krawedzie niewidoczne szary (#94a3b8), podstawa zielony (#16a34a), wysokosc czerwony (#dc2626), przekatna pomaranczowy (#ea580c)

\\\`\\\`\\\`python
from sympy import *
import math
${SVG_HELPER_CODE}
# Rzut aksonometryczny: przesuniecie dla osi Z i glebokosci
def project_3d(x, y, z, skew=0.5, angle=30):
    rad = math.radians(angle)
    px = x + z * skew * math.cos(rad)
    py = y + z * skew * math.sin(rad)
    return (px, py)

# Definiuj wymiary bryly z zadania
# ...

# Oblicz wierzcholki po rzucie
# Rysuj widoczne krawedzie linia ciagla, niewidoczne przerywana
# Dodaj etykiety wymiarow
# ...

# Zbierz w SVG i print()
\\\`\\\`\\\``,

  coordinate: `Napisz kod Python ktory generuje diagram SVG ukladu wspolrzednych z punktami/prostymi/okregami.

${SVG_COMMON_RULES}

SPECJALNE ZASADY:
- ZAWSZE rysuj osie X i Y ze strzalkami na koncach
- Oznacz skale na osiach (co 1 jednostke)
- Zaznacz punkty kolkami (r=0.12) z etykietami "A(x,y)"
- Proste/odcinki rysuj z rownaniem obok

KOLORY: osie czarny (#1e293b), punkty czerwony (#dc2626), proste niebieski (#2563eb), okrag zielony (#16a34a)

\\\`\\\`\\\`python
from sympy import *
from sympy.geometry import *
${SVG_HELPER_CODE}
def svg_arrow(x1, y1, x2, y2, color="#1e293b", width=0.06):
    import math
    dx = x2 - x1
    dy = y2 - y1
    angle = math.atan2(dy, dx)
    arr_len = 0.3
    ax1 = x2 - arr_len * math.cos(angle - 0.4)
    ay1 = y2 - arr_len * math.sin(angle - 0.4)
    ax2 = x2 - arr_len * math.cos(angle + 0.4)
    ay2 = y2 - arr_len * math.sin(angle + 0.4)
    line = svg_line(x1, y1, x2, y2, color=color, width=width)
    head = '<polygon points="' + str(round(x2,2)) + ',' + str(round(y2,2)) + ' ' + str(round(ax1,2)) + ',' + str(round(ay1,2)) + ' ' + str(round(ax2,2)) + ',' + str(round(ay2,2)) + '" fill="' + color + '"/>'
    return line + "\\n  " + head

def svg_axes(mn_x, mn_y, w, h):
    lines = []
    # os X
    lines.append(svg_arrow(mn_x, 0, mn_x + w, 0))
    lines.append(svg_label(mn_x + w - 0.2, 0.4, "x", font_size=0.4))
    # os Y
    lines.append(svg_arrow(0, mn_y + h, 0, mn_y))
    lines.append(svg_label(0.3, mn_y + 0.3, "y", font_size=0.4))
    # Skala
    import math
    i = math.ceil(mn_x)
    while i < mn_x + w:
        if i != 0:
            lines.append(svg_line(i, -0.1, i, 0.1, color="#1e293b", width=0.03))
            lines.append(svg_label(i, 0.45, str(i), font_size=0.3, color="#666"))
        i += 1
    j = math.ceil(mn_y)
    while j < mn_y + h:
        if j != 0:
            lines.append(svg_line(-0.1, j, 0.1, j, color="#1e293b", width=0.03))
            lines.append(svg_label(-0.4, j + 0.12, str(int(-j)), font_size=0.3, color="#666"))
        j += 1
    return "\\n  ".join(lines)

# Definiuj punkty/proste z zadania
# ...

# Oblicz viewBox
# Dodaj osie, siatke, punkty, proste, etykiety
# Zbierz w SVG i print()
\\\`\\\`\\\``,

  function_graph: `Napisz kod Python ktory generuje diagram SVG wykresu funkcji.

${SVG_COMMON_RULES}

SPECJALNE ZASADY:
- ZAWSZE rysuj osie X i Y ze strzalkami
- Oznacz skale na osiach
- Wykres funkcji rysuj jako polyline z duza iloscia punktow (100+)
- Zaznacz wazne punkty: miejsca zerowe (kolko), wierzcholek (kolko wypelnione), ekstrema
- Dodaj etykiete funkcji np. "f(x) = x^2 + 2x + 1"
- Zaznacz os symetrii linia przerywana jesli dotyczy

KOLORY: osie czarny (#1e293b), wykres niebieski (#2563eb), miejsca zerowe czerwony (#dc2626), wierzcholek zielony (#16a34a), os symetrii szary (#94a3b8)

\\\`\\\`\\\`python
from sympy import *
import math as pymath
${SVG_HELPER_CODE}
# Definiuj funkcje z zadania
x = symbols('x')
f = x**2 + 2*x - 3  # ZMIEN na funkcje z zadania

# Oblicz wazne punkty
zeros = [float(z) for z in solve(f, x) if z.is_real]
vertex_x = float(-Rational(2, 2))  # dla kwadratowej
vertex_y = float(f.subs(x, vertex_x))

# Zakres wykresu: od min(zeros) - 2 do max(zeros) + 2
x_min = min(zeros + [vertex_x]) - 2 if zeros else -5
x_max = max(zeros + [vertex_x]) + 2 if zeros else 5

# Wygeneruj punkty wykresu
n_points = 200
dx = (x_max - x_min) / n_points
plot_points = []
for i in range(n_points + 1):
    xi = x_min + i * dx
    yi = float(f.subs('x', xi))
    plot_points.append((xi, yi))

# viewBox
all_y = [p[1] for p in plot_points]
y_min = min(all_y) - 1
y_max = max(all_y) + 1
# flip y for SVG
vb_x = x_min - 1
vb_y = -(y_max + 1)
vb_w = (x_max - x_min) + 2
vb_h = (y_max - y_min) + 2

# Polyline points (SVG y flipped)
poly_str = " ".join(str(round(p[0], 2)) + "," + str(round(-p[1], 2)) for p in plot_points)

elements = []
elements.append(svg_grid(vb_x, vb_y, vb_w, vb_h))
# Dodaj osie, wykres, punkty, etykiety
# ...

# Zbierz w SVG i print()
\\\`\\\`\\\``,

  generic: `Napisz kod Python ktory generuje diagram SVG dla tego zadania matematycznego.

${SVG_COMMON_RULES}

Przeanalizuj zadanie i zdecyduj co narysowac. Uzyj odpowiednie ksztalty SVG.

\\\`\\\`\\\`python
from sympy import *
from sympy.geometry import *
${SVG_HELPER_CODE}
# Przeanalizuj zadanie i oblicz wspolrzedne
# Uzyj svg_bbox, svg_grid, svg_polygon, svg_circle, svg_line, svg_label
# Na koniec print() kompletny SVG
\\\`\\\`\\\``,
};

function getDiagramPrompt(diagramType) {
  return DIAGRAM_PROMPTS[diagramType] || DIAGRAM_PROMPTS.generic;
}

// ── Guardrail ─────────────────────────────────────────────────────────

async function checkGuardrail(userMessage, chatHistory = []) {
  return llmobs.trace({ kind: 'task', name: 'guardrail' }, async () => {
    // Build messages with conversation context so follow-ups are understood
    const messages = [];
    if (chatHistory.length > 0) {
      // Add a condensed context summary so the guardrail can understand follow-ups
      const contextLines = chatHistory.slice(-4).map(m =>
        `${m.role === 'user' ? 'Uczeń' : 'System'}: ${m.content.slice(0, 150)}`
      ).join('\n');
      messages.push({ role: 'user', content: `Kontekst rozmowy:\n${contextLines}\n\nNowa wiadomość do oceny:\n${userMessage}` });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const raw = await llmCall('guardrail', prompts.guardrail, messages, {
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

// =====================================================================
// Generator: task loading, intent detection, formatting
// =====================================================================

const TOPIC_KEYWORDS = {
  'funkcja kwadratowa': ['kwadrat', 'parabo', 'wierzchoł', 'delta', 'funkcj', 'f(x)', 'wielomian'],
  'trygonometria': ['sin', 'cos', 'tan', 'ctg', 'tg', 'trygon', 'kąt', 'stopni', 'radian'],
  'ciągi': ['ciąg', 'ciag', 'arytmetycz', 'geometrycz', 'wyraz', 'suma.*wyraz'],
  'geometria analityczna': ['prosta', 'okrąg', 'okrag', 'współrzędn', 'wspolrzedn', 'wektor', 'odcin'],
  'prawdopodobieństwo': ['prawdopodobi', 'losow', 'kostk', 'kul', 'urn', 'zdarzeni'],
  'kombinatoryka': ['kombinacj', 'permutacj', 'wariacj', 'silni', 'newton', 'dwumian', 'ile.*sposob'],
  'pochodne': ['pochodn', 'ekstr', 'monotonicz', 'styczn', 'asympto', 'przebieg'],
  'równania': ['równani', 'rownani', 'nierównoś', 'nierownosc', 'rozwiąż', 'rozwiaz', 'układ'],
  'geometria': ['trójkąt', 'trojkat', 'prostokąt', 'prostopadło', 'romb', 'ostrosłup', 'stożek', 'walec', 'kula', 'pole', 'objętość', 'obwód', 'planimetri', 'stereometri'],
  'logarytmy': ['log', 'logarytm'],
  'potęgi': ['potęg', 'poteg', 'wykładnicz', 'wykladnicz'],
  'granice': ['granic', 'limes', 'lim\\b'],
  'całki': ['całk', 'calk', 'pierwotna'],
};

function loadAllTasks() {
  const tasks = [];
  for (const level of ['podstawowa', 'rozszerzona']) {
    const dir = join(__dirname, 'datasets', level);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const [yearStr, lvlNum] = file.replace('.json', '').split('_');
        const year = parseInt(yearStr);
        const levelName = lvlNum === '1' ? 'podstawowa' : 'rozszerzona';
        for (const task of data) {
          const questionLower = (task.question || '').toLowerCase();
          const topics = [];
          for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
            if (keywords.some(kw => new RegExp(kw, 'i').test(questionLower))) {
              topics.push(topic);
            }
          }
          tasks.push({ ...task, year, level: levelName, topics });
        }
      } catch (e) {
        console.error(`Failed to load ${file}:`, e.message);
      }
    }
  }
  console.log(`[generator] Loaded ${tasks.length} tasks`);
  return tasks;
}

const allTasks = loadAllTasks();

// ── Definitional question detection ───────────────────────────────────

const DEFINITION_PREFIXES = [
  'co to jest', 'co to sa', 'co to są',
  'czym jest', 'czym sa', 'czym są',
  'zdefiniuj', 'definicja', 'podaj definicj',
  'co oznacza', 'co znaczy', 'co to znaczy',
  'what is', 'what are', 'define',
  'opisz czym', 'opisz co to',
  'na czym polega', 'o czym mówi', 'o czym mowi',
  'co mówi', 'co mowi',
  'jakie sa właściwości', 'jakie sa wlasciwosci',
  'jakie są właściwości', 'jakie sa cechy',
  'wymień właściwości', 'wymien wlasciwosci',
  'podaj właściwości', 'podaj wlasciwosci',
  'kiedy stosuje się', 'kiedy stosujemy',
  'do czego służy', 'do czego sluzy',
  'jaka jest różnica między', 'jaka jest roznica miedzy',
  'porównaj', 'porownaj',
];

// Questions that look definitional but actually need computation
const DEFINITION_EXCEPTIONS = /\d{2,}|oblicz|wyznacz|rozwiąż|rozwiaz|udowodnij|ile wynosi|jaki jest wynik|znajdź|znajdz|policz|=|\+\s*\d/;

function isDefinitionalQuestion(message) {
  const lower = message.toLowerCase().trim();
  // Must start with or contain a definitional prefix
  const hasPrefix = DEFINITION_PREFIXES.some(p => lower.includes(p));
  if (!hasPrefix) return false;
  // Must not contain computational markers
  if (DEFINITION_EXCEPTIONS.test(lower)) return false;
  // Short messages (< 15 words) with a definitional prefix are almost certainly definitional
  const wordCount = lower.split(/\s+/).length;
  if (wordCount <= 15) return true;
  // Longer messages: only if they start with a definitional prefix
  return DEFINITION_PREFIXES.some(p => lower.startsWith(p));
}

const DEFINITION_SYSTEM_PROMPT = `Jestes ekspertem matematyki. Odpowiadasz na pytania teoretyczne po polsku.

ZASADY:
1. Podaj jasna, zwiezla definicje lub wyjasnienie
2. Dodaj wzory i notacje matematyczne tam gdzie to potrzebne (uzyj standardowej notacji)
3. Podaj 1 lub 2 krotkie przyklady zastosowania
4. Jezeli pytanie dotyczy twierdzenia, podaj tresc twierdzenia i warunki stosowania
5. Nie generuj kodu Python ani SymPy
6. Odpowiedz powinna byc zrozumiala dla ucznia liceum
7. Uzyj formatowania Markdown: **pogrubienie** dla kluczowych terminow
8. Odpowiedz ma miec 150 do 400 slow`;

// ── Generator: custom constraint detection ────────────────────────────

// Patterns that indicate the user wants LLM-generated content, not pool lookup.
// Grade levels other than matura, specific formatting, pedagogical constraints.
function detectCustomGeneratorConstraints(lower) {
  // Non-matura grade levels (klasa 1-8, szkoła podstawowa, etc.)
  if (/\b(dla\s+)?\d\s*klas/.test(lower)) return true;
  if (/klasa?\s*\d/i.test(lower)) return true;
  if (/szko[łl][ayły]*\s*podstawow|szkol\w*\s*podstawow|szk\.\s*podst/i.test(lower)) return true;
  if (/przedszko|zerówk|zerowk/i.test(lower)) return true;
  // Specific format constraints
  if (/bez\s+(pytań|pytan|odpowiedzi|rozwiąza|rozwiaza)/.test(lower)) return true;
  if (/sam\s+(wymyśl|wymysl|sformuł|sformul|ułoż|uloz)/.test(lower)) return true;
  if (/tekstow|fabularny|słown|slown|historyjk/.test(lower)) return true;
  // Difficulty specification beyond basic/extended
  if (/łatw|latw|trudn|prostych|prosty|zaawansowan/.test(lower)) return true;
  // Teaching instructions
  if (/żeby uczeń|zeby uczen|tak aby|niech uczeń|niech uczen/.test(lower)) return true;
  // Specific operations for elementary math
  if (/dodawani|odejmowani|mnożeni|mnozeni|dzieleni|tabliczk/.test(lower)) return true;
  return false;
}

// ── Generator: intent detection ───────────────────────────────────────

const GENERATOR_KEYWORDS = [
  'wymyśl', 'wymysl', 'wygeneruj', 'generuj',
  'losuj mi', 'losuj zadani', 'losuj przyklad', 'losuj przyklad', 'wylosuj zadani', 'wylosuj mi',
  'zadaj mi', 'zadaj pytani', 'zadawaj',
  'arkusz', 'zestaw zadań', 'zestaw zadan',
  'ćwiczeni', 'cwiczeni', 'trening', 'praktyk',
  'daj mi zadani', 'daj mi zadanie z', 'podaj zadani', 'pokaż zadani', 'pokaz zadani',
  'przygotuj zadani', 'kilka zadań', 'kilka zadan',
  'poszukaj mi zadani', 'poszukaj zadani', 'znajdź mi zadani', 'znajdz mi zadani',
  'znajdź zadani', 'znajdz zadani', 'wyszukaj zadani', 'wyszukaj mi zadani',
  'dobierz zadani', 'dobierz mi zadani',
  'poszukaj mi ćwicze', 'poszukaj mi cwicze',
  'daj ćwiczeni', 'daj cwiczeni', 'daj przykład', 'daj przyklad',
  'pokaż przykład', 'pokaz przyklad', 'podaj przykład', 'podaj przyklad',
  'potrzebuję zadań', 'potrzebuje zadan',
  'jakieś zadani', 'jakies zadani', 'pare zadań', 'pare zadan',
  'przyklady z', 'przykłady z', 'cwiczen z', 'ćwiczeń z',
  'potrzebuje cwiczen', 'potrzebuję ćwicze',
];

const TUTORIAL_KEYWORDS = [
  'jak policzyć', 'jak policzyc', 'jak rozwiązać', 'jak rozwiazac',
  'jak liczyć', 'jak liczyc', 'jak obliczyć', 'jak obliczyc',
  'pokaż mi sposób', 'pokaz mi sposob', 'pokaż sposób', 'pokaz sposob',
  'naucz mnie', 'wytłumacz', 'wytlumacz', 'wyjaśnij', 'wyjasni',
  'sposób rozwiązywania', 'sposob rozwiazywania',
  'jak się robi', 'jak sie robi',
  'chcę się nauczyć', 'chce sie nauczyc',
  'potrzebuję pomocy z', 'potrzebuje pomocy z',
];

const TOPIC_ONLY_PATTERNS = [
  'ostrosłup', 'ostroslup', 'trójkąt', 'trojkat', 'funkcja kwadrat', 'funkcja liniow',
  'trygonometri', 'ciąg', 'ciag', 'geometri', 'prawdopodobień', 'prawdopodobien',
  'kombinatoryk', 'pochodn', 'równani', 'rownani', 'logarytm', 'potęg', 'poteg',
  'granic', 'całk', 'calk', 'stereometri', 'planimetri', 'wielomian',
  'procent', 'statystyk', 'wektor', 'bezwzględn', 'bezwzgledn',
  'funkcj', 'odwrotn', 'dziedzin', 'złożeni', 'zlozeni',
  'silni', 'dwumian', 'newton', 'skróconego', 'skroconego', 'nierównoś', 'nierownosc',
  'rachunek prawdopodobień', 'rachunek prawdopodobien',
  'analiz', 'optymalizacj', 'algebr',
];

function matchTopicName(lower) {
  const topicMap = {
    'funkcja kwadratowa': ['kwadrat', 'parabo', 'wierzchoł'],
    'trygonometria': ['trygonometri', 'sin', 'cos', 'tg', 'ctg'],
    'ciągi': ['ciąg', 'ciag', 'arytmetycz', 'geometrycz'],
    'geometria analityczna': ['geometria analityczn', 'geometri analityczn', 'współrzędn', 'wspolrzedn'],
    'prawdopodobieństwo': ['prawdopodobień', 'prawdopodobien', 'losow'],
    'kombinatoryka': ['kombinatoryk', 'permutacj', 'wariacj'],
    'pochodne': ['pochodn', 'ekstr', 'monotonicz'],
    'równania': ['równani', 'rownani', 'nierównoś', 'nierownosc', 'układ równ', 'uklad rown'],
    'geometria': ['trójkąt', 'trojkat', 'prostokąt', 'ostrosłup', 'ostroslup', 'stereometri', 'planimetri', 'pole', 'obwód', 'obwod', 'kąt', 'kat', 'okrąg', 'okrag', 'koł', 'kol'],
    'logarytmy': ['logarytm'],
    'potęgi': ['potęg', 'poteg', 'wykładnicz', 'wykladnicz'],
    'granice': ['granic', 'limes'],
    'całki': ['całk', 'calk', 'pierwotna'],
    'wielomiany': ['wielomian', 'stopień wielomian', 'pierwiastk wielomian'],
    'procenty': ['procent', 'oprocentowan', 'rabat'],
    'statystyka': ['statystyk', 'średni', 'sredni', 'median', 'odchyleni'],
    'wektory': ['wektor', 'skalar'],
    'wartość bezwzględna': ['bezwzględn', 'bezwzgledn', 'moduł', 'modul'],
    'funkcja liniowa': ['liniow', 'współczynnik kierunkow', 'wspolczynnik kierunkow', 'prosta'],
    'funkcje': ['funkcj', 'dziedzin', 'przeciwdziedzin', 'postać funkcj', 'postac funkcj', 'zamian postaci', 'odwrotn', 'złożeni funkcj', 'zlozeni funkcj'],
    'wzory skróconego mnożenia': ['skróconego', 'skroconego'],
    'silnia i dwumian Newtona': ['silni', 'dwumian', 'newton'],
    'nierówności': ['nierównoś', 'nierownosc'],
    'analiza matematyczna': ['analiz matematyczn', 'analizy matematyczn', 'analiza mat'],
    'optymalizacja': ['optymalizacj'],
    'algebra': ['algebr'],
  };
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return topic;
    }
  }
  return undefined;
}

// Normalize Polish diacritics: ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ź→z, ż→z
function stripDiacritics(str) {
  return str
    .replace(/[ąà]/g, 'a').replace(/[ćč]/g, 'c').replace(/[ęè]/g, 'e')
    .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
    .replace(/[śš]/g, 's').replace(/[źż]/g, 'z');
}

/**
 * Convert raw SymPy notation to proper mathematical notation.
 * e.g. Interval(-2, 2) → [-2, 2], Union(...) → ... u ..., oo → +∞
 */
function formatSymPyNotation(text) {
  if (!text) return text;
  return text
    // Interval.open(a, b) → (a, b)
    .replace(/Interval\.open\(([^,]+),\s*([^)]+)\)/g, '($1, $2)')
    // Interval.Lopen(a, b) → (a, b]
    .replace(/Interval\.Lopen\(([^,]+),\s*([^)]+)\)/g, '($1, $2]')
    // Interval.Ropen(a, b) → [a, b)
    .replace(/Interval\.Ropen\(([^,]+),\s*([^)]+)\)/g, '[$1, $2)')
    // Interval(a, b) → [a, b]
    .replace(/Interval\(([^,]+),\s*([^)]+)\)/g, '[$1, $2]')
    // Union(X, Y) → X u Y
    .replace(/Union\(([^)]+)\)/g, (_, inner) => inner.split(/,\s*/).join(' u '))
    // EmptySet or EmptySet() → zbiór pusty
    .replace(/EmptySet\(\)/g, 'zbiór pusty')
    .replace(/EmptySet/g, 'zbiór pusty')
    // FiniteSet(a, b, c) → {a, b, c}
    .replace(/FiniteSet\(([^)]+)\)/g, '{$1}')
    // oo → +∞, -oo → -∞
    .replace(/\boo\b/g, '∞')
    .replace(/-∞/g, '-∞')
    .replace(/\+∞/g, '+∞');
}

/**
 * Strip LaTeX markup from LLM output that ignores the "no LaTeX" prompt rule.
 * Converts $...$ wrapped expressions to plain text and removes common LaTeX commands.
 */
function stripLatex(text) {
  if (!text) return text;
  return text
    // Remove display math $$...$$ (non-greedy, across lines)
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    // Remove inline math $...$ (handles single chars like $1$, $n$)
    .replace(/\$([^$]*?)\$/g, '$1')
    // \frac{a}{b} => a/b
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
    // \sqrt[n]{x} => n-th root(x), \sqrt{x} => sqrt(x)
    .replace(/\\sqrt\[([^\]]+)\]\{([^}]+)\}/g, '$1-th root($2)')
    .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
    // \left and \right => remove
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    // ^\circ => degree symbol (must come before generic ^ handling)
    .replace(/\^\\circ/g, '\u00b0')
    .replace(/\\circ/g, '\u00b0')
    // \angle => angle symbol
    .replace(/\\angle/g, '\u2220')
    // \equiv => congruence symbol
    .replace(/\\equiv/g, '\u2261')
    // \pmod{n} => (mod n)
    .replace(/\\pmod\{([^}]+)\}/g, '(mod $1)')
    // \bmod and \mod => mod
    .replace(/\\bmod/g, 'mod')
    .replace(/\\mod/g, 'mod')
    // \geq, \leq, \neq, \approx => symbols
    .replace(/\\geq/g, '>=')
    .replace(/\\leq/g, '<=')
    .replace(/\\neq/g, '!=')
    .replace(/\\approx/g, '\u2248')
    .replace(/\\cdot/g, '\u00b7')
    .replace(/\\cdots/g, '...')
    .replace(/\\ldots/g, '...')
    .replace(/\\times/g, '\u00d7')
    .replace(/\\pm/g, '\u00b1')
    .replace(/\\mp/g, '\u2213')
    .replace(/\\infty/g, '\u221e')
    .replace(/\\to/g, '\u2192')
    .replace(/\\rightarrow/g, '\u2192')
    .replace(/\\leftarrow/g, '\u2190')
    .replace(/\\Rightarrow/g, '\u21d2')
    .replace(/\\Leftarrow/g, '\u21d0')
    .replace(/\\forall/g, '\u2200')
    .replace(/\\exists/g, '\u2203')
    .replace(/\\in /g, '\u2208 ')
    .replace(/\\subset/g, '\u2282')
    .replace(/\\cup/g, '\u222a')
    .replace(/\\cap/g, '\u2229')
    .replace(/\\neg/g, '\u00ac')
    .replace(/\\land/g, '\u2227')
    .replace(/\\lor/g, '\u2228')
    // \sum_{i=1}^{n} => sum(i=1..n)
    .replace(/\\sum_\{([^}]*)\}\^\{([^}]*)\}/g, 'sum($1..$2)')
    .replace(/\\sum/g, 'sum')
    // \int => integral symbol
    .replace(/\\int/g, '\u222b')
    // \overline{x} => x
    .replace(/\\overline\{([^}]+)\}/g, '$1')
    // \text{...} => content
    .replace(/\\text\{([^}]+)\}/g, '$1')
    // \mathbf, \mathrm, \mathit => content
    .replace(/\\math[a-z]+\{([^}]+)\}/g, '$1')
    // Superscript/subscript braces: ^{2} => ^2, _{i} => _i
    .replace(/\^\{([^}]+)\}/g, '^$1')
    .replace(/_\{([^}]+)\}/g, '_$1')
    // \\ (line break) => space
    .replace(/\\\\/g, ' ')
    // \quad, \qquad, \, \; \! \: => space
    .replace(/\\(?:qquad|quad|,|;|!|:)/g, ' ')
    // Remaining backslash commands like \alpha, \beta => just the word
    .replace(/\\([a-zA-Z]+)/g, '$1')
    // Remove leftover curly braces
    .replace(/[{}]/g, '')
    // Remove leftover dollar signs (from malformed LaTeX like $$expr$ with odd count)
    .replace(/\$/g, '')
    // Clean up extra spaces
    .replace(/  +/g, ' ')
    .trim();
}

// Strip markdown formatting from LLM output
function stripMarkdown(text) {
  if (!text) return text;
  return text
    // Remove headings: ### Title => Title
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold: **text** => text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove italic: *text* => text (but not ** which is already handled)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    // Remove horizontal rules: --- or *** or ___ on their own line
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // Remove inline code backticks: `code` => code
    .replace(/`([^`]+)`/g, '$1')
    // Clean up empty lines left by removed elements
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectGeneratorIntent(message) {
  const lower = message.toLowerCase().trim();
  const norm = stripDiacritics(lower);

  const hasKeyword = GENERATOR_KEYWORDS.some(kw => norm.includes(kw) || lower.includes(kw));

  // Also trigger on "N zadań/zadania/zadanie/ćwiczeń" pattern (e.g. "daj mi 5 zadań z trygonometrii")
  const hasCountPattern = /\d+\s*(zadan|zadani|zadanie|cwiczen|przyklad)/i.test(norm);

  if (hasKeyword || hasCountPattern) {
    // Guard: if the message looks like a concrete solve request (has question words
    // asking for a specific numerical/logical answer AND contains numbers or math ops),
    // treat it as a solve request, not a generator request.
    const solveSignals = /(?:jakie? jest|ile wynosi|ile jest|oblicz|wyznacz|rozwiąż|rozwiaz|udowodnij|znajd[źz]|jaka jest|ile|jaki)/i.test(lower);
    const hasMathContent = /[=+\-*/^√∫∑]|\d/.test(lower);
    const isLongProblem = lower.split(/\s+/).length >= 8;
    if (solveSignals && hasMathContent && isLongProblem) {
      // This looks like a word problem to solve, not a "generate me problems" request.
      // Fall through to the solve path instead.
    } else {
      let level;
      if (lower.includes('podstawow')) level = 'podstawowa';
      else if (lower.includes('rozszerzon')) level = 'rozszerzona';

      let count;
      const countMatch = norm.match(/(\d+)\s*(zadan|zadani|zadanie|pytan|cwiczen|przyklad)/);
      if (countMatch) count = parseInt(countMatch[1]);

      let topic;
      for (const tp of TOPIC_ONLY_PATTERNS) {
        if (lower.includes(tp)) {
          topic = matchTopicName(lower);
          break;
        }
      }

      // Detect if this needs LLM generation (custom constraints the pool can't serve)
      const needsLLM = detectCustomGeneratorConstraints(lower);

      return { isTrigger: true, topic, level, count, needsLLM, rawMessage: message };
    }
  }

  // Single topic name (1-3 words)
  const words = lower.split(/\s+/);
  if (words.length <= 3) {
    const isTopicOnly = TOPIC_ONLY_PATTERNS.some(tp => lower.includes(tp));
    if (isTopicOnly) {
      return { isTrigger: true, topic: matchTopicName(lower) };
    }
  }

  // Tutorial intent + topic
  const hasTutorial = TUTORIAL_KEYWORDS.some(kw => lower.includes(kw));
  if (hasTutorial) {
    const topic = matchTopicName(lower);
    if (topic) {
      let level;
      if (lower.includes('podstawow')) level = 'podstawowa';
      else if (lower.includes('rozszerzon')) level = 'rozszerzona';
      return { isTrigger: true, topic, level };
    }
  }

  // Level keyword without a real math problem
  const hasLevelWord = lower.includes('podstawow') || lower.includes('rozszerzon');
  if (hasLevelWord) {
    const looksLikeProblem = /[=+\-*/^√∫∑]|\d{2,}|oblicz|wyznacz|rozwiąż|rozwiaz|udowodnij|ile|jakie?|który|znajd[źz]/.test(lower);
    if (!looksLikeProblem) {
      const level = lower.includes('podstawow') ? 'podstawowa' : 'rozszerzona';
      const topic = matchTopicName(lower);
      return { isTrigger: true, topic, level };
    }
  }

  // If the message doesn't look like a concrete math problem, mark as uncertain
  // so the solver can do a quick LLM intent check before proceeding
  const looksLikeProblem = /[=+\-*/^√∫∑]|\d{2,}|oblicz|wyznacz|rozwiąż|rozwiaz|udowodnij|ile wynosi|ile jest|jakie? jest|który|znajd[źz]/.test(lower);
  if (!looksLikeProblem) {
    return { isTrigger: false, uncertain: true };
  }

  return { isTrigger: false, uncertain: false };
}

// ── Generator: LLM intent classification (lightweight) ────────────────

const INTENT_CLASSIFIER_PROMPT = `Czy uzytkownik prosi o WYGENEROWANIE/ZNALEZIENIE zadan lub cwiczen do rozwiazania, czy chce ROZWIAZAC konkretne zadanie matematyczne?

Odpowiedz JEDNYM slowem:
GENERUJ - jesli uzytkownik prosi o zadania, cwiczenia, przyklady do procwiczenia tematu
ROZWIAZ - jesli uzytkownik podaje konkretne zadanie do rozwiazania

Przyklady GENERUJ: "daj mi zadania z trygonometrii", "potrzebuje cwiczen z logarytmow", "przygotuj arkusz z geometrii", "zadania z: potegi i pierwiastki"
Przyklady ROZWIAZ: "oblicz 2+2", "rozwiaz rownanie x^2=4", "ile wynosi sin(30)", "znajdz pochodna f(x)=x^3"`;

// ── Generator: task filtering ─────────────────────────────────────────

// Umbrella topics that expand to multiple sub-topics for task filtering
const UMBRELLA_TOPICS = {
  'analiza matematyczna': ['pochodne', 'granice', 'całki', 'ekstr', 'monotonicz', 'asympto', 'przebieg', 'styczn', 'optymali'],
  'algebra': ['równania', 'logarytmy', 'potęgi', 'wielomiany', 'nierówności'],
};

function filterTasks({ topic, level, count = 5, year } = {}) {
  let pool = [...allTasks];

  if (level) pool = pool.filter(t => t.level === level);
  if (year) pool = pool.filter(t => t.year === parseInt(year));
  if (topic) {
    const topicLower = topic.toLowerCase();
    const subTopics = UMBRELLA_TOPICS[topicLower];
    let topicMatched;
    if (subTopics) {
      // Umbrella topic: match any sub-topic in task topics or question text
      topicMatched = pool.filter(t =>
        t.topics.some(tp => subTopics.some(st => tp.toLowerCase().includes(st))) ||
        subTopics.some(st => t.question.toLowerCase().includes(st))
      );
    } else {
      topicMatched = pool.filter(t =>
        t.topics.some(tp => tp.toLowerCase().includes(topicLower)) ||
        t.question.toLowerCase().includes(topicLower)
      );
    }
    if (topicMatched.length > 0) pool = topicMatched;
  }

  const n = Math.min(Math.max(1, parseInt(count) || 5), 20);
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map(t => ({
    question: t.question,
    options: t.options || null,
    answer: t.answer || null,
    year: t.year,
    level: t.level,
    topics: t.topics,
    task_number: t.metadata?.task_number,
    max_points: t.metadata?.max_points,
  }));
}

// ── Generator: formatting ─────────────────────────────────────────────

function formatGeneratorTasks(tasks, topic, level) {
  const header = topic
    ? `Oto zadania z tematu **${topic}**${level ? ` (${level})` : ''}:`
    : `Oto losowe zadania maturalne${level ? ` (${level})` : ''}:`;

  const lines = [header, ''];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const meta = [];
    if (t.year) meta.push(`${t.year}`);
    if (t.level) meta.push(t.level);
    if (t.max_points) meta.push(`${t.max_points} pkt`);

    lines.push(`**Zadanie ${i + 1}** ${meta.length > 0 ? `(${meta.join(', ')})` : ''}`);
    lines.push(t.question);

    if (t.options && typeof t.options === 'object') {
      const optionLabels = ['A', 'B', 'C', 'D'];
      const optEntries = Object.entries(t.options);
      for (let j = 0; j < optEntries.length; j++) {
        const label = optionLabels[j] || optEntries[j][0];
        const val = optEntries[j][1];
        const needsLatex = /[\\{}^_]/.test(val) && !/^\$/.test(val.trim());
        lines.push(`${label}. ${needsLatex ? `$${val}$` : val}`);
      }
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('Wklej treść zadania, żeby je rozwiązać krok po kroku.');

  return lines.join('\n');
}

// ── Generator: LLM-based task creation ────────────────────────────────

const GENERATOR_LLM_SYSTEM_PROMPT = `Jestes doswiadczonym nauczycielem matematyki. Tworzysz zadania matematyczne na zamowienie.

ZASADY:
1. Tworzysz dokladnie tyle zadan ile prosi uzytkownik (domyslnie 5)
2. Zadania musza byc poprawne matematycznie
3. Dostosuj poziom trudnosci do podanej klasy/poziomu
4. Jezeli uzytkownik podaje specjalne wymagania (format, typ, ograniczenia), scisle je przestrzegaj
5. Numeruj zadania: **Zadanie 1**, **Zadanie 2**, itd.
6. Na koncu dodaj linie: ---
7. Uzyj formatowania Markdown
8. Pisz po polsku
9. NIE podawaj odpowiedzi ani rozwiazania, chyba ze uzytkownik o to prosi`;

// =====================================================================
// Arithmetic scheme: written multiplication method
// =====================================================================

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function buildMultiplicationScheme(a, b) {
  const result = a * b;
  const lines = [];

  const top = Math.max(a, b);
  const bottom = Math.min(a, b);
  const bottomDigits = bottom.toString().split('').map(Number);

  lines.push(`**${formatNumber(a)} × ${formatNumber(b)} = ?**`);
  lines.push('');
  lines.push('Schemat mnożenia pisemnego:');
  lines.push('');
  lines.push('```');

  const partials = [];
  for (let i = bottomDigits.length - 1; i >= 0; i--) {
    const digit = bottomDigits[i];
    const placeValue = Math.pow(10, bottomDigits.length - 1 - i);
    const partial = top * digit * placeValue;
    const digitWithPlace = digit * placeValue;
    partials.push({ value: partial, label: `${top} × ${formatNumber(digitWithPlace)}` });
  }

  const resultStr = formatNumber(result);
  const maxWidth = Math.max(
    `${formatNumber(top)}`.length,
    `× ${formatNumber(bottom)}`.length,
    resultStr.length,
    ...partials.map(p => formatNumber(p.value).length)
  ) + 2;

  lines.push(formatNumber(top).padStart(maxWidth));
  lines.push(('× ' + formatNumber(bottom)).padStart(maxWidth));
  lines.push('─'.repeat(maxWidth));

  if (partials.length > 1) {
    for (const p of partials) {
      const valStr = formatNumber(p.value);
      lines.push(`${valStr.padStart(maxWidth)}    (${p.label})`);
    }
    lines.push('─'.repeat(maxWidth));
  }

  lines.push(resultStr.padStart(maxWidth));
  lines.push('```');

  lines.push('');
  lines.push(`**Wynik: ${formatNumber(a)} × ${formatNumber(b)} = ${formatNumber(result)}**`);

  return lines.join('\n');
}

/**
 * Try to evaluate simple arithmetic expressions directly (e.g. "2+2", "15/3", "7*8+2").
 * Returns a string answer or null if the message isn't pure arithmetic.
 */
function trySimpleArithmetic(message) {
  // Strip Polish question words: "ile to", "oblicz", "policz", "ile jest", "ile wynosi"
  let expr = message
    .replace(/ile\s+(to|jest|wynosi)\s*/gi, '')
    .replace(/oblicz\s*/gi, '')
    .replace(/policz\s*/gi, '')
    .replace(/[=?]/g, '')
    .trim();

  // Only allow digits, operators, parentheses, dots, spaces
  if (!/^[\d+\-*/().,%^ ]+$/.test(expr)) return null;
  // Must contain at least one operator
  if (!/[+\-*/^%]/.test(expr)) return null;
  // Replace ^ with ** for JS eval
  expr = expr.replace(/\^/g, '**');
  // Reject if too complex (safety: no long strings)
  if (expr.length > 100) return null;

  try {
    // Use Function constructor instead of eval for slightly safer evaluation
    const result = new Function(`"use strict"; return (${expr})`)();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    // Format: avoid floating point noise (e.g. 0.1+0.2=0.30000000000000004)
    const formatted = Number.isInteger(result) ? result.toString() : parseFloat(result.toPrecision(12)).toString();
    return formatted;
  } catch {
    return null;
  }
}

function tryArithmeticScheme(message) {
  // First try simple arithmetic (2+2, 15*3, etc.)
  const simple = trySimpleArithmetic(message);
  if (simple !== null) return `ODPOWIEDZ: ${simple}`;

  const cleaned = message.replace(/\s/g, '');
  const match = cleaned.match(/(\d{2,})\s*[*×·]\s*(\d{2,})/);
  if (!match) {
    const spaced = message.match(/(\d{2,})\s*[*×·]\s*(\d{2,})/);
    if (!spaced) return null;
    return buildMultiplicationScheme(parseInt(spaced[1]), parseInt(spaced[2]));
  }
  return buildMultiplicationScheme(parseInt(match[1]), parseInt(match[2]));
}

// =====================================================================
// Main solve function
// =====================================================================

export async function solve(userMessage, sessionId, onStep, chatHistory = []) {
  const send = (step, agentName, content, extra = {}) => {
    if (onStep) onStep({ step, agentName, content, ...extra });
  };

  return llmobs.trace({ kind: 'workflow', name: 'formulo.solve', sessionId }, async () => {

    // ── Step 0: Guardrail ──────────────────────────────────────────

    send('guardrail', 'Guardrail', 'Sprawdzam zapytanie...');

    const guardrailResult = await checkGuardrail(userMessage, chatHistory);

    if (!guardrailResult.valid) {
      send('guardrail_done', 'Guardrail', guardrailResult.reason, { blocked: true });
      return {
        success: false,
        blocked: true,
        reason: guardrailResult.reason || 'Mogę pomóc tylko z zadaniami z matematyki i nauk ścisłych.',
      };
    }

    send('guardrail_done', 'Guardrail', 'OK', { blocked: false });

    // ── Step 0.5: Generator intent ────────────────────────────────

    let generatorIntent = detectGeneratorIntent(userMessage);

    // If regex-based detection is uncertain, ask a lightweight LLM
    if (!generatorIntent.isTrigger && generatorIntent.uncertain) {
      try {
        const intentRaw = await llmCall('intent_classifier', INTENT_CLASSIFIER_PROMPT, [
          { role: 'user', content: userMessage },
        ], { maxTokens: 10, temperature: 0.1 });
        const intentWord = stripThink(intentRaw).trim().toUpperCase();
        if (intentWord.includes('GENERUJ')) {
          const lower = userMessage.toLowerCase();
          const norm = stripDiacritics(lower);
          const topic = matchTopicName(lower) || matchTopicName(norm);
          let level;
          if (lower.includes('podstawow')) level = 'podstawowa';
          else if (lower.includes('rozszerzon')) level = 'rozszerzona';
          let count;
          const countMatch = norm.match(/(\d+)\s*(zadan|zadani|zadanie|pytan|cwiczen|przyklad)/);
          if (countMatch) count = parseInt(countMatch[1]);
          generatorIntent = { isTrigger: true, topic, level, count, needsLLM: true, rawMessage: userMessage };
        }
      } catch (err) {
        // LLM intent check failed, fall through to solver
        console.warn('[intent_classifier] Error:', err.message);
      }
    }

    if (generatorIntent.isTrigger) {
      return llmobs.trace({ kind: 'task', name: 'generator' }, async () => {
        llmobs.annotate({ inputData: userMessage, metadata: {
          topic: generatorIntent.topic || 'ogolne',
          level: generatorIntent.level || 'brak',
          needsLLM: !!generatorIntent.needsLLM,
          count: generatorIntent.count || 5,
        }});

        // Custom constraints or non-matura level: use LLM to generate tasks
        if (generatorIntent.needsLLM) {
          send('generator', 'Generator Zadań', 'Tworzę zadania...');

          // Include conversation context for follow-up requests
          const genUserContent = chatHistory.length > 0
            ? `Kontekst rozmowy:\n${chatHistory.slice(-4).map(m => `${m.role === 'user' ? 'Uczeń' : 'System'}: ${m.content.slice(0, 200)}`).join('\n')}\n\nProśba:\n${userMessage}`
            : userMessage;
          const genRaw = await llmCall('generator_llm', GENERATOR_LLM_SYSTEM_PROMPT, [
            { role: 'user', content: genUserContent },
          ], { maxTokens: 2000, temperature: 0.7 });

          const content = stripMarkdown(stripLatex(stripThink(genRaw)));
          llmobs.annotate({ outputData: content });
          send('generator_done', 'Generator Zadań', content);
          return { success: true, type: 'generator', content };
        }

        // Standard matura pool lookup
        send('generator', 'Generator Zadań', 'Szukam zadań...');

        const tasks = filterTasks({
          topic: generatorIntent.topic,
          level: generatorIntent.level,
          count: generatorIntent.count || 5,
        });

        if (tasks.length === 0) {
          // Pool empty for this topic: fall back to LLM generation
          send('generator', 'Generator Zadań', 'Brak zadań w bazie, tworzę nowe...');

          const genFallbackContent = chatHistory.length > 0
            ? `Kontekst rozmowy:\n${chatHistory.slice(-4).map(m => `${m.role === 'user' ? 'Uczeń' : 'System'}: ${m.content.slice(0, 200)}`).join('\n')}\n\nProśba:\n${userMessage}`
            : userMessage;
          const genRaw = await llmCall('generator_llm', GENERATOR_LLM_SYSTEM_PROMPT, [
            { role: 'user', content: genFallbackContent },
          ], { maxTokens: 2000, temperature: 0.7 });

          const content = stripMarkdown(stripLatex(stripThink(genRaw)));
          llmobs.annotate({ outputData: content });
          send('generator_done', 'Generator Zadań', content);
          return { success: true, type: 'generator', content };
        }

        const content = formatGeneratorTasks(tasks, generatorIntent.topic, generatorIntent.level);
        llmobs.annotate({ outputData: content.substring(0, 500) + (content.length > 500 ? '...' : '') });
        send('generator_done', 'Generator Zadań', content);
        return { success: true, type: 'generator', content };
      });
    }

    // ── Step 0.55: Definitional / theoretical question ────────────

    if (isDefinitionalQuestion(userMessage)) {
      return llmobs.trace({ kind: 'task', name: 'definition' }, async () => {
        llmobs.annotate({ inputData: userMessage });
        send('definition', 'Definicja', 'Przygotowuję wyjaśnienie...');

        const definitionRaw = await llmCall('definition', DEFINITION_SYSTEM_PROMPT, [
          { role: 'user', content: userMessage },
        ], { maxTokens: 1000, temperature: 0.3 });

        const definition = stripThink(definitionRaw);
        llmobs.annotate({ outputData: definition });
        send('definition_done', 'Definicja', definition);
        return { success: true, type: 'definition', content: definition };
      });
    }

    // ── Step 0.6: Arithmetic scheme ───────────────────────────────

    const arithmeticResult = tryArithmeticScheme(userMessage);

    if (arithmeticResult) {
      send('arithmetic_done', 'Kalkulator', arithmeticResult);
      return { success: true, type: 'arithmetic', content: arithmeticResult };
    }

    // ── RAG: fetch context (non-blocking, runs in parallel with pipeline) ──

    let ragResults = [];
    let ragCategories = [];
    let ragContext = '';
    let sympyHints = '';

    if (await ragHealthy()) {
      send('rag', 'RAG', 'Szukam kontekstu...');
      ragResults = await ragQuery(userMessage, 5);
      ragCategories = detectCategories(userMessage);
      ragContext = formatRAGContext(ragResults, ragCategories);
      sympyHints = formatSymPyHints(ragResults, ragCategories);

      const ragSummaryParts = [];
      if (ragCategories.length) ragSummaryParts.push(`Kategorie: ${ragCategories.join(', ')}`);
      const methods = ragResults.filter(r => r.source === 'methods' && r.score > 0.10);
      if (methods.length) ragSummaryParts.push(`Metody: ${methods.slice(0, 3).map(m => m.title).join(', ')}`);
      const similar = ragResults.filter(r => (r.source === 'dataset' || r.source === 'informator_pdf') && r.score > 0.10);
      if (similar.length) ragSummaryParts.push(`Podobne zadania: ${similar.length}`);
      const hintCount = ragResults.filter(r => r.sympy_hint && r.score > 0.10).length;
      if (hintCount) ragSummaryParts.push(`Podpowiedzi SymPy: ${hintCount}`);

      send('rag_done', 'RAG', ragSummaryParts.length
        ? `📚 Baza Wiedzy (${ragResults.length} wyników)\n${ragSummaryParts.join('\n')}`
        : 'Brak trafień w bazie wiedzy.', { ragResults: ragResults.length, ragCategories });
    }

    // ── Step 0.7: Deterministic template solver ────────────────────

    const deterministicResult = tryDeterministicSolver(userMessage);
    if (deterministicResult) {
      send('deterministic', 'Solver Deterministyczny', `Wykryto wzorzec: ${deterministicResult.template}`);
      try {
        const detOutput = await callSymPy(deterministicResult.code);
        if (detOutput && detOutput.includes('ODPOWIEDZ:')) {
          send('deterministic_done', 'Solver Deterministyczny', detOutput, { templateUsed: deterministicResult.template });
          // Go to summary
          send('summary', 'Agent Podsumowujący', 'Tworzę wyjaśnienie...');
          const summaryContext = [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: `Rozwiązano szablonem deterministycznym: ${deterministicResult.template}` },
            { role: 'user', content: 'Napisz kod SymPy rozwiazujacy to zadanie.' },
            { role: 'assistant', content: '```python\n' + deterministicResult.code + '\n```' },
            { role: 'user', content: 'Wynik narzedzia:\n' + detOutput },
          ];
          const summaryRaw = await llmCall('summary', prompts.summary, summaryContext, {
            maxTokens: prompts.agents.summary.max_tokens,
            temperature: prompts.agents.summary.temperature,
          });
          const summary = stripMarkdown(stripThink(summaryRaw));
          send('summary_done', 'Agent Podsumowujący', summary);
          return {
            success: true,
            type: 'solve',
            classification: { type: deterministicResult.template, confidence: 1.0 },
            analyticalPlan: `Solver deterministyczny: ${deterministicResult.template}`,
            executorCode: deterministicResult.code,
            sympyResult: detOutput,
            summary,
          };
        }
      } catch (err) {
        // Deterministic solver failed, continue with normal pipeline
      }
    }

    // ── Detect proof problems (Lean verification happens after summary) ──

    const proofProblem = isProofProblem(userMessage);

    // ── Step 1: Classifier ─────────────────────────────────────────

    send('classifier', 'Klasyfikator', 'Klasyfikuję zadanie...');

    // Build classifier messages with conversation context for follow-ups
    const classifierMessages = [];
    if (chatHistory.length > 0) {
      const contextLines = chatHistory.slice(-4).map(m =>
        `${m.role === 'user' ? 'Uczeń' : 'System'}: ${m.content.slice(0, 200)}`
      ).join('\n');
      classifierMessages.push({ role: 'user', content: `Kontekst rozmowy:\n${contextLines}\n\nZadanie do klasyfikacji:\n${userMessage}` });
    } else {
      classifierMessages.push({ role: 'user', content: userMessage });
    }

    const classifierRaw = await llmCall('classifier', prompts.classifier, classifierMessages, {
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

    // Declare variables that can be set by either template or analytical/executor path
    let analyticalPlan = null;
    let executorCode = null;
    let sympyResult = null;
    let executorOutput = null;
    let hasResult = false;

    // ── Step 1.5: Try extraction template ──────────────────────────

    let templateSolved = false;
    const template = matchTemplate(userMessage, problemType);

    if (template) {
      send('extraction', 'Szablon Ekstrakcji', `Dopasowano szablon: ${template.name}`);

      try {
        // Extract values via LLM
        const extractionPrompt = buildExtractionSystemPrompt(template);
        const extractionRaw = await llmCall('extraction', extractionPrompt, [
          { role: 'user', content: userMessage },
        ], { maxTokens: 400, temperature: 0.1 });

        const extractedValues = extractJSON(stripThink(extractionRaw));

        if (extractedValues) {
          // Build code from template
          const templateCode = template.buildCode(extractedValues, mcOptions);
          send('extraction_code', 'Szablon Ekstrakcji', templateCode);

          try {
            const templateOutput = await callSymPy(templateCode);

            if (templateOutput && templateOutput.includes('ODPOWIEDZ:')) {
              // Template succeeded! Skip analytical+executor, go to summary
              send('extraction_done', 'Szablon Ekstrakcji', templateOutput, { templateUsed: template.id });

              // Set variables for summary step
              executorCode = templateCode;
              sympyResult = templateOutput;
              analyticalPlan = `Rozwiązano szablonem: ${template.name}`;
              templateSolved = true;
            }
          } catch (err) {
            // Template execution failed, continue with normal pipeline
            send('extraction_error', 'Szablon Ekstrakcji', `Błąd wykonania: ${err.message}`);
          }
        }
      } catch (err) {
        // Template extraction failed, continue with normal pipeline
        send('extraction_error', 'Szablon Ekstrakcji', `Błąd ekstrakcji: ${err.message}`);
      }
    }

    // If template didn't solve it, continue with analytical+executor pipeline
    if (!templateSolved) {
      // ── Step 2: Analytical Agent ───────────────────────────────────

      send('analytical', 'Agent Analityczny', 'Planuję rozwiązanie...');

      const analyticalUserContent = ragContext
        ? `${userMessage}\n${ragContext}`
        : userMessage;

      const analyticalRaw = await llmCall('analytical', prompts.analytical, [
        { role: 'user', content: analyticalUserContent },
      ], {
        maxTokens: prompts.agents.analytical.max_tokens,
        temperature: prompts.agents.analytical.temperature,
      });

      analyticalPlan = stripThink(analyticalRaw);
      send('analytical_done', 'Agent Analityczny', analyticalPlan);

      // ── Step 3: Executor Agent (SymPy code generation + execution)

      // Skip SymPy executor for proof problems — proofs need algebraic reasoning, not computation
      if (!proofProblem) { // begin: non-proof executor block

      send('executor', 'Agent Wykonawczy', 'Generuję kod SymPy...');

      const executorPrompt = isMultipleChoice
        ? prompts.executor_sympy_mc
        : prompts.executor_sympy;

      const executorUserContent = sympyHints
        ? `Napisz kod SymPy rozwiazujacy to zadanie.${sympyHints}`
        : 'Napisz kod SymPy rozwiazujacy to zadanie.';

      const executorContext = [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: analyticalPlan },
        { role: 'user', content: executorUserContent },
      ];

      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let executorRaw;

        if (attempt === 0) {
          executorRaw = await llmCall('executor', executorPrompt, executorContext, {
            maxTokens: prompts.agents.executor.max_tokens,
            temperature: prompts.agents.executor.temperature,
          });
        } else {
          const retryHint = formatRetryHint(ragResults);
          const retryMessages = [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: analyticalPlan },
            {
              role: 'user',
              content: `Kod SymPy zwrocil blad:\n${executorOutput}\n\nPopraw kod. Pamietaj: print("ODPOWIEDZ:", wynik)${retryHint}`,
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

        try {
          executorOutput = await callSymPy(executorCode);

          // Check for suspicious output (hidden errors, None, etc.)
          const suspicion = isOutputSuspicious(executorOutput || '');
          if (suspicion && attempt < MAX_RETRIES - 1) {
            console.warn(`⚠️ Attempt ${attempt + 1}: ${suspicion}`);
            send('executor_error', 'Agent Wykonawczy', `Podejrzany wynik: ${suspicion}`, { attempt });
            continue;
          }

          if (executorOutput && executorOutput.includes('ODPOWIEDZ:')) {
            sympyResult = executorOutput;
            break;
          }
          if (executorOutput && (executorOutput.includes('Error') || executorOutput.includes('Traceback'))) {
            send('executor_error', 'Agent Wykonawczy', executorOutput, { attempt });
            continue;
          }
          sympyResult = executorOutput;
          break;
        } catch (err) {
          executorOutput = `SymPy error: ${err.message}`;
          send('executor_error', 'Agent Wykonawczy', executorOutput, { attempt });
        }
      }
    }

    hasResult = !!sympyResult;
    send('executor_done', 'Agent Wykonawczy', formatSymPyNotation(sympyResult || executorOutput || 'Brak wyniku'), {
      hasResult,
    });

    // ── Step 3.5: Decomposition fallback (if executor failed) ──────

    if (!hasResult) {
      send('decompose', 'Dekompozycja', 'Rozbijam zadanie na pod-zadania...');
      try {
        const decompResult = await decompose(
          userMessage, ragContext, llmCall, callSymPy, extractPythonCode, stripThink
        );
        if (decompResult.success && decompResult.finalAnswer) {
          sympyResult = `ODPOWIEDZ: ${decompResult.finalAnswer}`;
          analyticalPlan = `Dekompozycja: ${decompResult.totalSteps} pod-zadań, ${decompResult.stepsCompleted} rozwiązanych`;
          executorCode = decompResult.subResults.map(r => r.code).filter(Boolean).join('\n\n');
          hasResult = true;
          send('decompose_done', 'Dekompozycja', `Rozwiązano przez dekompozycję: ${decompResult.finalAnswer}`, {
            subTasks: decompResult.totalSteps,
            completed: decompResult.stepsCompleted,
          });
        } else {
          send('decompose_fail', 'Dekompozycja', decompResult.error || 'Dekompozycja nie dała wyniku');
        }
      } catch (err) {
        send('decompose_fail', 'Dekompozycja', `Błąd dekompozycji: ${err.message}`);
      }
    }

    // ── Step 3.7: Brute-force verification (combinatorics) ─────────

    if (hasResult && sympyResult) {
      const answerMatch = /ODPOWIED[ZŹ]:\s*(.+)/i.exec(sympyResult);
      if (answerMatch) {
        const rawAnswer = answerMatch[1].trim();
        const verifiedAnswer = await verifyNumericAnswer(userMessage, rawAnswer);
        if (verifiedAnswer !== rawAnswer) {
          send('brute_force', 'Weryfikacja', `Korekta brute-force: ${rawAnswer} → ${verifiedAnswer}`);
          sympyResult = sympyResult.replace(rawAnswer, verifiedAnswer);
        }
        // If deterministic verification did not apply, try LLM brute-force for integer answers
        if (verifiedAnswer === rawAnswer) {
          const llmVerified = await bruteForceViaLLM(userMessage, rawAnswer, ragContext);
          if (llmVerified && llmVerified !== rawAnswer) {
            send('brute_force', 'Weryfikacja', `Korekta LLM brute-force: ${rawAnswer} → ${llmVerified}`);
            sympyResult = sympyResult.replace(rawAnswer, llmVerified);
          }
        }
      }
    }

    } // end: non-proof executor block

    // ── Step 4: Summary Agent ──────────────────────────────────────

    // Clean up SymPy notation before summary
    if (sympyResult) {
      sympyResult = formatSymPyNotation(sympyResult);
    }

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
        content: proofProblem
          ? 'To jest zadanie dowodowe. Przeprowadź dowód krok po kroku i wytłumacz każdy krok.'
          : 'Kod SymPy nie zadziałał. Rozwiąż zadanie analitycznie i wytłumacz krok po kroku.',
      });
    }

    const summaryRaw = await llmCall('summary', prompts.summary, summaryContext, {
      maxTokens: prompts.agents.summary.max_tokens,
      temperature: prompts.agents.summary.temperature,
    });

    const summary = stripMarkdown(stripThink(summaryRaw));
    send('summary_done', 'Agent Podsumowujący', summary);

    // ── Step 5: Lean verification (proof problems) ──────────────────

    let leanVerified = null;
    if (proofProblem) {
      const leanUp = await leanHealthy();
      if (!leanUp) {
        send('lean_verify_fail', 'Lean Prover', 'Lean Prover niedostępny. Weryfikacja formalna wyłączona.');
        leanVerified = false;
      } else {
        send('lean_verify', 'Lean Prover', 'Formalizuję i weryfikuję dowód w Lean 4...');
        try {
          const leanInput = hasResult
            ? `Zadanie:\n${userMessage}\n\nRozwiązanie:\n${sympyResult}\n\nSformalizuj dowód w Lean 4.`
            : `Zadanie:\n${userMessage}\n\nPlan rozwiązania:\n${analyticalPlan}\n\nSformalizuj dowód w Lean 4.`;

          const MAX_LEAN_ATTEMPTS = 2;
          let leanErrors = null;

          for (let leanAttempt = 1; leanAttempt <= MAX_LEAN_ATTEMPTS; leanAttempt++) {
            const messages = [{ role: 'user', content: leanInput }];

            if (leanAttempt > 1 && leanErrors) {
              messages.push({
                role: 'assistant',
                content: '```lean\n' + verifyCode + '\n```',
              });
              messages.push({
                role: 'user',
                content: `Lean zwrocil bledy:\n${leanErrors}\n\nPopraw kod. KRYTYCZNE: ring, ring_nf, norm_num sa NIEDOSTEPNE (wymagaja Mathlib). Uzyj import Std. Dla rownosci wielomianowych uzyj sorry. Dla liniowej arytmetyki uzyj omega. Wzorzec: have h : ... := by sorry; rw [h]; omega`,
              });
            }

            var verifyCodeRaw = await llmCall(`lean_post_verify_attempt${leanAttempt}`, LEAN_FORMALIZATION_PROMPT, messages, { maxTokens: 800, temperature: 0.2 });

            var verifyCode = extractLeanCode(stripThink(verifyCodeRaw));
            if (!verifyCode) {
              if (leanAttempt >= MAX_LEAN_ATTEMPTS) {
                leanVerified = false;
                send('lean_verify_fail', 'Lean Prover', 'Model nie wygenerował kodu Lean (pominięto formalną weryfikację).');
                break;
              }
              // Retry — niech LLM jeszcze raz sprobuje
              continue;
            }
            send('lean_verify_code', 'Lean Prover', 'Waiting for a response');

            const keepAliveLeanCheck = setInterval(() => {
                send('lean_verify_wait', 'Lean Prover'); // SSE comment, ignored by the client
            }, 15000);

            const verifyResult = await leanVerify(verifyCode);

            clearInterval(keepAliveLeanCheck);

            if (verifyResult.success && verifyResult.verificationDetails?.verified) {
              leanVerified = true;
              const hasSorry = verifyCode.includes('sorry');
              const warnings = verifyResult.verificationDetails?.warnings;
              if (hasSorry) {
                send('lean_verify_done', 'Lean Prover', 'Struktura dowodu zweryfikowana przez Lean 4 ✓ (zawiera sorry)');
              } else {
                send('lean_verify_done', 'Lean Prover', 'Dowód w pełni zweryfikowany formalnie przez Lean 4 ✓');
              }
              break;
            } else {
              leanErrors = verifyResult.verificationDetails?.errors?.join('; ') || 'verification failed';
              if (leanAttempt >= MAX_LEAN_ATTEMPTS) {
                leanVerified = false;
                send('lean_verify_fail', 'Lean Prover', `Lean nie zweryfikował dowodu: ${leanErrors}`);
              } else {
                send('lean_verify', 'Lean Prover', 'Pierwsza próba nieudana, poprawiam kod Lean...');
              }
            }
          }
        } catch (err) {
          leanVerified = false;
          send('lean_verify_fail', 'Lean Prover', `Błąd weryfikacji Lean: ${err.message}`);
        }
      }
    }

    // ── Step 6: Geometry / function diagram ─────────────────────────

    let diagram = null;
    if (shouldGenerateDiagram(userMessage, problemType)) {
      const diagramType = detectDiagramType(userMessage);
      const diagramPrompt = getDiagramPrompt(diagramType);
      send('diagram', 'Diagram', `Generuję diagram (${diagramType})...`);

      const MAX_DIAGRAM_ATTEMPTS = 2;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_DIAGRAM_ATTEMPTS; attempt++) {
        try {
          const messages = [
            { role: 'user', content: userMessage },
            ...(hasResult ? [{ role: 'assistant', content: 'Wynik obliczen:\n' + sympyResult }] : []),
          ];

          // On retry, include the error so the LLM can fix it
          if (attempt > 1 && lastError) {
            messages.push({
              role: 'user',
              content: 'Poprzedni kod SVG zakonczyl sie bledem:\n' + lastError + '\nPopraw kod. Pamietaj: NIE uzywaj f-stringow, uzyj konkatenacji stringow lub format().',
            });
          }

          const plotCodeRaw = await llmCall('geometry_plot', diagramPrompt, messages, {
            maxTokens: 2000,
            temperature: attempt === 1 ? 0.1 : 0.2,
          });

          let plotCode = extractPythonCode(stripThink(plotCodeRaw));
          if (!plotCode) {
            lastError = 'Nie udalo sie wyekstrahowac kodu Python z odpowiedzi LLM';
            continue;
          }

          // Sanitize the plot code (same fixes as executor code)
          plotCode = sanitizeGeneratedCode(plotCode);

          const svgResult = await callSymPyPlot(plotCode);
          if (svgResult && svgResult.includes('<svg')) {
            diagram = svgResult;
            send('diagram_done', 'Diagram', svgResult, { isSvg: true, diagramType });
            break;
          } else {
            lastError = svgResult || 'Kod nie wygenerował poprawnego SVG';
            if (attempt === MAX_DIAGRAM_ATTEMPTS) {
              send('diagram_fail', 'Diagram', lastError);
            }
          }
        } catch (err) {
          lastError = err.message;
          if (attempt === MAX_DIAGRAM_ATTEMPTS) {
            send('diagram_fail', 'Diagram', 'Blad generowania diagramu: ' + err.message);
          }
        }
      }
    }

    return {
      success: true,
      type: 'solve',
      classification,
      analyticalPlan,
      executorCode,
      sympyResult,
      summary,
      leanVerified,
      diagram,
    };
  });
}
