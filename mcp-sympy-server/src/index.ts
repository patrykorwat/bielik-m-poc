#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to venv Python (if exists) or fallback to system python3
const VENV_PYTHON = join(__dirname, "..", "venv", "bin", "python3");

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
];

/**
 * Execute Python code with SymPy
 */
async function executePythonSymPy(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = spawn(VENV_PYTHON, ["-c", code]);
    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python error: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
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
        const expression = args.expression.trim();
        let code: string;

        if (expression.includes('\n') || expression.startsWith('from ')) {
          // Multi-line script - execute as is (should already have print statements)
          code = `${baseImports}\n${expression}`;
        } else {
          // Single expression - wrap it
          code = `${baseImports}
result = ${expression}
print(result)`;
        }
        return await executePythonSymPy(code);
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
        const code = `${baseImports}
M = Matrix(${args.matrix})
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
