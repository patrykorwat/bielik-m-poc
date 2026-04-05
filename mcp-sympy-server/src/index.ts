#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to venv Python (if exists) or fallback to system python3
const VENV_PYTHON_PATH = join(__dirname, "..", "venv", "bin", "python3");
const VENV_PYTHON = existsSync(VENV_PYTHON_PATH) ? VENV_PYTHON_PATH : "python3";

/**
 * MCP Server for SymPy mathematical computations
 * Provides tools for symbolic mathematics, calculus, algebra, and more
 */

// Define available SymPy tools
const TOOLS: Tool[] = [
  {
    name: "sympy_calculate",
    description:
      "Execute SymPy mathematical expressions. Supports symbolic algebra, calculus, equation solving, simplification, and more. Returns the computed result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description:
            "SymPy Python expression to evaluate (e.g., 'integrate(x**2, x)', 'solve(x**2 - 4, x)', 'diff(sin(x), x)')",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "sympy_simplify",
    description:
      "Simplify a mathematical expression using SymPy's simplification algorithms.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Mathematical expression to simplify (e.g., 'sin(x)**2 + cos(x)**2')",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "sympy_solve",
    description: "Solve equations or systems of equations using SymPy.",
    inputSchema: {
      type: "object",
      properties: {
        equation: {
          type: "string",
          description: "Equation to solve (e.g., 'x**2 - 4' or 'Eq(x**2, 4)')",
        },
        variable: {
          type: "string",
          description: "Variable to solve for (e.g., 'x')",
        },
      },
      required: ["equation", "variable"],
    },
  },
  {
    name: "sympy_differentiate",
    description: "Compute derivatives of mathematical expressions.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression to differentiate (e.g., 'x**3 + 2*x')",
        },
        variable: {
          type: "string",
          description: "Variable to differentiate with respect to (e.g., 'x')",
        },
        order: {
          type: "number",
          description: "Order of derivative (default: 1)",
        },
      },
      required: ["expression", "variable"],
    },
  },
  {
    name: "sympy_integrate",
    description: "Compute integrals of mathematical expressions.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression to integrate (e.g., 'x**2')",
        },
        variable: {
          type: "string",
          description: "Variable to integrate with respect to (e.g., 'x')",
        },
        lower_limit: {
          type: "string",
          description: "Lower limit for definite integral (optional)",
        },
        upper_limit: {
          type: "string",
          description: "Upper limit for definite integral (optional)",
        },
      },
      required: ["expression", "variable"],
    },
  },
  {
    name: "sympy_expand",
    description: "Expand mathematical expressions (e.g., (x+1)**2 -> x**2 + 2*x + 1).",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression to expand (e.g., '(x + 1)**2')",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "sympy_factor",
    description: "Factor mathematical expressions.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression to factor (e.g., 'x**2 - 4')",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "sympy_limit",
    description: "Compute limits of mathematical expressions.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Expression to find limit of (e.g., 'sin(x)/x')",
        },
        variable: {
          type: "string",
          description: "Variable approaching the limit (e.g., 'x')",
        },
        point: {
          type: "string",
          description: "Point to approach (e.g., '0', 'oo' for infinity)",
        },
      },
      required: ["expression", "variable", "point"],
    },
  },
  {
    name: "sympy_matrix",
    description: "Perform matrix operations (determinant, inverse, eigenvalues, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Matrix operation: 'det', 'inverse', 'eigenvals', 'eigenvects', 'transpose'",
        },
        matrix: {
          type: "string",
          description: "Matrix as Python list (e.g., '[[1, 2], [3, 4]]')",
        },
      },
      required: ["operation", "matrix"],
    },
  },
  {
    name: "sympy_plot",
    description:
      "Generate an SVG diagram from Python code that uses sympy.geometry. The code MUST print SVG markup to stdout. No matplotlib needed. Use for geometry construction tasks (triangles, circles, inscribed/circumscribed figures).",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Python code that computes geometry using sympy and prints SVG markup to stdout. Must output a complete <svg>...</svg> element.",
        },
      },
      required: ["code"],
    },
  },
];

/**
 * Execute Python code with SymPy. Returns {stdout, stderr, exitCode}.
 */
async function executePythonSymPyRaw(code: string): Promise<{stdout: string; stderr: string; exitCode: number}> {
  return new Promise((resolve) => {
    const python = spawn(VENV_PYTHON, ["-c", code], { timeout: 30000 });
    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (exitCode) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? 1 });
    });

    python.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * Execute Python code with SymPy (legacy wrapper — rejects on error)
 */
async function executePythonSymPy(code: string): Promise<string> {
  const result = await executePythonSymPyRaw(code);
  if (result.exitCode !== 0) {
    throw new Error(`Python error: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Comprehensive sanitization of Python/SymPy code generated by LLM.
 * Matches threeAgentSystem.sanitizeCode() — single source of truth.
 */
function sanitizeCode(code: string): string {
  let lines = code.split('\n');

  // 1. Remove assert statements
  lines = lines.filter(line => !line.trim().startsWith('assert '));

  // 2. Remove duplicate variable definitions
  const definedVars = new Set<string>();
  const symbolDefRegex = /^(\w+)\s*=\s*symbols?\(/;
  lines = lines.filter(line => {
    const match = line.trim().match(symbolDefRegex);
    if (match) {
      const varName = match[1];
      if (definedVars.has(varName)) return false;
      definedVars.add(varName);
    }
    return true;
  });

  // 3. Remove duplicate imports
  const seenImports = new Set<string>();
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
      if (seenImports.has(trimmed)) return false;
      seenImports.add(trimmed);
    }
    return true;
  });

  // 4. Fix ^ → ** for exponentiation
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    return line
      .replace(/(\w)\^(\w)/g, '$1**$2')
      .replace(/\)\^(\w)/g, ')**$1')
      .replace(/(\w)\^\(/g, '$1**(')
      .replace(/\)\^\(/g, ')**(')
      .replace(/\^\{(\d+)\}/g, '**$1');
  });

  // 5. Filter out single-letter "imports" (Bielik hallucination)
  lines = lines.map(line => {
    const importMatch = line.match(/^(from sympy import .+)/);
    if (importMatch) {
      const parts = line.split(',').map(p => p.trim());
      const filtered = parts.filter(p => {
        if (p.startsWith('from ')) return true;
        if (/^[a-z]$/i.test(p)) return false;
        if (['R', 'x', 'y', 'z', 'a', 'b', 'c', 'n', 'm', 'k', 't'].includes(p)) return false;
        return true;
      });
      return filtered.join(', ');
    }
    return line;
  });

  // 5a. Strip unavailable modules (matplotlib, scipy, etc.)
  lines = lines.filter(line => {
    const t = line.trim();
    if (t.startsWith('import matplotlib') || t.startsWith('from matplotlib')) return false;
    if (t.startsWith('import scipy') || t.startsWith('from scipy')) return false;
    if (t.startsWith('import numpy') || t.startsWith('from numpy')) return false;
    // Remove plt.* calls
    if (t.startsWith('plt.')) return false;
    return true;
  });

  // 5b. Proactive fix: Piecewise chained comparisons → And()
  lines = lines.map(line => {
    if (line.includes('Piecewise') || line.includes('piecewise')) {
      line = line.replace(
        /(-?\d+\.?\d*)\s*(<=?)\s*(\w+)\s*(<|<=)\s*(-?\d+\.?\d*)/g,
        'And($1 $2 $3, $3 $4 $5)'
      );
      line = line.replace(
        /(-?\d+\.?\d*)\s*(<|<=)\s*(\w+)\s*(<=?)\s*(-?\d+\.?\d*)/g,
        'And($1 $2 $3, $3 $4 $5)'
      );
    }
    return line;
  });

  // 5c. Proactive fix: implicit multiplication (3BC → 3*BC, 3x → 3*x)
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    line = line.replace(/(\d)([A-Z]{2,})/g, '$1*$2');
    // Fix digit followed by single lowercase letter (3x → 3*x)
    line = line.replace(/(\d)([a-z])(?![a-zA-Z0-9_])/g, (match, digit, letter, offset, str) => {
      if (digit === '0' && letter === 'x') return match; // hex
      if (offset > 0 && /[a-zA-Z_]/.test(str[offset - 1])) return match; // part of identifier
      return digit + '*' + letter;
    });
    return line;
  });

  // 5d. Proactive fix: _N M log notation → log(M, N)
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
    line = line.replace(/\b_(\d+)\s+(\d+)\b/g, 'log($2, $1)');
    return line;
  });

  // 5e. Proactive fix: cos**2(x) → cos(x)**2, sin**2(x) → sin(x)**2, tan**2(x) → tan(x)**2
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    line = line.replace(/\b(sin|cos|tan|cot|sec|csc)\*\*(\d+)\(([^)]+)\)/g, '$1($3)**$2');
    return line;
  });

  // 5g. Proactive fix: solve(eq)**[0] → solve(eq)[0] (typo: ** before index)
  lines = lines.map(line => {
    line = line.replace(/\)\*\*\[(\d+)\]/g, ')[$1]');
    return line;
  });

  // 5f1. Proactive fix: hallucinated SymPy function names
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    // binomial_coeff / binomial_coefficient / comb → binomial
    line = line.replace(/\bbinomial_coeff\b/g, 'binomial');
    line = line.replace(/\bbinomial_coefficient\b/g, 'binomial');
    line = line.replace(/\bcomb\(/g, 'binomial(');
    line = line.replace(/\bnCr\(/g, 'binomial(');
    return line;
  });

  // 5f2. Proactive fix: variable named S conflicts with SymPy S singleton
  // Rename variable S to S_val when used as assignment target (not SymPy's S())
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
    // Match: S = something (but not S(...) which is SymPy's S function)
    if (/^\s*S\s*=\s*/.test(line) && !line.includes('S(')) {
      line = line.replace(/\bS\b(?!\s*\()/g, 'S_val');
    }
    return line;
  });

  // 5f. Proactive fix: Polish text in code → remove or translate
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (/^(jeśli|jesli|więc|wiec|zatem|czyli|ponieważ|poniewaz)\s/i.test(trimmed)) return false;
    return true;
  });
  // Translate Polish for/in loops: "dla X w Y:" → "for X in Y:"
  lines = lines.map(line => {
    line = line.replace(/\bdla\s+(.+?)\s+w\s+(.+?):/g, 'for $1 in $2:');
    return line;
  });

  // 5h. Proactive fix: lambdify(..., 'numpy') → direct SymPy computation
  lines = lines.map(line => {
    line = line.replace(/lambdify\(([^,]+),\s*([^,]+),\s*['"]numpy['"]\)/g, 'lambdify($1, $2, "math")');
    return line;
  });

  // 5i-pre. Proactive fix: Interval.open_left/open_right don't exist
  lines = lines.map(line => {
    line = line.replace(/Interval\.open_left\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, left_open=True)');
    line = line.replace(/Interval\.open_right\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, right_open=True)');
    line = line.replace(/Interval\.open\(([^,]+),\s*([^)]+)\)/g, 'Interval.open($1, $2)');
    line = line.replace(/Interval\.open_left\(([^)]+)\)/g, 'Interval($1, oo, left_open=True)');
    line = line.replace(/Interval\.open_right\(([^)]+)\)/g, 'Interval(-oo, $1, right_open=True)');
    return line;
  });

  // 5i-geom. Proactive fix: geometry free-function calls → method calls
  // Bielik writes incenter(tri), circumcenter(tri) etc. but SymPy uses tri.incenter
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    line = line.replace(/\bsemiperimeter\((\w+)\)/g, '($1.perimeter / 2)');
    line = line.replace(/\bincenter\((\w+)\)/g, '$1.incenter');
    line = line.replace(/\bcircumcenter\((\w+)\)/g, '$1.circumcenter');
    line = line.replace(/\bcircumradius\((\w+)\)/g, '$1.circumradius');
    line = line.replace(/\binradius\((\w+)\)/g, '$1.inradius');
    line = line.replace(/\bincircle\((\w+)\)/g, '$1.incircle');
    line = line.replace(/\bcircumcircle\((\w+)\)/g, '$1.circumcircle');
    return line;
  });

  // 5i. Proactive fix: format(sympy_expr, '.Nf') → format(float(sympy_expr), '.Nf')
  lines = lines.map(line => {
    line = line.replace(/format\((\w+),\s*(['"][^'"]+['"])\)/g, 'format(float($1), $2)');
    return line;
  });

  // 6. Fix wrong SymPy names
  const importFixes: Record<string, string> = {
    'Simplify': 'simplify', 'Greater': 'Gt', 'Less': 'Lt',
    'GreaterEqual': 'Ge', 'LessEqual': 'Le', 'Solve': 'solve',
    'Factor': 'factor', 'Expand': 'expand', 'Limit': 'limit',
    'Integrate': 'integrate', 'Derivative': 'diff', 'Trigsimp': 'trigsimp',
    'Power': 'Pow', 'Discrimant': 'discriminant', 'Discriminant': 'discriminant',
  };
  lines = lines.map(line => {
    for (const [wrong, correct] of Object.entries(importFixes)) {
      if (line.includes(wrong)) {
        line = line.replace(new RegExp(wrong, 'g'), correct);
      }
    }
    return line;
  });

  // 7. Fix Pi → pi, Infinity → oo, math.* → sympy
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) return line;
    line = line.replace(/\bPi\b/g, 'pi');
    line = line.replace(/\bInfinity\b/g, 'oo');
    line = line.replace(/\bmath\.sqrt\b/g, 'sqrt');
    line = line.replace(/\bmath\.pi\b/g, 'pi');
    line = line.replace(/\bmath\.e\b/g, 'E');
    line = line.replace(/\bmath\.log\b/g, 'log');
    line = line.replace(/\bmath\.sin\b/g, 'sin');
    line = line.replace(/\bmath\.cos\b/g, 'cos');
    // S.Interval → Interval (S registry doesn't have Interval)
    line = line.replace(/\bS\.Interval\b/g, 'Interval');
    line = line.replace(/\bS\.Reals\b/g, 'Reals');
    line = line.replace(/\bS\.Integers\b/g, 'Integers');
    return line;
  });

  // 7a. Fix .simplify() method → simplify() function call
  lines = lines.map(line => {
    if (line.includes('.simplify()')) {
      const assignMatch = line.match(/^(\s*\w+\s*=\s*)(.+)\.simplify\(\)\s*$/);
      if (assignMatch) {
        line = `${assignMatch[1]}simplify(${assignMatch[2]})`;
      } else {
        line = line.replace(/(\w+)\.simplify\(\)/g, 'simplify($1)');
        line = line.replace(/\)\.simplify\(\)/g, ')');
      }
    }
    return line;
  });

  // 7b. Fix .evalf() → N()
  lines = lines.map(line => line.replace(/(\w+)\.evalf\(\)/g, 'N($1)'));

  // 7c. Fix Interval.from_ends(a, b) → Interval(a, b)
  lines = lines.map(line => line.replace(/Interval\.from_ends\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2)'));

  // 7d. Fix float() wrapping symbolic expressions → float(N(expr))
  lines = lines.map(line => {
    if (line.includes('float(')) {
      line = line.replace(/float\(wynik\)/g, 'float(N(wynik))');
      line = line.replace(/float\(val\)/g, 'float(N(val))');
    }
    return line;
  });

  // 7e. Fix truth-value testing of symbolic comparisons → wrap in bool()
  lines = lines.map(line => {
    const trimmed = line.trim();
    if ((trimmed.startsWith('if ') || trimmed.startsWith('elif ') || trimmed.startsWith('while '))
        && /\.\w+\([^)]*\)\s*[<>]=?\s*\d/.test(trimmed)) {
      line = line.replace(/(if|elif|while)\s+(.+?):/g, '$1 bool($2):');
    }
    return line;
  });

  // 7f. Fix Eq() with single argument → Eq(expr, 0)
  lines = lines.map(line => {
    if (line.includes('Eq(')) {
      const eqMatch = line.match(/\bEq\(/);
      if (eqMatch) {
        const start = eqMatch.index! + eqMatch[0].length;
        let depth = 1;
        let pos = start;
        let hasComma = false;
        while (pos < line.length && depth > 0) {
          if (line[pos] === '(') depth++;
          else if (line[pos] === ')') depth--;
          else if (line[pos] === ',' && depth === 1) { hasComma = true; break; }
          pos++;
        }
        if (!hasComma && depth === 0) {
          const inner = line.substring(start, pos - 1);
          line = line.substring(0, eqMatch.index!) + `Eq(${inner}, 0)` + line.substring(pos);
        }
      }
    }
    return line;
  });

  // Remove input() calls
  lines = lines.filter(line => !line.includes('input('));

  // Fix bare math expressions with = that should be Eq()
  // Skips augmented assignments (+=, -=, etc.) and for loops
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
    if (trimmed.startsWith('if ') || trimmed.startsWith('elif ') || trimmed.startsWith('while ') || trimmed.startsWith('return ')) return line;
    if (trimmed.includes('==') || trimmed.includes('Eq(')) return line;
    // Skip augmented assignment operators: +=, -=, *=, /=, **=
    if (/[+\-*\/]=/.test(trimmed)) return line;
    // Skip for/in loops
    if (trimmed.startsWith('for ')) return line;
    if (/\w+\(/.test(trimmed)) return line;
    const badEqMatch = trimmed.match(/^([^=]+[+\-]|[^=]+\*\*[^=]*)\s*=\s*(\S.*)$/);
    if (badEqMatch) {
      const lhs = badEqMatch[1].replace(/\s*=?\s*$/, '').trim();
      const rhs = badEqMatch[2].trim();
      if (/^\w+\(/.test(rhs)) return line;
      const indent = line.match(/^(\s*)/)?.[1] || '';
      return `${indent}eq_expr = Eq(${lhs}, ${rhs})`;
    }
    return line;
  });

  // Fix == in equation definition (should be Eq())
  lines = lines.map(line => {
    const t = line.trim();
    if (/^\w+\s*=\s*.+==.+/.test(t) &&
        !t.startsWith('if ') && !t.startsWith('elif ') && !t.startsWith('while ') &&
        !t.startsWith('return ') && !t.startsWith('assert ')) {
      line = line.replace(/(\w+\s*=\s*)(.+?)\s*==\s*(.+)/, '$1Eq($2, $3)');
    }
    return line;
  });

  // Remove import math if all math.* calls replaced
  let codeText = lines.join('\n');
  if (!codeText.includes('math.')) {
    lines = lines.filter(l => !['import math', 'from math import *'].includes(l.trim()));
  }

  // Fix "import sympy" → "from sympy import *" (Bielik generates bare "import sympy"
  // but then uses unqualified names like solve(), symbols(), etc.)
  codeText = lines.join('\n');
  lines = lines.map(line => {
    const t = line.trim();
    if (t === 'import sympy' || t === 'import sympy as sp') {
      return 'from sympy import *';
    }
    return line;
  });
  // Also replace sympy.X(...) and sp.X(...) calls with bare X(...)
  lines = lines.map(line => {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('"') || t.startsWith("'")) return line;
    line = line.replace(/\bsympy\.(\w)/g, '$1');
    line = line.replace(/\bsp\.(\w)/g, '$1');
    return line;
  });

  // Ensure sympy import exists
  codeText = lines.join('\n');
  if (!codeText.includes('from sympy')) {
    lines.unshift('from sympy import *');
  }

  // Ensure itertools import if combinations/permutations used
  codeText = lines.join('\n');
  if ((codeText.includes('combinations(') || codeText.includes('permutations(')) &&
      !codeText.includes('from itertools') && !codeText.includes('import itertools')) {
    lines.splice(1, 0, 'from itertools import combinations, permutations');
  }

  // Ensure math import if math.* used and not already replaced
  if (codeText.includes('math.') && !codeText.includes('import math')) {
    lines.splice(1, 0, 'import math');
  }

  // 7g. Strip non-ASCII / unicode characters from code
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return line;
    line = line.replace(/≠/g, '!=');
    line = line.replace(/≥/g, '>=');
    line = line.replace(/≤/g, '<=');
    line = line.replace(/→/g, '');
    line = line.replace(/×/g, '*');
    line = line.replace(/÷/g, '/');
    line = line.replace(/·/g, '*');
    line = line.replace(/²/g, '**2');
    line = line.replace(/³/g, '**3');
    line = line.replace(/√/g, 'sqrt');
    line = line.replace(/π/g, 'pi');
    line = line.replace(/∞/g, 'oo');
    if (!trimmed.startsWith('"') && !trimmed.startsWith("'") && !trimmed.includes('print(')) {
      line = line.replace(/[^\x00-\x7F]/g, '');
    }
    return line;
  });

  // 7h. Fix Relational arithmetic: inequality = inequality - expr (impossible on Relational)
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
    const relArithMatch = trimmed.match(/^(\w+)\s*=\s*(\w+)\s*([+\-*/])\s*(.+)$/);
    if (relArithMatch) {
      const [, lhs, rhs_var] = relArithMatch;
      if (lhs === rhs_var) {
        const indent = line.match(/^(\s*)/)?.[1] || '';
        return `${indent}# ${trimmed}  # REMOVED: cannot do arithmetic on Relational`;
      }
    }
    return line;
  });

  // 7i. Fix N(expr).round(n) → round(float(N(expr)), n)
  lines = lines.map(line => {
    line = line.replace(/N\(([^)]+)\)\.round\((\d+)\)/g, 'round(float(N($1)), $2)');
    line = line.replace(/(\w+)\.round\((\d+)\)/g, (match, varName, digits) => {
      if (['result', 'wynik', 'answer', 'odpowiedz', 'T_new_rounded'].includes(varName)) {
        return `round(float(N(${varName})), ${digits})`;
      }
      return match;
    });
    return line;
  });

  // Fix truncated code: close unbalanced parens/brackets, remove incomplete last line
  {
    let codeStr = lines.join('\n');
    const openParens = (codeStr.match(/\(/g) || []).length;
    const closeParens = (codeStr.match(/\)/g) || []).length;
    const openBrackets = (codeStr.match(/\[/g) || []).length;
    const closeBrackets = (codeStr.match(/\]/g) || []).length;

    // If last line looks truncated, remove it
    const lastLine = lines[lines.length - 1]?.trim() || '';
    const isTruncated = (
      lastLine.endsWith(',') || lastLine.endsWith('(') || lastLine.endsWith('+') ||
      lastLine.endsWith('*') || lastLine.endsWith('-') || lastLine.endsWith('=') ||
      lastLine.endsWith('.') || lastLine.endsWith('\\') ||
      (openParens > closeParens + 1) // severely unbalanced
    );

    if (isTruncated && lines.length > 3) {
      // Remove truncated trailing lines
      while (lines.length > 3) {
        const ll = lines[lines.length - 1].trim();
        if (ll.endsWith(',') || ll.endsWith('(') || ll.endsWith('+') ||
            ll.endsWith('*') || ll.endsWith('-') || ll.endsWith('=') ||
            ll.endsWith('.') || ll === '') {
          lines.pop();
        } else {
          break;
        }
      }
    }

    // Balance remaining parens/brackets
    const finalCode = lines.join('\n');
    const op = (finalCode.match(/\(/g) || []).length;
    const cp = (finalCode.match(/\)/g) || []).length;
    const ob = (finalCode.match(/\[/g) || []).length;
    const cb = (finalCode.match(/\]/g) || []).length;

    if (op > cp) {
      lines[lines.length - 1] += ')'.repeat(op - cp);
    }
    if (ob > cb) {
      lines[lines.length - 1] += ']'.repeat(ob - cb);
    }
  }

  // Ensure print statement exists
  const hasPrint = lines.some(line => line.trim().startsWith('print(') || line.trim().startsWith('print ('));
  if (!hasPrint) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const assignMatch = lines[i].trim().match(/^(\w+)\s*=/);
      if (assignMatch && !lines[i].trim().startsWith('#') &&
          !lines[i].trim().startsWith('from ') && !lines[i].trim().startsWith('import ')) {
        lines.push(`print("ODPOWIEDZ:", ${assignMatch[1]})`);
        break;
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Try to fix code based on error message. Returns fixed code or same code if no fix.
 * Matches threeAgentSystem.tryFixCode() — single source of truth.
 */
function tryFixCode(code: string, errorMsg: string): string {
  let fixedCode = code;

  // Fix 1: NameError — add missing symbol definition
  const nameErrorMatch = errorMsg.match(/NameError: name '(\w+)' is not defined/);
  if (nameErrorMatch) {
    const missingVar = nameErrorMatch[1];
    const lines = fixedCode.split('\n');
    let insertIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('from ') || lines[i].trim().startsWith('import ')) {
        insertIdx = i + 1;
      }
    }
    lines.splice(insertIdx, 0, `${missingVar} = symbols('${missingVar}', real=True)`);
    fixedCode = lines.join('\n');
  }

  // Fix 2: IndexError on solve()[0]
  if (errorMsg.includes('IndexError: list index out of range')) {
    fixedCode = fixedCode.replace(
      /(\w+)\s*=\s*solve\(([^)]+)\)\[0\]/g,
      '_sols = solve($2)\n$1 = _sols[0] if _sols else None'
    );
  }

  // Fix 3: 'And'/'Or' object — not iterable or not subscriptable
  if (errorMsg.includes("'And' object") || errorMsg.includes("'Or' object")) {
    // Fix iteration: for x in result → wrap in list
    fixedCode = fixedCode.replace(
      /for\s+(\w+)\s+in\s+(\w+)/g,
      'for $1 in ([$2] if not hasattr($2, "__iter__") else $2)'
    );
    // Fix subscripting: result[0] → handle And/Or by wrapping solve
    // When solve() returns And/Or (system of inequalities), convert to list of args
    fixedCode = fixedCode.replace(
      /(\w+)\s*=\s*solve\(([^)]+)\)\[(\d+)\]/g,
      '_raw = solve($2)\n$1 = _raw.args[$3] if hasattr(_raw, "args") and not isinstance(_raw, list) else (_raw[$3] if isinstance(_raw, list) else _raw)'
    );
    // Also fix direct subscript on existing variable
    if (errorMsg.includes('not subscriptable')) {
      fixedCode = fixedCode.replace(
        /(\w+)\[(\d+)\]/g,
        '($1.args[$2] if hasattr($1, "args") else $1[$2])'
      );
    }
  }

  // Fix 4: 'bool' object has no attribute 'subs'
  if (errorMsg.includes("'bool' object has no attribute 'subs'")) {
    fixedCode = fixedCode.replace(/(\w+)\s*=\s*(.+?)\s*==\s*(.+)/g, '$1 = Eq($2, $3)');
  }

  // Fix 5: tuple/dict indexing with symbol
  if (errorMsg.includes('tuple indices must be integers') || errorMsg.includes('list indices must be integers')) {
    fixedCode = fixedCode.replace(/(\w+)\[(\w+)\](?!\s*if)/g, '$1[0]');
  }

  // Fix 6: SyntaxError "cannot assign to expression"
  if (errorMsg.includes('cannot assign to expression') || errorMsg.includes("Maybe you meant '=='")) {
    const lines = fixedCode.split('\n');
    fixedCode = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) return line;
      if (trimmed.includes('==') || trimmed.includes('Eq(')) return line;
      if (/\w+\(/.test(trimmed)) return line;
      const badEq = trimmed.match(/^([^=]+[+\-]|[^=]+\*\*[^=]*)\s*=\s*(\S.*)$/);
      if (badEq) {
        const lhs = badEq[1].replace(/\s*=?\s*$/, '').trim();
        const rhs = badEq[2].trim();
        if (/^\w+\(/.test(rhs)) return line;
        const indent = line.match(/^(\s*)/)?.[1] || '';
        return `${indent}eq_expr = Eq(${lhs}, ${rhs})`;
      }
      return line;
    }).join('\n');
  }

  // Fix 7: SympifyError / LaTeX in code
  if (errorMsg.includes('SympifyError') || errorMsg.includes('could not parse')) {
    fixedCode = fixedCode
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, 'Rational($1, $2)')
      .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
      .replace(/\\pi\b/g, 'pi')
      .replace(/\\cdot/g, '*')
      .replace(/\\left\(/g, '(')
      .replace(/\\right\)/g, ')');
  }

  // Fix 8: Symbol cannot be interpreted as integer
  if (errorMsg.includes("'Symbol' object cannot be interpreted as an integer")) {
    fixedCode = fixedCode.replace(/range\((\w+)\)/g, 'range(int($1))');
  }

  // Fix 9: AttributeError — wrong method names
  if (errorMsg.includes("has no attribute 'evalf'")) {
    fixedCode = fixedCode.replace(/(\w+)\.evalf\(\)/g, 'N($1)');
  }
  if (errorMsg.includes("has no attribute 'simplify'")) {
    fixedCode = fixedCode.replace(/(\w+)\.simplify\(\)/g, 'simplify($1)');
  }
  if (errorMsg.includes("'float' object has no attribute 'subs'") ||
      errorMsg.includes("'Float' object has no attribute 'subs'")) {
    // Variable was converted to float too early — use S() to keep symbolic
    fixedCode = fixedCode.replace(/(\w+)\s*=\s*float\(([^)]+)\)/g, '$1 = S($2)');
  }

  // Fix 9a: cannot import name 'X' from 'sympy' — model hallucinated a name
  const importNameMatch = errorMsg.match(/cannot import name '(\w+)' from '(\w+)'/);
  if (importNameMatch) {
    const badName = importNameMatch[1];
    // Known renames
    const renames: Record<string, string> = {
      'Power': 'Pow', 'Logarithm': 'log', 'Sine': 'sin', 'Cosine': 'cos',
      'Tangent': 'tan', 'ArcSin': 'asin', 'ArcCos': 'acos', 'ArcTan': 'atan',
    };
    if (renames[badName]) {
      fixedCode = fixedCode.replace(new RegExp(`\\b${badName}\\b`, 'g'), renames[badName]);
    } else {
      // Remove the specific import and use wildcard
      fixedCode = fixedCode.replace(new RegExp(`from sympy import.*\\b${badName}\\b,?\\s*`, 'g'), (match) => {
        // If this was the only import, replace with wildcard
        const remaining = match.replace(badName, '').replace(/,\s*,/g, ',').replace(/import\s*,/, 'import ').replace(/,\s*$/, '');
        return remaining.includes('import ') ? remaining : '';
      });
      if (!fixedCode.includes('from sympy import *')) {
        fixedCode = 'from sympy import *\n' + fixedCode;
      }
    }
  }

  // Fix 10: ZeroDivisionError
  if (errorMsg.includes('ZeroDivisionError')) {
    fixedCode = fixedCode.replace(/\/\s*0\b/g, '/ S(0)');
  }

  // Fix 11: Interval.from_ends → Interval
  if (errorMsg.includes("has no attribute 'from_ends'")) {
    fixedCode = fixedCode.replace(/Interval\.from_ends\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2)');
  }

  // Fix 12: Cannot convert expression to float
  if (errorMsg.includes('Cannot convert expression to float')) {
    fixedCode = fixedCode.replace(/float\((\w+)\)/g, 'float(N($1))');
  }

  // Fix 13: unsupported operand type for -: 'And'/'Or'/'Equality'/'Add' and int/other
  if (errorMsg.includes("unsupported operand type(s) for -:") &&
      (errorMsg.includes("'And'") || errorMsg.includes("'Or'") ||
       errorMsg.includes("'Equality'") || errorMsg.includes("'Add'"))) {
    fixedCode = fixedCode.replace(
      /if simplify\(wynik - val\) == 0:/g,
      'if str(wynik) == str(val) or (hasattr(wynik, "equals") and wynik.equals(val)):'
    );
    // Also fix direct arithmetic on And/Or/Equality results
    fixedCode = fixedCode.replace(
      /if simplify\(N\(wynik\) - N\(val\)\) == 0/g,
      'if str(N(wynik)) == str(N(val))'
    );
  }

  // Fix 14: cannot determine truth value of Relational
  if (errorMsg.includes('cannot determine truth value of Relational')) {
    fixedCode = fixedCode.replace(/if\s+(.+?)\s*([<>]=?)\s*(\d+)\s*:/g, 'if bool($1 $2 $3):');
  }

  // Fix 15: could not convert string to float
  if (errorMsg.includes('could not convert string to float')) {
    fixedCode = fixedCode.replace(/float\((\w+)\)/g, 'float(N($1))');
  }

  // Fix 16: object is not callable — 'Symbol', 'Add', 'Float', etc.
  if (errorMsg.includes('object is not callable')) {
    // Find which symbol name caused the error: e.g., combinations(...) where combinations is a symbol
    const callableMatch = errorMsg.match(/File.*line (\d+)/);
    // Common pattern: model uses combinations(), intersect(), etc. as plain calls
    // but they shadow SymPy symbols. Add proper imports.
    if (fixedCode.includes('combinations(') && !fixedCode.includes('from itertools')) {
      fixedCode = 'from itertools import combinations, permutations\n' + fixedCode;
    }
    if (fixedCode.includes('intersect(') || fixedCode.includes('.intersect(')) {
      // Replace intersect(a, b) with a.intersect(b) or Intersection(a, b)
      fixedCode = fixedCode.replace(/intersect\(([^,]+),\s*([^)]+)\)/g, 'Intersection($1, $2)');
    }
    // General: if variable is used as function, it might be a missing import
    const symbolCallMatch = errorMsg.match(/(\w+)\(/);
    if (symbolCallMatch) {
      const funcName = symbolCallMatch[1];
      // Check if it's used as a function but defined as a symbol
      if (fixedCode.includes(`${funcName} = symbols`)) {
        // Remove the symbol definition for this name
        fixedCode = fixedCode.replace(new RegExp(`^.*${funcName}\\s*=\\s*symbols.*$`, 'gm'), '');
      }
    }
  }

  // Fix 17: Any object not subscriptable (StrictLessThan, Float, Add, etc.)
  if (errorMsg.includes('not subscriptable')) {
    // Fix solve()[N] when result is not a list
    fixedCode = fixedCode.replace(
      /(\w+)\s*=\s*solve\(([^)]+)\)\[(\d+)\]/g,
      '_sol = solve($2)\n$1 = _sol[$3] if isinstance(_sol, list) else _sol'
    );
    // Fix direct subscript on non-list results (Float, inequality, etc.)
    fixedCode = fixedCode.replace(
      /(\w+)\[(\d+)\]/g,
      '($1[$2] if isinstance($1, (list, tuple)) else $1)'
    );
  }

  // Fix 18: 'list' object has no attribute 'subs' — solve returns list, need element
  if (errorMsg.includes("'list' object has no attribute 'subs'")) {
    fixedCode = fixedCode.replace(
      /(\w+)\.subs\(/g,
      '($1[0] if isinstance($1, list) else $1).subs('
    );
  }

  // Fix 19: div() used as division (should be Rational or /)
  if (errorMsg.includes('ComputationFailed') && fixedCode.includes('div(')) {
    fixedCode = fixedCode.replace(/\bdiv\(([^,]+),\s*([^)]+)\)/g, 'Rational($1, $2)');
  }

  // Fix 20: unsupported operand type for -: 'NegativeOne' and 'str'
  // Model compares numeric result with string options
  if (errorMsg.includes("'str'") && errorMsg.includes('unsupported operand')) {
    // The MC comparison tries to subtract strings — replace with string matching
    fixedCode = fixedCode.replace(
      /abs\(float\(N\((\w+)\[?\d?\]?\)\) - float\(N\(val[^)]*\)\)\)/g,
      'abs(float(N($1[0] if isinstance($1, list) else $1)) - float(N(val))) if not isinstance(val, str) else float("inf")'
    );
    // Also handle the simplify(wynik - val) pattern
    fixedCode = fixedCode.replace(
      /simplify\((\w+) - val\) == 0/g,
      '(str($1) == str(val) if isinstance(val, str) else simplify($1 - val) == 0)'
    );
  }

  // Fix 22a: cos**2(x) → cos(x)**2 — 'int' object is not callable
  if (errorMsg.includes("'int' object is not callable") || errorMsg.includes("'float' object is not callable")) {
    // Pattern: sin**2(x) → sin(x)**2, cos**2(x) → cos(x)**2
    fixedCode = fixedCode.replace(/(sin|cos|tan|cot|sec|csc)\*\*(\d+)\(([^)]+)\)/g, '$1($3)**$2');
  }

  // Fix 22b: 'LessThan'/'GreaterThan' object is not iterable — solve() returned inequality
  if (errorMsg.includes('is not iterable') &&
      (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan') ||
       errorMsg.includes('StrictLessThan') || errorMsg.includes('StrictGreaterThan'))) {
    // Wrap solve result iteration: for sol in solutions → handle single inequality
    fixedCode = fixedCode.replace(
      /for\s+(\w+)\s+in\s+(solutions?\w*|results?\w*|sols?\w*):/g,
      'for $1 in ([$2] if not isinstance($2, (list, tuple, set)) else $2):'
    );
    // Also fix tuple unpacking: interval = (float(solution[0]), float(solution[1]))
    fixedCode = fixedCode.replace(
      /\(float\((\w+)\[0\]\),\s*float\((\w+)\[1\]\)\)/g,
      '(float($1.lhs if hasattr($1, "lhs") else $1[0]), float($1.rhs if hasattr($1, "rhs") else $1[1]))'
    );
  }

  // Fix 22c: Chained comparison in Piecewise: -6 <= x < 0 → And(-6 <= x, x < 0)
  if (errorMsg.includes('Piecewise') || errorMsg.includes('chained comparison') ||
      (errorMsg.includes('TypeError') && fixedCode.includes('Piecewise'))) {
    // Replace chained comparisons like -6 <= x < 0 → And(-6 <= x, x < 0)
    fixedCode = fixedCode.replace(
      /(-?\d+\.?\d*)\s*(<=?)\s*(\w+)\s*(<=?)\s*(-?\d+\.?\d*)/g,
      'And($1 $2 $3, $3 $4 $5)'
    );
  }

  // Fix 22d: 'And' object has no attribute 'lhs'/'rhs' — solve returned compound condition
  if (errorMsg.includes("has no attribute 'lhs'") || errorMsg.includes("has no attribute 'rhs'")) {
    // Extract args from compound: val.lhs → val.args[0].lhs if And
    fixedCode = fixedCode.replace(
      /(\w+)\.lhs/g,
      '($1.args[0].lhs if hasattr($1, "args") and hasattr($1.args[0], "lhs") else $1.lhs if hasattr($1, "lhs") else $1)'
    );
    fixedCode = fixedCode.replace(
      /(\w+)\.rhs/g,
      '($1.args[0].rhs if hasattr($1, "args") and hasattr($1.args[0], "rhs") else $1.rhs if hasattr($1, "rhs") else $1)'
    );
  }

  // Fix 22e: .subs(x == value) → .subs(x, value) — wrong subs syntax
  if (errorMsg.includes('not subscriptable') || errorMsg.includes('cannot determine truth') ||
      errorMsg.includes('new pairs or an iterable of (old, new) tuples') ||
      fixedCode.match(/\.subs\(\w+\s*==\s*[^,)]+\)/)) {
    fixedCode = fixedCode.replace(
      /\.subs\((\w+)\s*==\s*([^)]+)\)/g,
      '.subs($1, $2)'
    );
    fixedCode = fixedCode.replace(
      /\.subs\(Eq\((\w+),\s*([^)]+)\)\)/g,
      '.subs($1, $2)'
    );
  }

  // Fix 22f: Code executed but produced no output — add print statement
  if (errorMsg.includes('produced no output') || errorMsg.includes('no output')) {
    // Check if there's no print statement
    if (!fixedCode.includes('print(')) {
      // Find the last assignment and print it
      const lines = fixedCode.split('\n');
      const lastAssign = [...lines].reverse().find(l => /^\s*\w+\s*=/.test(l) && !l.includes('symbols('));
      if (lastAssign) {
        const varName = lastAssign.match(/^\s*(\w+)\s*=/)?.[1];
        if (varName) {
          fixedCode += `\nprint("ODPOWIEDZ:", ${varName})`;
        }
      } else {
        // Last resort: print result variable if exists
        fixedCode += '\nprint("ODPOWIEDZ:", result if "result" in dir() else wynik if "wynik" in dir() else "BRAK")';
      }
    }
  }

  // Fix 22g: line() lowercase — should be Line() from geometry
  if (errorMsg.includes("'Symbol' object is not callable") && fixedCode.includes('line(')) {
    fixedCode = fixedCode.replace(/\bline\(/g, 'Line(');
    if (!fixedCode.includes('from sympy.geometry')) {
      fixedCode = 'from sympy.geometry import *\n' + fixedCode;
    }
  }

  // Fix 22h: KeyError on variable name or integer — solve() may return dict
  if (errorMsg.includes('KeyError:')) {
    const keyMatch = errorMsg.match(/KeyError:\s*(\w+)/);
    if (keyMatch) {
      const badKey = keyMatch[1];
      if (/^\d+$/.test(badKey)) {
        // KeyError: 0 — solve() returned dict, not list. Convert dict indexing to list(dict.values())
        fixedCode = fixedCode.replace(
          /(\w+)\[0\]/g,
          '(list($1.values())[0] if isinstance($1, dict) else $1[0])'
        );
        fixedCode = fixedCode.replace(
          /(\w+)\[1\]/g,
          '(list($1.values())[1] if isinstance($1, dict) else $1[1])'
        );
      } else {
        fixedCode = fixedCode.replace(
          new RegExp(`(\\w+)\\[${badKey}\\]`, 'g'),
          `($1[Symbol('${badKey}')] if Symbol('${badKey}') in $1 else ($1[0] if isinstance($1, (list, tuple)) else $1))`
        );
      }
    }
  }

  // Fix 22i: 'tuple' object has no attribute 'subs' — model built tuple instead of expression
  if (errorMsg.includes("'tuple' object has no attribute 'subs'")) {
    fixedCode = fixedCode.replace(
      /\(([^,]+),\s*([^)]+)\)\.subs\(/g,
      '$2.subs('
    );
  }

  // Fix 22j: 'Float' object is not subscriptable — double indexing on scalar
  if (errorMsg.includes("'Float' object is not subscriptable") || errorMsg.includes("'Integer' object is not subscriptable") || errorMsg.includes("'Rational' object is not subscriptable")) {
    fixedCode = fixedCode.replace(/(\w+\[\w+\])\[\w+\]/g, '$1');
    fixedCode = fixedCode.replace(/(\w+)\[0\]\[0\]/g, '$1[0]');
  }

  // Fix 22k: 'StrictLessThan'/'LessThan'/'GreaterThan' not subscriptable — only solve-result vars
  if (errorMsg.includes("object is not subscriptable") && (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan') || errorMsg.includes('StrictLessThan') || errorMsg.includes('StrictGreaterThan'))) {
    fixedCode = fixedCode.replace(/\b(solution|solutions|rozwiazanie|rozwiązanie|result|results|sol|wynik|answer|roots|rozwiazania|rozwiązania|rozwiązanie_uproszczone|uproszczone_rozwiązanie)\[0\]/g, '$1');
  }

  // Fix 22l: object of type 'StrictLessThan' has no len()
  if (errorMsg.includes("has no len()") && (errorMsg.includes('LessThan') || errorMsg.includes('GreaterThan'))) {
    fixedCode = fixedCode.replace(/if\s+len\((\w+)\)/g, 'if hasattr($1, "__iter__") and len(list($1.args))');
    fixedCode = fixedCode.replace(/len\((\w+)\)\s*==\s*(\d+)/g, 'hasattr($1, "__iter__") and len(list($1.args)) == $2');
  }

  // Fix 22m: 'BooleanAtom not allowed in this context'
  if (errorMsg.includes('BooleanAtom') || errorMsg.includes('BooleanTrue') || errorMsg.includes('BooleanFalse')) {
    fixedCode = fixedCode.replace(/float\(N\((\w+)\)\)/g, 'float($1) if not isinstance($1, (bool, BooleanTrue, BooleanFalse)) else (1.0 if $1 else 0.0)');
  }

  // Fix 22n: 'Symbol' object is not callable
  if (errorMsg.includes("'Symbol' object is not callable")) {
    fixedCode = fixedCode.replace(
      /\bdistance\(([^,]+),\s*([^)]+)\)/g,
      'sqrt(($1[0]-$2[0])**2 + ($1[1]-$2[1])**2)'
    );
    fixedCode = fixedCode.replace(
      /\bPochhammer\((\d+),\s*(\d+)\)/g,
      'log($2, $1)'
    );
  }

  // Fix 22o: 'Add'/'Mul' object has no attribute 'zero'/'coeffs'
  if (errorMsg.includes("has no attribute 'zero'")) {
    fixedCode = fixedCode.replace(/\.zero\(\)/g, '');
  }
  if (errorMsg.includes("has no attribute 'coeffs'")) {
    fixedCode = fixedCode.replace(/\.coeffs\b/g, '.as_coefficients_dict()');
  }

  // Fix 22p: 'Piecewise'/'Function' object has no attribute 'range'
  if (errorMsg.includes("has no attribute 'range'")) {
    fixedCode = fixedCode.replace(/^(.*\.range\(\).*)$/gm, '# $1  # .range() not available');
  }

  // Fix 22q: 'Symbol' object is not callable — f(x) where f is a symbol
  if (errorMsg.includes("'Symbol' object is not callable") && fixedCode.includes("symbols('f')")) {
    fixedCode = fixedCode.replace(/(\w+)\s*=\s*symbols\('f'\)/, "f = Function('f')(x)");
  }

  // Fix 22r-pre: 'Or'/'And' object has no attribute 'intersection'
  if (errorMsg.includes("has no attribute 'intersection'")) {
    fixedCode = fixedCode.replace(
      /(\w+)\.intersection\((\w+)\)/g,
      'Intersection($1, $2)'
    );
  }

  // Fix 22r-pre2: cannot unpack non-iterable Integer/Float
  if (errorMsg.includes('cannot unpack non-iterable') && (errorMsg.includes('Integer') || errorMsg.includes('Float') || errorMsg.includes('Rational'))) {
    fixedCode = fixedCode.replace(
      /(\w+),\s*(\w+)\s*=\s*(\w+)\[0\]/g,
      '_vals = list($3.values()) if isinstance($3, dict) else $3[0] if isinstance($3, list) else ($3,)\n$1, $2 = _vals[0], _vals[1] if len(_vals) > 1 else _vals[0]'
    );
  }

  // Fix 22r: 'NoneType' — solve() returned None
  if (errorMsg.includes("'NoneType'") && (errorMsg.includes('unsupported operand') || errorMsg.includes('not subscriptable') || errorMsg.includes('not iterable'))) {
    fixedCode = fixedCode.replace(
      /(\w+)\s*=\s*solve\(([^)]+)\)(\[(\d+)\])?/g,
      (match: string, varName: string, args: string, indexPart: string, idx: string) => {
        if (indexPart) {
          return `_tmp = solve(${args})\n${varName} = _tmp[${idx}] if _tmp else 0`;
        }
        return `${varName} = solve(${args}) or []`;
      }
    );
  }

  // Fix 22s: Interval.open_left/open_right don't exist
  if (errorMsg.includes("has no attribute 'open_left'") || errorMsg.includes("has no attribute 'open_right'")) {
    fixedCode = fixedCode.replace(/Interval\.open_left\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, left_open=True)');
    fixedCode = fixedCode.replace(/Interval\.open_right\(([^,]+),\s*([^)]+)\)/g, 'Interval($1, $2, right_open=True)');
    fixedCode = fixedCode.replace(/Interval\.open_left\(([^)]+)\)/g, 'Interval($1, oo, left_open=True)');
    fixedCode = fixedCode.replace(/Interval\.open_right\(([^)]+)\)/g, 'Interval(-oo, $1, right_open=True)');
  }

  // Fix 22: Equality.__new__() missing argument
  if (errorMsg.includes("Equality.__new__() missing")) {
    const fixEqOneArg = (src: string): string => {
      let result = '';
      let i = 0;
      while (i < src.length) {
        if (src.substring(i, i + 3) === 'Eq(' && (i === 0 || !/\w/.test(src[i - 1]))) {
          let depth = 1;
          let j = i + 3;
          while (j < src.length && depth > 0) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') depth--;
            j++;
          }
          const inner = src.substring(i + 3, j - 1);
          let d = 0;
          let hasComma = false;
          for (const ch of inner) {
            if (ch === '(') d++;
            else if (ch === ')') d--;
            else if (ch === ',' && d === 0) { hasComma = true; break; }
          }
          if (!hasComma) {
            result += `Eq(${inner}, 0)`;
          } else {
            result += src.substring(i, j);
          }
          i = j;
        } else {
          result += src[i];
          i++;
        }
      }
      return result;
    };
    fixedCode = fixEqOneArg(fixedCode);
  }

  // Fix 22t: "Relational cannot be used in Mul"
  if (errorMsg.includes('Relational cannot be used in')) {
    fixedCode = fixedCode.replace(
      /if\s+(simplify\([^)]+\))\s*([<>]=?)\s*(\d+):/g,
      'if bool($1 $2 $3):'
    );
    fixedCode = fixedCode.replace(
      /if\s+([^:]+?)\s*([<>]=?)\s*(\d+)\s*:/g,
      (match, expr, op, val) => {
        if (expr.includes('bool(')) return match;
        return `if bool(${expr} ${op} ${val}):`;
      }
    );
  }

  // Fix 22u: .subs(Eq(...)) or .subs(prosta) where prosta = Eq(y, expr)
  if (errorMsg.includes('old: new pairs') || errorMsg.includes('old, new') || errorMsg.includes('should be a dictionary')) {
    fixedCode = fixedCode.replace(
      /\.subs\(Eq\((\w+),\s*([^)]+)\)\)/g,
      '.subs($1, $2)'
    );
    const eqVars: string[] = [];
    const fixLines = fixedCode.split('\n');
    for (const line of fixLines) {
      const m = line.match(/(\w+)\s*=\s*Eq\((\w+),/);
      if (m) eqVars.push(m[1]);
    }
    for (const eqVar of eqVars) {
      const re = new RegExp(`\\.subs\\(${eqVar}\\)`, 'g');
      fixedCode = fixedCode.replace(re, `.subs(${eqVar}.lhs, ${eqVar}.rhs)`);
    }
  }

  // Fix 22v: "Cannot round symbolic expression"
  if (errorMsg.includes('Cannot round symbolic')) {
    fixedCode = fixedCode.replace(
      /N\(([^)]+)\)\.round\((\d+)\)/g,
      'round(float(N($1)), $2)'
    );
    fixedCode = fixedCode.replace(
      /(\w+)\.round\((\d+)\)/g,
      'round(float(N($1)), $2)'
    );
  }

  // Fix 22w: unsupported operand type for -/+/*: 'LessThan'/'GreaterThan'/etc
  if (errorMsg.includes('unsupported operand type') &&
      (errorMsg.includes("'LessThan'") || errorMsg.includes("'GreaterThan'") ||
       errorMsg.includes("'StrictLessThan'") || errorMsg.includes("'StrictGreaterThan'") ||
       errorMsg.includes("'NegativeOne'"))) {
    const fixLines = fixedCode.split('\n');
    for (let i = 0; i < fixLines.length; i++) {
      const t = fixLines[i].trim();
      if (/^\w+\s*=\s*\w+\s*[+\-*/]\s*.+/.test(t)) {
        const m = t.match(/^(\w+)\s*=\s*(\w+)\s*[+\-*/]/);
        if (m && m[1] === m[2]) {
          fixLines[i] = `# ${t}  # SKIP: Relational arithmetic`;
        }
      }
    }
    fixedCode = fixLines.join('\n');
    if (errorMsg.includes("'NegativeOne'") && errorMsg.includes("'str'")) {
      fixedCode = fixedCode.replace(
        /(\w+)\s*-\s*['"]([^'"]+)['"]/g,
        'str($1) == "$2"'
      );
    }
  }

  // Fix 22x: 'StrictLessThan'/'LessThan' object is not iterable
  if (errorMsg.includes('not iterable') &&
      (errorMsg.includes("'StrictLessThan'") || errorMsg.includes("'LessThan'") ||
       errorMsg.includes("'GreaterThan'") || errorMsg.includes("'StrictGreaterThan'"))) {
    fixedCode = fixedCode.replace(
      /for\s+(\w+)\s+in\s+solve\(([^)]+)\):/g,
      '_sol = solve($2)\nfor $1 in (_sol if hasattr(_sol, "__iter__") else [_sol]):'
    );
  }

  // Fix 22y: SympifyError on list/tuple
  if (errorMsg.includes('SympifyError')) {
    fixedCode = fixedCode.replace(
      /sympify\((\w+)\)/g,
      '$1  # removed sympify() wrapper'
    );
  }

  return fixedCode;
}

/**
 * Execute SymPy code with sanitization and auto-retry on failure.
 * This is the main entry point for code execution — used by both web app and test harness.
 */
/**
 * Check if stdout looks like it contains an error rather than a real answer.
 * Some Python errors print to stdout (e.g. via except blocks) or produce
 * suspicious output like "None", empty ODPOWIEDZ, etc.
 */
function isOutputSuspicious(stdout: string): string | null {
  const trimmed = stdout.trim();

  // Error patterns that indicate the code "ran" but produced an error-like output
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
    if (pat.test(trimmed)) {
      return `Output contains error: ${trimmed.substring(0, 120)}`;
    }
  }

  // Output is just "None" or "ODPOWIEDZ: None"
  if (/^(?:ODPOWIEDZ:\s*)?None\s*$/i.test(trimmed)) {
    return 'Output is None — solve() likely returned empty';
  }

  return null; // output looks OK
}

async function executeWithSanitizeAndRetry(rawCode: string, maxRetries: number = 3): Promise<string> {
  const baseImports = "from sympy import *\nimport sys\nsys.set_int_max_str_digits(0)\n";

  // Sanitize first
  let currentCode = sanitizeCode(rawCode);

  // Remove duplicate base imports since we prepend them
  currentCode = currentCode.replace(/^from sympy import \*\s*$/gm, '');
  currentCode = currentCode.replace(/^import sys\s*$/gm, '');
  currentCode = currentCode.replace(/^sys\.set_int_max_str_digits\(\d+\)\s*$/gm, '');

  const fullCode = `${baseImports}\n${currentCode}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const codeToRun = attempt === 0 ? fullCode : `${baseImports}\n${currentCode}`;
    const result = await executePythonSymPyRaw(codeToRun);

    if (result.exitCode === 0 && result.stdout) {
      // Check if stdout contains error-like content
      const suspicion = isOutputSuspicious(result.stdout);
      if (suspicion && attempt < maxRetries) {
        console.error(`⚠️ Attempt ${attempt + 1}: ${suspicion}`);
        // Treat as error and try to fix
        const fixedCode = tryFixCode(currentCode, result.stdout);
        if (fixedCode !== currentCode) {
          currentCode = fixedCode;
          continue;
        }
        // If no fix but stderr has info, try fixing from stderr
        if (result.stderr) {
          const fixedFromStderr = tryFixCode(currentCode, result.stderr);
          if (fixedFromStderr !== currentCode) {
            currentCode = fixedFromStderr;
            continue;
          }
        }
        // No fix found — return the output as-is (some "suspicious" outputs might be valid)
        return result.stdout;
      }
      return result.stdout;
    }

    if (result.exitCode === 0 && !result.stdout) {
      // Code ran but no output — might have stderr with warnings
      if (attempt < maxRetries && result.stderr) {
        const fixedCode = tryFixCode(currentCode, result.stderr);
        if (fixedCode !== currentCode) {
          currentCode = fixedCode;
          continue;
        }
      }
      throw new Error('Code executed but produced no output');
    }

    // exitCode != 0 — real error
    if (attempt < maxRetries) {
      const fixedCode = tryFixCode(currentCode, result.stderr);
      if (fixedCode === currentCode) {
        // No fix found
        throw new Error(`Python error: ${result.stderr}`);
      }
      currentCode = fixedCode;
    } else {
      throw new Error(`Python error: ${result.stderr}`);
    }
  }

  throw new Error('Exhausted retries');
}

/**
 * Handle tool execution
 */
async function handleToolCall(name: string, args: any): Promise<string> {
  const baseImports = "from sympy import *\nimport sys\nsys.set_int_max_str_digits(0)\n";

  try {
    switch (name) {
      case "sympy_calculate": {
        // Check if expression is multi-line code or single expression
        if (!args.expression && !args.code) {
          return "Error: No expression or code provided to sympy_calculate";
        }
        let expression = (args.expression || args.code || '').trim();

        if (expression.includes('\n') || expression.startsWith('from ')) {
          // Multi-line script — use comprehensive sanitization + retry
          return await executeWithSanitizeAndRetry(expression);
        } else {
          // Single expression - wrap it
          const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
          const builtins = ['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo', 'Eq', 'Rational', 'result', 'print', 'True', 'False', 'None', 'abs', 'Sum', 'Product', 'N', 'Float', 'Integer', 'latex', 'pprint', 'trigsimp', 'radsimp', 'nsimplify', 'cancel', 'apart', 'together'];
          const potentialSymbols = (expression.match(symbolsRegex) || [])
            .filter((s: string) => !builtins.includes(s));
          const uniqueSymbols = [...new Set(potentialSymbols)];

          const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
result = ${expression}
print(result)`;
          return await executePythonSymPy(code);
        }
      }

      case "sympy_simplify": {
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = simplify(expr)
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_solve": {
        // Extract all potential symbols from the equation AND variable
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.equation.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo', 'Eq'].includes(s));
        // Also add the variable we're solving for
        potentialSymbols.push(args.variable);
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
result = solve(${args.equation}, ${args.variable})
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_differentiate": {
        const order = args.order || 1;
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = diff(expr, ${args.variable}, ${order})
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_integrate": {
        let integralArgs = `${args.variable}`;
        if (args.lower_limit && args.upper_limit) {
          integralArgs = `(${args.variable}, ${args.lower_limit}, ${args.upper_limit})`;
        }
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = integrate(expr, ${integralArgs})
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_expand": {
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = expand(expr)
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_factor": {
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = factor(expr)
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_limit": {
        // Extract all potential symbols from the expression
        const symbolsRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const potentialSymbols = (args.expression.match(symbolsRegex) || [])
          .filter((s: string) => !['symbols', 'diff', 'integrate', 'solve', 'simplify', 'expand', 'factor', 'limit', 'Matrix', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pi', 'E', 'I', 'oo'].includes(s));
        const uniqueSymbols = [...new Set(potentialSymbols)];

        const code = `${baseImports}
${uniqueSymbols.map(s => `${s} = symbols('${s}')`).join('\n')}
expr = ${args.expression}
result = limit(expr, ${args.variable}, ${args.point})
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_matrix": {
        // Convert matrix to proper Python format
        let matrixStr: string;
        if (typeof args.matrix === 'string') {
          // Already a string, use as-is
          matrixStr = args.matrix;
        } else {
          // Array - convert to JSON then to Python list format
          matrixStr = JSON.stringify(args.matrix);
        }

        const code = `${baseImports}
M = Matrix(${matrixStr})
if '${args.operation}' == 'det':
    result = M.det()
elif '${args.operation}' == 'inverse':
    result = M.inv()
elif '${args.operation}' == 'eigenvals':
    result = M.eigenvals()
elif '${args.operation}' == 'eigenvects':
    result = M.eigenvects()
elif '${args.operation}' == 'transpose':
    result = M.T
else:
    result = 'Unknown operation'
print(result)`;
        return await executePythonSymPy(code);
      }

      case "sympy_plot": {
        if (!args.code) {
          return "Error: No code provided to sympy_plot";
        }
        // Execute the code as-is; it must print SVG to stdout
        const plotResult = await executePythonSymPyRaw(args.code);
        if (plotResult.exitCode !== 0) {
          return `Error: Plot generation failed: ${plotResult.stderr}`;
        }
        const svgOutput = plotResult.stdout.trim();
        if (!svgOutput.includes('<svg')) {
          return `Error: Code did not produce SVG output. Got: ${svgOutput.substring(0, 200)}`;
        }
        return svgOutput;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    throw new Error(`SymPy execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Main server setup
 */
async function main() {
  const server = new Server(
    {
      name: "mcp-sympy-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args || {});
      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("SymPy MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
