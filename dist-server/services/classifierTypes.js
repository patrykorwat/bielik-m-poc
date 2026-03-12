/**
 * Classifier Types — Problem type definitions for the deterministic solver pipeline.
 *
 * Covers matura-level AND university-level mathematics.
 * The LLM classifies problems into one of these types and extracts structured parameters.
 * Deterministic solvers then build SymPy code from the params.
 */
export var ProblemType;
(function (ProblemType) {
    // === Matura-level ===
    ProblemType["LIMIT"] = "limit";
    ProblemType["DERIVATIVE"] = "derivative";
    ProblemType["TRIG_EQUATION"] = "trig_equation";
    ProblemType["POLYNOMIAL_ROOTS"] = "polynomial_roots";
    ProblemType["LOGARITHM"] = "logarithm";
    ProblemType["PROBABILITY"] = "probability";
    ProblemType["COMBINATORICS"] = "combinatorics";
    ProblemType["SEQUENCE_ARITHMETIC"] = "sequence_arithmetic";
    ProblemType["SEQUENCE_GEOMETRIC"] = "sequence_geometric";
    ProblemType["PARAMETRIC_EQUATION"] = "parametric_equation";
    ProblemType["GEOMETRY_ANALYTIC"] = "geometry_analytic";
    ProblemType["GEOMETRY_SOLID"] = "geometry_solid";
    ProblemType["GEOMETRY_AREA"] = "geometry_area";
    ProblemType["OPTIMIZATION"] = "optimization";
    ProblemType["INEQUALITY"] = "inequality";
    ProblemType["PROOF"] = "proof";
    ProblemType["FUNCTION_PROPERTIES"] = "function_properties";
    ProblemType["SIMPLIFICATION"] = "simplification";
    // === University-level ===
    ProblemType["MODULAR_ARITHMETIC"] = "modular_arithmetic";
    ProblemType["NUMBER_THEORY"] = "number_theory";
    ProblemType["LINEAR_ALGEBRA"] = "linear_algebra";
    ProblemType["INTEGRAL"] = "integral";
    ProblemType["DIFFERENTIAL_EQUATION"] = "differential_equation";
    ProblemType["SERIES"] = "series";
    ProblemType["GROUP_THEORY"] = "group_theory";
    ProblemType["TOPOLOGY"] = "topology";
    ProblemType["COMPLEX_ANALYSIS"] = "complex_analysis";
    ProblemType["ALGEBRAIC_GEOMETRY"] = "algebraic_geometry";
    ProblemType["GRAPH_THEORY"] = "graph_theory";
    // === Fallback ===
    ProblemType["GENERAL"] = "general";
})(ProblemType || (ProblemType = {}));
// --- Confidence threshold for fallback ---
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.7;
// --- Types that always fall back to old pipeline ---
export const FALLBACK_TYPES = [
    ProblemType.PROOF,
];
