# MCP SymPy Server

Model Context Protocol (MCP) server for **SymPy** mathematical computations. Enables AI assistants to perform symbolic mathematics, calculus, algebra, and advanced mathematical operations.

## Features

The server provides 9 powerful mathematical tools:

### 1. **sympy_calculate**
Execute arbitrary SymPy expressions.
```python
# Examples:
integrate(x**2, x)
solve(x**2 - 4, x)
diff(sin(x), x)
```

### 2. **sympy_simplify**
Simplify mathematical expressions.
```python
# Example: sin(x)**2 + cos(x)**2 → 1
```

### 3. **sympy_solve**
Solve equations or systems of equations.
```python
# Examples:
x**2 - 4  # Solve for x
Eq(x**2 + y**2, 25)  # With explicit equation
```

### 4. **sympy_differentiate**
Compute derivatives (with support for higher-order derivatives).
```python
# Examples:
expression: x**3 + 2*x
variable: x
order: 1  # Optional, default is 1
```

### 5. **sympy_integrate**
Compute indefinite or definite integrals.
```python
# Indefinite: integrate x**2 dx
# Definite: integrate x**2 from 0 to 1
```

### 6. **sympy_expand**
Expand algebraic expressions.
```python
# Example: (x + 1)**2 → x**2 + 2*x + 1
```

### 7. **sympy_factor**
Factor expressions.
```python
# Example: x**2 - 4 → (x - 2)(x + 2)
```

### 8. **sympy_limit**
Compute limits.
```python
# Example: lim(x→0) sin(x)/x = 1
expression: sin(x)/x
variable: x
point: 0
```

### 9. **sympy_matrix**
Perform matrix operations.
```python
# Operations: det, inverse, eigenvals, eigenvects, transpose
matrix: [[1, 2], [3, 4]]
operation: det
```

## Prerequisites

- **Node.js** >= 18.0.0
- **Python 3** with **SymPy** installed

Install SymPy:
```bash
pip install sympy
```

Or with conda:
```bash
conda install sympy
```

## Installation

1. **Install dependencies:**
   ```bash
   cd mcp-sympy-server
   npm install
   ```

2. **Build the server:**
   ```bash
   npm run build
   ```

## Usage

### Running the Server

The server uses stdio for MCP communication:

```bash
npm start
# or
node dist/index.js
```

### Configuration for Claude Desktop

Add to your Claude Desktop config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "sympy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-sympy-server/dist/index.js"]
    }
  }
}
```

Or if installed globally:
```json
{
  "mcpServers": {
    "sympy": {
      "command": "mcp-sympy-server"
    }
  }
}
```

### Configuration for Other MCP Clients

For any MCP client, configure it to run:
```bash
node /path/to/mcp-sympy-server/dist/index.js
```

## Example Usage

Once connected, you can ask your AI assistant:

- "Calculate the derivative of x³ + 2x with respect to x"
- "Solve the equation x² - 4 = 0"
- "Integrate x² from 0 to 1"
- "Simplify sin(x)² + cos(x)²"
- "Find the limit of sin(x)/x as x approaches 0"
- "Factor x² - 4"
- "Expand (x + 1)³"
- "Find the determinant of [[1, 2], [3, 4]]"

The assistant will use the appropriate SymPy tool to compute the result.

## Development

### Watch mode (auto-rebuild on changes):
```bash
npm run watch
```

### Run after building:
```bash
npm run dev
```

## Architecture

The server:
1. Receives MCP tool call requests via stdio
2. Translates requests into Python/SymPy code
3. Executes Python code using `spawn`
4. Returns formatted results back through MCP

All computations are performed in isolated Python processes for safety.

## Error Handling

The server handles:
- Invalid expressions
- Python execution errors
- Malformed tool arguments
- Missing dependencies

Errors are returned as MCP error responses with descriptive messages.

## Reference

- [SymPy Documentation](https://docs.sympy.org/latest/index.html)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)

## License

MIT
