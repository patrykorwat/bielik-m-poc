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
import OpenAI from 'openai';
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

const LEAN_FORMALIZATION_PROMPT = `Jesteś ekspertem od formalizacji matematycznych dowodów w Lean 4.
Twoim zadaniem jest przetłumaczenie polskiego zadania maturalnego na formalny dowód w Lean 4.

ZASADY:
1. Napisz KOMPLETNY, samowystarczalny kod Lean 4 (bez importów Mathlib)
2. Użyj podstawowych taktyk: intro, apply, exact, simp, ring, omega, linarith, norm_num, nlinarith, positivity, field_simp, constructor, cases, induction, rfl, calc
3. Jeśli dowód jest zbyt trudny do pełnej formalizacji, użyj sorry dla najtrudniejszych kroków, ale sformalizuj jak najwięcej
4. ZAWSZE zwróć TYLKO blok kodu Lean 4, bez dodatkowego tekstu`;

function extractLeanCode(response) {
  const leanMatch = /```lean\s*\n([\s\S]*?)\n```/.exec(response);
  if (leanMatch) return leanMatch[1].trim();
  const plainMatch = /```\s*\n([\s\S]*?)\n```/.exec(response);
  if (plainMatch) {
    const code = plainMatch[1].trim();
    if (code.includes('theorem') || code.includes('lemma') || code.includes('def ')) return code;
  }
  const lines = response.split('\n');
  const start = lines.findIndex(l => /^\s*(theorem|lemma|def)\s/.test(l));
  if (start >= 0) return lines.slice(start).join('\n').trim();
  return response.trim();
}

async function leanHealthy() {
  try {
    const res = await fetch(`${LEAN_PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.leanInstalled === true;
  } catch { return false; }
}

async function leanVerify(theoremContent) {
  const res = await fetch(`${LEAN_PROXY_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theoremContent, filename: `proof_${Date.now()}.lean` }),
    signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) throw new Error(`Lean proxy returned ${res.status}`);
  return res.json();
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
  if (text.includes('from sympy') || text.includes('import sympy')) {
    return sanitizeGeneratedCode(text.trim());
  }
  return null;
}

// ── Helper: fix common Bielik code generation mistakes ────────────────

function sanitizeGeneratedCode(code) {
  let lines = code.split('\n');

  // 1. Replace f-string ODPOWIEDZ prints with simple concatenation.
  //    Bielik often produces broken f-strings with Polish text and unmatched parens.
  lines = lines.map(line => {
    // Match: print(f"ODPOWIEDZ: ... {var1} ... {var2} ...")
    if (/print\(f["']ODPOWIED/.test(line)) {
      // Extract all {variable} references from the f-string
      const vars = [];
      const varPattern = /\{([^}]+)\}/g;
      let m;
      while ((m = varPattern.exec(line)) !== null) {
        vars.push(m[1]);
      }
      if (vars.length === 1) {
        return `print("ODPOWIEDZ:", ${vars[0]})`;
      }
      if (vars.length > 1) {
        const pairs = vars.map(v => `"${v} =", ${v}`).join(', ", ", ');
        return `print("ODPOWIEDZ:", ${pairs})`;
      }
      // No vars found, just fix the print
      return line.replace(/print\(f["']/, 'print("').replace(/["']\)$/, '")');
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

// ── Geometry construction detection ───────────────────────────────────

const CONSTRUCTION_KEYWORDS = [
  'narysuj', 'rysuj', 'szkic', 'konstruk', 'wykres',
  'wpisz okrąg', 'opisz okrąg', 'okrąg wpisany', 'okrąg opisany',
  'inscribed circle', 'circumscribed circle',
  'draw', 'sketch', 'plot', 'diagram',
  'wykonaj konstrukcj', 'wykonaj rysunek',
];

function isConstructionTask(text) {
  const lower = text.toLowerCase();
  return CONSTRUCTION_KEYWORDS.some(kw => lower.includes(kw));
}

const GEOMETRY_PLOT_PROMPT = `Napisz kod Python ktory generuje diagram SVG dla tego zadania geometrycznego.

ZASADY:
1. Oblicz wspolrzedne punktow uzywajac sympy (Triangle, Circle, incircle, circumcircle, itp.)
2. Na koniec wypisz SVG uzywajac print(). SVG musi byc KOMPLETNY: <svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>
3. Uzyj viewBox i skalowania zeby diagram byl czytelny (min 400x400)
4. Kolory: trojkat niebieski (#2563eb), okrag wpisany czerwony (#dc2626), okrag opisany zielony (#16a34a)
5. Dodaj etykiety punktow (A, B, C) i wartosci (r, R)
6. Linie: stroke-width="2", fill="none"
7. Tlo biale
8. NIE uzywaj matplotlib! Generuj SVG recznie z obliczonych wspolrzednych
9. float() na kazdej wartosci sympy przed umieszeniem w SVG
10. TYLKO kod w bloku \`\`\`python ... \`\`\`

SZABLON:
\`\`\`python
from sympy import *
from sympy.geometry import *

# Definiuj trojkat
A = Point(0, 0)
B = Point(6, 0)
C = Point(3, 5)
t = Triangle(A, B, C)

# Oblicz okregi
ic = t.incircle    # okrag wpisany
cc = t.circumcircle # okrag opisany

# Konwersja do float
def pf(point):
    return (float(point.x), float(point.y))

def rf(val):
    return float(val)

# Skalowanie i przesuniecie
pts = [pf(A), pf(B), pf(C)]
cx_ic, cy_ic = pf(ic.center)
r_ic = rf(ic.radius)
cx_cc, cy_cc = pf(cc.center)
r_cc = rf(cc.radius)

# Oblicz bounding box i skaluj
all_x = [p[0] for p in pts] + [cx_cc - r_cc, cx_cc + r_cc]
all_y = [p[1] for p in pts] + [cy_cc - r_cc, cy_cc + r_cc]
margin = 1
min_x, max_x = min(all_x) - margin, max(all_x) + margin
min_y, max_y = min(all_y) - margin, max(all_y) + margin
w = max_x - min_x
h = max_y - min_y

# SVG (y-axis flipped)
def sy(y):
    return max_y - y + min_y

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x:.1f} {min_y:.1f} {w:.1f} {h:.1f}" width="500" height="500" style="background:white">
  <polygon points="{pts[0][0]:.2f},{sy(pts[0][1]):.2f} {pts[1][0]:.2f},{sy(pts[1][1]):.2f} {pts[2][0]:.2f},{sy(pts[2][1]):.2f}" fill="none" stroke="#2563eb" stroke-width="0.08"/>
  <circle cx="{cx_ic:.2f}" cy="{sy(cy_ic):.2f}" r="{r_ic:.2f}" fill="none" stroke="#dc2626" stroke-width="0.06" stroke-dasharray="0.15,0.1"/>
  <circle cx="{cx_cc:.2f}" cy="{sy(cy_cc):.2f}" r="{r_cc:.2f}" fill="none" stroke="#16a34a" stroke-width="0.06" stroke-dasharray="0.15,0.1"/>
  <text x="{pts[0][0]:.1f}" y="{sy(pts[0][1]) + 0.5:.1f}" font-size="0.5" text-anchor="middle">A</text>
  <text x="{pts[1][0]:.1f}" y="{sy(pts[1][1]) + 0.5:.1f}" font-size="0.5" text-anchor="middle">B</text>
  <text x="{pts[2][0] - 0.5:.1f}" y="{sy(pts[2][1]):.1f}" font-size="0.5" text-anchor="middle">C</text>
</svg>"""
print(svg)
\`\`\``;

// ── Guardrail ─────────────────────────────────────────────────────────

async function checkGuardrail(userMessage) {
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

// ── Generator: intent detection ───────────────────────────────────────

const GENERATOR_KEYWORDS = [
  'wymyśl', 'wymysl', 'wygeneruj', 'generuj', 'losuj',
  'zadaj mi', 'zadaj pytani', 'zadawaj',
  'arkusz', 'zestaw zadań', 'zestaw zadan',
  'ćwiczeni', 'cwiczeni', 'trening', 'praktyk',
  'daj mi zadani', 'podaj zadani', 'pokaż zadani', 'pokaz zadani',
  'przygotuj zadani', 'kilka zadań', 'kilka zadan',
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
];

function matchTopicName(lower) {
  const topicMap = {
    'funkcja kwadratowa': ['kwadrat', 'parabo', 'wierzchoł'],
    'trygonometria': ['trygonometri', 'sin', 'cos', 'tg', 'ctg'],
    'ciągi': ['ciąg', 'ciag', 'arytmetycz', 'geometrycz'],
    'geometria analityczna': ['geometri analityczn', 'współrzędn', 'wspolrzedn'],
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
  };
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return topic;
    }
  }
  return undefined;
}

function detectGeneratorIntent(message) {
  const lower = message.toLowerCase().trim();

  const hasKeyword = GENERATOR_KEYWORDS.some(kw => lower.includes(kw));

  if (hasKeyword) {
    let level;
    if (lower.includes('podstawow')) level = 'podstawowa';
    else if (lower.includes('rozszerzon')) level = 'rozszerzona';

    let count;
    const countMatch = lower.match(/(\d+)\s*(zadań|zadan|zadani|pytań|pytan)/);
    if (countMatch) count = parseInt(countMatch[1]);

    let topic;
    for (const tp of TOPIC_ONLY_PATTERNS) {
      if (lower.includes(tp)) {
        topic = matchTopicName(lower);
        break;
      }
    }

    return { isTrigger: true, topic, level, count };
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
    const looksLikeProblem = /[=+\-*/^√∫∑]|\d{2,}|oblicz|wyznacz|rozwiąż|rozwiaz|udowodnij|ile|jaki|który/.test(lower);
    if (!looksLikeProblem) {
      const level = lower.includes('podstawow') ? 'podstawowa' : 'rozszerzona';
      const topic = matchTopicName(lower);
      return { isTrigger: true, topic, level };
    }
  }

  return { isTrigger: false };
}

// ── Generator: task filtering ─────────────────────────────────────────

function filterTasks({ topic, level, count = 5, year } = {}) {
  let pool = [...allTasks];

  if (level) pool = pool.filter(t => t.level === level);
  if (year) pool = pool.filter(t => t.year === parseInt(year));
  if (topic) {
    const topicLower = topic.toLowerCase();
    const topicMatched = pool.filter(t =>
      t.topics.some(tp => tp.toLowerCase().includes(topicLower)) ||
      t.question.toLowerCase().includes(topicLower)
    );
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

function tryArithmeticScheme(message) {
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

export async function solve(userMessage, sessionId, onStep) {
  const send = (step, agentName, content, extra = {}) => {
    if (onStep) onStep({ step, agentName, content, ...extra });
  };

  return llmobs.trace({ kind: 'workflow', name: 'formulo.solve', sessionId }, async () => {

    // ── Step 0: Guardrail ──────────────────────────────────────────

    send('guardrail', 'Guardrail', 'Sprawdzam zapytanie...');

    const guardrailResult = await checkGuardrail(userMessage);

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

    const generatorIntent = detectGeneratorIntent(userMessage);

    if (generatorIntent.isTrigger) {
      send('generator', 'Generator Zadań', 'Szukam zadań...');

      const tasks = filterTasks({
        topic: generatorIntent.topic,
        level: generatorIntent.level,
        count: generatorIntent.count || 5,
      });

      if (tasks.length === 0) {
        const noResult = `Nie znalazłem zadań pasujących do "${generatorIntent.topic || 'ogólne'}". Spróbuj inne słowo kluczowe lub temat.`;
        send('generator_done', 'Generator Zadań', noResult);
        return { success: true, type: 'generator', content: noResult };
      }

      const content = formatGeneratorTasks(tasks, generatorIntent.topic, generatorIntent.level);
      send('generator_done', 'Generator Zadań', content);
      return { success: true, type: 'generator', content };
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
          const summary = stripThink(summaryRaw);
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

    // ── Step 0.8: Lean proof solver (for proof tasks) ──────────────

    const proofProblem = isProofProblem(userMessage);
    if (proofProblem && await leanHealthy()) {
      send('lean_proof', 'Lean Prover', 'Formalizuję dowód w Lean 4...');
      try {
        const leanCodeRaw = await llmCall('lean_formalization', LEAN_FORMALIZATION_PROMPT, [
          { role: 'user', content: `Zadanie do formalizacji w Lean 4:\n${userMessage}` },
        ], { maxTokens: 800, temperature: 0.2 });

        const leanCode = extractLeanCode(stripThink(leanCodeRaw));
        send('lean_proof_code', 'Lean Prover', leanCode);

        const verifyResult = await leanVerify(leanCode);

        if (verifyResult.success && verifyResult.verificationDetails?.verified) {
          send('lean_proof_done', 'Lean Prover', 'Dowód zweryfikowany przez Lean 4.');

          // Summary for the verified proof
          send('summary', 'Agent Podsumowujący', 'Tworzę wyjaśnienie...');
          const summaryContext = [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: 'Dowód został sformalizowany i zweryfikowany w Lean 4.' },
            { role: 'user', content: `Kod Lean 4:\n\`\`\`lean\n${leanCode}\n\`\`\`` },
            { role: 'user', content: 'Wyjaśnij dowód krok po kroku po polsku.' },
          ];
          const summaryRaw = await llmCall('summary', prompts.summary, summaryContext, {
            maxTokens: prompts.agents.summary.max_tokens,
            temperature: prompts.agents.summary.temperature,
          });
          const summary = stripThink(summaryRaw);
          send('summary_done', 'Agent Podsumowujący', summary);

          return {
            success: true,
            type: 'solve',
            classification: { type: 'proof', confidence: 1.0 },
            analyticalPlan: 'Lean 4 formalization',
            executorCode: leanCode,
            sympyResult: verifyResult.output || 'Verified',
            summary,
            leanVerified: true,
          };
        }
        // Verification failed, fall through to normal pipeline
        send('lean_proof_fail', 'Lean Prover', 'Formalna weryfikacja nie powiodła się, kontynuuję standardową ścieżką.');
      } catch (err) {
        // Lean unavailable or error, continue with normal pipeline
      }
    }

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

    // Declare variables that can be set by either template or analytical/executor path
    let analyticalPlan = null;
    let executorCode = null;
    let sympyResult = null;
    let executorOutput = null;

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

    let hasResult = !!sympyResult;
    send('executor_done', 'Agent Wykonawczy', sympyResult || executorOutput || 'Brak wyniku', {
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

    // ── Step 4: Summary Agent ──────────────────────────────────────

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

    // ── Step 5: Lean post-solve verification (proof problems only) ──

    let leanVerified = null;
    if (proofProblem && hasResult && await leanHealthy()) {
      send('lean_verify', 'Lean Prover', 'Weryfikuję rozwiązanie...');
      try {
        // Ask LLM to formalize the solution into Lean 4
        const verifyCodeRaw = await llmCall('lean_post_verify', LEAN_FORMALIZATION_PROMPT, [
          { role: 'user', content: `Zadanie:\n${userMessage}\n\nRozwiązanie SymPy:\n${sympyResult}\n\nSformalizuj dowód w Lean 4.` },
        ], { maxTokens: 800, temperature: 0.2 });

        const verifyCode = extractLeanCode(stripThink(verifyCodeRaw));
        const verifyResult = await leanVerify(verifyCode);

        if (verifyResult.success && verifyResult.verificationDetails?.verified) {
          leanVerified = true;
          send('lean_verify_done', 'Lean Prover', 'Rozwiązanie zweryfikowane formalnie przez Lean 4.');
        } else {
          leanVerified = false;
          const errors = verifyResult.verificationDetails?.errors?.join('; ') || 'verification failed';
          send('lean_verify_fail', 'Lean Prover', `Formalna weryfikacja nie powiodła się: ${errors}`);
        }
      } catch (err) {
        // Lean verification is optional, don't block the result
        send('lean_verify_fail', 'Lean Prover', 'Lean Prover niedostępny.');
      }
    }

    // ── Step 6: Geometry diagram (construction tasks only) ─────────

    let diagram = null;
    if (isConstructionTask(userMessage)) {
      send('diagram', 'Diagram', 'Generuję diagram...');
      try {
        const plotCodeRaw = await llmCall('geometry_plot', GEOMETRY_PLOT_PROMPT, [
          { role: 'user', content: userMessage },
          ...(hasResult ? [{ role: 'assistant', content: `Wynik obliczeń:\n${sympyResult}` }] : []),
        ], { maxTokens: 1200, temperature: 0.1 });

        const plotCode = extractPythonCode(stripThink(plotCodeRaw));
        if (plotCode) {
          const svgResult = await callSymPyPlot(plotCode);
          if (svgResult && svgResult.includes('<svg')) {
            diagram = svgResult;
            send('diagram_done', 'Diagram', svgResult, { isSvg: true });
          } else {
            send('diagram_fail', 'Diagram', svgResult || 'Nie udało się wygenerować diagramu');
          }
        }
      } catch (err) {
        send('diagram_fail', 'Diagram', `Błąd generowania diagramu: ${err.message}`);
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
