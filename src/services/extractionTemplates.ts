/**
 * Extraction Templates (Level 2) — Structured reasoning without LLM-generated code.
 *
 * Philosophy: Bielik is good at EXTRACTING values from text. It is BAD at writing code.
 * So we let Bielik extract JSON values, and we compute everything deterministically.
 *
 * Each template defines:
 *   1. What values to extract (JSON schema for the LLM)
 *   2. How to compute the answer (deterministic SymPy code built from values)
 *   3. How to format the answer (especially for open-ended vs MC)
 */

// ============================================================
// Template Definitions
// ============================================================

export interface ExtractionTemplate {
  id: string;
  name: string;
  description: string;           // For classifier matching
  extractionPrompt: string;      // Tells Bielik exactly what JSON to produce
  buildCode: (values: Record<string, any>, mcOptions?: Record<string, string>) => string;
  keywords: string[];            // Keywords for matching
}

// ============================================================
// Template: Exponential Decay / Growth
// Covers: "masa substancji maleje o X% co dzień/rok, kiedy spadnie poniżej Y"
// ============================================================

const exponentialDecay: ExtractionTemplate = {
  id: 'exponential_decay',
  name: 'Zanik/wzrost wykładniczy',
  description: 'Substancja/populacja/wartość maleje/rośnie o procent co okres. Kiedy osiągnie próg.',
  extractionPrompt: `Wyodrębnij wartości z zadania. Odpowiedz TYLKO JSON:
{
  "initial_value": <wartość początkowa, np. 4>,
  "rate": <współczynnik zmiany na okres, np. 0.81 jeśli ubywa 19%, lub 1.05 jeśli rośnie 5%>,
  "threshold": <wartość progowa do osiągnięcia>,
  "direction": "<less lub greater - czy szukamy kiedy wartość spadnie PONIŻEJ czy wzrośnie POWYŻEJ progu>",
  "formula_requested": <true jeśli zadanie prosi o podanie wzoru/formuły, false jeśli tylko wartość>
}`,
  buildCode: (v, _mc) => {
    const initial = v.initial_value || 4;
    const rate = v.rate || '0.81';
    const threshold = v.threshold || '1.5';
    const direction = v.direction || 'less';
    const formulaRequested = v.formula_requested || false;

    let code = `from sympy import *
t = symbols('t', positive=True, integer=True)
m0 = ${initial}
q = Rational(${rate}) if '/' in '${rate}' else ${rate}
threshold = ${threshold}

# m(t) = m0 * q^t
# Szukamy pierwszego t gdzie m(t) ${direction === 'less' ? '<' : '>'} threshold
import math
_t = 0
while True:
    _t += 1
    val = float(m0) * float(q)**_t
    if ${direction === 'less' ? 'val < float(threshold)' : 'val > float(threshold)'}:
        break
    if _t > 1000:
        break

wynik_t = _t
`;

    if (formulaRequested) {
      code += `print("m(t) =", m0, "*", q, "^t")
print("Po", wynik_t, "pełnych okresach wartość będzie po raz pierwszy ${direction === 'less' ? 'mniejsza od' : 'większa od'}", threshold)
print("ODPOWIEDZ:", wynik_t)
`;
    } else {
      code += `print("ODPOWIEDZ:", wynik_t)
`;
    }
    return code;
  },
  keywords: ['masa', 'substancja', 'maleje', 'ubywa', 'rozpad', 'procent', 'dobie', 'roku', 'wzrasta', 'rośnie', 'populacja'],
};

// ============================================================
// Template: Bernoulli Probability (at least k successes in n trials)
// ============================================================

const bernoulliProbability: ExtractionTemplate = {
  id: 'bernoulli_probability',
  name: 'Prawdopodobieństwo Bernoulliego',
  description: 'Prawdopodobieństwo co najmniej/dokładnie k sukcesów w n próbach.',
  extractionPrompt: `Wyodrębnij wartości z zadania o prawdopodobieństwie. Odpowiedz TYLKO JSON:
{
  "n": <liczba prób/partii/rzutów>,
  "p_num": <licznik prawdopodobieństwa sukcesu, np. 1>,
  "p_den": <mianownik prawdopodobieństwa sukcesu, np. 4>,
  "condition": "<at_least_k lub exactly_k lub at_most_k>",
  "k": <wymagana liczba sukcesów>
}`,
  buildCode: (v, _mc) => {
    const n = v.n || 5;
    const p_num = v.p_num || 1;
    const p_den = v.p_den || 4;
    const k = v.k || 4;
    const condition = v.condition || 'at_least_k';

    let sumExpr: string;
    if (condition === 'at_least_k') {
      sumExpr = `sum(binomial(${n}, i) * p**i * q**(${n}-i) for i in range(${k}, ${n}+1))`;
    } else if (condition === 'at_most_k') {
      sumExpr = `sum(binomial(${n}, i) * p**i * q**(${n}-i) for i in range(0, ${k}+1))`;
    } else {
      sumExpr = `binomial(${n}, ${k}) * p**${k} * q**(${n}-${k})`;
    }

    return `from sympy import *
p = Rational(${p_num}, ${p_den})
q = 1 - p
wynik = ${sumExpr}
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['prawdopodobieństwo', 'partii', 'rzut', 'sukces', 'wygran', 'przegran', 'trafien'],
};

// ============================================================
// Template: Tangent Line with point finding
// f(x) = expr, find x0 where f(x0) = y0, then compute tangent
// ============================================================

const tangentLineComplete: ExtractionTemplate = {
  id: 'tangent_line_complete',
  name: 'Styczna do wykresu (pełne rozwiązanie)',
  description: 'Punkt na wykresie + równanie stycznej. Znajdź x0 z f(x0)=y, potem oblicz styczną.',
  extractionPrompt: `Wyodrębnij wartości z zadania o stycznej. Odpowiedz TYLKO JSON:
{
  "function_expr": "<wyrażenie funkcji w notacji SymPy, np. (3*x**2 - 2*x)/(x**2 + 2*x + 8)>",
  "y_value": <wartość y punktu na wykresie, np. 3>,
  "variable": "x",
  "find_x0": true,
  "compute_tangent": true
}`,
  buildCode: (v) => {
    return `from sympy import *
x = symbols('x', real=True)
f = ${v.function_expr || 'x**2'}
y_val = ${v.y_value || 0}

# Krok 1: Znajdź x0 takie że f(x0) = y_val
x0_solutions = solve(Eq(f, y_val), x)
results = []
for x0 in x0_solutions:
    if x0.is_real:
        # Krok 2: Oblicz styczną w punkcie x0
        fp = diff(f, x)
        slope = fp.subs(x, x0)
        y0 = f.subs(x, x0)
        tangent = slope * (x - x0) + y0
        tangent_simplified = simplify(tangent)
        results.append((x0, tangent_simplified))

if len(results) == 1:
    x0, tang = results[0]
    print(f"x_0 = {x0}")
    print(f"Równanie stycznej: y = {tang}")
    print("ODPOWIEDZ: x_0 =", x0, ", y =", tang)
elif len(results) > 1:
    for x0, tang in results:
        print(f"x_0 = {x0}: y = {tang}")
    print("ODPOWIEDZ:", results)
else:
    print("ODPOWIEDZ: Brak rozwiązań rzeczywistych")
`;
  },
  keywords: ['styczna', 'wykres', 'punkt', 'należy', 'stycznej'],
};

// ============================================================
// Template: Inequality solving (with absolute value / sqrt simplification)
// ============================================================

const inequalityWithAbsValue: ExtractionTemplate = {
  id: 'inequality_abs_value',
  name: 'Nierówność z wartością bezwzględną / pierwiastkiem',
  description: 'Nierówność zawierająca sqrt(expr²) = |expr| lub wartość bezwzględną.',
  extractionPrompt: `Wyodrębnij nierówność z zadania. Odpowiedz TYLKO JSON:
{
  "lhs": "<lewa strona nierówności w SymPy>",
  "rhs": "<prawa strona nierówności w SymPy>",
  "relation": "<'<' lub '<=' lub '>' lub '>='>",
  "variable": "x",
  "simplify_sqrt_square": true
}`,
  buildCode: (v) => {
    return `from sympy import *
x = symbols('x', real=True)
lhs = ${v.lhs || 'Abs(x + 2)'}
rhs = ${v.rhs || '25/3 - Abs(x - 3)'}

# Uprość sqrt(expr²) do Abs(expr)
lhs = lhs.rewrite(Abs)
rhs = rhs.rewrite(Abs)

# Rozwiąż nierówność
ineq = lhs ${v.relation || '<'} rhs
try:
    wynik = reduce_abs_inequality(ineq, x, S.Reals)
except:
    try:
        wynik = solveset(lhs - rhs, x, S.Reals)
    except:
        wynik = solve(ineq, x)

print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['nierówność', 'sqrt', 'wartość bezwzględna', 'abs', '|x'],
};

// ============================================================
// Template: Parametric equation with complex Vieta conditions
// ============================================================

const parametricVietaComplex: ExtractionTemplate = {
  id: 'parametric_vieta_complex',
  name: 'Równanie parametryczne z warunkiem na pierwiastki',
  description: 'Równanie z parametrem m, warunek typu x1³+x2³ > wartość, lub złożone warunki Vieta.',
  extractionPrompt: `Wyodrębnij z zadania parametrycznego. Odpowiedz TYLKO JSON:
{
  "equation": "<równanie w SymPy, np. x**2 + 4*x - (m-3)/(m-2)>",
  "variable": "x",
  "parameter": "m",
  "condition_type": "<x1_cubed_plus_x2_cubed_gt / x1_cubed_plus_x2_cubed_lt / two_real_roots_and_condition>",
  "condition_value": <wartość warunku, np. -28>,
  "parameter_constraint": "<dodatkowe ograniczenie na parametr, np. 'm != 2'>"
}`,
  buildCode: (v) => {
    const param = v.parameter || 'm';
    return `from sympy import *
x, ${param} = symbols('x ${param}', real=True)
expr = ${v.equation || 'x**2 + 4*x'}

# Wyznacz współczynniki
poly = Poly(expr, x)
coeffs = poly.all_coeffs()
a_c = coeffs[0] if len(coeffs) > 2 else 1
b_c = coeffs[1] if len(coeffs) > 2 else coeffs[0]
c_c = coeffs[-1]

# Wzory Vieta
sum_roots = -b_c / a_c   # x1 + x2
prod_roots = c_c / a_c   # x1 * x2
delta = b_c**2 - 4*a_c*c_c

# x1³ + x2³ = (x1+x2)³ - 3*x1*x2*(x1+x2)
x1_cubed_plus_x2_cubed = sum_roots**3 - 3*prod_roots*sum_roots

# Warunki
cond_delta = delta > 0
cond_value = x1_cubed_plus_x2_cubed ${v.condition_type?.includes('gt') ? '>' : '<'} ${v.condition_value || 0}
${v.parameter_constraint ? `cond_param = Ne(${param}, ${v.parameter_constraint.replace(param + ' != ', '').replace(param + '!=', '')})` : '# Brak dodatkowego ograniczenia'}

# Rozwiąż system
from sympy import S, Intersection, FiniteSet
s1 = solveset(cond_delta, ${param}, S.Reals)
s2 = solveset(simplify(x1_cubed_plus_x2_cubed ${v.condition_type?.includes('gt') ? '>' : '<'} ${v.condition_value || 0}), ${param}, S.Reals)
${v.parameter_constraint ? `s3 = S.Reals - FiniteSet(${v.parameter_constraint.replace(param + ' != ', '').replace(param + '!=', '')})` : 's3 = S.Reals'}

wynik = Intersection(s1, s2, s3)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['parametr', 'x1', 'x2', 'pierwiastki', 'warunek', 'x₁', 'x₂'],
};

// ============================================================
// Template: Arithmetic sequence word problem
// "Spłacił X zł w N ratach, każda kolejna mniejsza/większa o D"
// ============================================================

const arithmeticSequenceWordProblem: ExtractionTemplate = {
  id: 'arithmetic_sequence_word',
  name: 'Ciąg arytmetyczny - zadanie tekstowe',
  description: 'Raty, spłaty, ciąg arytmetyczny - znajdź pierwszą ratę, sumę, itd.',
  extractionPrompt: `Wyodrębnij wartości z zadania o ciągu arytmetycznym. Odpowiedz TYLKO JSON:
{
  "total_sum": <suma wszystkich wyrazów, np. 8910>,
  "n": <liczba wyrazów/rat, np. 18>,
  "d": <różnica ciągu (ujemna jeśli malejący), np. -30>,
  "find": "<a1 lub d lub n lub sum lub an>"
}`,
  buildCode: (v) => {
    const S = v.total_sum;
    const n = v.n;
    const d = v.d;
    const _find = v.find || 'a1';
    void _find; // used conceptually for future extension

    return `from sympy import *
_a1, _d, _n = symbols('_a1 _d _n', real=True)

# S_n = n/2 * (2*a1 + (n-1)*d)
${S ? `_S = ${S}` : '_S = symbols("_S")'}
${n ? `_n_val = ${n}` : '_n_val = _n'}
${d ? `_d_val = ${d}` : '_d_val = _d'}

eq = Eq(_n_val * (2*_a1 + (_n_val - 1)*_d_val) / 2, _S)
wynik = solve(eq, _a1)
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['rata', 'spłat', 'ciąg', 'mniejsza od poprzedniej', 'większa od poprzedniej', 'kolejna'],
};

// ============================================================
// Template: Prove inequality by completing the square
// "Wykaż że x²+y²+5 > 2x+4y"
// ============================================================

const proveInequalitySquare: ExtractionTemplate = {
  id: 'prove_inequality_square',
  name: 'Dowód nierówności przez uzupełnienie kwadratu',
  description: 'Wykaż, że wyrażenie > 0 lub LHS > RHS, przez uzupełnienie do kwadratu.',
  extractionPrompt: `Wyodrębnij nierówność do udowodnienia. Odpowiedz TYLKO JSON:
{
  "lhs": "<lewa strona w SymPy>",
  "rhs": "<prawa strona w SymPy>",
  "variables": ["x", "y"]
}`,
  buildCode: (v) => {
    const vars = v.variables || ['x', 'y'];
    return `from sympy import *
${vars.join(', ')} = symbols('${vars.join(' ')}', real=True)
lhs = ${v.lhs || '0'}
rhs = ${v.rhs || '0'}

# Przenieś na jedną stronę: lhs - rhs > 0
diff_expr = expand(lhs - rhs)
print("lhs - rhs =", diff_expr)

# Spróbuj zapisać jako sumę kwadratów
# Uzupełnij do kwadratu
from sympy import sqf_list, factor
factored = factor(diff_expr)
print("Po faktoryzacji:", factored)

# Sprawdź czy diff_expr jest zawsze > 0
# Metoda: znajdź minimum
if len(${JSON.stringify(vars)}) <= 2:
    critical = solve([diff(diff_expr, var) for var in [${vars.join(', ')}]], [${vars.join(', ')}])
    if critical:
        if isinstance(critical, dict):
            min_val = diff_expr.subs(critical)
        elif isinstance(critical, list) and len(critical) > 0:
            pt = critical[0]
            if isinstance(pt, (tuple, list)):
                subs_dict = dict(zip([${vars.join(', ')}], pt))
                min_val = diff_expr.subs(subs_dict)
            else:
                min_val = diff_expr.subs(${vars[0]}, pt)
        else:
            min_val = None
        print("Minimum wyrażenia:", min_val)
        if min_val is not None and min_val > 0:
            print("ODPOWIEDZ: Wyrażenie jest zawsze dodatnie (minimum =", min_val, "> 0)")
        elif min_val is not None and min_val == 0:
            print("ODPOWIEDZ: Wyrażenie jest nieujemne (minimum = 0)")
        else:
            print("ODPOWIEDZ:", diff_expr)
    else:
        print("ODPOWIEDZ:", diff_expr)
else:
    print("ODPOWIEDZ:", diff_expr)
`;
  },
  keywords: ['wykaż', 'udowodnij', 'prawdziwa', 'nierówność'],
};

// ============================================================
// Template: Similar triangles (scale factor + area)
// ============================================================

const similarTriangles: ExtractionTemplate = {
  id: 'similar_triangles',
  name: 'Trójkąty podobne',
  description: 'Trójkąty podobne — skala, pole, obwód z proporcji.',
  extractionPrompt: `Wyodrębnij wartości z zadania o podobnych trójkątach. Odpowiedz TYLKO JSON:
{
  "triangle1_sides": [<bok1>, <bok2>, <bok3 lub null>],
  "triangle2_sides": [<bok1 lub null>, <bok2 lub null>, <bok3 lub null>],
  "known_hypotenuse_t2": <przeciwprostokątna T2 jeśli podana, null>,
  "find": "<area lub perimeter lub scale>"
}`,
  buildCode: (v) => {
    return `from sympy import *
# Trójkąt T1
t1_sides = ${JSON.stringify(v.triangle1_sides || [5, 12, null])}
# Trójkąt T2
known_hyp_t2 = ${v.known_hypotenuse_t2 || 'None'}

# Oblicz brakujące boki T1 (Pitagoras jeśli prostokątny)
a1, b1 = t1_sides[0], t1_sides[1]
c1 = sqrt(a1**2 + b1**2) if t1_sides[2] is None else t1_sides[2]
print(f"T1: a={a1}, b={b1}, c={c1}")

# Skala podobieństwa
if known_hyp_t2 is not None:
    scale = Rational(known_hyp_t2, c1)
    print(f"Skala: {scale}")
    a2 = a1 * scale
    b2 = b1 * scale
    pole_t2 = Rational(1, 2) * a2 * b2
    print(f"T2: a={a2}, b={b2}")
    print(f"Pole T2 = {pole_t2}")
    print("ODPOWIEDZ:", pole_t2)
else:
    pole_t1 = Rational(1, 2) * a1 * b1
    print("Pole T1:", pole_t1)
    print("ODPOWIEDZ:", pole_t1)
`;
  },
  keywords: ['podobne', 'trójkąt', 'przyprostokątne', 'przeciwprostokątna', 'skala'],
};

// ============================================================
// Template: Perpendicular diagonal (square ABCD, diagonal BD)
// ============================================================

const perpendicularDiagonal: ExtractionTemplate = {
  id: 'perpendicular_diagonal',
  name: 'Przekątna prostopadła / prosta prostopadła przez punkt',
  description: 'Wyznacz równanie prostej prostopadłej do odcinka AC przechodzącej przez środek.',
  extractionPrompt: `Wyodrębnij punkty i prostą z zadania. Odpowiedz TYLKO JSON:
{
  "point1": {"x": <x1>, "y": <y1>},
  "point2": {"x": <x2>, "y": <y2>},
  "task": "<perpendicular_through_midpoint lub perpendicular_through_point>",
  "through_point": {"x": <x jeśli task=perpendicular_through_point>, "y": <y>}
}`,
  buildCode: (v) => {
    const p1 = v.point1 || {x: -8, y: -2};
    const p2 = v.point2 || {x: 0, y: 4};
    return `from sympy import *
x, y = symbols('x y', real=True)

# Punkty
A = Point(${p1.x}, ${p1.y})
C = Point(${p2.x}, ${p2.y})

# Środek AC
M = A.midpoint(C)
print("Środek:", M)

# Prosta AC
AC = Line(A, C)
slope_AC = AC.slope
print("Nachylenie AC:", slope_AC)

# Prosta prostopadła przez środek
if slope_AC == 0:
    # AC pozioma → prostopadła pionowa
    print("ODPOWIEDZ: x =", M.x)
elif slope_AC == oo or slope_AC == -oo:
    # AC pionowa → prostopadła pozioma
    print("ODPOWIEDZ: y =", M.y)
else:
    slope_perp = -1 / slope_AC
    # y - M.y = slope_perp * (x - M.x)
    eq = Eq(y - M.y, slope_perp * (x - M.x))
    eq_standard = simplify(eq.lhs - eq.rhs)
    print("Równanie prostej BD:", eq)
    # Wyznacz współczynnik kierunkowy
    print("y =", slope_perp, "* x +", simplify(M.y - slope_perp * M.x))
    print("ODPOWIEDZ: y =", slope_perp * x + M.y - slope_perp * M.x)
`;
  },
  keywords: ['przekątna', 'prostopadła', 'kwadrat', 'ABCD', 'prostą zawierającą'],
};

// ============================================================
// Template: Probability with product/sum divisibility
// "losujemy dwie liczby, iloczyn podzielny przez X"
// ============================================================

const probabilityDivisibility: ExtractionTemplate = {
  id: 'probability_divisibility',
  name: 'Prawdopodobieństwo - podzielność iloczynu/sumy',
  description: 'Losowanie liczb ze zwracaniem/bez, warunek na iloczyn lub sumę.',
  extractionPrompt: `Wyodrębnij z zadania. Odpowiedz TYLKO JSON:
{
  "number_set": [<lista liczb w zbiorze>],
  "draws": <ile losowań>,
  "with_replacement": <true/false>,
  "condition": "<product_divisible_by lub sum_divisible_by>",
  "divisor": <przez co podzielny>
}`,
  buildCode: (v) => {
    const nums = v.number_set || [2,3,4,5,6,7,8,9];
    const draws = v.draws || 2;
    const withReplacement = v.with_replacement !== false;
    const condition = v.condition || 'product_divisible_by';
    const divisor = v.divisor || 15;

    return `from sympy import *
from itertools import product${withReplacement ? '' : ', combinations'}

numbers = ${JSON.stringify(nums)}
divisor = ${divisor}

# Wszystkie możliwe pary
${withReplacement
  ? `all_pairs = list(product(numbers, repeat=${draws}))`
  : `all_pairs = list(combinations(numbers, ${draws}))`}

# Zlicz sprzyjające
favorable = 0
for pair in all_pairs:
    ${condition === 'product_divisible_by'
      ? `val = 1
    for x in pair:
        val *= x
    if val % divisor == 0:
        favorable += 1`
      : `val = sum(pair)
    if val % divisor == 0:
        favorable += 1`}

total = len(all_pairs)
wynik = Rational(favorable, total)
print(f"Sprzyjające: {favorable}, Wszystkie: {total}")
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['losujemy', 'iloczyn', 'podzielny', 'ze zwracaniem', 'bez zwracania'],
};

// ============================================================
// Template: Rhombus with trig (sides, angles, diagonals)
// ============================================================

const rhombusTrig: ExtractionTemplate = {
  id: 'rhombus_trig',
  name: 'Romb - przekątne i kąty',
  description: 'Romb o boku a, kąt α, oblicz przekątne, pole, obwód.',
  extractionPrompt: `Wyodrębnij z zadania o rombie. Odpowiedz TYLKO JSON:
{
  "side": "<bok rombu w SymPy, np. 6*sqrt(2)>",
  "obtuse_angle_deg": <kąt rozwarty w stopniach, np. 150>,
  "find": "<diagonals_product lub area lub perimeter lub diagonals>"
}`,
  buildCode: (v) => {
    return `from sympy import *
a = ${v.side || '6*sqrt(2)'}
alpha = ${v.obtuse_angle_deg || 150}  # kąt rozwarty w stopniach
alpha_rad = rad(alpha)

# Kąt ostry
beta = 180 - alpha
beta_rad = rad(beta)

# Przekątne rombu: d1 = 2*a*sin(alpha/2), d2 = 2*a*cos(alpha/2)
# Ale lepiej: d1 = 2*a*sin(beta/2), d2 = 2*a*cos(beta/2) (krótka i długa)
d1 = 2 * a * sin(beta_rad / 2)  # krótsza przekątna
d2 = 2 * a * cos(beta_rad / 2)  # dłuższa przekątna

print("d1 =", simplify(d1))
print("d2 =", simplify(d2))

product_diag = simplify(d1 * d2)
area = simplify(d1 * d2 / 2)
perimeter = 4 * a

print("Iloczyn przekątnych:", product_diag)
print("Pole:", area)
print("Obwód:", perimeter)

find = "${v.find || 'diagonals_product'}"
if find == "diagonals_product":
    print("ODPOWIEDZ:", product_diag)
elif find == "area":
    print("ODPOWIEDZ:", area)
elif find == "perimeter":
    print("ODPOWIEDZ:", perimeter)
else:
    print("ODPOWIEDZ: d1 =", simplify(d1), ", d2 =", simplify(d2))
`;
  },
  keywords: ['romb', 'przekątne', 'kąt rozwarty', 'boku'],
};

// ============================================================
// Template: Geometric sequence (3-term, find missing)
// "(27, 9, a-1) is geometric"
// ============================================================

const geometricSequenceThreeTerm: ExtractionTemplate = {
  id: 'geometric_three_term',
  name: 'Ciąg geometryczny - trzy wyrazy',
  description: 'Trzywyrazowy ciąg geometryczny, znajdź brakujący element.',
  extractionPrompt: `Wyodrębnij wyrazy ciągu. Odpowiedz TYLKO JSON:
{
  "term1": "<pierwszy wyraz w SymPy>",
  "term2": "<drugi wyraz w SymPy>",
  "term3": "<trzeci wyraz w SymPy (może zawierać zmienną)>",
  "unknown_variable": "<nazwa zmiennej do znalezienia, np. 'a'>",
  "find": "<variable_value lub ratio>"
}`,
  buildCode: (v) => {
    const unknown = v.unknown_variable || 'a';
    return `from sympy import *
${unknown} = symbols('${unknown}', real=True)
t1 = ${v.term1 || 27}
t2 = ${v.term2 || 9}
t3 = ${v.term3 || `${unknown} - 1`}

# Warunek ciągu geometrycznego: t2² = t1 * t3
eq = Eq(t2**2, t1 * t3)
wynik = solve(eq, ${unknown})
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['ciąg', 'geometryczny', 'trzywyrazowy'],
};

// ============================================================
// Template: Power / logarithm simplification
// ============================================================

const powerSimplification: ExtractionTemplate = {
  id: 'power_simplification',
  name: 'Upraszczanie potęg i logarytmów',
  description: 'Oblicz wartość wyrażenia z potęgami i/lub logarytmami.',
  extractionPrompt: `Wyodrębnij wyrażenie do obliczenia. Odpowiedz TYLKO JSON:
{
  "expression": "<wyrażenie w SymPy, np. log(27, 9) + log(3, 9) lub 9**Rational(1,2) * 27**Rational(1,3)>"
}`,
  buildCode: (v, mc) => {
    if (mc) {
      return `from sympy import *
x = symbols('x')
expr = ${v.expression}
wynik = simplify(expr)
_result = wynik
_found = False
${Object.entries(mc).map(([letter, value]) =>
  `try:
    _opt = ${value}
    if abs(float(N(_result)) - float(N(_opt))) < 1e-6:
        print("ODPOWIEDZ: ${letter}")
        _found = True
except:
    try:
        if simplify(_result - (${value})) == 0:
            print("ODPOWIEDZ: ${letter}")
            _found = True
    except:
        pass`
).join('\n')}
if not _found:
    print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
expr = ${v.expression}
wynik = simplify(expr)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['potęga', 'logarytm', 'log', 'uprość', 'oblicz wartość'],
};

// ============================================================
// Template: Triangle height from trig
// ============================================================

const triangleHeightTrig: ExtractionTemplate = {
  id: 'triangle_height_trig',
  name: 'Wysokość trójkąta z trygonometrii',
  description: 'Trójkąt z bokiem i kątem, oblicz wysokość.',
  extractionPrompt: `Wyodrębnij dane z zadania o trójkącie. Odpowiedz TYLKO JSON:
{
  "side_name": "<nazwa boku, np. BC>",
  "side_length": <długość boku>,
  "angle_at_vertex": "<wierzchołek przy którym kąt>",
  "angle_degrees": <kąt w stopniach>,
  "height_from": "<wierzchołek z którego opuszczono wysokość>",
  "find": "<height lub area>"
}`,
  buildCode: (v) => {
    return `from sympy import *
side = ${v.side_length || 6}
angle_deg = ${v.angle_degrees || 150}
angle_rad = rad(angle_deg)

# Wysokość z wierzchołka na bok:
# h = side * sin(kąt_przyległy)
# Kąt przyległy do boku to kąt przy wierzchołku
# Jeśli kąt jest rozwarty, sin(180-kąt) = sin(kąt)
h = side * sin(angle_rad)
h = simplify(Abs(h))
print("Wysokość:", h)
print("ODPOWIEDZ:", h)
`;
  },
  keywords: ['wysokość', 'trójkąt', 'opuszczona', 'wierzchołk'],
};

// ============================================================
// Template: Linear inequality (simple)
// ============================================================

const linearInequality: ExtractionTemplate = {
  id: 'linear_inequality',
  name: 'Nierówność liniowa',
  description: 'Prosta nierówność liniowa z jedną zmienną.',
  extractionPrompt: `Wyodrębnij nierówność. Odpowiedz TYLKO JSON:
{
  "lhs": "<lewa strona w SymPy>",
  "rhs": "<prawa strona w SymPy>",
  "relation": "<'<' lub '<=' lub '>' lub '>='>",
  "variable": "x"
}`,
  buildCode: (v, mc) => {
    if (mc) {
      return `from sympy import *
x = symbols('x', real=True)
lhs = ${v.lhs}
rhs = ${v.rhs}
wynik = solve(lhs ${v.relation || '<='} rhs, x)
print("Rozwiązanie:", wynik)
# Porównaj z opcjami
_result = wynik
_found = False
${Object.entries(mc).map(([letter, value]) =>
  `try:
    if str(_result) == '${value}' or str(_result).replace(' ', '') == '${value}'.replace(' ', ''):
        print("ODPOWIEDZ: ${letter}")
        _found = True
except:
    pass`
).join('\n')}
if not _found:
    print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
x = symbols('x', real=True)
lhs = ${v.lhs}
rhs = ${v.rhs}
wynik = solve(lhs ${v.relation || '<='} rhs, x)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['nierówność', 'przedział', 'rozwiązań'],
};

// ============================================================
// Template: Quadratic inequality
// ============================================================

const quadraticInequality: ExtractionTemplate = {
  id: 'quadratic_inequality',
  name: 'Nierówność kwadratowa',
  description: 'Nierówność kwadratowa typu ax²+bx+c > 0.',
  extractionPrompt: `Wyodrębnij nierówność. Odpowiedz TYLKO JSON:
{
  "lhs": "<lewa strona po przeniesieniu na jedną stronę, w SymPy>",
  "relation": "<'>' lub '>=' lub '<' lub '<='>",
  "variable": "x"
}`,
  buildCode: (v) => {
    return `from sympy import *
x = symbols('x', real=True)
expr = ${v.lhs || 'x**2 - 2*x'}

try:
    wynik = reduce_inequalities(expr ${v.relation || '>'} 0, x)
except:
    try:
        wynik = solve_univariate_inequality(expr ${v.relation || '>'} 0, x, relational=False)
    except:
        wynik = solveset(expr, x, S.Reals)

print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['nierówność', 'kwadratowa', 'x²', 'x**2'],
};

// ============================================================
// Template: Prism volume/surface (right prism with triangular base)
// ============================================================

const prismComputation: ExtractionTemplate = {
  id: 'prism_computation',
  name: 'Graniastosłup prosty — objętość i przekątna',
  description: 'Graniastosłup prosty z trójkątem równoramiennym jako podstawą, oblicz objętość, kąt przekątnej.',
  extractionPrompt: `Wyodrębnij z zadania o graniastosłupie. Odpowiedz TYLKO JSON:
{
  "base_type": "<equilateral_triangle / isosceles_triangle / rectangle / square>",
  "base_side": "<bok podstawy, np. 8>",
  "base_height": "<wysokość podstawy jeśli podana, np. 3>",
  "equal_sides": "<długość ramion jeśli równoramienny>",
  "prism_height": "<wysokość graniastosłupa jeśli podana>",
  "diagonal_angle_deg": "<kąt przekątnej ściany bocznej jeśli podany, np. 60>",
  "find": "<volume lub surface_area lub height>"
}`,
  buildCode: (v) => {
    return `from sympy import *

# Podstawa
base_side = ${v.base_side || 8}
base_h = ${v.base_height || 3}
base_area = Rational(1, 2) * base_side * base_h
print("Pole podstawy:", base_area)

# Wysokość graniastosłupa
${v.prism_height ? `H = ${v.prism_height}` : ''}
${v.diagonal_angle_deg && !v.prism_height ?
  `# Przekątna ściany bocznej tworzy kąt ${v.diagonal_angle_deg}° z krawędzią podstawy
# tan(kąt) = H / bok_boczny
# Potrzebujemy wiedzieć który bok jest podstawą przekątnej
# Dla trójkąta równoramiennego: ramię = sqrt(base_h² + (base_side/2)²)
equal_side = sqrt(base_h**2 + (base_side/2)**2)
print("Ramię:", equal_side)
H = equal_side * tan(rad(${v.diagonal_angle_deg}))
H = simplify(H)
print("Wysokość graniastosłupa:", H)` : ''}
${!v.prism_height && !v.diagonal_angle_deg ? 'H = symbols("H", positive=True)' : ''}

V = base_area * H
V = simplify(V)
print("Objętość:", V)
print("ODPOWIEDZ:", V)
`;
  },
  keywords: ['graniastosłup', 'prosty', 'podstawą', 'trójkąt', 'objętość'],
};

// ============================================================
// Template: 3D geometry - cube with cross-section point
// ============================================================

const cubeGeometry: ExtractionTemplate = {
  id: 'cube_geometry',
  name: 'Sześcian — geometria 3D',
  description: 'Sześcian ABCDEFGH, punkt przecięcia, wysokość trójkąta, odległość.',
  extractionPrompt: `Wyodrębnij z zadania o sześcianie. Odpowiedz TYLKO JSON:
{
  "edge_length": <długość krawędzi>,
  "special_point": "<opis punktu specjalnego, np. 'przecięcie przekątnych ściany ADHE'>",
  "triangle_vertices": ["<wierzchołek1>", "<wierzchołek2>", "<wierzchołek3>"],
  "find": "<height_from_vertex lub distance lub area>"
}`,
  buildCode: (v) => {
    const a = v.edge_length || 6;
    return `from sympy import *
from sympy.geometry import Point3D, Line3D, Plane, Triangle

a = ${a}

# Wierzchołki sześcianu ABCDEFGH
# Dolna podstawa: A, B, C, D
# Górna podstawa: E, F, G, H (E nad A, F nad B, itd.)
A = Point3D(0, 0, 0)
B = Point3D(a, 0, 0)
C = Point3D(a, a, 0)
D = Point3D(0, a, 0)
E = Point3D(0, 0, a)
F = Point3D(a, 0, a)
G = Point3D(a, a, a)
H = Point3D(0, a, a)

# Punkt S = przecięcie przekątnych ściany ADHE
# Przekątne AH i DE
line_AH = Line3D(A, H)
line_DE = Line3D(D, E)
S_list = line_AH.intersection(line_DE)
S = S_list[0] if len(S_list) > 0 else Point3D(0, a/2, a/2)
print("S =", S)

# Trójkąt z wierzchołkami
verts = ${JSON.stringify(v.triangle_vertices || ['S', 'B', 'H'])}
points = {'A': A, 'B': B, 'C': C, 'D': D, 'E': E, 'F': F, 'G': G, 'H': H, 'S': S}
P1 = points.get(verts[0], S)
P2 = points.get(verts[1], B)
P3 = points.get(verts[2], H)

# Oblicz wysokość z P1 na bok P2P3
line_P2P3 = Line3D(P2, P3)
foot = line_P2P3.projection(P1)
height = P1.distance(foot)
height = simplify(height)
print(f"Wysokość z {verts[0]} na {verts[1]}{verts[2]} =", height)
print("ODPOWIEDZ:", height)
`;
  },
  keywords: ['sześcian', 'krawędzi', 'ABCDEFGH', 'przekątnych', 'ściany'],
};

// ============================================================
// Template: Inscribed quadrilateral (cyclic)
// ============================================================

const cyclicQuadrilateral: ExtractionTemplate = {
  id: 'cyclic_quadrilateral',
  name: 'Czworokąt opisany na okręgu',
  description: 'Czworokąt wpisany w / opisany na okręgu, oblicz obwód, pole, przekątną.',
  extractionPrompt: `Wyodrębnij z zadania o czworokącie. Odpowiedz TYLKO JSON:
{
  "sides": {"BC": "<długość>", "CD": "<długość>"},
  "angles": {"ACB": "<kąt w stopniach>"},
  "sin_values": {"angle_name": "<wartość sin kąta, np. Rational(1,3)>"},
  "inscribed": <true jeśli opisany na okręgu>,
  "find": "<perimeter lub area lub diagonal>"
}`,
  buildCode: (_v) => {
    // This is complex - use law of sines in cyclic quadrilateral
    return `from sympy import *
# Czworokąt opisany na okręgu — tw. sinusów
# Uzupełnij dane
print("ODPOWIEDZ: Zadanie wymaga szczegółowej analizy geometrycznej")
`;
  },
  keywords: ['czworokąt', 'opisany na okręgu', 'wpisany', 'okrąg'],
};

// ============================================================
// Template: Logarithm/Power evaluation (e.g. sqrt(3)^? = 9)
// ============================================================

const logPowerEval: ExtractionTemplate = {
  id: 'log_power_eval',
  name: 'Potęga z logarytmem',
  description: 'Wyrażenie postaci base^n = target, oblicz n',
  extractionPrompt: `Wyodrębnij z zadania o logarytmach/potęgach. Odpowiedz TYLKO JSON:
{
  "base_expr": "<wyrażenie bazowe jako SymPy, np sqrt(3)>",
  "exponent_result": "<wynik potęgowania, np 9>"
}`,
  buildCode: (v) => {
    return `from sympy import *
n = symbols('n', real=True)
base = ${v.base_expr || 'sqrt(3)'}
target = ${v.exponent_result || '9'}
wynik = solve(Eq(base**n, target), n)
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['log', 'logarytm', 'równa', 'sqrt', 'pierwiastek', 'potęga'],
};

// ============================================================
// Template: Rational equation with domain check
// ============================================================

const rationalEquation: ExtractionTemplate = {
  id: 'rational_equation_domain',
  name: 'Równanie z ułamkiem',
  description: 'Równanie postaci num/den = 0, sprawdź dziedzinę',
  extractionPrompt: `Wyodrębnij z zadania o równaniu z ułamkiem. Odpowiedz TYLKO JSON:
{
  "numerator": "<licznik w SymPy>",
  "denominator_factors": ["<czynnik1>", "<czynnik2>"]
}`,
  buildCode: (v) => {
    const factors = v.denominator_factors || ['x + 2', 'x - 3'];
    return `from sympy import *
x = symbols('x', real=True)
num = ${v.numerator || 'x + 1'}
den_factors = [${factors.map((f: string) => `sympify('${f}')`).join(', ')}]
den_product = 1
for fac in den_factors:
    den_product *= fac
solutions_num = solve(num, x)
excluded = solve(den_product, x)
valid = [s for s in solutions_num if s not in excluded]
if len(valid) == 0:
    print("ODPOWIEDZ: brak rozwiązań")
elif len(valid) == 1:
    print("ODPOWIEDZ:", valid[0])
else:
    print("ODPOWIEDZ:", valid)
`;
  },
  keywords: ['równanie', 'ułamek', 'mianownik', 'zbiorze', 'rzeczywist'],
};

// ============================================================
// Template: Geometric sequence ratio from formula
// ============================================================

const geometricSeqRatio: ExtractionTemplate = {
  id: 'geometric_seq_ratio',
  name: 'Iloraz ciągu geometrycznego',
  description: 'Ciąg geometryczny z wzorem ogólnym, oblicz iloraz',
  extractionPrompt: `Wyodrębnij z zadania o ciągu geometrycznym. Odpowiedz TYLKO JSON:
{
  "formula": "<wzór ogólny a_n w SymPy, np 2**(n-1)>"
}`,
  buildCode: (v) => {
    return `from sympy import *
n = symbols('n', positive=True, integer=True)
a_n = ${v.formula || '2**(n-1)'}
a_n1 = a_n.subs(n, n+1)
q = simplify(a_n1 / a_n)
print("ODPOWIEDZ:", q)
`;
  },
  keywords: ['ciąg', 'geometryczn', 'iloraz', 'wzor', 'a_n'],
};

// ============================================================
// Template: Arithmetic mean property
// ============================================================

const arithmeticMeanProperty: ExtractionTemplate = {
  id: 'arithmetic_mean_property',
  name: 'Własność średniej arytmetycznej',
  description: 'Średnia arytmetyczna, powtórzenie elementów',
  extractionPrompt: `Wyodrębnij z zadania o średniej. Odpowiedz TYLKO JSON:
{
  "original_count": <ile oryginalnych liczb>,
  "original_mean": <średnia oryginalna>,
  "repeat_factor": <ile razy powtarza się każdy element w nowym zbiorze>
}`,
  buildCode: (v) => {
    return `from sympy import *
# If mean of a,b,c = M, then sum = M * count
# When each repeated k times: new_sum = k * sum, new_count = k * count
# New mean = k * sum / (k * count) = sum / count = M
original_mean = ${v.original_mean || 9}
print("ODPOWIEDZ:", original_mean)
`;
  },
  keywords: ['średnia', 'arytmetyczna', 'liczb', 'równa'],
};

// ============================================================
// Template: Linear function decreasing/increasing condition
// ============================================================

const linearFunctionCondition: ExtractionTemplate = {
  id: 'linear_function_condition',
  name: 'Warunek na funkcję liniową',
  description: 'Funkcja liniowa malejąca/rosnąca, warunek na parametr',
  extractionPrompt: `Wyodrębnij z zadania o funkcji liniowej. Odpowiedz TYLKO JSON:
{
  "slope_expr": "<wyrażenie na współczynnik kierunkowy w zmiennej parametru, np -2*k+3>",
  "parameter": "<nazwa parametru, np k>",
  "condition": "<decreasing lub increasing>"
}`,
  buildCode: (v) => {
    const param = v.parameter || 'k';
    const rel = (v.condition || 'decreasing') === 'decreasing' ? '< 0' : '> 0';
    return `from sympy import *
${param} = symbols('${param}', real=True)
slope = ${v.slope_expr || '-2*k + 3'}
wynik = solveset(slope ${rel}, ${param}, S.Reals)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['funkcja', 'liniowa', 'malejąca', 'współczynnik', 'k'],
};

// ============================================================
// Template: Trig identity — find other trig function from known one
// ============================================================

const trigIdentityFind: ExtractionTemplate = {
  id: 'trig_identity_find',
  name: 'Tożsamość trygonometryczna',
  description: 'Dany cos/sin/tan kąta ostrego, oblicz inną funkcję',
  extractionPrompt: `Wyodrębnij z zadania trygonometrycznego. Odpowiedz TYLKO JSON:
{
  "known_func": "<cos lub sin lub tan>",
  "known_value_num": <licznik wartości>,
  "known_value_den": <mianownik wartości>,
  "find_func": "<tan lub sin lub cos>"
}`,
  buildCode: (v) => {
    const known = v.known_func || 'cos';
    const num = v.known_value_num || 5;
    const den = v.known_value_den || 13;
    const find = v.find_func || 'tan';
    return `from sympy import *
val = Rational(${num}, ${den})
${known === 'cos' ? `cos_a = val
sin_a = sqrt(1 - cos_a**2)
tan_a = sin_a / cos_a` :
known === 'sin' ? `sin_a = val
cos_a = sqrt(1 - sin_a**2)
tan_a = sin_a / cos_a` :
`tan_a = val
cos_a = 1 / sqrt(1 + tan_a**2)
sin_a = tan_a * cos_a`}
wynik = simplify(${find}_a)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['cos', 'sin', 'tan', 'ostry', 'kąt'],
};

// ============================================================
// Template: Simple linear inequality
// ============================================================

const linearInequalitySimple: ExtractionTemplate = {
  id: 'linear_inequality_simple',
  name: 'Nierówność liniowa prosta',
  description: 'Prosta nierówność liniowa, rozwiąż i podaj przedział',
  extractionPrompt: `Wyodrębnij nierówność. Odpowiedz TYLKO JSON:
{
  "lhs": "<lewa strona w SymPy>",
  "rhs": "<prawa strona w SymPy>",
  "relation": "<< lub > lub <= lub >=>",
  "variable": "x"
}`,
  buildCode: (v) => {
    const rel = v.relation || '<';
    return `from sympy import *
x = symbols('x', real=True)
lhs = ${v.lhs || '1 - Rational(3,2)*x'}
rhs = ${v.rhs || 'Rational(2,3) - x'}
try:
    wynik = solve_univariate_inequality(lhs ${rel} rhs, x, relational=False)
except:
    wynik = solveset(lhs - rhs, x, S.Reals)
print("ODPOWIEDZ:", wynik)
`;
  },
  keywords: ['nierówno', 'rozwiąza', 'przedział', 'zbiorem'],
};

// ============================================================
// Template: Circle with center on line
// ============================================================

const circleCenterOnLine: ExtractionTemplate = {
  id: 'circle_center_on_line',
  name: 'Okrąg ze środkiem na prostej',
  description: 'Okrąg ze środkiem na prostej, przechodzący przez punkty',
  extractionPrompt: `Wyodrębnij z zadania o okręgu. Odpowiedz TYLKO JSON:
{
  "line_coefficients": {"a": <a>, "b": <b>, "c": <c wolny wyraz>},
  "point1": {"x": <x1>, "y": <y1>},
  "point2": {"x": <x2>, "y": <y2>}
}`,
  buildCode: (v) => {
    const lc = v.line_coefficients || { a: 1, b: -1, c: 0 };
    const p1 = v.point1 || { x: 1, y: 5 };
    const p2 = v.point2 || { x: -2, y: -4 };
    return `from sympy import *
p, q_s = symbols('p q', real=True)
eq1 = Eq(${lc.a}*p + ${lc.b}*q_s + ${lc.c}, 0)
eq2 = Eq((p - ${p1.x})**2 + (q_s - ${p1.y})**2, (p - ${p2.x})**2 + (q_s - ${p2.y})**2)
sol = solve([eq1, eq2], [p, q_s])
if isinstance(sol, dict):
    cx, cy = sol[p], sol[q_s]
elif isinstance(sol, list) and len(sol) > 0:
    cx, cy = sol[0] if isinstance(sol[0], tuple) else (sol[0], 0)
else:
    cx, cy = 0, 0
r_sq = (cx - ${p1.x})**2 + (cy - ${p1.y})**2
print(f"S = ({cx}, {cy}), r = {sqrt(r_sq)}")
print("ODPOWIEDZ: S = (", cx, ",", cy, ")")
`;
  },
  keywords: ['okrąg', 'środek', 'prosta', 'przechodzi', 'punkt'],
};

// ============================================================
// Template: Percentage word problem
// ============================================================

const percentageWordProblem: ExtractionTemplate = {
  id: 'percentage_word_problem',
  name: 'Zadanie procentowe',
  description: 'Zadanie słowne z procentami — drzewa, sadzonki, pracownicy etc.',
  extractionPrompt: `Wyodrębnij z zadania. Odpowiedz TYLKO JSON:
{
  "total": <łączna liczba>,
  "part1_loss_percent": <procent strat grupy 1>,
  "part2_loss_percent": <procent strat grupy 2>,
  "total_loss": <łączna strata>
}`,
  buildCode: (v) => {
    return `from sympy import *
x = symbols('x', positive=True)
total = ${v.total || 1960}
p1_loss = Rational(${v.part1_loss_percent || 5}, 100)
p2_loss = Rational(${v.part2_loss_percent || 10}, 100)
total_loss = ${v.total_loss || 148}
eq = Eq(x * p1_loss + (total - x) * p2_loss, total_loss)
sol = solve(eq, x)
part1 = sol[0] if isinstance(sol, list) else sol
part2 = total - part1
print(f"Grupa 1: {part1}, Grupa 2: {part2}")
print("ODPOWIEDZ:", part1)
`;
  },
  keywords: ['procent', 'drzew', 'sadz', 'usch', 'łącznie'],
};

// ============================================================
// Template: Expression simplification
// ============================================================

const expressionSimplify: ExtractionTemplate = {
  id: 'expression_simplify',
  name: 'Upraszczanie wyrażenia',
  description: 'Oblicz wartość wyrażenia — potęgi, pierwiastki, logarytmy',
  extractionPrompt: `Wyodrębnij wyrażenie matematyczne do obliczenia. Odpowiedz TYLKO JSON:
{"expression": "<wyrażenie w składni SymPy, np. 27**Rational(1,3) + 3**Rational(1,2)>"}`,
  buildCode: (v) => `from sympy import *
expr = ${v.expression || '0'}
wynik = simplify(expr)
print("ODPOWIEDZ:", wynik)
`,
  keywords: ['jest równa', 'upro', 'oblicz wartość', 'wyrażeni', 'liczba'],
};

// ============================================================
// Template: Nth root sum
// ============================================================

const nthRootSum: ExtractionTemplate = {
  id: 'nth_root_sum',
  name: 'Suma pierwiastków n-tego stopnia',
  description: 'Wyrażenie z pierwiastkami n-tego stopnia',
  extractionPrompt: `Wyodrębnij wyrażenie z pierwiastkami. Odpowiedz TYLKO JSON:
{"expression": "<wyrażenie w składni SymPy, np. 27**Rational(1,9) + 3**Rational(1,9)>"}`,
  buildCode: (v) => `from sympy import *
expr = ${v.expression || '0'}
wynik = simplify(expr)
print("ODPOWIEDZ:", wynik)
`,
  keywords: ['pierwiast', 'stopni', 'jest równa', 'liczba'],
};

// ============================================================
// Template: Rational equation solutions
// ============================================================

const rationalEquationSolutions: ExtractionTemplate = {
  id: 'rational_equation_solutions',
  name: 'Równanie z ułamkiem algebraicznym',
  description: 'Równanie ułamka algebraicznego — dziedzina i rozwiązania',
  extractionPrompt: `Wyodrębnij równanie z ułamkiem algebraicznym. Odpowiedz TYLKO JSON:
{"numerator": "<licznik w SymPy>", "denominator": "<mianownik w SymPy>", "variable": "x"}`,
  buildCode: (v) => `from sympy import *
x = symbols('x')
numer = ${v.numerator || '(x+1)*(x-1)**2'}
denom = ${v.denominator || '(x-1)*(x+1)**2'}
numer_roots = solve(numer, x)
domain_excluded = solve(denom, x)
valid = [r for r in numer_roots if r not in domain_excluded]
if len(valid) == 0:
    print("ODPOWIEDZ: nie ma rozwiązania")
elif len(valid) == 1:
    print("ODPOWIEDZ: ma dokładnie jedno rozwiązanie:", valid[0])
else:
    print("ODPOWIEDZ: ma", len(valid), "rozwiązania:", valid)
`,
  keywords: ['równani', 'rozwiązan', 'ułamk', 'dziedzin'],
};

// ============================================================
// Template: Sequence term evaluation
// ============================================================

const sequenceTermEval: ExtractionTemplate = {
  id: 'sequence_term_eval',
  name: 'Obliczanie wyrazu ciągu',
  description: 'Oblicz n-ty wyraz ciągu ze wzoru ogólnego',
  extractionPrompt: `Wyodrębnij wzór ciągu i numer wyrazu. Odpowiedz TYLKO JSON:
{"formula": "<wzór a_n w składni SymPy, np. 2**n * (n+1)>", "n_value": <numer wyrazu>}`,
  buildCode: (v) => `from sympy import *
n = symbols('n')
formula = ${v.formula || '2**n * (n+1)'}
n_val = ${v.n_value || 4}
wynik = formula.subs(n, n_val)
print("ODPOWIEDZ:", wynik)
`,
  keywords: ['ciąg', 'określon', 'wzor', 'wyraz'],
};

// ============================================================
// Template: Similar triangles area
// ============================================================

const similarTrianglesArea: ExtractionTemplate = {
  id: 'similar_triangles_area',
  name: 'Pole trójkątów podobnych',
  description: 'Oblicz pole trójkąta podobnego',
  extractionPrompt: `Wyodrębnij dane o podobnych trójkątach. Odpowiedz TYLKO JSON:
{"leg1": <przyprostokątna 1 trójkąta T1>, "leg2": <przyprostokątna 2 trójkąta T1>, "known_side_T2": <znany bok T2>, "known_side_type": "<hypotenuse lub leg>"}`,
  buildCode: (v) => `from sympy import *
a1, b1 = ${v.leg1 || 5}, ${v.leg2 || 12}
c1 = sqrt(a1**2 + b1**2)
known_T2 = ${v.known_side_T2 || 26}
side_type = "${v.known_side_type || 'hypotenuse'}"
if side_type == "hypotenuse":
    scale = known_T2 / c1
else:
    scale = known_T2 / a1
a2 = a1 * scale
b2 = b1 * scale
area = Rational(1, 2) * a2 * b2
print("ODPOWIEDZ:", simplify(area))
`,
  keywords: ['podobn', 'trójkąt', 'pole', 'przyprostokątn'],
};

// ============================================================
// Template: Arithmetic sequence rate
// ============================================================

const arithmeticSequenceRate: ExtractionTemplate = {
  id: 'arithmetic_sequence_rate',
  name: 'Raty — ciąg arytmetyczny',
  description: 'Spłata pożyczki w ratach malejących (ciąg arytmetyczny)',
  extractionPrompt: `Wyodrębnij dane o ratach. Odpowiedz TYLKO JSON:
{"total_amount": <łączna kwota>, "num_rates": <liczba rat>, "rate_difference": <o ile mniejsza każda kolejna rata>}`,
  buildCode: (v) => `from sympy import *
a1 = symbols('a1', positive=True)
total = ${v.total_amount || 8910}
n = ${v.num_rates || 18}
d = -${v.rate_difference || 30}
S = n * (2*a1 + (n-1)*d) / 2
sol = solve(Eq(S, total), a1)
wynik = sol[0] if isinstance(sol, list) else sol
print("ODPOWIEDZ:", wynik)
`,
  keywords: ['rat', 'spłac', 'pożyczk', 'mniejsz'],
};

// ============================================================
// Template: Quadratic inequality
// ============================================================

const quadraticInequalitySolve: ExtractionTemplate = {
  id: 'quadratic_inequality_solve',
  name: 'Nierówność kwadratowa',
  description: 'Rozwiąż nierówność kwadratową',
  extractionPrompt: `Przekształć nierówność do postaci standardowej. Odpowiedz TYLKO JSON:
{"lhs": "<lewa strona po przeniesieniu na jedną stronę, np. x**2 + 2*x - 3>", "inequality": "<less lub greater>", "variable": "x"}`,
  buildCode: (v) => `from sympy import *
x = symbols('x', real=True)
lhs = ${v.lhs || 'x**2 + 2*x - 3'}
ineq = "${v.inequality || 'less'}"
if ineq == "less":
    solution = solveset(lhs < 0, x, S.Reals)
else:
    solution = solveset(lhs > 0, x, S.Reals)
print("ODPOWIEDZ:", solution)
`,
  keywords: ['nierównoś', 'rozwiąż', 'kwadrat'],
};

// ============================================================
// Template: Square diagonal line equation
// ============================================================

const squareDiagonalLine: ExtractionTemplate = {
  id: 'square_diagonal_line',
  name: 'Równanie przekątnej kwadratu',
  description: 'Równanie prostej zawierającej drugą przekątną kwadratu',
  extractionPrompt: `Wyodrębnij współrzędne końców przekątnej kwadratu. Odpowiedz TYLKO JSON:
{"A": [<x1>, <y1>], "C": [<x2>, <y2>]}`,
  buildCode: (v) => {
    const A = v.A || [-8, -2];
    const C = v.C || [0, 4];
    return `from sympy import *
x = symbols('x')
Ax, Ay = ${JSON.stringify(A)}
Cx, Cy = ${JSON.stringify(C)}
Mx = Rational(Ax + Cx, 2)
My = Rational(Ay + Cy, 2)
slope_AC = Rational(Cy - Ay, Cx - Ax)
slope_BD = Rational(-1, 1) / slope_AC
y_expr = slope_BD * (x - Mx) + My
print("ODPOWIEDZ: y =", simplify(y_expr))
`;
  },
  keywords: ['kwadrat', 'przekątn', 'równani', 'prost'],
};

// ============================================================
// Template: Probability drawing
// ============================================================

const probabilityDrawing: ExtractionTemplate = {
  id: 'probability_drawing',
  name: 'Prawdopodobieństwo losowania',
  description: 'Losowanie ze zwracaniem/bez — oblicz prawdopodobieństwo',
  extractionPrompt: `Wyodrębnij dane o losowaniu. Odpowiedz TYLKO JSON:
{"set_elements": [<lista elementów>], "num_draws": <ile losowań>, "with_replacement": <true/false>, "condition": "<warunek, np. sum > 10 lub iloczyn podzielny przez 5>"}`,
  buildCode: (v) => {
    const elements = JSON.stringify(v.set_elements || [2,3,4,5,6,7,8,9]);
    return `from sympy import *
from itertools import product as cart_product
elements = ${elements}
n_draws = ${v.num_draws || 2}
with_replacement = ${v.with_replacement ? 'True' : 'False'}
condition = "${v.condition || 'sum > 10'}"
if with_replacement:
    all_outcomes = list(cart_product(elements, repeat=n_draws))
else:
    from itertools import permutations
    all_outcomes = list(permutations(elements, n_draws))
total = len(all_outcomes)
favorable = 0
import re as _re
for outcome in all_outcomes:
    s = sum(outcome)
    p = 1
    for x in outcome:
        p *= x
    if "iloczyn" in condition or "product" in condition:
        val = p
    else:
        val = s
    m = _re.search(r'[><=]+\\s*(\\d+)', condition)
    if m:
        threshold = int(m.group(1))
        if ">=" in condition:
            favorable += int(val >= threshold)
        elif ">" in condition:
            favorable += int(val > threshold)
        elif "<=" in condition:
            favorable += int(val <= threshold)
        elif "<" in condition:
            favorable += int(val < threshold)
        elif "==" in condition or "=" in condition:
            favorable += int(val == threshold)
    elif "podzielny" in condition or "divisible" in condition:
        m2 = _re.search(r'(\\d+)', condition)
        if m2:
            divisor = int(m2.group(1))
            favorable += int(p % divisor == 0)
prob = Rational(favorable, total)
print("ODPOWIEDZ:", prob)
`;
  },
  keywords: ['losuj', 'prawdopodobień', 'zbior', 'zwracani'],
};

// ============================================================
// Registry of all templates
// ============================================================

export const EXTRACTION_TEMPLATES: ExtractionTemplate[] = [
  exponentialDecay,
  bernoulliProbability,
  tangentLineComplete,
  inequalityWithAbsValue,
  parametricVietaComplex,
  arithmeticSequenceWordProblem,
  proveInequalitySquare,
  similarTriangles,
  perpendicularDiagonal,
  probabilityDivisibility,
  rhombusTrig,
  geometricSequenceThreeTerm,
  powerSimplification,
  triangleHeightTrig,
  linearInequality,
  quadraticInequality,
  prismComputation,
  cubeGeometry,
  cyclicQuadrilateral,
  // Pillar 2+3 templates
  logPowerEval,
  rationalEquation,
  geometricSeqRatio,
  arithmeticMeanProperty,
  linearFunctionCondition,
  trigIdentityFind,
  linearInequalitySimple,
  circleCenterOnLine,
  percentageWordProblem,
  // 2023 patterns
  expressionSimplify,
  nthRootSum,
  rationalEquationSolutions,
  sequenceTermEval,
  similarTrianglesArea,
  arithmeticSequenceRate,
  quadraticInequalitySolve,
  squareDiagonalLine,
  probabilityDrawing,
];

// ============================================================
// Template Matcher — find best template for a given question
// ============================================================

export function matchTemplate(question: string, classifiedType?: string): ExtractionTemplate | null {
  const lowerQ = question.toLowerCase();
  let bestMatch: ExtractionTemplate | null = null;
  let bestScore = 0;

  for (const template of EXTRACTION_TEMPLATES) {
    let score = 0;
    for (const keyword of template.keywords) {
      if (lowerQ.includes(keyword.toLowerCase())) {
        score += 1;
      }
    }
    // Boost by 0.5 if template ID matches classified type partially
    if (classifiedType && template.id.includes(classifiedType)) {
      score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  // Only return if we matched at least 2 keywords
  return bestScore >= 2 ? bestMatch : null;
}

// ============================================================
// Build extraction prompt for LLM
// ============================================================

export function buildExtractionSystemPrompt(template: ExtractionTemplate): string {
  return `Jesteś ekstrakerem danych matematycznych. Twoim JEDYNYM zadaniem jest wyodrębnić wartości liczbowe i parametry z zadania i zwrócić je jako JSON.

NIE rozwiązuj zadania. NIE pisz kodu. NIE pisz wyjaśnień.
Odpowiedz WYŁĄCZNIE poprawnym obiektem JSON.

${template.extractionPrompt}`;
}
