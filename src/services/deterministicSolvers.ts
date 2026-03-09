/**
 * Deterministic Solvers — Build SymPy code from classified problem parameters.
 *
 * Each solver takes typed params and returns a complete SymPy code string.
 * The code is deterministic: same params → same code → same answer.
 * No LLM reasoning needed for code generation.
 */

import {
  ProblemType,
  ClassificationResult,
  LimitParams,
  DerivativeParams,
  TrigEquationParams,
  PolynomialRootsParams,
  LogarithmParams,
  ProbabilityParams,
  CombinatoricsParams,
  SequenceArithmeticParams,
  SequenceGeometricParams,
  ParametricEquationParams,
  GeometryAnalyticParams,
  GeometrySolidParams,
  GeometryAreaParams,
  OptimizationParams,
  InequalityParams,
  ProofParams,
  FunctionPropertiesParams,
  SimplificationParams,
  GeneralParams,
} from './classifierTypes.js';

// ============================================================
// Helper: wrap code for MC option comparison
// ============================================================

function wrapForMC(coreCode: string, resultVar: string, mcOptions: { A: string; B: string; C: string; D: string }): string {
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

function solveLimit(p: LimitParams): string {
  const dir = p.direction ? `, '${p.direction}'` : '';
  return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
expr = ${p.expression}
wynik = limit(expr, ${p.variable}, ${p.approach}${dir})
print("ODPOWIEDZ:", wynik)
`;
}

function solveDerivative(p: DerivativeParams): string {
  const lines = [`from sympy import *`,
    `${p.variable} = symbols('${p.variable}', real=True)`,
    `f = ${p.expression}`];

  switch (p.task) {
    case 'derivative':
      lines.push(`fp = diff(f, ${p.variable})`);
      if (p.point) {
        lines.push(`wynik = fp.subs(${p.variable}, ${p.point})`);
      } else {
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
      } else {
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
  }
  return lines.join('\n');
}

function solveTrigEquation(p: TrigEquationParams): string {
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

function solvePolynomialRoots(p: PolynomialRootsParams): string {
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
  }
  return lines.join('\n');
}

function solveLogarithm(p: LogarithmParams): string {
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

function solveProbability(p: ProbabilityParams): string {
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

function solveCombinatorics(p: CombinatoricsParams): string {
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

function solveSequenceArithmetic(p: SequenceArithmeticParams): string {
  // Use _a1, _d prefixed names to avoid collisions with SymPy global symbols
  const lines = [`from sympy import *`];
  lines.push(`_a1, _d = symbols('_a1 _d', real=True)`);

  // Handle conditions first (e.g. "a3 = 10", "a7 = 22")
  if (p.conditions && p.conditions.length > 0) {
    const eqs: string[] = [];
    for (const cond of p.conditions) {
      const match = cond.match(/a[_]?(\d+)\s*=\s*(.+)/);
      if (match) {
        const idx = match[1];
        const val = match[2].trim();
        eqs.push(`Eq(_a1 + (${idx} - 1)*_d, ${val})`);
      } else if (cond.includes('=')) {
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
  if (p.a1) lines.push(`_a1 = ${p.a1}`);
  if (p.d) lines.push(`_d = ${p.d}`);

  // Set n
  if (p.n) {
    lines.push(`_n = ${p.n}`);
  } else {
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
  }

  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

function solveSequenceGeometric(p: SequenceGeometricParams): string {
  // Use _a1, _q prefixed names to avoid collisions with SymPy global symbols
  const lines = [`from sympy import *`];
  lines.push(`_a1, _q = symbols('_a1 _q', positive=True)`);

  // Handle conditions first (e.g. "a2 = 6", "a5 = 162")
  if (p.conditions && p.conditions.length > 0) {
    const eqs: string[] = [];
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
  if (p.a1) lines.push(`_a1 = ${p.a1}`);
  if (p.q) lines.push(`_q = ${p.q}`);

  // Set n
  if (p.n) {
    lines.push(`_n = ${p.n}`);
  } else {
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
      } else {
        lines.push(`# decay_threshold requires initial_value, threshold, and q`);
        lines.push(`wynik = 0`);
      }
      break;
  }

  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

function solveParametricEquation(p: ParametricEquationParams): string {
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

function solveSimplification(p: SimplificationParams): string {
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
      } else {
        lines.push(`wynik = simplify(expr)`);
      }
      break;
    case 'compare':
      lines.push(`wynik = expr`);
      break;
  }

  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

function extractCoordsFromDescription(description: string): Array<{ name: string; x: string; y: string }> {
  const points: Array<{ name: string; x: string; y: string }> = [];
  // Match patterns like A(1, 2), B(-3, 4), P(1/2, 3)
  const pattern = /([A-Z])\s*\(\s*(-?[\d./]+)\s*[,;]\s*(-?[\d./]+)\s*\)/g;
  let match;
  while ((match = pattern.exec(description)) !== null) {
    points.push({ name: match[1], x: match[2], y: match[3] });
  }
  return points;
}

function solveGeometryAnalytic(p: GeometryAnalyticParams): string {
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
  }

  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

function solveGeometrySolid(p: GeometrySolidParams): string {
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
      } else if (p.base === 'hexagon') {
        lines.push(`# Prism with hexagonal base`);
        lines.push(`S_base = 3*sqrt(3)/2 * a**2`);
      } else if (p.base === 'square') {
        lines.push(`S_base = a**2`);
      } else if (p.base === 'rectangle') {
        lines.push(`S_base = a * b`);
      } else {
        lines.push(`S_base = a**2  # default square base`);
      }
      lines.push(`V = S_base * h`);
      lines.push(`S_lateral = Piecewise((3*a*h, Eq(S_base, sqrt(3)/4 * a**2)), (6*a*h, Eq(S_base, 3*sqrt(3)/2 * a**2)), (4*a*h, True))`);
      lines.push(`S_total = 2*S_base + S_lateral`);
      break;
    case 'pyramid':
      if (p.base === 'square') {
        lines.push(`S_base = a**2`);
      } else if (p.base === 'triangle') {
        lines.push(`S_base = sqrt(3)/4 * a**2`);
      } else {
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

function solveGeometryArea(p: GeometryAreaParams): string {
  const lines = [`from sympy import *`];

  // Fallback: extract coordinates from description if not provided
  let coordinates = p.coordinates;
  if ((!coordinates || coordinates.length === 0) && p.description) {
    coordinates = extractCoordsFromDescription(p.description);
  }

  if (coordinates && coordinates.length > 0) {
    // Coordinate geometry approach
    const pts: string[] = [];
    for (const pt of coordinates) {
      lines.push(`${pt.name} = Point(${pt.x}, ${pt.y})`);
      pts.push(pt.name);
    }

    switch (p.task) {
      case 'area':
        if (pts.length === 3) {
          lines.push(`triangle = Triangle(${pts.join(', ')})`);
          lines.push(`wynik = triangle.area`);
        } else {
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
  } else {
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

function solveOptimization(p: OptimizationParams): string {
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
  } else if (p.domain_start) {
    lines.push(`        if cp > ${p.domain_start}:`);
  } else if (p.domain_end) {
    lines.push(`        if cp < ${p.domain_end}:`);
  } else {
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
  } else {
    lines.push(`best = max(values, key=lambda pair: pair[1])`);
  }

  lines.push(`print(f"${p.variable} = {best[0]}, f({best[0]}) = {best[1]}")`);
  lines.push(`print("ODPOWIEDZ:", best[1])`);
  return lines.join('\n');
}

function solveInequality(p: InequalityParams): string {
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
        wynik = solveset(expr - (${rhs}), ${p.variable}, S.Reals)
    except:
        wynik = solve(expr - (${rhs}), ${p.variable})
print("ODPOWIEDZ:", wynik)
`;
    case 'range':
      return `from sympy import *
${p.variable} = symbols('${p.variable}', real=True)
try:
    wynik = solveset(${p.expression} ${p.relation} ${rhs}, ${p.variable}, S.Reals)
except:
    wynik = solve(${p.expression} - (${rhs}), ${p.variable})
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

function solveProof(p: ProofParams): string {
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

function solveFunctionProperties(p: FunctionPropertiesParams): string {
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
  }

  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

function solveGeneral(p: GeneralParams): string {
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
  return `from sympy import *
# ${p.description}
print("ODPOWIEDZ: TODO")
`;
}

// ============================================================
// Main Router
// ============================================================

export function buildSolverCode(classification: ClassificationResult): string {
  const { type, params, isMultipleChoice, mcOptions, rawQuestion } = classification;

  // Enrich geometry params with rawQuestion for coordinate extraction fallback
  if (type === ProblemType.GEOMETRY_ANALYTIC || type === ProblemType.GEOMETRY_AREA) {
    const geoParams = params as any;
    if (!geoParams.description || geoParams.description.length < 20) {
      geoParams.description = rawQuestion;
    }
  }

  // Build core code first
  let coreCode: string;

  switch (type) {
    case ProblemType.LIMIT:
      coreCode = solveLimit(params as LimitParams);
      break;
    case ProblemType.DERIVATIVE:
      coreCode = solveDerivative(params as DerivativeParams);
      break;
    case ProblemType.TRIG_EQUATION:
      coreCode = solveTrigEquation(params as TrigEquationParams);
      break;
    case ProblemType.POLYNOMIAL_ROOTS:
      coreCode = solvePolynomialRoots(params as PolynomialRootsParams);
      break;
    case ProblemType.LOGARITHM:
      coreCode = solveLogarithm(params as LogarithmParams);
      break;
    case ProblemType.PROBABILITY:
      coreCode = solveProbability(params as ProbabilityParams);
      break;
    case ProblemType.COMBINATORICS:
      coreCode = solveCombinatorics(params as CombinatoricsParams);
      break;
    case ProblemType.SEQUENCE_ARITHMETIC:
      coreCode = solveSequenceArithmetic(params as SequenceArithmeticParams);
      break;
    case ProblemType.SEQUENCE_GEOMETRIC:
      coreCode = solveSequenceGeometric(params as SequenceGeometricParams);
      break;
    case ProblemType.PARAMETRIC_EQUATION:
      coreCode = solveParametricEquation(params as ParametricEquationParams);
      break;
    case ProblemType.GEOMETRY_ANALYTIC:
      coreCode = solveGeometryAnalytic(params as GeometryAnalyticParams);
      break;
    case ProblemType.GEOMETRY_SOLID:
      coreCode = solveGeometrySolid(params as GeometrySolidParams);
      break;
    case ProblemType.GEOMETRY_AREA:
      coreCode = solveGeometryArea(params as GeometryAreaParams);
      break;
    case ProblemType.OPTIMIZATION:
      coreCode = solveOptimization(params as OptimizationParams);
      break;
    case ProblemType.INEQUALITY:
      coreCode = solveInequality(params as InequalityParams);
      break;
    case ProblemType.PROOF:
      coreCode = solveProof(params as ProofParams);
      break;
    case ProblemType.FUNCTION_PROPERTIES:
      coreCode = solveFunctionProperties(params as FunctionPropertiesParams);
      break;
    case ProblemType.SIMPLIFICATION:
      coreCode = solveSimplification(params as SimplificationParams);
      break;
    case ProblemType.GENERAL:
    default:
      coreCode = solveGeneral(params as GeneralParams);
      break;
  }

  // If MC, wrap with option comparison
  if (isMultipleChoice && mcOptions) {
    // Extract the result variable name (the one after "wynik = " or before print)
    // Strip the core code of its import and print lines, keep the computation
    const coreLines = coreCode.split('\n').filter(l =>
      !l.startsWith('from sympy') && !l.startsWith('print(') && l.trim() !== ''
    );
    return wrapForMC(coreLines.join('\n'), 'wynik', mcOptions);
  }

  return coreCode;
}

// ============================================================
// Exports for testing
// ============================================================

export {
  solveLimit,
  solveDerivative,
  solveTrigEquation,
  solvePolynomialRoots,
  solveLogarithm,
  solveProbability,
  solveCombinatorics,
  solveSequenceArithmetic,
  solveSequenceGeometric,
  solveParametricEquation,
  solveSimplification,
  solveGeometryAnalytic,
  solveGeometrySolid,
  solveGeometryArea,
  solveOptimization,
  solveInequality,
  solveProof,
  solveFunctionProperties,
  solveGeneral,
  wrapForMC,
};
