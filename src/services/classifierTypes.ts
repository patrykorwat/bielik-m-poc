/**
 * Classifier Types — Problem type definitions for the deterministic solver pipeline.
 *
 * Covers matura-level AND university-level mathematics.
 * The LLM classifies problems into one of these types and extracts structured parameters.
 * Deterministic solvers then build SymPy code from the params.
 */

export enum ProblemType {
  // === Matura-level ===
  LIMIT = 'limit',
  DERIVATIVE = 'derivative',
  TRIG_EQUATION = 'trig_equation',
  POLYNOMIAL_ROOTS = 'polynomial_roots',
  LOGARITHM = 'logarithm',
  PROBABILITY = 'probability',
  COMBINATORICS = 'combinatorics',
  SEQUENCE_ARITHMETIC = 'sequence_arithmetic',
  SEQUENCE_GEOMETRIC = 'sequence_geometric',
  PARAMETRIC_EQUATION = 'parametric_equation',
  GEOMETRY_ANALYTIC = 'geometry_analytic',
  GEOMETRY_SOLID = 'geometry_solid',
  GEOMETRY_AREA = 'geometry_area',
  OPTIMIZATION = 'optimization',
  INEQUALITY = 'inequality',
  PROOF = 'proof',
  FUNCTION_PROPERTIES = 'function_properties',
  SIMPLIFICATION = 'simplification',

  // === University-level ===
  MODULAR_ARITHMETIC = 'modular_arithmetic',   // congruences, F_p, F_{p^k}, CRT, Euler/Fermat
  NUMBER_THEORY = 'number_theory',             // GCD, LCM, divisibility, primes, Diophantine
  LINEAR_ALGEBRA = 'linear_algebra',           // matrices, determinants, eigenvalues, rank, systems
  INTEGRAL = 'integral',                       // definite/indefinite integrals, substitution, by parts
  DIFFERENTIAL_EQUATION = 'differential_equation', // ODE, PDE, initial value problems
  SERIES = 'series',                           // power series, Taylor, Fourier, convergence tests
  GROUP_THEORY = 'group_theory',               // groups, rings, fields, homomorphisms, orders
  TOPOLOGY = 'topology',                       // metric spaces, continuity, compactness (basic)
  COMPLEX_ANALYSIS = 'complex_analysis',       // complex numbers, residues, contour integrals
  ALGEBRAIC_GEOMETRY = 'algebraic_geometry',   // varieties, curves over finite fields, intersection
  GRAPH_THEORY = 'graph_theory',               // Euler paths, chromatic number, planarity

  // === Fallback ===
  GENERAL = 'general',
}

// --- Parameter interfaces for each problem type ---

export interface LimitParams {
  expression: string;      // SymPy expression, e.g. "(x**2 - 1)/(x - 1)"
  variable: string;        // typically "x" or "n"
  approach: string;        // value approached, e.g. "1", "oo", "-oo"
  direction?: '+' | '-';   // one-sided limit direction
}

export interface DerivativeParams {
  expression: string;      // function expression, e.g. "x**3 - 2*x"
  variable: string;
  point?: string;          // evaluate at specific point
  task: 'derivative' | 'tangent_line' | 'extrema' | 'monotonicity';
  tangent_point?: string;  // x-value for tangent line
  tangent_y_value?: string;  // y-value to solve for when finding tangent point
}

export interface TrigEquationParams {
  equation: string;        // e.g. "sin(2*x) - cos(x)"
  variable: string;
  domain_start?: string;   // e.g. "0"
  domain_end?: string;     // e.g. "2*pi"
}

export interface PolynomialRootsParams {
  expression: string;      // polynomial expression, e.g. "x**3 - 6*x**2 + 11*x - 6"
  variable: string;
  task: 'roots' | 'factorize' | 'evaluate' | 'remainder';
  eval_point?: string;     // for evaluate task
}

export interface LogarithmParams {
  expression: string;      // e.g. "log(8, 2) + log(27, 3)"
  task: 'simplify' | 'solve_equation' | 'evaluate';
  equation?: string;       // for solve_equation: "log(x, 2) = 3"
  variable?: string;
}

export interface ProbabilityParams {
  type: 'bernoulli' | 'classical' | 'conditional' | 'geometric';
  n?: string;              // number of trials
  k?: string;              // successes
  p?: string;              // probability of success
  total_outcomes?: string; // for classical
  favorable_outcomes?: string;
  description: string;     // natural language for complex setups
}

export interface CombinatoricsParams {
  type: 'permutation' | 'combination' | 'variation' | 'count';
  n: string;               // total elements
  k?: string;              // selected elements
  with_repetition?: boolean;
  expression?: string;     // direct expression like "factorial(10)/factorial(7)"
}

export interface SequenceArithmeticParams {
  task: 'nth_term' | 'sum' | 'find_d' | 'find_a1' | 'find_n';
  a1?: string;             // first term
  d?: string;              // common difference
  n?: string;              // number of terms or specific term index
  an?: string;             // nth term value
  sum?: string;            // sum value
  conditions?: string[];   // e.g. ["a3 = 10", "a7 = 22"]
}

export interface SequenceGeometricParams {
  task: 'nth_term' | 'sum' | 'find_q' | 'find_a1' | 'find_n' | 'infinite_sum' | 'decay_threshold';
  a1?: string;
  q?: string;              // common ratio
  n?: string;
  an?: string;
  sum?: string;
  conditions?: string[];
  initial_value?: string;  // for decay_threshold: starting value m₀
  threshold?: string;      // for decay_threshold: threshold value
}

export interface ParametricEquationParams {
  equation: string;        // e.g. "x**2 + m*x + (m+2)"
  variable: string;        // main variable (usually "x")
  parameter: string;       // parameter name (usually "m")
  condition: string;       // e.g. "two_real_roots", "sum_of_roots > 0", "roots_positive"
  extra_value?: string;    // for x1_equals_kx2: k value; for roots_sum/roots_product: the bound
  // Known conditions:
  // "two_real_roots" → delta > 0
  // "one_real_root" → delta = 0
  // "no_real_roots" → delta < 0
  // "roots_positive" → delta >= 0, sum > 0, product > 0
  // "roots_negative" → delta >= 0, sum < 0, product > 0
  // "roots_opposite_sign" → product < 0
  // "x1_equals_kx2" → x1 = k*x2 (use Vieta's formulas)
  // "x1_cubed_plus_x2_cubed" → condition on x1³+x2³
  // "roots_sum" → condition on sum of roots
  // "roots_product" → condition on product of roots
  // custom condition as string → direct solve
}

export interface GeometryAnalyticParams {
  task: 'distance' | 'midpoint' | 'line_equation' | 'circle' | 'intersection' | 'tangent' | 'perpendicular';
  points?: Array<{ name: string; x: string; y: string }>;
  lines?: Array<{ name: string; equation: string }>;     // e.g. "2*x + 3*y - 6"
  circles?: Array<{ name: string; equation: string }>;    // e.g. "(x-1)**2 + (y-2)**2 - 25"
  description: string;     // natural language description of the geometric setup
}

export interface GeometrySolidParams {
  solid: 'prism' | 'pyramid' | 'cylinder' | 'cone' | 'sphere' | 'frustum';
  task: 'volume' | 'surface_area' | 'edge_length' | 'height' | 'angle';
  base: 'triangle' | 'square' | 'rectangle' | 'hexagon' | 'circle' | 'other';
  known_values: Record<string, string>;  // e.g. { "a": "6", "h": "8", "V": "192" }
  description: string;
}

export interface GeometryAreaParams {
  figure: 'triangle' | 'quadrilateral' | 'trapezoid' | 'parallelogram' | 'circle_sector' | 'polygon' | 'composite';
  task: 'area' | 'perimeter' | 'diagonal' | 'angle' | 'ratio';
  known_values: Record<string, string>;
  coordinates?: Array<{ name: string; x: string; y: string }>;
  description: string;
}

export interface OptimizationParams {
  function_expr: string;   // e.g. "x**2 + 1728/x"
  variable: string;
  domain_start?: string;   // constraint: x > 0
  domain_end?: string;
  task: 'minimize' | 'maximize';
  constraints?: string[];  // additional constraints
}

export interface InequalityParams {
  expression: string;      // e.g. "x**2 - 4*x + 3"
  variable: string;
  type: 'solve' | 'prove' | 'range';  // solve inequality, prove it, or find parameter range
  relation: '>' | '>=' | '<' | '<=' | '!=';
  rhs?: string;            // right-hand side, default "0"
}

export interface ProofParams {
  statement: string;       // what to prove, in natural language
  type: 'identity' | 'inequality' | 'divisibility' | 'geometric' | 'induction';
  lhs?: string;            // left side of identity
  rhs?: string;            // right side of identity
  variables?: string[];
}

export interface FunctionPropertiesParams {
  expression: string;      // function expression
  variable: string;
  task: 'domain' | 'range' | 'zeros' | 'monotonicity' | 'parity' | 'composition' | 'inverse';
  composition_with?: string;  // for composition task
}

export interface SimplificationParams {
  expression: string;
  variable?: string;
  task: 'simplify' | 'evaluate' | 'compare';
  eval_point?: string;
}

export interface GeneralParams {
  expression?: string;
  description: string;     // natural language fallback description
  sympy_code?: string;     // if the model can provide direct code
}

// --- University-level parameter interfaces ---

export interface ModularArithmeticParams {
  task: 'solve_congruence' | 'count_solutions' | 'find_order' | 'euler_phi' | 'crt' | 'finite_field' | 'intersection_variety';
  modulus?: string;           // e.g. "17" or "17**4"
  equations?: string[];       // system of equations/congruences
  field_size?: string;        // e.g. "17**4" for F_{17^4}
  variables?: string[];       // e.g. ["x", "y"]
  description: string;
}

export interface NumberTheoryParams {
  task: 'gcd' | 'lcm' | 'factorize' | 'diophantine' | 'primes' | 'divisors' | 'euler_phi' | 'legendre_symbol';
  numbers?: string[];         // e.g. ["120", "84"]
  equation?: string;          // for Diophantine: "3*x + 5*y = 1"
  variables?: string[];
  description: string;
}

export interface LinearAlgebraParams {
  task: 'determinant' | 'inverse' | 'eigenvalues' | 'eigenvectors' | 'rank' | 'solve_system' | 'diagonalize' | 'characteristic_polynomial' | 'nullspace' | 'rref';
  matrix?: string;            // SymPy Matrix(...) or [[1,2],[3,4]]
  matrices?: string[];        // for operations on multiple matrices
  system_equations?: string[]; // for solve_system: ["2*x + y - 3", "x - y + 1"]
  variables?: string[];
  description: string;
}

export interface IntegralParams {
  expression: string;         // integrand
  variable: string;
  task: 'indefinite' | 'definite' | 'improper' | 'double' | 'triple' | 'line' | 'surface';
  lower_bound?: string;       // for definite/improper
  upper_bound?: string;
  outer_variable?: string;    // for double/triple integrals
  outer_lower?: string;       // outer integral lower bound
  outer_upper?: string;       // outer integral upper bound
  method?: string;            // hint: 'substitution', 'by_parts', 'partial_fractions'
}

export interface DifferentialEquationParams {
  equation: string;           // e.g. "f(x).diff(x) + f(x) - x"
  function_name: string;      // e.g. "f"
  variable: string;
  order?: number;             // 1, 2, ...
  initial_conditions?: Record<string, string>; // e.g. {"f(0)": "1", "f'(0)": "0"}
  task: 'solve' | 'particular_solution' | 'classify';
}

export interface SeriesParams {
  expression: string;         // general term or function
  variable: string;
  task: 'convergence' | 'sum' | 'taylor' | 'fourier' | 'partial_sum' | 'radius';
  point?: string;             // expansion point for Taylor
  n_terms?: number;           // number of terms
  test?: string;              // convergence test: 'ratio', 'root', 'comparison', 'integral'
}

export interface GroupTheoryParams {
  task: 'order' | 'subgroups' | 'is_cyclic' | 'generators' | 'quotient' | 'homomorphism' | 'classify';
  group?: string;             // e.g. "SymmetricGroup(4)", "CyclicGroup(12)"
  element?: string;           // for order of element
  description: string;
}

export interface ComplexAnalysisParams {
  expression: string;         // complex function
  variable: string;           // usually "z"
  task: 'residue' | 'contour_integral' | 'poles' | 'laurent' | 'conformal_map' | 'analytic_check';
  point?: string;             // singularity point
  contour?: string;           // description of contour
  contour_radius?: string;    // radius for circular contour (default: include all poles)
}

export interface AlgebraicGeometryParams {
  equations: string[];        // defining equations of variety
  variables: string[];        // e.g. ["x", "y"]
  field?: string;             // e.g. "GF(17)" or "QQ" or "GF(17**4)"
  task: 'count_points' | 'intersection' | 'genus' | 'singularities' | 'parametrize' | 'degree';
  description: string;
}

export interface GraphTheoryParams {
  task: 'chromatic_number' | 'euler_path' | 'hamilton' | 'planarity' | 'shortest_path' | 'spanning_tree' | 'matching';
  vertices?: number;
  edges?: string[];           // e.g. ["(0,1)", "(1,2)", "(2,0)"]
  adjacency_matrix?: string;
  description: string;
}

// --- Union of all parameter types ---

export type ProblemParams =
  | LimitParams
  | DerivativeParams
  | TrigEquationParams
  | PolynomialRootsParams
  | LogarithmParams
  | ProbabilityParams
  | CombinatoricsParams
  | SequenceArithmeticParams
  | SequenceGeometricParams
  | ParametricEquationParams
  | GeometryAnalyticParams
  | GeometrySolidParams
  | GeometryAreaParams
  | OptimizationParams
  | InequalityParams
  | ProofParams
  | FunctionPropertiesParams
  | SimplificationParams
  | ModularArithmeticParams
  | NumberTheoryParams
  | LinearAlgebraParams
  | IntegralParams
  | DifferentialEquationParams
  | SeriesParams
  | GroupTheoryParams
  | ComplexAnalysisParams
  | AlgebraicGeometryParams
  | GraphTheoryParams
  | GeneralParams;

// --- Classification result ---

export interface ClassificationResult {
  type: ProblemType;
  params: ProblemParams;
  confidence: number;        // 0.0 - 1.0
  rawQuestion: string;
  isMultipleChoice: boolean;
  mcOptions?: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
}

// --- Solver result ---

export interface SolverResult {
  code: string;              // Generated SymPy code
  output?: string;           // MCP execution output
  answer?: string;           // Extracted answer
  solverType: ProblemType;
  success: boolean;
  error?: string;
}

// --- Confidence threshold for fallback ---

export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.7;

// --- Types that always fall back to old pipeline ---

export const FALLBACK_TYPES: ProblemType[] = [
  ProblemType.PROOF,
];
