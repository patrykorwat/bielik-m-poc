/**
 * Deterministic Solvers — Build SymPy code from classified problem parameters.
 *
 * Each solver takes typed params and returns a complete SymPy code string.
 * The code is deterministic: same params → same code → same answer.
 * No LLM reasoning needed for code generation.
 */
import { ProblemType, } from './classifierTypes.js';
// ============================================================
// Helper: wrap code for MC option comparison
// ============================================================
function wrapForMC(coreCode, resultVar, mcOptions) {
    // Build per-option comparison with individual try/except for robustness
    const optionChecks = Object.entries(mcOptions).map(([letter, value]) => {
        return `try:
    _opt_${letter} = ${value}
    if _opt_${letter} is not None and _result is not None:
        try:
            if abs(float(N(_result)) - float(N(_opt_${letter}))) < 1e-6:
                print("ODPOWIEDZ: ${letter}")
                _found = True
        except:
            try:
                if simplify(_result - _opt_${letter}) == 0:
                    print("ODPOWIEDZ: ${letter}")
                    _found = True
            except:
                pass
except:
    pass`;
    }).join('\n');
    return `from sympy import *
x, y, z, m, n, k, t, a, b, c, d, q, r = symbols('x y z m n k t a b c d q r', real=True)

${coreCode}

# Compare with MC options
_result = ${resultVar}
_found = False
${optionChecks}
if not _found:
    print("ODPOWIEDZ:", _result)
`;
}
// ============================================================
// Individual Solvers
// ============================================================
function solveLimit(p) {
    const dir = p.direction ? `, '${p.direction}'` : '';
    return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
wynik = limit(expr, ${p.variable}, ${p.approach}${dir})
print("ODPOWIEDZ:", wynik)
`;
}
function solveDerivative(p) {
    const lines = [`from sympy import *`,
        `${p.variable} = symbols('${p.variable}', real=True)`,
        `f = ${p.expression}`];
    switch (p.task) {
        case 'derivative':
            lines.push(`fp = diff(f, ${p.variable})`);
            if (p.point) {
                lines.push(`wynik = fp.subs(${p.variable}, ${p.point})`);
            }
            else {
                lines.push(`wynik = fp`);
            }
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
        case 'tangent_line':
            lines.push(`fp = diff(f, ${p.variable})`);
            // If tangent_y_value is provided, solve f(x) = y_value first to find x0
            if (p.tangent_y_value) {
                lines.push(`y_target = ${p.tangent_y_value}`);
                lines.push(`x0_solutions = solve(Eq(f, y_target), ${p.variable})`);
                lines.push(`if isinstance(x0_solutions, list) and len(x0_solutions) > 0:`);
                lines.push(`    x0 = x0_solutions[0]`);
                lines.push(`else:`);
                lines.push(`    x0 = x0_solutions`);
            }
            else {
                lines.push(`x0 = ${p.tangent_point || p.point || '0'}`);
            }
            lines.push(`slope = fp.subs(${p.variable}, x0)`);
            lines.push(`y0 = f.subs(${p.variable}, x0)`);
            lines.push(`tangent = slope * (${p.variable} - x0) + y0`);
            lines.push(`print("ODPOWIEDZ:", expand(tangent))`);
            break;
        case 'extrema':
            lines.push(`fp = diff(f, ${p.variable})`);
            lines.push(`critical = solve(fp, ${p.variable})`);
            lines.push(`fpp = diff(fp, ${p.variable})`);
            lines.push(`for cp in critical:`);
            lines.push(`    val = fpp.subs(${p.variable}, cp)`);
            lines.push(`    fval = f.subs(${p.variable}, cp)`);
            lines.push(`    kind = "minimum" if val > 0 else ("maximum" if val < 0 else "inflection")`);
            lines.push(`    print(f"x={cp}: f(x)={fval} ({kind})")`);
            lines.push(`print("ODPOWIEDZ:", [(cp, f.subs(${p.variable}, cp)) for cp in critical])`);
            break;
        case 'monotonicity':
            lines.push(`fp = diff(f, ${p.variable})`);
            lines.push(`critical = solve(fp, ${p.variable})`);
            lines.push(`print("Punkty krytyczne:", critical)`);
            lines.push(`print("ODPOWIEDZ:", critical)`);
            break;
        default:
            // Default: compute derivative
            lines.push(`fp = diff(f, ${p.variable})`);
            if (p.point) {
                lines.push(`wynik = fp.subs(${p.variable}, ${p.point})`);
            }
            else {
                lines.push(`wynik = fp`);
            }
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
    }
    return lines.join('\n');
}
function solveTrigEquation(p) {
    const domainStart = p.domain_start || '0';
    const domainEnd = p.domain_end || '2*pi';
    return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
eq = ${p.equation}
solutions = solveset(eq, ${p.variable}, domain=Interval(${domainStart}, ${domainEnd}))
if solutions.is_FiniteSet:
    sorted_sol = sorted(list(solutions))
    print("ODPOWIEDZ:", sorted_sol)
else:
    print("ODPOWIEDZ:", solutions)
`;
}
function solvePolynomialRoots(p) {
    const lines = [`from sympy import *`,
        `${p.variable} = symbols('${p.variable}', real=True)`,
        `expr = ${p.expression}`];
    switch (p.task) {
        case 'roots':
            lines.push(`wynik = solve(expr, ${p.variable})`);
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
        case 'factorize':
            lines.push(`wynik = factor(expr)`);
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
        case 'evaluate':
            lines.push(`wynik = expr.subs(${p.variable}, ${p.eval_point})`);
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
        case 'remainder':
            lines.push(`q, rem = div(Poly(expr, ${p.variable}), Poly(${p.variable} - (${p.eval_point}), ${p.variable}))`);
            lines.push(`print("ODPOWIEDZ:", rem.as_expr())`);
            break;
        default:
            // Default: solve for roots
            lines.push(`wynik = solve(expr, ${p.variable})`);
            lines.push(`print("ODPOWIEDZ:", wynik)`);
            break;
    }
    return lines.join('\n');
}
function solveLogarithm(p) {
    switch (p.task) {
        case 'simplify':
        case 'evaluate':
            return `from sympy import *
wynik = simplify(${p.expression})
print("ODPOWIEDZ:", wynik)
`;
        case 'solve_equation':
            return `from sympy import *
${p.variable || 'x'} = symbols('${p.variable || 'x'}', positive=True)
eq = ${p.equation}
wynik = solve(eq, ${p.variable || 'x'})
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *\nprint("ODPOWIEDZ:", simplify(${p.expression}))`;
}
function solveProbability(p) {
    switch (p.type) {
        case 'bernoulli':
            return `from sympy import *
n, k_val, p_val = ${p.n}, ${p.k}, Rational(${p.p})
wynik = binomial(n, k_val) * p_val**k_val * (1 - p_val)**(n - k_val)
print("ODPOWIEDZ:", wynik)
`;
        case 'classical':
            return `from sympy import *
favorable = ${p.favorable_outcomes || '1'}
total = ${p.total_outcomes || '1'}
wynik = Rational(favorable, total)
print("ODPOWIEDZ:", wynik)
`;
        case 'conditional':
            return `from sympy import *
# ${p.description}
# P(A|B) = P(A ∩ B) / P(B)
# Setup from problem description
${p.favorable_outcomes ? `favorable = ${p.favorable_outcomes}` : '# Define favorable outcomes'}
${p.total_outcomes ? `total = ${p.total_outcomes}` : '# Define total outcomes'}
wynik = Rational(favorable, total)
print("ODPOWIEDZ:", wynik)
`;
        case 'geometric':
            return `from sympy import *
p_val = Rational(${p.p})
k_val = ${p.k}
wynik = (1 - p_val)**(k_val - 1) * p_val
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *\nprint("ODPOWIEDZ: TODO")`;
}
function solveCombinatorics(p) {
    if (p.expression) {
        return `from sympy import *
wynik = ${p.expression}
print("ODPOWIEDZ:", wynik)
`;
    }
    switch (p.type) {
        case 'combination':
            return `from sympy import *
wynik = binomial(${p.n}, ${p.k || '0'})
print("ODPOWIEDZ:", wynik)
`;
        case 'permutation':
            if (p.k) {
                return `from sympy import *
wynik = factorial(${p.n}) / factorial(${p.n} - ${p.k})
print("ODPOWIEDZ:", wynik)
`;
            }
            return `from sympy import *
wynik = factorial(${p.n})
print("ODPOWIEDZ:", wynik)
`;
        case 'variation':
            if (p.with_repetition) {
                return `from sympy import *
wynik = ${p.n}**${p.k || '1'}
print("ODPOWIEDZ:", wynik)
`;
            }
            return `from sympy import *
wynik = factorial(${p.n}) / factorial(${p.n} - ${p.k || '0'})
print("ODPOWIEDZ:", wynik)
`;
        case 'count':
            return `from sympy import *
wynik = ${p.expression || p.n}
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *\nprint("ODPOWIEDZ:", factorial(${p.n}))`;
}
function solveSequenceArithmetic(p) {
    // Use _a1, _d prefixed names to avoid collisions with SymPy global symbols
    const lines = [`from sympy import *`];
    lines.push(`_a1, _d = symbols('_a1 _d', real=True)`);
    // Handle conditions first (e.g. "a3 = 10", "a7 = 22")
    if (p.conditions && p.conditions.length > 0) {
        const eqs = [];
        for (const cond of p.conditions) {
            const match = cond.match(/a[_]?(\d+)\s*=\s*(.+)/);
            if (match) {
                const idx = match[1];
                const val = match[2].trim();
                eqs.push(`Eq(_a1 + (${idx} - 1)*_d, ${val})`);
            }
            else if (cond.includes('=')) {
                eqs.push(`Eq(${cond.replace('=', ',')})`);
            }
        }
        if (eqs.length > 0) {
            lines.push(`_rozw = solve([${eqs.join(', ')}], [_a1, _d])`);
            lines.push(`if isinstance(_rozw, dict):`);
            lines.push(`    _a1 = _rozw.get(Symbol('_a1'), _a1)`);
            lines.push(`    _d = _rozw.get(Symbol('_d'), _d)`);
            lines.push(`elif isinstance(_rozw, list) and len(_rozw) > 0:`);
            lines.push(`    _sol = _rozw[0] if isinstance(_rozw[0], (tuple, list)) else _rozw`);
            lines.push(`    if isinstance(_sol, (tuple, list)) and len(_sol) >= 2:`);
            lines.push(`        _a1, _d = _sol[0], _sol[1]`);
            lines.push(`    elif isinstance(_sol, dict):`);
            lines.push(`        _a1 = _sol.get(Symbol('_a1'), _a1)`);
            lines.push(`        _d = _sol.get(Symbol('_d'), _d)`);
        }
    }
    // Override with directly provided values
    if (p.a1)
        lines.push(`_a1 = ${p.a1}`);
    if (p.d)
        lines.push(`_d = ${p.d}`);
    // Set n
    if (p.n) {
        lines.push(`_n = ${p.n}`);
    }
    else {
        lines.push(`_n = symbols('_n', positive=True, integer=True)`);
    }
    switch (p.task) {
        case 'nth_term':
            lines.push(`wynik = _a1 + (_n - 1)*_d`);
            break;
        case 'sum':
            lines.push(`wynik = _n * (2*_a1 + (_n - 1)*_d) / 2`);
            break;
        case 'find_d':
            lines.push(`wynik = _d`);
            break;
        case 'find_a1':
            lines.push(`wynik = _a1`);
            break;
        case 'find_n':
            lines.push(`wynik = _n`);
            break;
        default:
            // Default: compute nth term
            lines.push(`wynik = _a1 + (_n - 1)*_d`);
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveSequenceGeometric(p) {
    // Use _a1, _q prefixed names to avoid collisions with SymPy global symbols
    const lines = [`from sympy import *`];
    lines.push(`_a1, _q = symbols('_a1 _q', positive=True)`);
    // Handle conditions first (e.g. "a2 = 6", "a5 = 162")
    if (p.conditions && p.conditions.length > 0) {
        const eqs = [];
        for (const cond of p.conditions) {
            const match = cond.match(/a[_]?(\d+)\s*=\s*(.+)/);
            if (match) {
                const idx = match[1];
                const val = match[2].trim();
                eqs.push(`Eq(_a1 * _q**(${idx} - 1), ${val})`);
            }
        }
        if (eqs.length > 0) {
            lines.push(`_rozw = solve([${eqs.join(', ')}], [_a1, _q])`);
            lines.push(`if isinstance(_rozw, dict):`);
            lines.push(`    _a1 = _rozw.get(Symbol('_a1'), _a1)`);
            lines.push(`    _q = _rozw.get(Symbol('_q'), _q)`);
            lines.push(`elif isinstance(_rozw, list) and len(_rozw) > 0:`);
            lines.push(`    _sol = _rozw[0] if isinstance(_rozw[0], (tuple, list)) else _rozw`);
            lines.push(`    if isinstance(_sol, (tuple, list)) and len(_sol) >= 2:`);
            lines.push(`        _a1, _q = _sol[0], _sol[1]`);
            lines.push(`    elif isinstance(_sol, dict):`);
            lines.push(`        _a1 = _sol.get(Symbol('_a1'), _a1)`);
            lines.push(`        _q = _sol.get(Symbol('_q'), _q)`);
        }
    }
    // Override with directly provided values
    if (p.a1)
        lines.push(`_a1 = ${p.a1}`);
    if (p.q)
        lines.push(`_q = ${p.q}`);
    // Set n
    if (p.n) {
        lines.push(`_n = ${p.n}`);
    }
    else {
        lines.push(`_n = symbols('_n', positive=True, integer=True)`);
    }
    switch (p.task) {
        case 'nth_term':
            lines.push(`wynik = _a1 * _q**(_n - 1)`);
            break;
        case 'sum':
            lines.push(`wynik = _a1 * (1 - _q**_n) / (1 - _q)`);
            break;
        case 'infinite_sum':
            lines.push(`wynik = _a1 / (1 - _q)`);
            break;
        case 'find_q':
            lines.push(`wynik = _q`);
            break;
        case 'find_a1':
            lines.push(`wynik = _a1`);
            break;
        case 'find_n':
            lines.push(`wynik = _n`);
            break;
        case 'decay_threshold':
            // Find first n where m(n) < threshold
            // m(n) = m0 * q^n
            // m0 * q^n < threshold → q^n < threshold/m0 → n > log(threshold/m0)/log(q)
            if (p.initial_value && p.threshold && p.q) {
                lines.push(`m0 = ${p.initial_value}`);
                lines.push(`_threshold = ${p.threshold}`);
                lines.push(`# m(n) = m0 * q^n`);
                lines.push(`# Solve m0 * q^n < threshold`);
                lines.push(`# q^n < threshold/m0 → n > log(threshold/m0)/log(q)`);
                lines.push(`_n_val = ceiling(log(_threshold / m0) / log(_q))`);
                lines.push(`wynik = _n_val`);
            }
            else {
                lines.push(`# decay_threshold requires initial_value, threshold, and q`);
                lines.push(`wynik = 0`);
            }
            break;
        default:
            // Default: compute nth term
            lines.push(`wynik = _a1 * _q**(_n - 1)`);
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveParametricEquation(p) {
    const x = p.variable;
    const m = p.parameter;
    // Handle equation with '=' (e.g. "x**2 + m*x + 4 = 0" → just use LHS)
    let equation = p.equation;
    if (equation.includes('=') && !equation.includes('==') && !equation.includes('!=') && !equation.includes('<=') && !equation.includes('>=')) {
        const parts = equation.split('=');
        equation = parts[0].trim();
        // If RHS is not 0, subtract it
        const rhs = parts[1]?.trim();
        if (rhs && rhs !== '0') {
            equation = `(${equation}) - (${rhs})`;
        }
    }
    const lines = [
        `from sympy import *`,
        `${x}, ${m} = symbols('${x} ${m}', real=True)`,
        `expr = ${equation}`,
        `poly = Poly(expr, ${x})`,
        `coeffs = poly.all_coeffs()`,
        `a_coeff = coeffs[0] if len(coeffs) > 2 else 1`,
        `b_coeff = coeffs[1] if len(coeffs) > 2 else coeffs[0]`,
        `c_coeff = coeffs[-1]`,
        `delta = b_coeff**2 - 4*a_coeff*c_coeff`,
    ];
    switch (p.condition) {
        case 'two_real_roots':
            lines.push(`wynik = solve(delta > 0, ${m})`);
            break;
        case 'one_real_root':
            lines.push(`wynik = solve(Eq(delta, 0), ${m})`);
            break;
        case 'no_real_roots':
            lines.push(`wynik = solve(delta < 0, ${m})`);
            break;
        case 'roots_positive':
            lines.push(`sum_roots = -b_coeff / a_coeff`);
            lines.push(`prod_roots = c_coeff / a_coeff`);
            lines.push(`cond1 = solve(delta >= 0, ${m})`);
            lines.push(`cond2 = solve(sum_roots > 0, ${m})`);
            lines.push(`cond3 = solve(prod_roots > 0, ${m})`);
            lines.push(`# Intersection of all conditions`);
            lines.push(`from sympy import Intersection, S`);
            lines.push(`s1 = solveset(delta >= 0, ${m}, S.Reals)`);
            lines.push(`s2 = solveset(sum_roots > 0, ${m}, S.Reals)`);
            lines.push(`s3 = solveset(prod_roots > 0, ${m}, S.Reals)`);
            lines.push(`wynik = Intersection(s1, s2, s3)`);
            break;
        case 'roots_negative':
            lines.push(`sum_roots = -b_coeff / a_coeff`);
            lines.push(`prod_roots = c_coeff / a_coeff`);
            lines.push(`s1 = solveset(delta >= 0, ${m}, S.Reals)`);
            lines.push(`s2 = solveset(sum_roots < 0, ${m}, S.Reals)`);
            lines.push(`s3 = solveset(prod_roots > 0, ${m}, S.Reals)`);
            lines.push(`wynik = Intersection(s1, s2, s3)`);
            break;
        case 'roots_opposite_sign':
            lines.push(`prod_roots = c_coeff / a_coeff`);
            lines.push(`wynik = solve(prod_roots < 0, ${m})`);
            break;
        case 'x1_equals_kx2':
            // x1 = k*x2, use Vieta's formulas
            // x1 + x2 = -b/a, x1*x2 = c/a
            // Substitute x1 = k*x2: k*x2 + x2 = -b/a → (k+1)*x2 = -b/a
            // k*x2*x2 = c/a → k*x2² = c/a
            // From these: x2² = c/(a*k), and (k+1)*sqrt(c/(a*k)) = -b/a
            // Or: k*x2² = c/a and (k+1)*x2 = -b/a
            // From second: x2 = -b/(a(k+1))
            // Substitute into first: k*(-b/(a(k+1)))² = c/a → k*b²/(a²(k+1)²) = c/a
            // k*b² = a*c*(k+1)² → k*b² = a*c*(k² + 2k + 1) → k*b² = a*c*k² + 2*a*c*k + a*c
            // a*c*k² + (2*a*c - b²)*k + a*c = 0
            const k = p.extra_value || '1';
            lines.push(`k_val = ${k}`);
            lines.push(`# x1 = k*x2, use Vieta's formulas`);
            lines.push(`# x1 + x2 = -b/a, x1*x2 = c/a`);
            lines.push(`# (k+1)*x2 = -b/a and k*x2² = c/a`);
            lines.push(`# From second: x2² = c/(a*k), substitute into first (indirectly)`);
            lines.push(`# Solve: a*c*k² + (2*a*c - b²)*k + a*c = 0`);
            lines.push(`vieta_eq = a_coeff*c_coeff*k_val**2 + (2*a_coeff*c_coeff - b_coeff**2)*k_val + a_coeff*c_coeff`);
            lines.push(`wynik = solve(vieta_eq, ${m})`);
            break;
        case 'x1_cubed_plus_x2_cubed':
            // x1³ + x2³ = (x1 + x2)³ - 3*x1*x2*(x1 + x2)
            // Use Vieta's formulas: x1+x2 = -b/a, x1*x2 = c/a
            lines.push(`sum_roots = -b_coeff / a_coeff`);
            lines.push(`prod_roots = c_coeff / a_coeff`);
            lines.push(`# x1³ + x2³ = (x1+x2)³ - 3*x1*x2*(x1+x2)`);
            lines.push(`x1_cubed_plus_x2_cubed = sum_roots**3 - 3*prod_roots*sum_roots`);
            lines.push(`# Extract condition from problem (this needs additional constraint)`);
            lines.push(`# For now, solve delta > 0 for real roots`);
            lines.push(`s1 = solveset(delta > 0, ${m}, S.Reals)`);
            lines.push(`wynik = s1`);
            break;
        case 'roots_sum':
            // Condition on sum of roots: x1 + x2 = -b/a
            lines.push(`sum_roots = -b_coeff / a_coeff`);
            lines.push(`# Default: sum > 0`);
            lines.push(`wynik = solve(sum_roots > 0, ${m})`);
            break;
        case 'roots_product':
            // Condition on product of roots: x1*x2 = c/a
            lines.push(`prod_roots = c_coeff / a_coeff`);
            lines.push(`# Default: product > 0`);
            lines.push(`wynik = solve(prod_roots > 0, ${m})`);
            break;
        default:
            // Custom condition — try to solve directly
            lines.push(`# Custom condition: ${p.condition}`);
            lines.push(`wynik = solve(${p.condition}, ${m})`);
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveSimplification(p) {
    const variable = p.variable || 'x';
    const lines = [`from sympy import *`];
    lines.push(`${variable} = symbols('${variable}', real=True)`);
    lines.push(`expr = ${p.expression}`);
    switch (p.task) {
        case 'simplify':
            lines.push(`wynik = simplify(expr)`);
            break;
        case 'evaluate':
            if (p.eval_point) {
                lines.push(`wynik = expr.subs(${variable}, ${p.eval_point})`);
            }
            else {
                lines.push(`wynik = simplify(expr)`);
            }
            break;
        case 'compare':
            lines.push(`wynik = expr`);
            break;
        default:
            // Default: simplify
            lines.push(`wynik = simplify(expr)`);
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function extractCoordsFromDescription(description) {
    const points = [];
    // Match patterns like A(1, 2), B(-3, 4), P(1/2, 3)
    const pattern = /([A-Z])\s*\(\s*(-?[\d./]+)\s*[,;]\s*(-?[\d./]+)\s*\)/g;
    let match;
    while ((match = pattern.exec(description)) !== null) {
        points.push({ name: match[1], x: match[2], y: match[3] });
    }
    return points;
}
function solveGeometryAnalytic(p) {
    const lines = [`from sympy import *`, `x, y = symbols('x y', real=True)`];
    // Define points — fallback to extracting from description if not provided
    let points = p.points;
    if ((!points || points.length === 0) && p.description) {
        points = extractCoordsFromDescription(p.description);
    }
    if (points) {
        for (const pt of points) {
            lines.push(`${pt.name} = Point(${pt.x}, ${pt.y})`);
        }
    }
    // Define lines
    if (p.lines) {
        for (const ln of p.lines) {
            lines.push(`${ln.name} = Line(${ln.equation})`);
        }
    }
    // Define circles
    if (p.circles) {
        for (const c of p.circles) {
            lines.push(`${c.name} = Circle(${c.equation})`);
        }
    }
    switch (p.task) {
        case 'distance':
            if (points && points.length >= 2) {
                lines.push(`wynik = ${points[0].name}.distance(${points[1].name})`);
            }
            break;
        case 'midpoint':
            if (points && points.length >= 2) {
                lines.push(`wynik = ${points[0].name}.midpoint(${points[1].name})`);
            }
            break;
        case 'line_equation':
            if (points && points.length >= 2) {
                lines.push(`line = Line(${points[0].name}, ${points[1].name})`);
                lines.push(`wynik = line.equation()`);
            }
            break;
        case 'circle':
        case 'tangent':
        case 'intersection':
        case 'perpendicular':
            // Use description-based approach for complex geometry
            lines.push(`# ${p.description}`);
            lines.push(`# Complex geometry — using description-driven approach`);
            if (p.description) {
                lines.push(`wynik = "See computation above"`);
            }
            break;
        default:
            // Default: try distance if 2+ points, else describe
            if (points && points.length >= 2) {
                lines.push(`wynik = ${points[0].name}.distance(${points[1].name})`);
            }
            else {
                lines.push(`wynik = "Nieobslugiwane zadanie geometryczne"`);
            }
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveGeometrySolid(p) {
    const lines = [`from sympy import *`];
    // Define known values as symbols or numbers
    const knownVars = Object.keys(p.known_values);
    if (knownVars.length > 0) {
        lines.push(`${knownVars.join(', ')} = symbols('${knownVars.join(' ')}', positive=True)`);
        for (const [k, v] of Object.entries(p.known_values)) {
            lines.push(`${k} = ${v}`);
        }
    }
    // Build formulas based on solid type
    switch (p.solid) {
        case 'prism':
            if (p.base === 'triangle') {
                lines.push(`# Prism with triangular base`);
                lines.push(`S_base = sqrt(3)/4 * a**2  # equilateral triangle`);
            }
            else if (p.base === 'hexagon') {
                lines.push(`# Prism with hexagonal base`);
                lines.push(`S_base = 3*sqrt(3)/2 * a**2`);
            }
            else if (p.base === 'square') {
                lines.push(`S_base = a**2`);
            }
            else if (p.base === 'rectangle') {
                lines.push(`S_base = a * b`);
            }
            else {
                lines.push(`S_base = a**2  # default square base`);
            }
            lines.push(`V = S_base * h`);
            lines.push(`S_lateral = Piecewise((3*a*h, Eq(S_base, sqrt(3)/4 * a**2)), (6*a*h, Eq(S_base, 3*sqrt(3)/2 * a**2)), (4*a*h, True))`);
            lines.push(`S_total = 2*S_base + S_lateral`);
            break;
        case 'pyramid':
            if (p.base === 'square') {
                lines.push(`S_base = a**2`);
            }
            else if (p.base === 'triangle') {
                lines.push(`S_base = sqrt(3)/4 * a**2`);
            }
            else {
                lines.push(`S_base = a**2`);
            }
            lines.push(`V = Rational(1, 3) * S_base * h`);
            break;
        case 'cylinder':
            lines.push(`V = pi * r**2 * h`);
            lines.push(`S_lateral = 2 * pi * r * h`);
            lines.push(`S_total = 2 * pi * r**2 + S_lateral`);
            break;
        case 'cone':
            lines.push(`l = sqrt(r**2 + h**2)  # slant height`);
            lines.push(`V = Rational(1, 3) * pi * r**2 * h`);
            lines.push(`S_lateral = pi * r * l`);
            lines.push(`S_total = pi * r**2 + S_lateral`);
            break;
        case 'sphere':
            lines.push(`V = Rational(4, 3) * pi * r**3`);
            lines.push(`S_total = 4 * pi * r**2`);
            break;
        default:
            lines.push(`# ${p.description}`);
            break;
    }
    // Solve for the requested quantity
    switch (p.task) {
        case 'volume':
            lines.push(`wynik = simplify(V)`);
            break;
        case 'surface_area':
            lines.push(`wynik = simplify(S_total)`);
            break;
        case 'edge_length':
        case 'height':
            lines.push(`# Solve for unknown from volume/surface equation`);
            lines.push(`wynik = V  # Override with actual solve if needed`);
            break;
        default:
            lines.push(`wynik = V`);
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveGeometryArea(p) {
    const lines = [`from sympy import *`];
    // Fallback: extract coordinates from description if not provided
    let coordinates = p.coordinates;
    if ((!coordinates || coordinates.length === 0) && p.description) {
        coordinates = extractCoordsFromDescription(p.description);
    }
    if (coordinates && coordinates.length > 0) {
        // Coordinate geometry approach
        const pts = [];
        for (const pt of coordinates) {
            lines.push(`${pt.name} = Point(${pt.x}, ${pt.y})`);
            pts.push(pt.name);
        }
        switch (p.task) {
            case 'area':
                if (pts.length === 3) {
                    lines.push(`triangle = Triangle(${pts.join(', ')})`);
                    lines.push(`wynik = triangle.area`);
                }
                else {
                    lines.push(`polygon = Polygon(${pts.join(', ')})`);
                    lines.push(`wynik = polygon.area`);
                }
                break;
            case 'perimeter':
                lines.push(`polygon = Polygon(${pts.join(', ')})`);
                lines.push(`wynik = polygon.perimeter`);
                break;
            default:
                lines.push(`wynik = Polygon(${pts.join(', ')}).area`);
        }
    }
    else {
        // Known values approach
        const knownVars = Object.keys(p.known_values);
        if (knownVars.length > 0) {
            lines.push(`${knownVars.join(', ')} = symbols('${knownVars.join(' ')}', positive=True)`);
            for (const [k, v] of Object.entries(p.known_values)) {
                lines.push(`${k} = ${v}`);
            }
        }
        lines.push(`# ${p.description}`);
        lines.push(`wynik = 0  # Compute from description`);
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
function solveOptimization(p) {
    const lines = [
        `from sympy import *`,
        `${p.variable} = symbols('${p.variable}', real=True)`,
        `f = ${p.function_expr}`,
        `fp = diff(f, ${p.variable})`,
        `critical = solve(fp, ${p.variable})`,
        `# Filter to domain`,
        `valid = []`,
        `for cp in critical:`,
        `    if cp.is_real:`,
    ];
    if (p.domain_start && p.domain_end) {
        lines.push(`        if ${p.domain_start} <= cp <= ${p.domain_end}:`);
    }
    else if (p.domain_start) {
        lines.push(`        if cp > ${p.domain_start}:`);
    }
    else if (p.domain_end) {
        lines.push(`        if cp < ${p.domain_end}:`);
    }
    else {
        lines.push(`        if True:`);
    }
    lines.push(`            valid.append(cp)`);
    lines.push(`# Evaluate at critical points and endpoints`);
    lines.push(`values = [(cp, f.subs(${p.variable}, cp)) for cp in valid]`);
    if (p.domain_start && p.domain_end) {
        lines.push(`values.append((${p.domain_start}, f.subs(${p.variable}, ${p.domain_start})))`);
        lines.push(`values.append((${p.domain_end}, f.subs(${p.variable}, ${p.domain_end})))`);
    }
    if (p.task === 'minimize') {
        lines.push(`best = min(values, key=lambda pair: pair[1])`);
    }
    else {
        lines.push(`best = max(values, key=lambda pair: pair[1])`);
    }
    lines.push(`print(f"${p.variable} = {best[0]}, f({best[0]}) = {best[1]}")`);
    lines.push(`print("ODPOWIEDZ:", best[1])`);
    return lines.join('\n');
}
function solveInequality(p) {
    const rhs = p.rhs || '0';
    switch (p.type) {
        case 'solve':
            return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
try:
    wynik = solve_univariate_inequality(expr ${p.relation} ${rhs}, ${p.variable}, relational=False)
except:
    try:
        wynik = reduce_inequalities(expr ${p.relation} ${rhs}, ${p.variable})
    except:
        try:
            wynik = solveset(expr ${p.relation} ${rhs}, ${p.variable}, S.Reals)
        except:
            wynik = solve(expr ${p.relation} ${rhs}, ${p.variable})
print("ODPOWIEDZ:", wynik)
`;
        case 'range':
            return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
try:
    wynik = solveset(${p.expression} ${p.relation} ${rhs}, ${p.variable}, S.Reals)
except:
    try:
        wynik = reduce_inequalities(${p.expression} ${p.relation} ${rhs}, ${p.variable})
    except:
        wynik = solve(${p.expression} ${p.relation} ${rhs}, ${p.variable})
print("ODPOWIEDZ:", wynik)
`;
        case 'prove':
            return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression} - (${rhs})
simplified = simplify(expr)
print("Uproszczone:", simplified)
print("ODPOWIEDZ:", simplified)
`;
    }
    return '';
}
function solveProof(p) {
    // Proofs are handled by fallback to old pipeline
    // But provide basic algebraic verification for identity proofs
    if (p.type === 'identity' && p.lhs && p.rhs) {
        const vars = p.variables?.join(', ') || 'x';
        return `from sympy import *
${vars} = symbols('${vars}', real=True)
lhs = ${p.lhs}
rhs = ${p.rhs}
diff_expr = simplify(lhs - rhs)
print("LHS - RHS =", diff_expr)
if diff_expr == 0:
    print("ODPOWIEDZ: Tozsamosc prawdziwa (LHS = RHS)")
else:
    print("ODPOWIEDZ: Roznica =", diff_expr)
`;
    }
    return `from sympy import *
# Proof task — requires step-by-step reasoning
# ${p.statement}
print("ODPOWIEDZ: Dowod wymaga rozumowania krok po kroku")
`;
}
function solveFunctionProperties(p) {
    const lines = [
        `from sympy import *`,
        `${p.variable} = symbols('${p.variable}', real=True)`,
        `f = ${p.expression}`,
    ];
    switch (p.task) {
        case 'domain':
            lines.push(`from sympy import S`);
            lines.push(`wynik = calculus_util.continuous_domain(f, ${p.variable}, S.Reals) if hasattr(calculus_util, 'continuous_domain') else solveset(1/f, ${p.variable}, S.Reals).complement(S.Reals)`);
            // Simpler approach
            lines.length -= 1;
            lines.push(`from sympy.calculus.util import continuous_domain`);
            lines.push(`wynik = continuous_domain(f, ${p.variable}, S.Reals)`);
            break;
        case 'range':
            lines.push(`from sympy.calculus.util import function_range`);
            lines.push(`wynik = function_range(f, ${p.variable}, S.Reals)`);
            break;
        case 'zeros':
            lines.push(`wynik = solve(f, ${p.variable})`);
            break;
        case 'monotonicity':
            lines.push(`fp = diff(f, ${p.variable})`);
            lines.push(`critical = solve(fp, ${p.variable})`);
            lines.push(`print("Punkty krytyczne:", critical)`);
            lines.push(`wynik = critical`);
            break;
        case 'parity':
            lines.push(`f_neg = f.subs(${p.variable}, -${p.variable})`);
            lines.push(`if simplify(f - f_neg) == 0:`);
            lines.push(`    wynik = "parzysta"`);
            lines.push(`elif simplify(f + f_neg) == 0:`);
            lines.push(`    wynik = "nieparzysta"`);
            lines.push(`else:`);
            lines.push(`    wynik = "ani parzysta, ani nieparzysta"`);
            break;
        case 'inverse':
            lines.push(`y = symbols('y', real=True)`);
            lines.push(`inv = solve(Eq(y, f), ${p.variable})`);
            lines.push(`wynik = inv`);
            break;
        case 'composition':
            if (p.composition_with) {
                lines.push(`g = ${p.composition_with}`);
                lines.push(`wynik = simplify(f.subs(${p.variable}, g))`);
            }
            break;
        default:
            // Default: simplify the expression
            lines.push(`wynik = simplify(f)`);
            break;
    }
    lines.push(`print("ODPOWIEDZ:", wynik)`);
    return lines.join('\n');
}
// ============================================================
// University-level Solvers
// ============================================================
function solveModularArithmetic(p) {
    const vars = (p.variables || ['x']).join(', ');
    const modRaw = p.modulus || p.field_size || '17';
    // Parse modulus: could be "17", "17^4", "17**4"
    const modMatch = String(modRaw).match(/^(\d+)(?:[\^*]{1,2}(\d+))?$/);
    const prime = modMatch ? modMatch[1] : modRaw;
    const modExp = modMatch?.[2] ? parseInt(modMatch[2]) : 1;
    const fieldSize = modExp > 1 ? `${prime}**${modExp}` : `${prime}`;
    const isBruteForceOK = Math.pow(parseInt(prime), modExp) <= 500;
    if (p.task === 'count_solutions' && p.equations?.length) {
        if (isBruteForceOK) {
            // Small field — brute-force is OK
            return `from sympy import *
${vars} = symbols('${vars}')
p = ${fieldSize}
count = 0
solutions = []
${p.variables && p.variables.length >= 2 ? `for _x in range(p):
    for _y in range(p):
        _vals = {${p.variables[0]}: _x, ${p.variables[1]}: _y}
        if all(int(eq.subs(_vals)) % ${prime} == 0 for eq in [${p.equations.join(', ')}]):
            count += 1
            solutions.append((_x, _y))` : `for _x in range(p):
    _vals = {${p.variables?.[0] || 'x'}: _x}
    if all(int(eq.subs(_vals)) % ${prime} == 0 for eq in [${p.equations.join(', ')}]):
        count += 1`}
wynik = count
print("ODPOWIEDZ:", wynik)
`;
        }
        // Large field — use Groebner basis mod p
        return `from sympy import *
${vars} = symbols('${vars}')
p = ${prime}
k = ${modExp}
q = p**k  # = ${fieldSize}

eqs = [${p.equations.join(', ')}]

# Use Groebner basis over GF(p) to solve symbolically
print("=== Groebner basis mod", p, "===")
try:
    G = groebner(eqs, [${vars}], modulus=p, order='lex')
    gb_polys = list(G)
    print("Baza Groebnera:", gb_polys)

    if len(gb_polys) == 1 and gb_polys[0] == 1:
        print("System sprzeczny → 0 rozwiazan w F_{" + str(q) + "}")
        wynik = 0
    elif len(gb_polys) == 0:
        wynik = q**${p.variables?.length || 1}
    else:
        # Count solutions via GCD with Frobenius polynomials
        solutions = solve(gb_polys, [${vars}])
        print("Rozwiazania:", solutions)
        wynik = len(solutions) if isinstance(solutions, list) else 1
except Exception as e:
    print(f"Blad: {e}")
    wynik = "blad"
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'euler_phi') {
        return `from sympy import *
wynik = totient(${fieldSize})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'find_order') {
        return `from sympy import *
from sympy.ntheory import n_order
${vars} = symbols('${vars}')
wynik = n_order(${p.equations?.[0] || '2'}, ${fieldSize})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'crt' && p.equations?.length) {
        // CRT equations come as pairs: "x ≡ r (mod m)" or as "r, m" strings
        // We parse them from the equations array
        return `from sympy import *
from sympy.ntheory.modular import crt
import re

# Parse congruences from equations
remainders = []
moduli = []
raw_eqs = ${JSON.stringify(p.equations)}
for eq_str in raw_eqs:
    # Try pattern: "x ≡ r (mod m)" or "x = r mod m" or "r, m"
    m1 = re.search(r'(\\d+)\\s*(?:mod|%)\\s*(\\d+)', eq_str)
    m2 = re.search(r'(\\d+)\\s*,\\s*(\\d+)', eq_str)
    if m1:
        remainders.append(int(m1.group(1)))
        moduli.append(int(m1.group(2)))
    elif m2:
        remainders.append(int(m2.group(1)))
        moduli.append(int(m2.group(2)))
    else:
        print(f"Nie rozpoznano: {eq_str}")

if moduli and remainders:
    result = crt(moduli, remainders)
    if result is not None:
        wynik = f"x ≡ {result[0]} (mod {result[1]})"
    else:
        wynik = "CRT nie ma rozwiazania (moduly nie sa parami wzglednie pierwsze)"
else:
    wynik = "Brak danych do CRT"
print("ODPOWIEDZ:", wynik)
`;
    }
    // Generic: try to solve congruence
    if (p.equations?.length) {
        return `from sympy import *
${vars} = symbols('${vars}')
p = ${prime}
eqs = [${p.equations.join(', ')}]
# Brute force over F_p
solutions = []
for _x in range(p):
    vals = {${p.variables?.[0] || 'x'}: _x}
    if all((eq.subs(vals)) % p == 0 for eq in eqs):
        solutions.append(_x)
wynik = solutions
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO - modular arithmetic")
`;
}
function solveNumberTheory(p) {
    if (p.task === 'gcd' && p.numbers?.length) {
        return `from sympy import *
wynik = gcd(${p.numbers.join(', ')})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'lcm' && p.numbers?.length) {
        return `from sympy import *
wynik = lcm(${p.numbers.join(', ')})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'factorize' && p.numbers?.length) {
        return `from sympy import *
wynik = factorint(${p.numbers[0]})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'diophantine' && p.equation) {
        return `from sympy import *
${(p.variables || ['x', 'y']).join(', ')} = symbols('${(p.variables || ['x', 'y']).join(' ')}', integer=True)
eq = ${p.equation}
wynik = diophantine(eq)
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'euler_phi' && p.numbers?.length) {
        return `from sympy import *
wynik = totient(${p.numbers[0]})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'divisors' && p.numbers?.length) {
        return `from sympy import *
wynik = divisors(${p.numbers[0]})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'legendre_symbol' && p.numbers?.length && p.numbers.length >= 2) {
        return `from sympy import *
from sympy.ntheory import legendre_symbol
wynik = legendre_symbol(${p.numbers[0]}, ${p.numbers[1]})
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO - number theory")
`;
}
function solveLinearAlgebra(p) {
    const vars = (p.variables || ['x', 'y', 'z']).join(', ');
    if (p.task === 'determinant' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.det()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'inverse' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.inv()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'eigenvalues' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.eigenvals()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'eigenvectors' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.eigenvects()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'rank' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.rank()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'rref' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.rref()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'nullspace' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
wynik = M.nullspace()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'characteristic_polynomial' && p.matrix) {
        return `from sympy import *
lam = symbols('lambda')
M = ${p.matrix}
wynik = M.charpoly(lam)
print("ODPOWIEDZ:", wynik.as_expr())
`;
    }
    if (p.task === 'diagonalize' && p.matrix) {
        return `from sympy import *
M = ${p.matrix}
try:
    P, D = M.diagonalize()
    print("P =", P)
    print("D =", D)
    wynik = (P, D)
except Exception as e:
    print("Macierz nie jest diagonalizowalna:", e)
    wynik = None
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'solve_system' && p.system_equations?.length) {
        return `from sympy import *
${vars} = symbols('${vars}')
eqs = [${p.system_equations.join(', ')}]
wynik = solve(eqs, [${vars}])
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO - linear algebra")
`;
}
function solveIntegral(p) {
    if (p.task === 'definite' && p.lower_bound && p.upper_bound) {
        return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
wynik = integrate(expr, (${p.variable}, ${p.lower_bound}, ${p.upper_bound}))
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'improper' && p.lower_bound && p.upper_bound) {
        return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
wynik = integrate(expr, (${p.variable}, ${p.lower_bound}, ${p.upper_bound}))
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'double') {
        // Double integral needs two sets of bounds — use params if available
        const innerVar = p.variable || 'x';
        const outerVar = p.outer_variable || (innerVar === 'x' ? 'y' : 'x');
        return `from sympy import *
${innerVar}, ${outerVar} = symbols('${innerVar} ${outerVar}', real=True)
expr = ${p.expression}
wynik = integrate(expr, (${innerVar}, ${p.lower_bound || '0'}, ${p.upper_bound || '1'}), (${outerVar}, ${p.outer_lower || '0'}, ${p.outer_upper || '1'}))
print("ODPOWIEDZ:", wynik)
`;
    }
    // Default: indefinite integral
    return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
wynik = integrate(expr, ${p.variable})
print("ODPOWIEDZ:", wynik)
`;
}
function solveDifferentialEquation(p) {
    const fn = p.function_name || 'f';
    const v = p.variable || 'x';
    let code = `from sympy import *
${v} = symbols('${v}', real=True)
${fn} = Function('${fn}')
eq = Eq(${p.equation}, 0)
`;
    if (p.task === 'particular_solution' && p.initial_conditions) {
        const ics = [];
        for (const [key, val] of Object.entries(p.initial_conditions)) {
            ics.push(`${key}: ${val}`);
        }
        code += `ics = {${ics.join(', ')}}
wynik = dsolve(eq, ${fn}(${v}), ics=ics)
`;
    }
    else {
        code += `wynik = dsolve(eq, ${fn}(${v}))
`;
    }
    code += `print("ODPOWIEDZ:", wynik)
`;
    return code;
}
function solveSeries(p) {
    const v = p.variable || 'n';
    if (p.task === 'convergence' || p.task === 'sum') {
        return `from sympy import *
${v} = symbols('${v}', positive=True, integer=True)
expr = ${p.expression}
# Try to compute the sum directly
s = summation(expr, (${v}, 1, oo))
if s.is_number and s.is_finite:
    print("Szereg zbiezny, suma =", s)
    wynik = s
elif s == oo or s == -oo or s is S.NaN:
    print("Szereg rozbiezny")
    wynik = "rozbiezny"
else:
    # summation returned unevaluated — use ratio test (d'Alembert)
    a_n = expr
    a_n1 = expr.subs(${v}, ${v}+1)
    L = limit(abs(a_n1 / a_n), ${v}, oo)
    print("Test d'Alemberta: L =", L)
    if L.is_number:
        if L < 1:
            print("L < 1 → zbiezny bezwzglednie")
            wynik = "zbiezny (L=" + str(L) + ")"
        elif L > 1:
            print("L > 1 → rozbiezny")
            wynik = "rozbiezny"
        else:
            print("L = 1 → test nierozstrzygajacy")
            wynik = "nierozstrzygajacy (L=1)"
    else:
        wynik = s  # return the symbolic form
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'taylor') {
        return `from sympy import *
x = symbols('x', real=True)
expr = ${p.expression}
wynik = series(expr, x, ${p.point || '0'}, ${p.n_terms || 6})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'partial_sum') {
        return `from sympy import *
${v} = symbols('${v}', positive=True, integer=True)
expr = ${p.expression}
wynik = summation(expr, (${v}, 1, ${p.n_terms || 'n'}))
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'radius') {
        return `from sympy import *
${v} = symbols('${v}', positive=True, integer=True)
x = symbols('x')
a_n = ${p.expression}
ratio = simplify(abs(a_n.subs(${v}, ${v}+1) / a_n))
L = limit(ratio, ${v}, oo)
R = 1/L if L != 0 else oo
wynik = R
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
${v} = symbols('${v}', positive=True, integer=True)
expr = ${p.expression}
wynik = summation(expr, (${v}, 1, oo))
print("ODPOWIEDZ:", wynik)
`;
}
function solveGroupTheory(p) {
    // SymPy.combinatorics handles permutation groups.
    // For abstract groups (Z/nZ, direct products, etc.) we use number-theoretic approach.
    // Detect if this is a cyclic/abstract group reference (e.g., "Z/12Z", "Z_12", "C_12")
    const isAbstract = p.group && /^[ZC][\/_]?\d+|^\d+$/.test(p.group.replace(/\s/g, ''));
    if (isAbstract || !p.group) {
        // Abstract group — number-theoretic approach
        const n = p.group ? p.group.replace(/[^0-9]/g, '') : '1';
        if (p.task === 'order') {
            return `from sympy import *
n = ${n}
wynik = n
print("ODPOWIEDZ:", wynik)
`;
        }
        if (p.task === 'is_cyclic') {
            return `from sympy import *
n = ${n}
# Z/nZ is always cyclic
wynik = True
print("ODPOWIEDZ:", wynik)
`;
        }
        if (p.task === 'subgroups') {
            return `from sympy import *
n = ${n}
# Subgroups of Z/nZ correspond to divisors of n
divs = divisors(n)
wynik = len(divs)
print("Podgrupy Z/" + str(n) + "Z:", [f"Z/{n//d}Z (rzad {n//d})" for d in divs])
print("ODPOWIEDZ:", wynik)
`;
        }
        if (p.task === 'generators') {
            return `from sympy import *
from sympy.ntheory import totient
n = ${n}
# Generators of Z/nZ are elements coprime with n
gens = [k for k in range(1, n) if gcd(k, n) == 1]
wynik = gens
print("Generatory Z/" + str(n) + "Z:", gens)
print("Phi(" + str(n) + ") =", totient(n))
print("ODPOWIEDZ:", wynik)
`;
        }
        return `from sympy import *
n = ${n}
# ${p.description}
print("ODPOWIEDZ: TODO - abstract group")
`;
    }
    // Permutation group — use SymPy combinatorics
    if (p.task === 'order') {
        return `from sympy.combinatorics import *
G = ${p.group}
wynik = G.order()
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'is_cyclic') {
        return `from sympy.combinatorics import *
G = ${p.group}
wynik = G.is_cyclic
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'subgroups') {
        return `from sympy.combinatorics import *
G = ${p.group}
subs = list(G.subgroups())
wynik = len(subs)
print("Liczba podgrup:", wynik)
for s in subs[:20]:
    print(" -", s.order())
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'generators') {
        return `from sympy.combinatorics import *
G = ${p.group}
wynik = G.generators
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy.combinatorics import *
# ${p.description}
print("ODPOWIEDZ: TODO - group theory")
`;
}
function solveComplexAnalysis(p) {
    const v = p.variable || 'z';
    if (p.task === 'residue' && p.point) {
        return `from sympy import *
${v} = symbols('${v}')
expr = ${p.expression}
wynik = residue(expr, ${v}, ${p.point})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'poles') {
        return `from sympy import *
${v} = symbols('${v}')
expr = ${p.expression}
# Find poles (zeros of denominator)
num, den = fraction(expr)
wynik = solve(den, ${v})
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'laurent') {
        return `from sympy import *
${v} = symbols('${v}')
expr = ${p.expression}
wynik = series(expr, ${v}, ${p.point || '0'}, 6)
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'contour_integral') {
        const radius = p.contour_radius || '10';
        return `from sympy import *
${v} = symbols('${v}')
expr = ${p.expression}
# Residue theorem: contour integral = 2*pi*i * sum(residues inside contour)
num, den = fraction(expr)
_poles = solve(den, ${v})
print("Bieguny:", _poles)
_radius = ${radius}
_total_res = 0
for _pole in _poles:
    try:
        if abs(complex(_pole)) < _radius:
            r = residue(expr, ${v}, _pole)
            print(f"  Residuum w {_pole}: {r}")
            _total_res += r
    except (TypeError, ValueError):
        # Symbolic pole — include it
        r = residue(expr, ${v}, _pole)
        print(f"  Residuum w {_pole}: {r}")
        _total_res += r
wynik = 2 * pi * I * _total_res
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
${v} = symbols('${v}')
# ${p.expression}
print("ODPOWIEDZ: TODO - complex analysis")
`;
}
function solveAlgebraicGeometry(p) {
    const vars = p.variables.join(', ');
    const field = p.field || 'QQ';
    // Parse field: GF(p), GF(p^k), GF(p**k), GF(p^k) etc.
    const fieldMatch = field.match(/GF\((\d+)(?:[\^*]{1,2}(\d+))?\)/);
    const prime = fieldMatch ? fieldMatch[1] : null;
    const fieldExp = fieldMatch?.[2] ? parseInt(fieldMatch[2]) : 1;
    const isFiniteField = !!prime;
    if (isFiniteField && p.equations.length >= 1) {
        const primeInt = parseInt(prime);
        const q = Math.pow(primeInt, fieldExp);
        const isBruteForceOK = q <= 500; // only brute-force for small fields
        if (isBruteForceOK && p.variables.length === 2) {
            // Small field — direct brute-force over F_{p^k}
            if (fieldExp === 1) {
                return `from sympy import *
${vars} = symbols('${vars}')
p = ${prime}
eqs = [${p.equations.join(', ')}]
count = 0
solutions = []
for _x in range(p):
    for _y in range(p):
        _vals = {${p.variables[0]}: _x, ${p.variables[1]}: _y}
        if all(int(eq.subs(_vals)) % p == 0 for eq in eqs):
            count += 1
            solutions.append((_x, _y))
print("Rozwiazania:", solutions)
wynik = count
print("ODPOWIEDZ:", wynik)
`;
            }
            else {
                // Small extension field F_{p^k} — use Groebner + Frobenius approach
                // NOTE: F_{p^k} is NOT Z/p^kZ! Elements are polynomials over F_p.
                // Correct approach: Groebner basis mod p with Frobenius constraints x^q - x = 0
                // This restricts solutions to exactly the elements of F_{p^k}.
                return `from sympy import *
${vars} = symbols('${vars}')
_p = ${prime}
_k = ${fieldExp}
_q = _p**_k  # = ${q}
eqs = [${p.equations.join(', ')}]

# Groebner basis mod p + Frobenius constraints (x^q = x for all x in F_q)
frobenius = [v**_q - v for v in [${vars}]]
full_system = eqs + frobenius
try:
    G = groebner(full_system, [${vars}], modulus=_p, order='lex')
    gb = list(G)
    print("Groebner + Frobenius:", gb)
    if len(gb) == 1 and gb[0] == 1:
        wynik = 0
    elif len(gb) == 0:
        wynik = _q**${p.variables.length}
    else:
        # Count roots of last (univariate) poly via gcd with x^q - x
        last = gb[-1]
        free = sorted(last.free_symbols, key=str)
        if len(free) == 1:
            v = free[0]
            g = gcd(Poly(last, v, modulus=_p), Poly(v**_q - v, v, modulus=_p))
            wynik = degree(g)
        else:
            solutions = solve(gb, [${vars}])
            wynik = len(solutions) if isinstance(solutions, list) else 1
except Exception as e:
    print(f"Error: {e}")
    wynik = "error"
print("ODPOWIEDZ:", wynik)
`;
            }
        }
        // Large field or many variables — Groebner basis mod p + Frobenius
        // Mathematically correct approach:
        //   1. Groebner basis of {eqs} ∪ {x^q - x : x ∈ vars} over F_p[vars]
        //   2. If basis = [1], system inconsistent over ALL extensions → 0 solutions
        //   3. Otherwise, count roots via gcd with x^q - x for univariate remainder
        // NOTE: For very large q (like 17^4 = 83521), computing x^q - x as a dense
        // polynomial is expensive. We first check if basis = [1] WITHOUT Frobenius
        // (inconsistent over F_p ⟹ inconsistent over F_{p^k}), which is cheap.
        return `from sympy import *
${vars} = symbols('${vars}')
_p = ${prime}
_k = ${fieldExp}
_q = _p**_k  # = ${prime}^${fieldExp}

eqs = [${p.equations.join(', ')}]

print("=== Algebraic Geometry over F_{" + str(_q) + "} ===")

# Step 1: Quick check — Groebner basis mod p WITHOUT Frobenius
# If inconsistent here, it's inconsistent over any extension
try:
    G = groebner(eqs, [${vars}], modulus=_p, order='lex')
    gb = list(G)
    print("Groebner mod", _p, ":", gb)

    if len(gb) == 1 and gb[0] == 1:
        print("System sprzeczny nad F_p → sprzeczny nad F_{p^k}")
        wynik = 0
    elif len(gb) == 0:
        # Empty basis: all points are solutions
        wynik = _q**${p.variables.length}
    else:
        # Step 2: Need Frobenius constraints for exact F_{p^k} count
        # For large q, x^q - x is degree q polynomial — too expensive to compute densely.
        # Instead, for each univariate factor, use modular exponentiation.
        # SymPy's Poly with modulus handles this via repeated squaring.
        print("Adding Frobenius constraints x^q - x = 0...")
        frobenius = [v**_q - v for v in [${vars}]]
        full_system = list(gb) + frobenius
        try:
            G2 = groebner(full_system, [${vars}], modulus=_p, order='lex')
            gb2 = list(G2)
            print("Groebner + Frobenius:", gb2[:5], "..." if len(gb2) > 5 else "")

            if len(gb2) == 1 and gb2[0] == 1:
                wynik = 0
            elif len(gb2) == 0:
                wynik = _q**${p.variables.length}
            else:
                # Last poly should be univariate — count its F_q roots
                last = gb2[-1]
                free = sorted(last.free_symbols, key=str)
                if len(free) == 1:
                    v = free[0]
                    g = gcd(Poly(last, v, modulus=_p), Poly(v**_q - v, v, modulus=_p))
                    wynik = degree(g)
                    print(f"Roots in F_q: degree(gcd) = {wynik}")
                else:
                    solutions = solve(gb2, [${vars}])
                    wynik = len(solutions) if isinstance(solutions, list) else 1
        except Exception as e2:
            print(f"Frobenius step failed: {e2}")
            # Fallback: just use basis without Frobenius
            solutions = solve(gb, [${vars}])
            wynik = len(solutions) if isinstance(solutions, list) else "unknown"
except Exception as e:
    print(f"Groebner error: {e}")
    wynik = "error"

print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'intersection' && p.equations.length >= 2) {
        return `from sympy import *
${vars} = symbols('${vars}')
eqs = [${p.equations.join(', ')}]
wynik = solve(eqs, [${vars}])
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.task === 'degree') {
        return `from sympy import *
${vars} = symbols('${vars}')
expr = ${p.equations[0]}
wynik = degree(Poly(expr, ${vars}))
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
${vars} = symbols('${vars}')
# ${p.description}
print("ODPOWIEDZ: TODO - algebraic geometry")
`;
}
function solveGraphTheory(p) {
    // Graph theory in SymPy is limited — use networkx-style approach with sympy.combinatorics
    if (p.adjacency_matrix) {
        return `from sympy import *
M = ${p.adjacency_matrix}
# Analyze adjacency matrix
n = M.shape[0]
print("Vertices:", n)
print("Edges:", sum(M[i,j] for i in range(n) for j in range(i+1, n)))
wynik = M
print("ODPOWIEDZ:", wynik)
`;
    }
    if (p.edges?.length && p.vertices) {
        return `from sympy import *
# Graph with ${p.vertices} vertices and edges ${p.edges.join(', ')}
vertices = ${p.vertices}
edges = [${p.edges.join(', ')}]
# Build adjacency
adj = {i: set() for i in range(vertices)}
for (u, v) in edges:
    adj[u].add(v)
    adj[v].add(u)
degrees = {v: len(adj[v]) for v in range(vertices)}
print("Degrees:", degrees)
# ${p.task}
wynik = degrees
print("ODPOWIEDZ:", wynik)
`;
    }
    return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO - graph theory")
`;
}
function extractMathExpr(description) {
    // Strip Polish question words and extract the math part
    const stripped = description
        .replace(/ile\s+(to|wynosi|jest)/gi, '')
        .replace(/oblicz|wylicz|co\s+to\s+jest|jaki\s+jest\s+wynik/gi, '')
        .trim();
    // Match a standalone math expression: digits, operators, parens, dots
    const m = stripped.match(/^[\d\s+\-*/^().]+$/);
    if (m) {
        const expr = m[0].trim().replace(/\^/g, '**');
        if (/\d/.test(expr) && /[+\-*/]/.test(expr))
            return expr;
    }
    return null;
}
function solveGeneral(p) {
    if (p.sympy_code) {
        return p.sympy_code;
    }
    if (p.expression) {
        return `from sympy import *
x = symbols('x', real=True)
wynik = simplify(${p.expression})
print("ODPOWIEDZ:", wynik)
`;
    }
    const mathExpr = extractMathExpr(p.description || '');
    if (mathExpr) {
        return `from sympy import *
try:
    wynik = sympify("${mathExpr}")
    print("ODPOWIEDZ:", wynik)
except Exception as e:
    print("ODPOWIEDZ: TODO")
`;
    }
    return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO")
`;
}
// ============================================================
// Main Router
// ============================================================
export function buildSolverCode(classification) {
    const { type, params, isMultipleChoice, mcOptions, rawQuestion } = classification;
    // Enrich geometry params with rawQuestion for coordinate extraction fallback
    if (type === ProblemType.GEOMETRY_ANALYTIC || type === ProblemType.GEOMETRY_AREA) {
        const geoParams = params;
        if (!geoParams.description || geoParams.description.length < 20) {
            geoParams.description = rawQuestion;
        }
    }
    // Build core code first
    let coreCode;
    switch (type) {
        case ProblemType.LIMIT:
            coreCode = solveLimit(params);
            break;
        case ProblemType.DERIVATIVE:
            coreCode = solveDerivative(params);
            break;
        case ProblemType.TRIG_EQUATION:
            coreCode = solveTrigEquation(params);
            break;
        case ProblemType.POLYNOMIAL_ROOTS:
            coreCode = solvePolynomialRoots(params);
            break;
        case ProblemType.LOGARITHM:
            coreCode = solveLogarithm(params);
            break;
        case ProblemType.PROBABILITY:
            coreCode = solveProbability(params);
            break;
        case ProblemType.COMBINATORICS:
            coreCode = solveCombinatorics(params);
            break;
        case ProblemType.SEQUENCE_ARITHMETIC:
            coreCode = solveSequenceArithmetic(params);
            break;
        case ProblemType.SEQUENCE_GEOMETRIC:
            coreCode = solveSequenceGeometric(params);
            break;
        case ProblemType.PARAMETRIC_EQUATION:
            coreCode = solveParametricEquation(params);
            break;
        case ProblemType.GEOMETRY_ANALYTIC:
            coreCode = solveGeometryAnalytic(params);
            break;
        case ProblemType.GEOMETRY_SOLID:
            coreCode = solveGeometrySolid(params);
            break;
        case ProblemType.GEOMETRY_AREA:
            coreCode = solveGeometryArea(params);
            break;
        case ProblemType.OPTIMIZATION:
            coreCode = solveOptimization(params);
            break;
        case ProblemType.INEQUALITY:
            coreCode = solveInequality(params);
            break;
        case ProblemType.PROOF:
            coreCode = solveProof(params);
            break;
        case ProblemType.FUNCTION_PROPERTIES:
            coreCode = solveFunctionProperties(params);
            break;
        case ProblemType.SIMPLIFICATION:
            coreCode = solveSimplification(params);
            break;
        // University-level
        case ProblemType.MODULAR_ARITHMETIC:
            coreCode = solveModularArithmetic(params);
            break;
        case ProblemType.NUMBER_THEORY:
            coreCode = solveNumberTheory(params);
            break;
        case ProblemType.LINEAR_ALGEBRA:
            coreCode = solveLinearAlgebra(params);
            break;
        case ProblemType.INTEGRAL:
            coreCode = solveIntegral(params);
            break;
        case ProblemType.DIFFERENTIAL_EQUATION:
            coreCode = solveDifferentialEquation(params);
            break;
        case ProblemType.SERIES:
            coreCode = solveSeries(params);
            break;
        case ProblemType.GROUP_THEORY:
            coreCode = solveGroupTheory(params);
            break;
        case ProblemType.COMPLEX_ANALYSIS:
            coreCode = solveComplexAnalysis(params);
            break;
        case ProblemType.ALGEBRAIC_GEOMETRY:
            coreCode = solveAlgebraicGeometry(params);
            break;
        case ProblemType.GRAPH_THEORY:
            coreCode = solveGraphTheory(params);
            break;
        case ProblemType.TOPOLOGY:
            // Topology problems are too abstract for deterministic solving — fall through to general
            coreCode = solveGeneral(params);
            break;
        case ProblemType.GENERAL:
        default:
            coreCode = solveGeneral(params);
            break;
    }
    // If MC, wrap with option comparison
    if (isMultipleChoice && mcOptions) {
        // Extract the result variable name (the one after "wynik = " or before print)
        // Strip the core code of its import and print lines, keep the computation
        const coreLines = coreCode.split('\n').filter(l => !l.startsWith('from sympy') && !l.startsWith('print(') && l.trim() !== '');
        return wrapForMC(coreLines.join('\n'), 'wynik', mcOptions);
    }
    return coreCode;
}
// ============================================================
// Exports for testing
// ============================================================
export { solveLimit, solveDerivative, solveTrigEquation, solvePolynomialRoots, solveLogarithm, solveProbability, solveCombinatorics, solveSequenceArithmetic, solveSequenceGeometric, solveParametricEquation, solveSimplification, solveGeometryAnalytic, solveGeometrySolid, solveGeometryArea, solveOptimization, solveInequality, solveProof, solveFunctionProperties, solveGeneral, 
// University-level
solveModularArithmetic, solveNumberTheory, solveLinearAlgebra, solveIntegral, solveDifferentialEquation, solveSeries, solveGroupTheory, solveComplexAnalysis, solveAlgebraicGeometry, solveGraphTheory, wrapForMC, };
