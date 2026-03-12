/**
 * Classifier Service — Extract structured JSON from LLM classification of math problems.
 *
 * Calls the 11B model with a classifier prompt, extracts JSON with problem type + params.
 * Robust parsing handles markdown fences, partial JSON, and common LLM output quirks.
 */
import { ProblemType, CLASSIFIER_CONFIDENCE_THRESHOLD, } from './classifierTypes.js';
// ============================================================
// JSON Extraction from LLM output
// ============================================================
function extractJSON(text) {
    // Strategy 1: Look for JSON in ```json ... ``` fences
    const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
        try {
            return JSON.parse(fenceMatch[1]);
        }
        catch { /* continue */ }
    }
    // Strategy 2: Find the outermost { ... } block
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                const candidate = text.substring(start, i + 1);
                try {
                    return JSON.parse(candidate);
                }
                catch {
                    // Try fixing common issues
                    const fixed = candidate
                        .replace(/'/g, '"') // single → double quotes
                        .replace(/,\s*}/g, '}') // trailing commas
                        .replace(/,\s*]/g, ']') // trailing commas in arrays
                        .replace(/(\w+):/g, '"$1":') // unquoted keys
                        .replace(/""/g, '"'); // double-double quotes fix
                    try {
                        return JSON.parse(fixed);
                    }
                    catch { /* continue searching */ }
                }
                start = -1;
            }
        }
    }
    // Strategy 3: Try the entire text as JSON
    try {
        return JSON.parse(text.trim());
    }
    catch { /* give up */ }
    return null;
}
// ============================================================
// LaTeX → SymPy conversion for LLM params
// ============================================================
function latexToSymPy(expr) {
    if (!expr || typeof expr !== 'string')
        return String(expr || '0');
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
function sanitizeParams(params) {
    const exprKeys = new Set([
        'expression', 'equation', 'function_expr', 'lhs', 'rhs', 'approach', 'point',
        'tangent_point', 'domain_start', 'domain_end', 'eval_point',
        'a1', 'd', 'q', 'n', 'an', 'sum', 'p', 'favorable_outcomes', 'total_outcomes',
    ]);
    const result = {};
    for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string' && exprKeys.has(k)) {
            result[k] = latexToSymPy(v);
        }
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            result[k] = sanitizeParams(v);
        }
        else if (Array.isArray(v)) {
            result[k] = v.map(item => typeof item === 'string' ? latexToSymPy(item) :
                (item && typeof item === 'object' ? sanitizeParams(item) : item));
        }
        else {
            result[k] = v;
        }
    }
    return result;
}
// ============================================================
// Validate and normalize classification result
// ============================================================
function normalizeType(raw) {
    const normalized = raw.toLowerCase().trim().replace(/[-\s]/g, '_');
    // Direct match
    if (Object.values(ProblemType).includes(normalized)) {
        return normalized;
    }
    // Fuzzy matching for common variations
    const aliases = {
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
        // University-level aliases
        'modular': ProblemType.MODULAR_ARITHMETIC,
        'kongruencja': ProblemType.MODULAR_ARITHMETIC,
        'congruence': ProblemType.MODULAR_ARITHMETIC,
        'finite_field': ProblemType.MODULAR_ARITHMETIC,
        'cialo_skonczne': ProblemType.MODULAR_ARITHMETIC,
        'teoria_liczb': ProblemType.NUMBER_THEORY,
        'number_theory': ProblemType.NUMBER_THEORY,
        'nwd': ProblemType.NUMBER_THEORY,
        'gcd': ProblemType.NUMBER_THEORY,
        'diofantyczny': ProblemType.NUMBER_THEORY,
        'diophantine': ProblemType.NUMBER_THEORY,
        'podzielnosc': ProblemType.NUMBER_THEORY,
        'algebra_liniowa': ProblemType.LINEAR_ALGEBRA,
        'linear_algebra': ProblemType.LINEAR_ALGEBRA,
        'macierz': ProblemType.LINEAR_ALGEBRA,
        'matrix': ProblemType.LINEAR_ALGEBRA,
        'wyznacznik': ProblemType.LINEAR_ALGEBRA,
        'determinant': ProblemType.LINEAR_ALGEBRA,
        'eigenvalue': ProblemType.LINEAR_ALGEBRA,
        'calka': ProblemType.INTEGRAL,
        'integral': ProblemType.INTEGRAL,
        'calkowanie': ProblemType.INTEGRAL,
        'integration': ProblemType.INTEGRAL,
        'rownanie_rozniczkowe': ProblemType.DIFFERENTIAL_EQUATION,
        'differential_equation': ProblemType.DIFFERENTIAL_EQUATION,
        'ode': ProblemType.DIFFERENTIAL_EQUATION,
        'szereg': ProblemType.SERIES,
        'series': ProblemType.SERIES,
        'taylor': ProblemType.SERIES,
        'fourier': ProblemType.SERIES,
        'zbieznosc': ProblemType.SERIES,
        'convergence': ProblemType.SERIES,
        'grupa': ProblemType.GROUP_THEORY,
        'group': ProblemType.GROUP_THEORY,
        'group_theory': ProblemType.GROUP_THEORY,
        'pierscien': ProblemType.GROUP_THEORY,
        'ring': ProblemType.GROUP_THEORY,
        'analiza_zespolona': ProblemType.COMPLEX_ANALYSIS,
        'complex_analysis': ProblemType.COMPLEX_ANALYSIS,
        'residuum': ProblemType.COMPLEX_ANALYSIS,
        'residue': ProblemType.COMPLEX_ANALYSIS,
        'geometria_algebraiczna': ProblemType.ALGEBRAIC_GEOMETRY,
        'algebraic_geometry': ProblemType.ALGEBRAIC_GEOMETRY,
        'variete': ProblemType.ALGEBRAIC_GEOMETRY,
        'variety': ProblemType.ALGEBRAIC_GEOMETRY,
        'krzywa_eliptyczna': ProblemType.ALGEBRAIC_GEOMETRY,
        'elliptic_curve': ProblemType.ALGEBRAIC_GEOMETRY,
        'graf': ProblemType.GRAPH_THEORY,
        'graph_theory': ProblemType.GRAPH_THEORY,
        'euler_path': ProblemType.GRAPH_THEORY,
        'chromatic': ProblemType.GRAPH_THEORY,
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
function validateClassification(raw, question) {
    const type = normalizeType(raw.type || raw.problem_type || raw.category || 'general');
    const confidence = typeof raw.confidence === 'number'
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0.5; // default if missing
    const rawParams = raw.params || raw.parameters || raw;
    const params = sanitizeParams(rawParams);
    // Detect MC from question text
    const isMultipleChoice = /\b[ABCD]\.\s/.test(question) || /opcj[aei]/i.test(question);
    let mcOptions;
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
        }
        else {
            // Try to extract from question text
            mcOptions = extractMCOptionsFromQuestion(question);
        }
    }
    return {
        type,
        params: params,
        confidence,
        rawQuestion: question,
        isMultipleChoice,
        mcOptions,
    };
}
function extractMCOptionsFromQuestion(question) {
    const options = {};
    // Pattern: "A. value" or "A) value"
    const pattern = /([ABCD])[.)]\s*(.+?)(?=\s*[ABCD][.)]\s|$)/gs;
    let match;
    while ((match = pattern.exec(question)) !== null) {
        options[match[1]] = match[2].trim();
    }
    if (options.A && options.B && options.C && options.D) {
        return options;
    }
    // Pattern: "$A$. value" or LaTeX-wrapped
    const latexPattern = /\$?([ABCD])\$?[.)]\s*\$?(.+?)\$?(?=\s*\$?[ABCD]\$?[.)]\s|$)/gs;
    while ((match = latexPattern.exec(question)) !== null) {
        options[match[1]] = match[2].trim()
            .replace(/^\$/, '').replace(/\$$/, '') // strip dollar signs
            .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)')
            .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
            .replace(/\\cdot/g, '*')
            .replace(/\\pi/g, 'pi');
    }
    if (options.A && options.B && options.C && options.D) {
        return options;
    }
    return undefined;
}
// ============================================================
// Regex pre-classifier — fast keyword-based detection (no LLM)
// Returns a hint type if keywords strongly match, null otherwise.
// ============================================================
function regexPreClassify(question) {
    const lower = question.toLowerCase();
    // Finite fields / modular arithmetic (strongest signal)
    if (/\bf[_\s]?\{?\s*\d+\s*(\^\s*\d+)?\s*\}?/i.test(question) ||
        /cia[lł]o\s+sko[nń]czon/i.test(lower) ||
        /finite\s+field/i.test(lower) ||
        /galois\s+field/i.test(lower) ||
        /\bgf\s*\(\s*\d+/i.test(lower) ||
        /mod(ulo)?\s+\d+/i.test(lower) && /kongruencj|rozwi[aą]z/i.test(lower)) {
        return ProblemType.MODULAR_ARITHMETIC;
    }
    // Algebraic geometry (varieties, curves over fields)
    if (/variet[yi]/i.test(lower) ||
        /intersection\s+point/i.test(lower) && /field/i.test(lower) ||
        /krzywa\s+eliptyczn/i.test(lower) ||
        /elliptic\s+curve/i.test(lower) ||
        /genus/i.test(lower) && /curve/i.test(lower)) {
        return ProblemType.ALGEBRAIC_GEOMETRY;
    }
    // Linear algebra
    if (/macierz|matrix|matrices/i.test(lower) ||
        /wyznacznik|determinant/i.test(lower) ||
        /warto[sś][cć]\s+w[lł]asn|eigenvalue|eigenvector/i.test(lower) ||
        /rz[aą]d\s+macierz|rank\s+of/i.test(lower) ||
        /j[aą]dro|nullspace|kernel/i.test(lower)) {
        return ProblemType.LINEAR_ALGEBRA;
    }
    // Differential equations
    if (/r[oó]wnanie\s+r[oó][zż]niczkow/i.test(lower) ||
        /differential\s+equation/i.test(lower) ||
        /\bode\b|\bpde\b/i.test(lower) ||
        /y['′]\s*[+=]|y''\s*[+=]/i.test(lower) ||
        /warunek\s+pocz[aą]tkow|initial\s+(value|condition)/i.test(lower)) {
        return ProblemType.DIFFERENTIAL_EQUATION;
    }
    // Integrals (university-level: double, triple, improper, line, surface)
    if (/ca[lł]ka\s+(podw[oó]jn|potr[oó]jn|nieoznaczon|niew[lł]a[sś]ciw|krzywoliniow|powierzchniow)/i.test(lower) ||
        /double\s+integral|triple\s+integral|improper\s+integral|line\s+integral|surface\s+integral/i.test(lower)) {
        return ProblemType.INTEGRAL;
    }
    // Basic integral detection (if not caught by matura-level)
    if (/\bca[lł]k[aąeę]/i.test(lower) && !/matur/i.test(lower) ||
        /\bintegra(l|te)\b/i.test(lower)) {
        return ProblemType.INTEGRAL;
    }
    // Series (power series, Taylor, Fourier, convergence)
    if (/szereg\s+(pot[eę]gow|taylor|fourier|maclaurin)/i.test(lower) ||
        /power\s+series|taylor\s+(series|expansion)|fourier\s+(series|transform)/i.test(lower) ||
        /zbie[zż]no[sś][cć]\s+szereg|convergence\s+(of\s+)?(the\s+)?series/i.test(lower) ||
        /promie[nń]\s+zbie[zż]no|radius\s+of\s+convergence/i.test(lower)) {
        return ProblemType.SERIES;
    }
    // Group theory
    if (/grup[aąeęy]\s+(cykliczn|symetryczn|permutacj|abelow)/i.test(lower) ||
        /group\s+(of\s+)?(order|symmetr|permutation|cyclic|abelian)/i.test(lower) ||
        /pier[sś]cie[nń]|ring\s+of|homomorfizm|homomorphism|izomorfizm|isomorphism/i.test(lower) ||
        /podgrup[aąeęy]|subgroup|quotient\s+group/i.test(lower)) {
        return ProblemType.GROUP_THEORY;
    }
    // Complex analysis
    if (/residuum|residue\s+at/i.test(lower) ||
        /ca[lł]ka\s+konturow|contour\s+integral/i.test(lower) ||
        /biegun\w*\s+funkcj|pole\s+of\s+(the\s+)?function/i.test(lower) ||
        /szereg\s+laurent|laurent\s+series/i.test(lower) ||
        /analityczn\w+\s+funkcj|analytic\s+function/i.test(lower)) {
        return ProblemType.COMPLEX_ANALYSIS;
    }
    // Number theory
    if (/nwd|nww|gcd|lcm/i.test(lower) && !/geometr/i.test(lower) ||
        /podzielno[sś][cć]|divisib/i.test(lower) ||
        /diofant|diophantine/i.test(lower) ||
        /symbol\s+legendre|legendre\s+symbol|jacobi\s+symbol/i.test(lower) ||
        /twierdzenie\s+(euler|fermat|wilson)/i.test(lower) ||
        /euler.*phi|totient/i.test(lower)) {
        return ProblemType.NUMBER_THEORY;
    }
    // Graph theory
    if (/graf\w*\s+(euler|hamilton|planar|dwudzieln|pe[lł]n)/i.test(lower) ||
        /chromatic\s+number|euler\s+(path|circuit)/i.test(lower) ||
        /drzewo\s+rozpinaj|spanning\s+tree/i.test(lower) ||
        /liczba\s+chromatyczn/i.test(lower)) {
        return ProblemType.GRAPH_THEORY;
    }
    return null; // no strong signal — let LLM decide
}
// ============================================================
// Main classifier function
// ============================================================
export async function classifyProblem(question, classifierPrompt, llmAgent, ragContext, options) {
    const universityEnabled = options?.enableUniversity ?? true;
    // === Stage 1: Regex pre-classification (skip university patterns when disabled) ===
    const regexHint = universityEnabled ? regexPreClassify(question) : null;
    if (regexHint) {
        console.log(`🔍 [Regex Pre-Classifier] Detected: ${regexHint}`);
    }
    // Build the user message with optional RAG context
    let userMessage = question;
    if (ragContext) {
        userMessage = `${ragContext}\n\n--- ZADANIE ---\n${userMessage}`;
    }
    // Call LLM
    const response = await llmAgent.execute(classifierPrompt, [{ role: 'user', content: userMessage }], {
        maxTokens: options?.maxTokens || 400,
        temperature: options?.temperature || 0.1,
    });
    // Strip <think> blocks if present
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Extract JSON
    const parsed = extractJSON(cleaned);
    if (!parsed) {
        console.warn('[Classifier] Failed to extract JSON from response:', cleaned.substring(0, 200));
        // If regex detected a type, use it instead of GENERAL
        if (regexHint) {
            console.log(`🔍 [Regex Override] LLM failed JSON parse → using regex hint: ${regexHint}`);
            return {
                type: regexHint,
                params: { description: question },
                confidence: 0.6,
                rawQuestion: question,
                isMultipleChoice: /\b[ABCD]\.\s/.test(question),
            };
        }
        return {
            type: ProblemType.GENERAL,
            params: { description: question },
            confidence: 0.0, // Will trigger fallback
            rawQuestion: question,
            isMultipleChoice: /\b[ABCD]\.\s/.test(question),
        };
    }
    const result = validateClassification(parsed, question);
    // === Stage 3: Regex override when LLM gives GENERAL but regex found specific type ===
    if (regexHint && result.type === ProblemType.GENERAL && regexHint !== ProblemType.GENERAL) {
        console.log(`🔍 [Regex Override] LLM → general, regex → ${regexHint}. Overriding type.`);
        result.type = regexHint;
        // Boost confidence slightly so it doesn't immediately fall back
        result.confidence = Math.max(result.confidence, 0.75);
    }
    // Also override if regex detected a university-level type but LLM picked a wrong matura type
    const universityTypes = [
        ProblemType.MODULAR_ARITHMETIC, ProblemType.NUMBER_THEORY, ProblemType.LINEAR_ALGEBRA,
        ProblemType.INTEGRAL, ProblemType.DIFFERENTIAL_EQUATION, ProblemType.SERIES,
        ProblemType.GROUP_THEORY, ProblemType.TOPOLOGY, ProblemType.COMPLEX_ANALYSIS,
        ProblemType.ALGEBRAIC_GEOMETRY, ProblemType.GRAPH_THEORY,
    ];
    if (regexHint && universityTypes.includes(regexHint) && !universityTypes.includes(result.type)) {
        console.log(`🔍 [Regex Override] LLM → ${result.type} (matura), regex → ${regexHint} (university). Overriding.`);
        result.type = regexHint;
        result.confidence = Math.max(result.confidence, 0.75);
    }
    return result;
}
// ============================================================
// Check if classification should use fallback
// ============================================================
export function shouldUseFallback(classification) {
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
export { extractJSON, normalizeType, validateClassification, extractMCOptionsFromQuestion, };
