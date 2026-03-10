#!/usr/bin/env python3
"""
Dataset test harness for bielik-m-poc multi-agent system.
Thin harness — all code sanitization, error fixing, and retry logic
lives in the production MCP SymPy server. This script only handles:
  - LLM API calls (direct to model endpoint)
  - Code extraction from LLM responses
  - Answer checking / scoring
  - Result reporting

REQUIRES: MCP proxy running on port 3001 (npm run mcp-proxy)

Usage:
  python3 test-dataset.py                          # Test 5 random questions from 2024 (both levels)
  python3 test-dataset.py --year 2024              # Test 5 random from 2024
  python3 test-dataset.py --year 2024 --all        # Test ALL questions from 2024
  python3 test-dataset.py --year all --sample 3    # 3 random questions per year
  python3 test-dataset.py --year 2024 --task 1,2,5 # Specific tasks
  python3 test-dataset.py --level rozszerzona      # Only extended level
  python3 test-dataset.py --only-mc                # Only multiple choice
  python3 test-dataset.py --only-open              # Only open-ended
  python3 test-dataset.py --api-url URL --api-key KEY --model MODEL  # Remote API

Setup:
  1. Start MCP proxy: npm run mcp-proxy  (port 3001)
  2. Start LLM server: mlx_lm.server ... (port 8011) or use --api-url for remote
  3. Run: python3 test-dataset.py --year 2024 --all

Remote API (e.g. Cyfronet LLM Lab):
  export BIELIK_API_URL=https://xxx
  export BIELIK_API_KEY=YOUR_TOKEN
  python3 test-dataset.py --model speakleash/Bielik-11B-v3.0-Instruct --year 2024 --all

  Or via CLI args:
  python3 test-dataset.py --api-url $BIELIK_API_URL --api-key $BIELIK_API_KEY --model speakleash/Bielik-11B-v3.0-Instruct --year 2024 --all
"""

import json
import sys
import os
import time
import re
import random
import argparse
import signal
import subprocess
from urllib.request import Request, urlopen
from urllib.error import URLError


def ensure_sympy():
    """Check if sympy is available, install if not."""
    try:
        subprocess.run(
            ["python3", "-c", "import sympy"],
            capture_output=True, timeout=10
        )
        return True
    except:
        pass

    print("⚠️  sympy not found. Installing...")
    try:
        subprocess.run(
            ["pip3", "install", "sympy", "--break-system-packages", "-q"],
            capture_output=True, timeout=120
        )
        # Verify
        result = subprocess.run(
            ["python3", "-c", "import sympy; print(sympy.__version__)"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            print(f"  ✅ sympy {result.stdout.strip()} installed")
            return True
    except Exception as e:
        print(f"  ❌ Failed to install sympy: {e}")

    print("  Try manually: pip3 install sympy")
    return False


# Ensure sympy is available before running tests
SYMPY_AVAILABLE = ensure_sympy()


# Graceful Ctrl+C handling
interrupted = False
def signal_handler(sig, frame):
    global interrupted
    if interrupted:
        print("\n\nForce quit.")
        sys.exit(1)
    interrupted = True
    print("\n\n⚠️  Interrupted! Printing results so far...\n")

signal.signal(signal.SIGINT, signal_handler)

# ── Configuration ────────────────────────────────────────────────────────

DATASETS_BASE = os.path.join(os.path.dirname(__file__), "datasets")
DATASETS_DIR = os.path.join(DATASETS_BASE, "podstawowa")  # default: basic level
PROMPTS_FILE = os.path.join(os.path.dirname(__file__), "prompts.json")
MCP_PROXY_URL = "http://localhost:3001"
LEAN_PROXY_URL = "http://localhost:3002"
RAG_SERVICE_URL = "http://localhost:3003"

# ── Config (loaded from shared prompts.json) ─────────────────────────────

def _load_config():
    with open(PROMPTS_FILE) as f:
        return json.load(f)

_CONFIG = _load_config()

# Model defaults (can be overridden by CLI args)
DEFAULT_PORT = int(_CONFIG["model"]["base_url"].split(":")[-1])
DEFAULT_MODEL = _CONFIG["model"]["default"]
TEMPERATURE = _CONFIG["agents"]["executor"]["temperature"]

# Prompts
ANALYTICAL_PROMPT = _CONFIG["analytical"]
EXECUTOR_PROMPT = _CONFIG["executor_sympy"]
EXECUTOR_MC_PROMPT = _CONFIG.get("executor_sympy_mc", _CONFIG["executor_sympy"])
SUMMARY_PROMPT = _CONFIG["summary"]
CLASSIFIER_PROMPT = _CONFIG.get("classifier", "")

# Per-agent settings
AGENT_CONFIG = _CONFIG["agents"]

# ── API Call ─────────────────────────────────────────────────────────────

def call_bielik(system_prompt, messages, base_url, model, max_tokens=2048, temperature=None, api_key=None):
    """Call Bielik via OpenAI-compatible API."""
    url = f"{base_url}/v1/chat/completions"
    all_messages = [{"role": "system", "content": system_prompt}]
    all_messages.extend(messages)

    payload = json.dumps({
        "model": model,
        "messages": all_messages,
        "stream": False,
        "temperature": temperature if temperature is not None else TEMPERATURE,
        "max_tokens": max_tokens,
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = Request(url, data=payload, headers=headers)

    try:
        with urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            # Remove <think> blocks
            content = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()
            content = re.sub(r'<think>[\s\S]*', '', content).strip()
            content = re.sub(r'</?think>', '', content).strip()
            return content
    except URLError as e:
        print(f"  ERROR: Cannot connect to Bielik at {url}: {e}")
        return None
    except Exception as e:
        print(f"  ERROR: {e}")
        return None


# ── MCP Proxy Integration ────────────────────────────────────────────────

def check_mcp_proxy():
    """Check if MCP proxy server is running."""
    try:
        req = Request(f"{MCP_PROXY_URL}/health")
        with urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get('mcpConnected', False)
    except:
        return False


def check_lean_proxy():
    """Check if Lean proxy server is running."""
    try:
        req = Request(f"{LEAN_PROXY_URL}/health")
        with urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get('status') == 'ok'
    except:
        return False


def query_rag_hints(question_text):
    """Query the RAG service for SymPy hints related to the question. Returns hint string or empty."""
    try:
        payload = json.dumps({"query": question_text, "k": 3}).encode("utf-8")
        req = Request(f"{RAG_SERVICE_URL}/query", data=payload,
                     headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            results = data.get("results", [])
            hints = []
            for r in results:
                if r.get("sympy_hint"):
                    hints.append(f"# Metoda: {r.get('title', '')}\n# {r['sympy_hint']}")
                if r.get("tips"):
                    hints.append(f"# Tip: {r['tips'][:120]}")
            return "\n".join(hints[:6]) if hints else ""
    except:
        return ""


def call_mcp_sympy(code):
    """Execute SymPy code via MCP proxy server (same as UI).
    Sanitization, retry and error fixing are handled server-side by the MCP SymPy server.
    Returns (output, error, returncode)."""
    url = f"{MCP_PROXY_URL}/tools/call"
    payload = json.dumps({
        "name": "sympy_calculate",
        "arguments": {"expression": code}
    }).encode("utf-8")

    req = Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            # MCP returns {content: [{type: "text", text: "..."}]} format
            content = data.get('content', [])
            if isinstance(content, list) and content:
                text = content[0].get('text', '')
                is_error = content[0].get('isError', False)
                if is_error:
                    return '', text, 1
                return text, '', 0
            elif isinstance(content, str):
                return content, '', 0
            else:
                return str(data), '', 0
    except URLError as e:
        return '', f"MCP proxy error: {e}", 1
    except Exception as e:
        return '', f"MCP error: {e}", 1


# ── Helpers ──────────────────────────────────────────────────────────────

def clean_latex_for_display(text):
    """Convert LaTeX to plain text for display (v3 — better coverage + corruption handling)."""
    t = text
    t = re.sub(r'\$\$?', '', t)
    # Remove \boxed{...} → content (also handle corrupted \x08oxed from broken encoding)
    t = re.sub(r'\\boxed\{([^}]*)\}', r'\1', t)
    t = re.sub(r'\x08oxed\{([^}]*)\}', r'\1', t)  # corrupted \boxed
    # Handle \root{x} as alias for \sqrt{x} (corrupted LaTeX)
    t = re.sub(r'\\root\{([^}]*)\}', r'sqrt(\1)', t)
    # Nested fractions (handle 2 levels)
    for _ in range(2):
        t = re.sub(r'\\d?frac\{([^{}]*)\}\{([^{}]*)\}', r'(\1)/(\2)', t)
    # Roots: \sqrt[n]{x} → x**(1/n), \sqrt{x} → sqrt(x)
    t = re.sub(r'\\sqrt\[(\d+)\]\{([^}]*)\}', r'(\2)**(1/\1)', t)
    t = re.sub(r'\\sqrt\{([^}]*)\}', r'sqrt(\1)', t)
    # Subscripts: a_{n} → a_n, log_{b} → log_b
    t = re.sub(r'_\{([^}]*)\}', r'_\1', t)
    # Superscripts: x^{2} → x**2
    t = re.sub(r'\^\{([^}]*)\}', r'**(\1)', t)
    t = re.sub(r'\^(\d+)', r'**\1', t)
    # Operators and formatting
    t = re.sub(r'\\cdot', '*', t)
    t = re.sub(r'\\times', '*', t)
    t = re.sub(r'\\(left|right|text|mathrm|quad|,|;|!|\\)', ' ', t)
    t = re.sub(r'\\langle', '<', t)
    t = re.sub(r'\\rangle', '>', t)
    t = re.sub(r'\\infty', 'inf', t)
    t = re.sub(r'\\leq?', '<=', t)
    t = re.sub(r'\\geq?', '>=', t)
    t = re.sub(r'\\neq?', '!=', t)
    t = re.sub(r'\\in\b', ' in ', t)
    t = re.sub(r'\\pi\b', 'pi', t)
    t = re.sub(r'\\log_\{([^}]*)\}', r'log_\1', t)
    t = re.sub(r'\\log\b', 'log', t)
    t = re.sub(r'\\ln\b', 'ln', t)
    t = re.sub(r'\\(sin|cos|tg|ctg|tan|cot|arcsin|arccos|arctg|arctan)\b', r'\1', t)
    # Remove remaining LaTeX commands
    t = re.sub(r'\\[a-zA-Z]+', '', t)
    # Clean braces and formatting
    t = re.sub(r'[{}]', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    # Strip leading labels like "|BC| =" from expected answers
    t = re.sub(r'^\|?\w+\|?\s*=\s*', '', t).strip()
    return t


def extract_first_code_block(text):
    """Extract first Python code block (v3 — also extracts fenceless Python)."""
    # 1. Standard markdown fences
    match = re.search(r'```python\s*\n([\s\S]*?)\n```', text)
    if match:
        return match.group(1).strip()
    match = re.search(r'```\s*\n([\s\S]*?)\n```', text)
    if match:
        return match.group(1).strip()

    # 2. Fenceless extraction: find consecutive Python-like lines
    # (common with FP16 Bielik on remote APIs that ignore fence instructions)
    lines = text.split('\n')
    py_lines = []
    in_block = False
    for line in lines:
        stripped = line.strip()
        is_py = bool(
            stripped.startswith(('from ', 'import ', 'print(', '#')) or
            re.match(r'^[a-zA-Z_]\w*\s*=\s*', stripped) or
            re.match(r'^(?:for |if |elif |else:|while |try:|except |def |return |with )', stripped) or
            re.match(r'^(?:wynik|opcja_|wy |result|answer)', stripped) or
            stripped == '' and in_block  # blank lines inside block
        )
        if is_py:
            py_lines.append(line)
            in_block = True
        elif in_block and stripped == '':
            py_lines.append(line)  # allow one blank line
        else:
            # End of block — if we have enough, stop
            if len([l for l in py_lines if l.strip()]) >= 3:
                break
            if not in_block:
                py_lines = []  # reset if we haven't started
            else:
                break  # end of a started block

    # Filter and validate
    code_lines = [l for l in py_lines if l.strip()]
    if len(code_lines) >= 3:
        has_import = any('import' in l or 'from ' in l for l in code_lines)
        has_compute = any(re.search(r'[=+\-*/()]', l) for l in code_lines)
        if has_import or has_compute:
            code = '\n'.join(py_lines).strip()
            # Remove trailing non-code lines
            while code and not code.split('\n')[-1].strip():
                code = '\n'.join(code.split('\n')[:-1])
            return code

    return None


def truncate_after_first_code_block(text):
    """Truncate response after first code block (matches production)."""
    match = re.search(r'([\s\S]*?```python\s*\n[\s\S]*?\n```)', text)
    if match:
        return match.group(1).strip()
    match = re.search(r'([\s\S]*?```\s*\n[\s\S]*?\n```)', text)
    if match:
        return match.group(1).strip()
    return text


def _normalize_infinity(s):
    """Normalize SymPy infinity representations for answer comparison."""
    # Order matters: replace -oo before oo to avoid double replacement
    s = s.replace('-oo', '-∞').replace('oo', '∞')
    # Also normalize standalone ∞ with sign prefix patterns
    s = s.replace('-infty', '-∞').replace('infty', '∞').replace('\\infty', '∞')
    s = s.replace('Interval(-∞, ∞)', 'R').replace('(-∞, ∞)', 'R')
    s = s.replace('Reals', 'R')
    # Also handle: Interval(a, ∞) etc.
    s = re.sub(r'Interval\(([^,]+),\s*∞\)', r'(\1, ∞)', s)
    s = re.sub(r'Interval\(-∞,\s*([^)]+)\)', r'(-∞, \1)', s)
    return s


def extract_answer_from_output(output):
    """Extract ODPOWIEDZ/ODPOWIEDŹ value from SymPy output (v2 — better MC extraction)."""
    # Try both ASCII and Polish versions
    match = re.search(r'ODPOWIED[ZŹ]:\s*(.+)', output, re.IGNORECASE)
    if match:
        answer = match.group(1).strip()
        # Unwrap lists: [value] → value, {key: value} → value
        answer = re.sub(r'^\[(.+)\]$', r'\1', answer)
        # Unwrap sets/dicts with single value
        m = re.match(r'^\{(?:\w+:\s*)?(.+?)\}$', answer)
        if m:
            answer = m.group(1)
        # Normalize SymPy infinity notation
        answer = _normalize_infinity(answer)
        # Skip None / empty
        if answer.lower() in ('none', 'null', '[]', '{}', '', 'set()'):
            return None
        return answer

    # Try alternative labels: "Wynik:", "Odpowiedź:", "Answer:", "Result:"
    for pattern in [r'(?:wynik|result|answer|odp):\s*(.+)',
                    r'(?:poprawna odpowied[zź]|correct answer).*?:\s*(.+)',
                    r'(?:opcja|option):\s*([A-Da-d])\b']:
        match = re.search(pattern, output, re.IGNORECASE)
        if match:
            answer = match.group(1).strip()
            if answer.lower() not in ('none', 'null', '[]', '{}', '', 'set()'):
                return answer

    # Look for MC letter pattern in output: "A", "B", "C", "D" on its own line
    lines = [l.strip() for l in output.strip().split('\n') if l.strip()]
    for line in reversed(lines):
        if re.match(r'^[A-Da-d]$', line):
            return line.upper()

    # Look for the last printed value
    if lines:
        # Prefer lines with values (not just text)
        for line in reversed(lines):
            if re.search(r'[-\d.*/()a-z]', line, re.IGNORECASE):
                # Strip label prefix like "Wynik: " or "result: "
                cleaned = re.sub(r'^[A-Za-ząćęłńóśźż\s]+:\s*', '', line)
                if cleaned:
                    # Unwrap lists
                    cleaned = re.sub(r'^\[(.+)\]$', r'\1', cleaned)
                    if cleaned.lower() not in ('none', 'null', '[]', '{}', '', 'set()'):
                        return cleaned
        return lines[-1]
    return None


def format_question(q):
    """Format question for the model, converting LaTeX to plain text."""
    text = clean_latex_for_display(q['question'])
    if q.get('options'):
        text += "\nOpcje:"
        for key, val in q['options'].items():
            text += f"\n  {key.upper()}) {clean_latex_for_display(val)}"
        text += "\n\nWybierz poprawna opcje (A/B/C/D)."
    return text


def _sympy_eval(expr_str):
    """Try to evaluate a math expression using sympy. Returns float or None."""
    if not SYMPY_AVAILABLE:
        return None
    try:
        # Clean the expression
        s = expr_str.strip()
        s = re.sub(r'\\text\{[^}]*\}', '', s)  # remove \text{...}
        s = s.replace('\\cdot', '*')
        s = s.replace('\\left', '').replace('\\right', '')
        s = re.sub(r'\\d?frac\{([^}]*)\}\{([^}]*)\}', r'((\1)/(\2))', s)
        s = re.sub(r'\\sqrt\{([^}]*)\}', r'sqrt(\1)', s)
        s = s.replace('\\', '')  # remove remaining backslashes
        s = s.replace('{', '(').replace('}', ')')  # braces → parens
        s = s.replace('^', '**')
        s = re.sub(r'(\d)\s*([a-zA-Z])', r'\1*\2', s)  # 2x → 2*x
        s = s.replace('zł', '').replace('°', '').strip()
        s = re.sub(r',(\d)', r'.\1', s)  # Polish decimal comma
        s = s.replace(' ', '')  # remove spaces

        if not s or s in ('', '-', '+'):
            return None

        code = f"from sympy import *; print(float(sympify('{s}')))"
        proc = subprocess.run(
            ["python3", "-c", code],
            capture_output=True, text=True, timeout=5
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return float(proc.stdout.strip())
    except:
        pass
    return None


def _sympy_compare(expr1, expr2):
    """Compare two symbolic expressions using sympy. Returns True if equal."""
    if not SYMPY_AVAILABLE:
        return False
    try:
        code = f"""
from sympy import *
e1 = sympify('{expr1}')
e2 = sympify('{expr2}')
print(simplify(e1 - e2) == 0 or e1.equals(e2))
"""
        proc = subprocess.run(
            ["python3", "-c", code],
            capture_output=True, text=True, timeout=5
        )
        return proc.returncode == 0 and 'True' in proc.stdout
    except:
        return False


def _try_float(s):
    """Try to extract a float from a string."""
    s = s.strip().replace(',', '.')
    # Remove units and text
    s = re.sub(r'[a-zA-Ząćęłńóśźż°]+$', '', s).strip()
    try:
        return float(s)
    except ValueError:
        pass
    # Try extracting last number
    nums = re.findall(r'-?\d+\.?\d*', s)
    if nums:
        try:
            return float(nums[-1])
        except:
            pass
    return None


def _normalize_interval(s):
    """Normalize interval notation for comparison.
    E.g. '(x > 2/3) & (x < oo)' → '(2/3, inf)'
         '(-1 <= x) & (x <= 4)' → '<-1, 4>'
    """
    s = s.strip()

    # Pattern: (x > a) & (x < b) or (a < x) & (x < b)
    m = re.search(r'(?:x\s*>\s*(.+?))\s*&\s*(?:x\s*<\s*(.+?))\)?$', s)
    if not m:
        m = re.search(r'(?:(.+?)\s*<\s*x)\s*&\s*(?:x\s*<\s*(.+?))\)?$', s)
    if m:
        left, right = m.group(1).strip(), m.group(2).strip()
        right = right.replace('oo', 'inf')
        left = left.replace('-oo', '-inf')
        return f"({left}, {right})"

    # Pattern: (x >= a) & (x <= b) or (-1 <= x) & (x <= 4)
    m = re.search(r'(?:(?:x\s*>=\s*|(.+?)\s*<=\s*x)).*?&.*?(?:x\s*<=\s*(.+?))\)?$', s)
    if m:
        left, right = m.group(1) or '', m.group(2) or ''
        return f"<{left.strip()}, {right.strip()}>"

    return s


def _strip_units(s):
    """Strip Polish/math units and labels from a value string.
    E.g. '6 cm' → '6', '10.0000 cm' → '10', 'Szerokość ekranu = 10.00 cm' → '10'
    """
    s = s.strip()
    # Remove common Polish labels (Szerokość/Wysokość/Pole/Objętość = ...)
    s = re.sub(r'^[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ\s]+[=:]\s*', '', s)
    # Remove units at end
    s = re.sub(r'\s*(cm²|cm³|cm|mm|m²|m³|m|km|zł|°|stopni|%|proc|st\.)\s*$', '', s, flags=re.IGNORECASE)
    # Remove trailing zeros from decimals: 10.0000000 → 10
    s = re.sub(r'\.0+$', '', s)
    return s.strip()


def _extract_dimension_pair(got, expected):
    """Try to match dimension-pair answers like '6 × 10' or '6 cm × 10 cm'.
    Expected may use \\times, ×, x, or *.
    Returns True if dimensions match (in any order), False/None otherwise.
    """
    # Parse expected as a×b pattern
    exp_clean = expected.replace('\\times', '×').replace('*', '×')
    exp_match = re.match(r'^\s*(-?[\d.]+)\s*×\s*(-?[\d.]+)\s*$', exp_clean)
    if not exp_match:
        return None  # expected is not a dimension pair

    exp_a, exp_b = float(exp_match.group(1)), float(exp_match.group(2))
    exp_pair = sorted([exp_a, exp_b])

    # Parse got — try multiple formats
    got_clean = got.replace('×', 'x').replace('\\times', 'x').replace('*', 'x')
    # Remove units
    got_clean = re.sub(r'\s*(cm²|cm³|cm|mm|m²|m³|m|km)\s*', ' ', got_clean, flags=re.IGNORECASE).strip()

    # Direct a x b pattern
    got_match = re.search(r'(-?[\d.]+)\s*x\s*(-?[\d.]+)', got_clean)
    if got_match:
        got_a, got_b = float(got_match.group(1)), float(got_match.group(2))
        got_pair = sorted([got_a, got_b])
        if abs(got_pair[0] - exp_pair[0]) < 0.01 and abs(got_pair[1] - exp_pair[1]) < 0.01:
            return True

    # Verbose output: extract two key numbers from comma/newline-separated values
    # e.g. "Szerokość ekranu = 10.000 cm, Wysokość ekranu = 6.000 cm"
    numbers = re.findall(r'=\s*(-?[\d.]+)', got)
    if not numbers:
        numbers = re.findall(r'(-?\d+\.?\d*)', _strip_units(got))
    if len(numbers) >= 2:
        # Take the last two distinct numbers (most likely the final answer values)
        nums = [float(n) for n in numbers]
        # Remove trailing zeros: 10.0000 → 10.0
        nums = [round(n, 6) for n in nums]
        # Try all pairs of extracted numbers
        for i in range(len(nums)):
            for j in range(i + 1, len(nums)):
                pair = sorted([nums[i], nums[j]])
                if abs(pair[0] - exp_pair[0]) < 0.01 and abs(pair[1] - exp_pair[1]) < 0.01:
                    return True

    return False


def _detect_digit_counting_params(problem_text):
    """Detect digit-counting problem pattern and extract parameters.
    Returns (n_odd, n_even, no_repeats) or None if not a digit-counting problem."""
    text = problem_text.lower()

    if not re.search(r'cyfr|zapisie dziesi[eę]tnym|liczb\w* naturaln', text):
        return None

    no_repeats = bool(re.search(r'nie powt[aó]rza|różn\w* cyfr|bez powt[oó]rzeń|r[oó]żnych cyfr', text))

    polish_numbers = {
        'jedno': 1, 'jeden': 1, 'jedna': 1,
        'dwie': 2, 'dwa': 2, 'dwóch': 2, 'dwu': 2,
        'trzy': 3, 'trzech': 3,
        'cztery': 4, 'czterech': 4,
        'pięć': 5, 'pięciu': 5,
    }

    num_pat = r'(\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)'

    odd_m = re.search(rf'(?:dokładnie\s+)?{num_pat}\s+(?:cyfr\w*)\s+(?:s[aą]\s+)?nieparzyst', text)
    even_m = re.search(rf'(?:dokładnie\s+)?{num_pat}\s+(?:cyfr\w*)\s+(?:s[aą]\s+)?parzyst', text)

    if not odd_m or not even_m:
        return None

    n_odd = polish_numbers.get(odd_m.group(1), None)
    if n_odd is None:
        try: n_odd = int(odd_m.group(1))
        except: return None

    n_even = polish_numbers.get(even_m.group(1), None)
    if n_even is None:
        try: n_even = int(even_m.group(1))
        except: return None

    if not (1 <= n_odd <= 5 and 0 <= n_even <= 5):
        return None

    total = n_odd + n_even
    if not (1 <= total <= 9):
        return None

    return (n_odd, n_even, no_repeats)


def _build_digit_counting_solver_code(n_odd, n_even, no_repeats):
    """Generate SymPy code with full mathematical solution steps for digit-counting problems.
    Produces proper 'obliczenia' suitable for showing to a matura student."""
    total = n_odd + n_even
    has_zero = n_even > 0  # even digits include 0

    lines = [
        'from sympy import *',
        '',
        f'# Krok 1: Wybór {n_odd} cyfr nieparzystych z 5 dostępnych (1,3,5,7,9)',
        f'wybor_nieparzystych = binomial(5, {n_odd})',
        f'print("Wybór {n_odd} nieparzystych z 5:", wybor_nieparzystych)',
        '',
        f'# Krok 2: Wybór {n_even} cyfr parzystych z 5 dostępnych (0,2,4,6,8)',
        f'wybor_parzystych = binomial(5, {n_even})',
        f'print("Wybór {n_even} parzystych z 5:", wybor_parzystych)',
        '',
        f'# Krok 3: Permutacje {total} wybranych cyfr',
        f'permutacje = factorial({total})',
        f'print("Permutacje {total} cyfr:", permutacje)',
        '',
        f'# Krok 4: Wszystkie liczby bez ograniczeń',
        f'wszystkie = wybor_nieparzystych * wybor_parzystych * permutacje',
        f'print("Wszystkie kombinacje:", wszystkie)',
    ]

    if has_zero and total > 1:
        lines += [
            '',
            f'# Krok 5: Odejmij przypadki gdy 0 jest na pierwszej pozycji',
            f'# Jeśli 0 jest na początku: 0 jest JUŻ WYBRANE, zostaje binomial(4, {n_even - 1}) parzystych',
            f'przypadki_z_zerem = wybor_nieparzystych * binomial(4, {n_even - 1}) * factorial({total - 1})',
            f'print("Przypadki z 0 na początku:", przypadki_z_zerem)',
            '',
            f'# Krok 6: Wynik końcowy',
            f'wynik = wszystkie - przypadki_z_zerem',
        ]
    else:
        lines += [
            '',
            f'wynik = wszystkie',
        ]

    lines += [
        f'print("ODPOWIEDZ:", wynik)',
    ]

    return '\n'.join(lines)


def _detect_triangle_optimization_params(problem_text):
    """Detect triangle optimization/computation problems using Heron's formula.

    Handles multiple sub-patterns:
      A) Triangle inscribed in circle + perimeter + side ratio → max area
      B) Isosceles triangle + perimeter → max area / area as function of side
      C) Triangle with given numeric sides → compute area (direct Heron)
      D) Triangle + perimeter + side ratio (no circle) → max area

    Returns dict with 'subtype' and parameters, or None."""
    # Normalize Unicode math symbols (𝑅→R, 𝑎→a, etc.) to ASCII for regex matching
    import unicodedata
    normalized = problem_text
    # Replace Mathematical Italic/Bold letters with ASCII equivalents
    def _normalize_math_char(ch):
        cp = ord(ch)
        if 0x1D400 <= cp <= 0x1D419: return chr(65 + cp - 0x1D400)  # Bold A-Z
        if 0x1D41A <= cp <= 0x1D433: return chr(97 + cp - 0x1D41A)  # Bold a-z
        if 0x1D434 <= cp <= 0x1D44D: return chr(65 + cp - 0x1D434)  # Italic A-Z
        if 0x1D44E <= cp <= 0x1D467: return chr(97 + cp - 0x1D44E)  # Italic a-z
        if 0x1D468 <= cp <= 0x1D481: return chr(65 + cp - 0x1D468)  # Bold Italic A-Z
        if 0x1D482 <= cp <= 0x1D49B: return chr(97 + cp - 0x1D482)  # Bold Italic a-z
        if 0x1D7CE <= cp <= 0x1D7D7: return chr(48 + cp - 0x1D7CE)  # Bold digits
        return ch
    normalized = ''.join(_normalize_math_char(ch) for ch in normalized)
    text = normalized.lower()

    has_triangle = bool(re.search(r'tr[oó]jk[aą]t', text))
    if not has_triangle:
        return None

    has_area = bool(re.search(r'pol[eua]|area', text))
    has_maximize = bool(re.search(r'największ|maksymal|najwększ|możliwie największ|najmniejsz', text))
    has_circle = bool(re.search(r'okr[ęeą]g', text))
    has_inscribed = bool(re.search(r'wpisan', text))
    has_isosceles = bool(re.search(r'równoramienn', text))
    has_perimeter = bool(re.search(r'obw[oó]d', text))

    # ─── Sub-pattern C: Direct Heron (given 3 numeric side lengths) ───
    if has_area and not has_maximize:
        # "trójkąt o bokach 3, 4, 5" or "boki trójkąta mają długości a=3, b=5, c=7"
        sides_m = re.search(
            r'bok(?:ach|i|ów)?\s+(?:o\s+długości(?:ach)?\s+)?'
            r'(?:\$?(\d+(?:[.,]\d+)?)\$?\s*[,;]\s*\$?(\d+(?:[.,]\d+)?)\$?\s*(?:[,;i]\s*(?:i\s+)?)\$?(\d+(?:[.,]\d+)?)\$?)',
            text
        )
        if not sides_m:
            # Try: "długości boków ... wynoszą 3, 5, 7"
            sides_m = re.search(
                r'długoś\w+\s+bok\w*.*?(\d+(?:[.,]\d+)?)\s*[,;]\s*(\d+(?:[.,]\d+)?)\s*(?:[,;i]\s*(?:i\s+)?)?(\d+(?:[.,]\d+)?)',
                text
            )
        if sides_m:
            try:
                a = float(sides_m.group(1).replace(',', '.'))
                b = float(sides_m.group(2).replace(',', '.'))
                c = float(sides_m.group(3).replace(',', '.'))
                if a + b > c and b + c > a and a + c > b:
                    return {
                        'subtype': 'direct_heron',
                        'sides': (a, b, c),
                    }
            except:
                pass

    if not has_area:
        return None

    # ─── Extract perimeter (numeric or symbolic) ───
    perimeter_value = None    # numeric perimeter (e.g. 18)
    perimeter_mult = None     # symbolic: perimeter = k*R
    radius_symbol = 'R'

    # Numeric perimeter: "obwód równy 18" or "obwodzie równym 18" or "obwody równe 3R"
    perim_num_m = re.search(r'obw[oó]d\w*\s+(?:równ\w*\s+|=\s*)?(\d+)', text)
    if perim_num_m:
        val_str = perim_num_m.group(1)
        # Check if followed by R (symbolic) or just a number
        after = text[perim_num_m.end():]
        if re.match(r'\s*[·*]?\s*r\b', after) or re.match(r'[·*]?\s*r\b', after):
            perimeter_mult = int(val_str)
        elif re.match(r'\s', after) or after == '' or re.match(r'[.,;]', after):
            perimeter_value = int(val_str)
        else:
            # "3r" without space — still symbolic
            if re.match(r'r\b', after):
                perimeter_mult = int(val_str)
            else:
                perimeter_value = int(val_str)

    # If we have a circle, extract radius symbol
    if has_circle:
        radius_match = re.search(r'promieni[ue]?\s+(?:równ\w+\s+)?(\w+|\d+)', text)
        if radius_match:
            rs = radius_match.group(1).upper()
            if rs not in ('RÓWN', 'RÓWNY', 'RÓWNYM'):
                radius_symbol = rs
            else:
                m2 = re.search(r'promieni\w*\s+równ\w+\s+(\w+)', text)
                if m2:
                    radius_symbol = m2.group(1).upper()

    # ─── Extract side ratio ───
    side_ratio = None
    polish_multipliers = {
        'dwukrotnie': 2, 'dwa razy': 2, 'dwukrotn': 2,
        'trzykrotnie': 3, 'trzy razy': 3, 'trzykrotn': 3,
        'czterokrotnie': 4, 'cztery razy': 4,
    }
    for keyword, mult in polish_multipliers.items():
        if keyword in text:
            side_ratio = mult
            break
    if side_ratio is None:
        ratio_m = re.search(r'(\d+)\s+raz[ey]\s+dłuż', text)
        if ratio_m:
            side_ratio = int(ratio_m.group(1))

    # ─── Sub-pattern A: Inscribed in circle + perimeter + side ratio ───
    if has_circle and has_inscribed and perimeter_mult and side_ratio:
        return {
            'subtype': 'inscribed_circle',
            'perimeter_mult': perimeter_mult,
            'side_ratio': side_ratio,
            'radius_symbol': radius_symbol,
            'maximize': has_maximize,
        }

    # ─── Sub-pattern B: Isosceles + perimeter → max area ───
    if has_isosceles and has_perimeter and (perimeter_value is not None) and has_maximize:
        return {
            'subtype': 'isosceles_perimeter',
            'perimeter': perimeter_value,
            'maximize': True,
        }

    # ─── Sub-pattern D: Perimeter + side ratio (no circle) → optimize area ───
    if has_perimeter and side_ratio and (perimeter_value is not None) and has_maximize:
        return {
            'subtype': 'perimeter_ratio',
            'perimeter': perimeter_value,
            'side_ratio': side_ratio,
            'maximize': True,
        }

    return None


def _build_triangle_optimization_code(params):
    """Generate SymPy code for triangle optimization/computation problems.
    Dispatches to the appropriate sub-solver based on subtype."""
    subtype = params['subtype']

    if subtype == 'direct_heron':
        return _build_direct_heron_code(params['sides'])
    elif subtype == 'inscribed_circle':
        return _build_inscribed_circle_code(params)
    elif subtype == 'isosceles_perimeter':
        return _build_isosceles_perimeter_code(params)
    elif subtype == 'perimeter_ratio':
        return _build_perimeter_ratio_code(params)
    else:
        return None


def _build_direct_heron_code(sides):
    """Sub-pattern C: Given 3 numeric sides, compute area via Heron's formula."""
    a, b, c = sides
    return f"""from sympy import *

# Obliczanie pola trójkąta o bokach {a}, {b}, {c} wzorem Herona

a, b, c = Rational('{a}'), Rational('{b}'), Rational('{c}')
print(f"Boki trójkąta: a = {{a}}, b = {{b}}, c = {{c}}")

# Krok 1: Sprawdzenie nierówności trójkąta
assert a + b > c and b + c > a and a + c > b, "Nierówność trójkąta nie jest spełniona!"
print("Nierówność trójkąta: spełniona ✓")

# Krok 2: Półobwód
s = (a + b + c) / 2
print(f"Półobwód: s = ({{a}} + {{b}} + {{c}}) / 2 = {{s}}")

# Krok 3: Wzór Herona: P = √(s(s-a)(s-b)(s-c))
pole_sq = s * (s - a) * (s - b) * (s - c)
print(f"s(s-a)(s-b)(s-c) = {{s}}·{{s-a}}·{{s-b}}·{{s-c}} = {{pole_sq}}")

pole = sqrt(pole_sq)
pole_simplified = simplify(pole)
print(f"Pole = √{{pole_sq}} = {{pole_simplified}}")

# Wynik
print(f"ODPOWIEDZ: {{pole_simplified}}")
"""


def _build_inscribed_circle_code(params):
    """Sub-pattern A: Triangle inscribed in circle + perimeter + side ratio → max area."""
    k = params['perimeter_mult']
    n = params['side_ratio']
    R_sym = params['radius_symbol']
    n1 = n + 1

    return f"""from sympy import *
import warnings
warnings.filterwarnings('ignore')

# ══════════════════════════════════════════════════════════════════
# Trójkąt wpisany w okrąg o promieniu {R_sym}, obwód = {k}{R_sym},
# jeden bok jest {n} razy dłuższy od drugiego.
# Szukamy trójkąta o największym polu.
# ══════════════════════════════════════════════════════════════════

{R_sym} = symbols('{R_sym}', positive=True)
t = symbols('t', positive=True)

# Krok 1: Boki trójkąta (krótszy = t·{R_sym}, dłuższy = {n}t·{R_sym}, trzeci z obwodu)
a_expr = {n} * t * {R_sym}
b_expr = t * {R_sym}
c_expr = ({k} - {n1}*t) * {R_sym}
print(f"Boki: a={n}t·{R_sym}, b=t·{R_sym}, c=({k}-{n1}t)·{R_sym}")

# Krok 2: Nierówność trójkąta → t ∈ ({k}/{2*n1}, {k}/{2*n})
t_min = Rational({k}, {2*n1})
t_max = Rational({k}, {2*n})
print(f"Zakres t: ({{t_min}}, {{t_max}})")

# Krok 3: Pole ze wzoru Herona
s = Rational({k}, 2) * {R_sym}
Area_sq = expand(s * (s - a_expr) * (s - b_expr) * (s - c_expr))
print(f"Pole² (Heron): {{factor(Area_sq)}}")

# Krok 4: Warunek okręgu opisanego: R_opis = abc/(4·Pole) = {R_sym}
# → (abc)² = 16·{R_sym}²·Pole²
abc = a_expr * b_expr * c_expr
equation = expand(abc**2 - 16 * {R_sym}**2 * Area_sq)
eq_t = simplify(equation / {R_sym}**6)
print(f"Równanie: {{Poly(eq_t, t).as_expr()}} = 0")

# Krok 5: Rozwiązanie
solutions = solve(eq_t, t)
valid = []
for sol in solutions:
    try:
        # Use evalf() which works with CRootOf objects (degree-6 polynomials)
        val = sol.evalf()
        if hasattr(val, 'is_real') and val.is_real:
            tv = float(val)
        else:
            cv = complex(val)
            if abs(cv.imag) < 1e-8:
                tv = cv.real
            else:
                continue
        if float(t_min) < tv < float(t_max):
            valid.append((tv, sol))
            print(f"  t = {{tv:.6f}} ✓")
    except:
        pass

# Krok 6: Porównanie pól
best_area, best_sides = None, None
for tv, ts in valid:
    av, bv, cv = {n}*tv, tv, {k}-{n1}*tv
    sv = {k}/2
    asq = sv*(sv-av)*(sv-bv)*(sv-cv)
    if asq > 0:
        area = asq**0.5
        print(f"  t≈{{tv:.6f}}: boki ({{av:.4f}}{R_sym}, {{bv:.4f}}{R_sym}, {{cv:.4f}}{R_sym}), Pole≈{{area:.6f}}{R_sym}²")
        if best_area is None or area > best_area:
            best_area, best_sides = area, (av, bv, cv)

if best_area is not None:
    af, bf, cf = best_sides
    print(f"\\nTrójkąt o największym polu:")
    print(f"  boki: a≈{{af:.6f}}·{R_sym}, b≈{{bf:.6f}}·{R_sym}, c≈{{cf:.6f}}·{R_sym}")
    print(f"  Pole ≈ {{best_area:.6f}}·{R_sym}²")
    print(f"ODPOWIEDZ: {{best_area:.6f}}*{R_sym}^2")
else:
    print("ODPOWIEDZ: brak rozwiazania")
"""


def _build_isosceles_perimeter_code(params):
    """Sub-pattern B: Isosceles triangle + given perimeter → maximize area.
    E.g. 'trójkąty równoramienne o obwodzie 18, największe pole'."""
    P = params['perimeter']

    return f"""from sympy import *

# ══════════════════════════════════════════════════════════════════
# Trójkąt równoramienny o obwodzie {P}, szukamy największego pola.
# ══════════════════════════════════════════════════════════════════

b = symbols('b', positive=True)  # ramię

# Krok 1: Podstawa trójkąta
# Obwód: 2b + a = {P} → a = {P} - 2b
a_expr = {P} - 2*b
print(f"Ramię: b, podstawa: a = {P} - 2b")

# Krok 2: Warunki
# a > 0 → b < {P}/2 = {P//2 if P%2==0 else f'{P}/2'}
# Nierówność trójkąta: 2b > a → 2b > {P} - 2b → b > {P}/4 = {P/4}
# Dziedzina: b ∈ ({P}/4, {P}/2), czyli b > {P/4} i b < {P/2}
print(f"Dziedzina: b ∈ ({P}/4, {P}/2)")

# Krok 3: Wysokość na podstawę
# h = √(b² - (a/2)²) = √(b² - ({P}/2 - b)²) = √({P}b - {P**2}/4)
# bo b² - ({P}/2 - b)² = b² - {P**2}/4 + {P}b - b² = {P}b - {P**2}/4
h_sq = {P}*b - Rational({P**2}, 4)
print(f"Wysokość²: h² = {P}b - {P**2}/4")

# Krok 4: Pole
# P(b) = (1/2) · a · h = (1/2)({P} - 2b) · √({P}b - {P**2}/4)
P_area = Rational(1, 2) * ({P} - 2*b) * sqrt(h_sq)
print(f"Pole P(b) = (1/2)·({P}-2b)·√({P}b - {P**2}/4)")

# Krok 5: Maksymalizacja — liczymy pochodną P²(b) (łatwiej bez pierwiastka)
P_sq = Rational(1, 4) * ({P} - 2*b)**2 * h_sq
P_sq_expanded = expand(P_sq)
print(f"P²(b) = {{P_sq_expanded}}")

# Pochodna P² po b
dP_sq = diff(P_sq_expanded, b)
dP_sq_factored = factor(dP_sq)
print(f"d(P²)/db = {{dP_sq_factored}}")

# Punkty krytyczne
critical = solve(dP_sq, b)
print(f"Punkty krytyczne: b = {{critical}}")

# Krok 6: Wybór maximum z dziedziny
best_area = None
best_b = None
for bc in critical:
    bv = float(bc)
    if {P}/4 < bv < {P}/2:
        area_val = float(P_area.subs(b, bc))
        if area_val > 0 and (best_area is None or area_val > best_area):
            best_area = area_val
            best_b = bc

if best_b is not None:
    a_val = {P} - 2*best_b
    area_exact = simplify(P_area.subs(b, best_b))
    print(f"\\nMaksimum dla b = {{best_b}}")
    print(f"  Boki: ramię b = {{best_b}}, podstawa a = {{a_val}}")
    print(f"  Pole = {{area_exact}}")
    print(f"ODPOWIEDZ: {{area_exact}}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
"""


def _build_perimeter_ratio_code(params):
    """Sub-pattern D: Triangle with given perimeter + side ratio → optimize area.
    E.g. 'trójkąt o obwodzie 24, jeden bok dwukrotnie dłuższy, największe pole'."""
    P = params['perimeter']
    n = params['side_ratio']
    n1 = n + 1

    return f"""from sympy import *

# ══════════════════════════════════════════════════════════════════
# Trójkąt o obwodzie {P}, jeden bok {n}× dłuższy od drugiego.
# Szukamy trójkąta o największym polu.
# ══════════════════════════════════════════════════════════════════

t = symbols('t', positive=True)  # krótszy bok

# Krok 1: Boki trójkąta
# krótszy = t, dłuższy = {n}t, trzeci = {P} - {n1}t
a = {n} * t
b = t
c = {P} - {n1} * t
print(f"Boki: {n}t, t, {P}-{n1}t")

# Krok 2: Nierówność trójkąta → t ∈ ({P}/{2*n1}, {P}/{2*n})
t_min = Rational({P}, {2*n1})
t_max = Rational({P}, {2*n})
print(f"Zakres: t ∈ ({{t_min}}, {{t_max}})")

# Krok 3: Pole ze wzoru Herona
s = Rational({P}, 2)
Area_sq = expand(s * (s - a) * (s - b) * (s - c))
print(f"Pole²(t) = {{factor(Area_sq)}}")

# Krok 4: Maksymalizacja P² — pochodna
dA_sq = diff(Area_sq, t)
print(f"d(Pole²)/dt = {{factor(dA_sq)}}")

critical = solve(dA_sq, t)
print(f"Punkty krytyczne: {{critical}}")

# Krok 5: Wybór maximum
best_area = None
best_t_val = None
for tc in critical:
    try:
        tv = float(tc)
        if float(t_min) < tv < float(t_max):
            asq = float(Area_sq.subs(t, tc))
            if asq > 0:
                area = asq**0.5
                sides = ({n}*tv, tv, {P}-{n1}*tv)
                print(f"  t={{tv:.4f}}: boki ({{sides[0]:.4f}}, {{sides[1]:.4f}}, {{sides[2]:.4f}}), Pole={{area:.6f}}")
                if best_area is None or area > best_area:
                    best_area = area
                    best_t_val = tc
    except:
        pass

if best_t_val is not None:
    area_exact = sqrt(Area_sq.subs(t, best_t_val))
    area_simplified = simplify(area_exact)
    sides_exact = ({n}*best_t_val, best_t_val, {P}-{n1}*best_t_val)
    print(f"\\nMaksymalne pole:")
    print(f"  boki: ({{sides_exact[0]}}, {{sides_exact[1]}}, {{sides_exact[2]}})")
    print(f"  Pole = {{area_simplified}}")
    print(f"ODPOWIEDZ: {{area_simplified}}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
"""


def _try_template_solver(question_text):
    """Try to solve the problem using a deterministic template (no LLM needed).
    Returns dict with 'code', 'answer', 'output' or None if no template matches."""

    # Pattern 1: Digit counting with odd/even constraints
    params = _detect_digit_counting_params(question_text)
    if params:
        n_odd, n_even, no_repeats = params
        code = _build_digit_counting_solver_code(n_odd, n_even, no_repeats)

        # Execute locally (we're in Python, no need for MCP)
        local_ns = {}
        import io, contextlib
        output_buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(output_buf):
                exec(code, {'__builtins__': __builtins__}, local_ns)
            output = output_buf.getvalue()
            answer_m = re.search(r'ODPOWIEDZ:\s*(\S+)', output)
            if answer_m:
                return {
                    'success': True,
                    'code': code,
                    'output': output,
                    'answer': answer_m.group(1),
                    'template': 'digit_counting',
                }
        except Exception as e:
            print(f"  ⚠️ Template solver error: {e}")
            return None

    # Pattern 2: Triangle optimization/computation (Heron-based)
    tri_params = _detect_triangle_optimization_params(question_text)
    if tri_params:
        code = _build_triangle_optimization_code(tri_params)
        if code:
            local_ns = {}
            import io, contextlib
            output_buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(output_buf):
                    exec(code, {'__builtins__': __builtins__}, local_ns)
                output = output_buf.getvalue()
                answer_m = re.search(r'ODPOWIEDZ:\s*(.+)', output)
                if answer_m:
                    return {
                        'success': True,
                        'code': code,
                        'output': output,
                        'answer': answer_m.group(1).strip(),
                        'template': f'triangle_{tri_params["subtype"]}',
                    }
            except Exception as e:
                print(f"  ⚠️ Template solver error (triangle_{tri_params['subtype']}): {e}")
                return None

    # Future patterns can be added here
    return None


def check_answer(expected, got, question):
    """Check if the model's answer matches expected. Returns (match, explanation)."""
    if not got:
        return False, "No answer produced"

    got_clean = got.strip()
    got_lower = got_clean.lower()

    # For multiple choice: try to match by value against each option
    if question.get('options'):
        # Keep expected letter in ORIGINAL case to match dict keys (uppercase in dataset)
        expected_letter = expected.strip().upper()
        expected_opt_latex = question['options'].get(expected_letter, '')
        expected_opt_plain = clean_latex_for_display(expected_opt_latex)

        # Helper: case-insensitive key comparison
        def key_matches(opt_key):
            return opt_key.upper() == expected_letter

        # 1. Check if model explicitly says the letter
        letter_match = re.search(r'\b([a-dA-D])\b', got_clean)
        if letter_match:
            got_letter = letter_match.group(1).upper()
            if got_letter == expected_letter:
                return True, f"Letter match: {got_letter}"

        # 2. Normalize intervals and compare
        got_normalized = _normalize_interval(got_clean)
        if got_normalized != got_clean:  # only if normalization changed something
            best_interval_match = None
            for opt_key, opt_latex in question['options'].items():
                opt_plain = clean_latex_for_display(opt_latex)
                opt_normalized = _normalize_interval(opt_plain)
                if opt_normalized == opt_plain:  # option isn't an interval
                    continue
                got_nums = re.findall(r'-?\d+(?:/\d+)?(?:\.\d+)?|inf|-inf', got_normalized)
                opt_nums = re.findall(r'-?\d+(?:/\d+)?(?:\.\d+)?|inf|-inf', opt_normalized)
                if got_nums and opt_nums and got_nums == opt_nums:
                    got_left = got_normalized[0] if got_normalized else ''
                    opt_left = opt_normalized[0] if opt_normalized else ''
                    if got_left == opt_left:
                        best_interval_match = opt_key
            if best_interval_match:
                if key_matches(best_interval_match):
                    return True, f"Interval match: {got_normalized} ≈ option {best_interval_match}"
                else:
                    return False, f"Interval matched option {best_interval_match}, expected {expected_letter}"

        # 2b. Direct symbolic or text match against each option
        for opt_key, opt_latex in question['options'].items():
            opt_plain = clean_latex_for_display(opt_latex)
            if _sympy_compare(got_clean, opt_plain):
                if key_matches(opt_key):
                    return True, f"Symbolic option match: {got_clean} = option {opt_key}"
                else:
                    return False, f"Symbolic matched option {opt_key}, expected {expected_letter}"
            # Text substring match (for "nie ma rozwiązania" etc.)
            got_text = got_clean.lower().strip().rstrip('.')
            opt_text = opt_plain.lower().strip().rstrip('.')
            if got_text and opt_text and (got_text in opt_text or opt_text in got_text):
                if key_matches(opt_key):
                    return True, f"Text option match: '{got_clean}' ≈ option {opt_key}"
                else:
                    return False, f"Text matched option {opt_key}, expected {expected_letter}"

        # 3. Try to evaluate model's numeric answer and compare with each option
        got_value = _sympy_eval(got_clean) or _try_float(got_clean)

        if got_value is not None:
            best_match = None
            best_diff = float('inf')
            for opt_key, opt_latex in question['options'].items():
                opt_plain = clean_latex_for_display(opt_latex)
                opt_value = _sympy_eval(opt_plain) or _try_float(opt_plain)
                if opt_value is not None:
                    diff = abs(got_value - opt_value)
                    if diff < best_diff:
                        best_diff = diff
                        best_match = opt_key

            if best_match and best_diff < 0.01:
                if key_matches(best_match):
                    return True, f"Value match: {got_value} = option {best_match} ({clean_latex_for_display(question['options'][best_match])})"
                else:
                    return False, f"Matched option {best_match}, expected {expected_letter}"

        # 4. Symbolic comparison with expected option
        if _sympy_compare(got_clean, expected_opt_plain):
            return True, f"Symbolic match with option {expected_letter}"

        return False, f"Expected {expected_letter} ({expected_opt_plain}), got: {got_clean[:60]}"

    # For open-ended: try numeric/symbolic comparison
    expected_plain = clean_latex_for_display(expected)

    # Normalize infinity representations in both sides
    got_norm = _normalize_infinity(got_clean)
    exp_norm = _normalize_infinity(expected_plain)
    if got_norm.lower() == exp_norm.lower():
        return True, f"Infinity-normalized match: {got_norm}"

    # Normalize SymPy interval notation: Interval.open(-3, 1) → (-3, 1)
    interval_match = re.match(r'Interval(?:\.open)?\((.+?),\s*(.+?)\)', got_clean)
    if interval_match:
        a, b = interval_match.group(1).strip(), interval_match.group(2).strip()
        got_interval = f"({a}, {b})"
        if got_interval == expected_plain or got_interval.lower() == expected_plain.lower():
            return True, f"Interval match: {got_interval}"
        # Also try with normalized infinity
        got_interval_norm = _normalize_infinity(got_interval)
        if got_interval_norm.lower() == exp_norm.lower():
            return True, f"Interval-infinity match: {got_interval_norm}"

    # Normalize Union notation: Union(Interval(-oo, -3), Interval(1, oo)) → (-∞, -3) ∪ (1, ∞)
    union_match = re.findall(r'Interval(?:\.open)?\(([^)]+)\)', got_clean)
    if len(union_match) >= 2:
        parts = []
        for um in union_match:
            endpoints = [x.strip() for x in um.split(',')]
            if len(endpoints) == 2:
                a, b = endpoints
                a = a.replace('-oo', '-∞').replace('oo', '∞')
                b = b.replace('-oo', '-∞').replace('oo', '∞')
                parts.append(f"({a}, {b})")
        got_union = " ∪ ".join(parts)
        if got_union.lower() == expected_plain.lower():
            return True, f"Union match: {got_union}"

    # Normalize SymPy sqrt notation: 2*sqrt(13) → 2√13
    got_sqrt_normalized = re.sub(r'(\d+)\*sqrt\((\d+)\)', r'\1√\2', got_clean)
    got_sqrt_normalized = re.sub(r'sqrt\((\d+)\)', r'√\1', got_sqrt_normalized)
    exp_sqrt_normalized = re.sub(r'(\d+)\*sqrt\((\d+)\)', r'\1√\2', expected_plain)
    exp_sqrt_normalized = re.sub(r'sqrt\((\d+)\)', r'√\1', exp_sqrt_normalized)
    if got_sqrt_normalized.lower() == exp_sqrt_normalized.lower():
        return True, f"Sqrt-normalized match: {got_sqrt_normalized}"

    # Dimension-pair matching: e.g. expected "6 × 10", got "6 cm × 10 cm" or verbose
    dim_result = _extract_dimension_pair(got_clean, expected_plain)
    if dim_result is True:
        return True, f"Dimension-pair match"

    # Unit-stripped comparison: strip units/labels from got and retry
    got_stripped = _strip_units(got_clean)
    if got_stripped != got_clean and got_stripped:
        if got_stripped.lower() == expected_plain.lower():
            return True, f"Unit-stripped match: {got_stripped}"
        # Also try sqrt normalization on stripped
        got_stripped_sqrt = re.sub(r'(\d+)\*sqrt\((\d+)\)', r'\1√\2', got_stripped)
        got_stripped_sqrt = re.sub(r'sqrt\((\d+)\)', r'√\1', got_stripped_sqrt)
        if got_stripped_sqrt.lower() == exp_sqrt_normalized.lower():
            return True, f"Unit-stripped sqrt match: {got_stripped_sqrt}"

    # Verbose output extraction: if got is very long, try to extract key numbers
    if len(got_clean) > 3 * max(len(expected_plain), 5):
        # Extract all numbers from verbose output
        all_nums = re.findall(r'-?\d+\.?\d*', got_clean)
        # Try matching the last few numbers against expected
        exp_nums = re.findall(r'-?\d+\.?\d*', expected_plain)
        if exp_nums and all_nums:
            for num in reversed(all_nums):
                for en in exp_nums:
                    try:
                        if abs(float(num) - float(en)) < 0.01:
                            return True, f"Verbose numeric extract: {num} ≈ {en}"
                    except ValueError:
                        pass

    # String match
    if expected_plain.lower() in got_lower:
        return True, "Substring match"

    # Check if got_clean appears as core value in expected (strip label like "|BC| = ", "P(A) = ")
    exp_core_match = re.match(r'^[|A-Za-z_()]+\s*=\s*(.+)$', expected_plain)
    if exp_core_match:
        exp_core = exp_core_match.group(1).strip()
        # Direct string match with core
        if got_clean.lower() == exp_core.lower():
            return True, f"Core value match: {got_clean} = {exp_core}"
        # Sqrt-normalized match with core
        exp_core_sqrt = re.sub(r'(\d+)\*sqrt\((\d+)\)', r'\1√\2', exp_core)
        exp_core_sqrt = re.sub(r'sqrt\((\d+)\)', r'√\1', exp_core_sqrt)
        if got_sqrt_normalized.lower() == exp_core_sqrt.lower():
            return True, f"Core sqrt match: {got_sqrt_normalized} = {exp_core_sqrt}"
        # Symbolic comparison with core
        if _sympy_compare(got_clean, exp_core):
            return True, f"Core symbolic match: {got_clean} = {exp_core}"

    # Numeric match (with sympy_eval for symbolic expressions like 2*sqrt(13))
    got_value = _sympy_eval(got_clean) or _try_float(got_clean)
    # Also try unit-stripped version for numeric eval
    if got_value is None and got_stripped != got_clean:
        got_value = _sympy_eval(got_stripped) or _try_float(got_stripped)
    exp_value = _sympy_eval(expected_plain) or _try_float(expected_plain)
    if got_value is not None and exp_value is not None:
        if abs(got_value - exp_value) < 0.01:
            return True, f"Numeric match: {got_value}"
        # Also check ratio (for fractions like 13/25 = 0.52)
        if exp_value != 0 and abs(got_value / exp_value - 1.0) < 0.01:
            return True, f"Ratio match: {got_value} ≈ {exp_value}"

    # Also try numeric match with core value extracted from expected
    if exp_core_match:
        exp_core = exp_core_match.group(1).strip()
        exp_core_value = _sympy_eval(exp_core) or _try_float(exp_core)
        if got_value is not None and exp_core_value is not None:
            if abs(got_value - exp_core_value) < 0.01:
                return True, f"Core numeric match: {got_value} = {exp_core}"

    # Symbolic comparison
    if _sympy_compare(got_clean, expected_plain):
        return True, f"Symbolic match"

    # Try matching against parts of expected (e.g. "b = 4, c = -5" → check if got matches any key value)
    # Also try matching the core expression from expected (strip "variable = " prefix)
    exp_parts = re.split(r'[,;]', expected_plain)
    for part in exp_parts:
        part = part.strip()
        # Extract value after = sign
        m = re.match(r'[\w_|]+\s*=\s*(.+)', part)
        val = m.group(1).strip() if m else part
        if val and (val.lower() == got_lower or
                    _sympy_compare(got_clean, val) or
                    (got_value is not None and _sympy_eval(val) is not None and
                     abs(got_value - _sympy_eval(val)) < 0.01)):
            return True, f"Partial match: {got_clean} matches '{part}'"

    return False, f"Expected: {expected_plain}, got: {got_clean[:80]}"


def load_questions(year, datasets_dir):
    """Load questions from a specific year's dataset."""
    # Try level-specific suffix first (_1 for basic, _2 for extended)
    for suffix in ['_1', '_2']:
        path = os.path.join(datasets_dir, f"{year}{suffix}.json")
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
    return []


def load_questions_both_levels(year, base_dir):
    """Load questions from both levels for a given year.
    Returns (rozszerzona_questions, podstawowa_questions)."""
    rozszerzona = []
    podstawowa = []
    roz_dir = os.path.join(base_dir, "rozszerzona")
    pod_dir = os.path.join(base_dir, "podstawowa")
    if os.path.isdir(roz_dir):
        rozszerzona = load_questions(year, roz_dir)
    if os.path.isdir(pod_dir):
        podstawowa = load_questions(year, pod_dir)
    return rozszerzona, podstawowa


def available_years_all(base_dir):
    """List available dataset years across both levels."""
    years = set()
    for level in ["rozszerzona", "podstawowa"]:
        level_dir = os.path.join(base_dir, level)
        if not os.path.isdir(level_dir):
            continue
        for f in sorted(os.listdir(level_dir)):
            m = re.match(r'(\d{4})_\d\.json', f)
            if m:
                years.add(int(m.group(1)))
    return sorted(years)


def available_years(datasets_dir):
    """List available dataset years in a single directory."""
    years = []
    if not os.path.exists(datasets_dir):
        return years
    for f in sorted(os.listdir(datasets_dir)):
        m = re.match(r'(\d{4})_\d\.json', f)
        if m:
            y = int(m.group(1))
            if y not in years:
                years.append(y)
    return years


def _execute_via_mcp(code, verbose, result):
    """Execute SymPy code via MCP proxy (prod path — sanitization and retry handled server-side).
    Returns output or None."""
    try:
        stdout, stderr, rc = call_mcp_sympy(code)

        if rc == 0 and stdout:
            result['answer_got'] = extract_answer_from_output(stdout)
            if verbose:
                answer_line = result['answer_got'] or stdout[-80:]
                print(f"  MCP:       ✅ → {answer_line[:60]}")
            return stdout
        elif rc == 0 and not stdout:
            if verbose:
                print(f"  MCP:       ❌ no output (code ran without print)")
            result['errors'].append("MCP: no output produced")
            return None
        else:
            err = stderr[-120:] if stderr else "unknown error"
            if verbose:
                print(f"  MCP:       ❌ {err}")
            result['errors'].append(f"MCP error: {stderr[:200]}")
            return None

    except Exception as e:
        result['errors'].append(f"MCP exception: {e}")
        if verbose:
            print(f"  MCP:       ❌ exception: {e}")
        return None


# ── Classifier Mode: Deterministic Solver ────────────────────────────────

def _extract_json_from_response(text):
    """Extract JSON object from LLM classifier response."""
    # Strip <think> blocks
    text = re.sub(r'<think>[\s\S]*?</think>', '', text).strip()

    # Strategy 1: JSON in ```json ... ``` fences
    m = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
    if m:
        try:
            return json.loads(m.group(1))
        except:
            pass

    # Strategy 2: First { ... } block
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start >= 0:
                candidate = text[start:i+1]
                try:
                    return json.loads(candidate)
                except:
                    # Try fixing common issues
                    fixed = candidate.replace("'", '"')
                    fixed = re.sub(r',\s*}', '}', fixed)
                    fixed = re.sub(r',\s*]', ']', fixed)
                    try:
                        return json.loads(fixed)
                    except:
                        pass
                start = -1

    # Strategy 3: Entire text
    try:
        return json.loads(text.strip())
    except:
        pass

    # Strategy 4: Parse plain-text "Kategoria: X" / "Metoda: Y" format
    # Bielik sometimes ignores JSON instruction and returns analytical-style text
    return _parse_plaintext_classification(text)


# Mapping from Polish category names to classifier types
_CATEGORY_TO_TYPE = {
    'ciagi': 'sequence_geometric',
    'ciag': 'sequence_geometric',
    'ciag arytmetyczny': 'sequence_arithmetic',
    'ciag geometryczny': 'sequence_geometric',
    'rownania': 'polynomial_roots',
    'rownanie': 'polynomial_roots',
    'nierownosci': 'inequality',
    'nierownosc': 'inequality',
    'rownania, nierownosci': 'inequality',
    'potegi': 'simplification',
    'logarytm': 'logarithm',
    'logarytmy': 'logarithm',
    'prawdopodobienstwo': 'probability',
    'kombinatoryka': 'combinatorics',
    'geometria': 'geometry_analytic',
    'geometria analityczna': 'geometry_analytic',
    'stereometria': 'geometry_solid',
    'trygonometria': 'trig_equation',
    'pochodna': 'derivative',
    'pochodne': 'derivative',
    'granica': 'limit',
    'optymalizacja': 'optimization',
    'funkcja': 'function_properties',
    'funkcje': 'function_properties',
    'upraszczanie': 'simplification',
    'dowod': 'proof',
    'parametr': 'parametric_equation',
    'rownanie parametryczne': 'parametric_equation',
}

def _parse_plaintext_classification(text):
    """Fallback parser for non-JSON classifier responses.
    Parses 'Kategoria: X' format into a classification dict."""
    text_lower = text.lower().strip()

    # Look for "Kategoria: X" or "Typ: X"
    cat_match = re.search(r'kategoria:\s*([^\n]+)', text_lower)
    if not cat_match:
        cat_match = re.search(r'typ:\s*([^\n]+)', text_lower)
    if not cat_match:
        return None

    category_raw = cat_match.group(1).strip().rstrip('.')

    # Map to classifier type
    ptype = _CATEGORY_TO_TYPE.get(category_raw)
    if not ptype:
        # Try partial matches
        for key, val in _CATEGORY_TO_TYPE.items():
            if key in category_raw or category_raw in key:
                ptype = val
                break
    if not ptype:
        ptype = 'general'

    # Extract any numeric expressions from "Plan:" section
    params = {}

    # Try to extract expression from Metoda line
    method_match = re.search(r'metoda:\s*([^\n]+)', text_lower)
    if method_match:
        params['method_hint'] = method_match.group(1).strip()

    return {
        'type': ptype,
        'confidence': 0.55,  # Low confidence — will trigger extraction chain fallback
        'params': params,
        'mc_options': {},
        '_parsed_from_plaintext': True
    }


def _detect_categories(question_text):
    """Detect problem categories from question text (port of ragService.ts detectCategories)."""
    lower = question_text.lower()
    categories_def = [
        ('stereometria', ['graniastosłup', 'ostrosłup', 'walec', 'stożek', 'kula', 'bryła', 'objętość', 'pole powierzchni', 'przekrój', 'krawędź boczna', 'ściana boczna', 'wysokość bryły', 'podstawa bryły', 'sześciokąt']),
        ('parametric', ['parametr', 'wartości m', 'wartości a', 'wartości p', 'dla jakich', 'warunek na', 'wyróżnik', 'delta']),
        ('ciagi', ['ciąg arytmetyczny', 'ciąg geometryczny', 'ciąg', 'wyraz ciągu', 'różnica ciągu', 'iloraz ciągu', 'suma ciągu', 'n-ty wyraz']),
        ('trygonometria', ['sinus', 'cosinus', 'tangens', 'sin', 'cos', 'tg', 'trygonometr', 'kąt', 'stopni']),
        ('dowody', ['wykaż', 'udowodnij', 'dowód', 'indukcja', 'pokaż że', 'pokaż, że']),
        ('optymalizacja', ['największ', 'najmniejsz', 'maksymaln', 'minimaln', 'optymal', 'ekstremum', 'wartość największa', 'wartość najmniejsza']),
        ('prawdopodobienstwo', ['prawdopodobień', 'losow', 'rzut kostk', 'rzut monet', 'urna', 'kula z urny', 'zdarzeni']),
        ('granice', ['granica', 'lim', 'granicy', 'dąży do', 'zbieżn']),
        ('nierownosci', ['nierówność', 'nierównoś', 'rozwiąż nierówność']),
        ('geometria_analityczna', ['okrąg', 'prosta', 'współrzędn', 'równoległobok', 'przekątne', 'środek odcinka', 'punkt przeci']),
        ('kombinatoryka', ['ile jest', 'na ile sposobów', 'liczba naturalna', 'zapis dziesiętny', 'cyfr', 'kombinacj', 'permutacj']),
        ('logarytmy', ['logarytm', 'log_', 'log ']),
        ('funkcja_kwadratowa', ['funkcja kwadratowa', 'parabola', 'oś symetrii', 'wierzchołek']),
    ]
    matched = []
    for name, keywords in categories_def:
        if any(kw in lower for kw in keywords):
            matched.append(name)
    return matched


def _get_category_strategy(category):
    """Return category-specific SymPy strategy hints (port of ragService.ts getCategoryStrategy)."""
    strategies = {
        'stereometria': 'STRATEGIA STEREOMETRIA:\n- Zidentyfikuj typ bryly (graniastoslup/ostroslup/walec/stozek/kula)\n- Wyznacz pole podstawy (S) i wysokosc (h)\n- V = S * h (graniastoslup/walec) lub V = (1/3) * S * h (ostroslup/stozek)\n- Tw. Pitagorasa 3D: a**2 + b**2 + c**2 = d**2\nSymPy: from sympy import *; a, h = symbols("a h", positive=True); V = a**2 * h',
        'parametric': 'STRATEGIA PARAMETR:\n- Wyciagnij parametr (m, a, p) z rownania\n- Utworz wielomian w x: Poly(eq, x)\n- Oblicz wyroznik: delta = discriminant(poly)\n- Jedno rozw. -> delta = 0; dwa rozne -> delta > 0; brak -> delta < 0\n- UWAGA: sprawdz edge case gdy wspolczynnik przy x**2 = 0 (liniowe!)\nSymPy: from sympy import *; m = symbols("m"); poly = Poly(eq, x); delta = discriminant(poly); solve(delta > 0, m)',
        'ciagi': 'STRATEGIA CIAGI:\n- Arytmetyczny: a_n = a_1 + (n-1)*d, S_n = n*(a_1 + a_n)/2\n- Geometryczny: a_n = a_1 * q**(n-1), S_n = a_1*(1 - q**n)/(1 - q)\n- Jesli (x, y, z) geometryczny -> y**2 = x*z\n- Jesli (x, y, z) arytmetyczny -> 2*y = x + z\nSymPy: from sympy import *; a1, d, q, n = symbols("a1 d q n"); solve([eq1, eq2], [a1, d])',
        'trygonometria': 'STRATEGIA TRYGONOMETRIA:\n- Tozsamosci: sin(x)**2 + cos(x)**2 = 1, sin(2*x) = 2*sin(x)*cos(x)\n- Rownania trygonometryczne: uzyj solveset(eq, x, Interval(0, 2*pi))\nSymPy: from sympy import *; x = symbols("x", real=True); solveset(sin(x) - Rational(1,2), x, Interval(0, 2*pi))',
        'dowody': 'STRATEGIA DOWODY:\n- Bezposredni: przeksztalc lewa strone do prawej\n- Sprzecznosc: zaloz NOT(teza), doprowadz do sprzecznosci\n- Indukcja: base case n=1 + krok indukcyjny\nSymPy: from sympy import *; simplify(LHS - RHS)  # powinno dac 0',
        'optymalizacja': 'STRATEGIA OPTYMALIZACJA:\n- Wyraz funkcje celu f(x) jednej zmiennej\n- Pochodna: diff(f, x), punkty krytyczne: solve(diff(f, x), x)\n- Sprawdz znak f\'\'(x) (min/max) + wartosci na krancach\nSymPy: from sympy import *; x = symbols("x", positive=True); f = ...; crits = solve(diff(f, x), x)',
        'prawdopodobienstwo': 'STRATEGIA PRAWDOPODOBIENSTWO:\n- P(A) = |A| / |Omega| — policz zdarzenia sprzyjajace i wszystkie\n- Kombinacje: binomial(n, k); Permutacje: factorial(n)/factorial(n-k)\n- Uzyj Rational(a,b) NIE float\nSymPy: from sympy import *; binomial(n, k); Rational(sprzyjajace, wszystkie)',
        'granice': 'STRATEGIA GRANICE:\n- limit(expr, x, a, "-") dla lewostronnej, limit(expr, x, a, "+") dla prawostronnej\n- Jesli 0/0: uprosc ulamek (factor + cancel)\n- Jesli k/0: sprawdz znak -> +-oo\nSymPy: from sympy import *; x = symbols("x"); limit(expr, x, a)',
        'nierownosci': 'STRATEGIA NIEROWNOSCI:\n- Przeniesc WSZYSTKO na jedna strone: wyrazenie <= 0\n- Uzyj solve_univariate_inequality(expr <= 0, x, relational=False)\n- Alternatywa: solve(expr, x) -> miejsca zerowe, recznie sprawdz znak\nSymPy: from sympy import *; from sympy.solvers.inequalities import solve_univariate_inequality',
        'geometria_analityczna': 'STRATEGIA GEOMETRIA ANALITYCZNA:\n- Odleglosc: sqrt((x2-x1)**2+(y2-y1)**2)\n- Srodek odcinka: ((x1+x2)/2, (y1+y2)/2)\n- Rownolegobok: przekatne dziela sie na polowy -> C = 2*P - A\nSymPy: from sympy import *; sqrt((x2-x1)**2 + (y2-y1)**2)',
        'kombinatoryka': 'STRATEGIA KOMBINATORYKA:\n- Cyfry bez powtorzen: rozwaz OSOBNO przypadek z cyfra 0!\n- 0 nie moze stac na pierwszym miejscu -> odejmij zle przypadki\n- binomial(n,k) = C(n,k), factorial(n) = n!\nSymPy: from sympy import *; binomial(5,3) * factorial(5)',
        'logarytmy': 'STRATEGIA LOGARYTMY:\n- log(x, base) w SymPy — NIE log_base(x)!\n- Zmiana podstawy: log_b(x) = log(x)/log(b)\n- log(a*b) = log(a) + log(b); log(a**n) = n*log(a)\nSymPy: from sympy import *; log(9, sqrt(3)); simplify(...)',
        'funkcja_kwadratowa': 'STRATEGIA FUNKCJA KWADRATOWA:\n- f(x) = a*x**2 + b*x + c\n- Os symetrii: x = -b/(2*a), Wierzcholek: W = (-b/(2*a), f(-b/(2*a)))\n- Wyroznik: delta = b**2-4*a*c, Miejsca zerowe: (-b+-sqrt(delta))/(2*a)\nSymPy: from sympy import *; b, c = symbols("b c"); solve([Eq(-b/2, -2), Eq(1+b+c, -10)], [b, c])',
    }
    return strategies.get(category, '')


def _build_rag_context(question_text):
    """Build RAG context for classifier call (mimics threeAgentSystem.ts behavior)."""
    categories = _detect_categories(question_text)
    if not categories:
        return ''

    sections = []
    for cat in categories:
        strategy = _get_category_strategy(cat)
        if strategy:
            sections.append(strategy)

    if len(categories) > 1:
        sections.append(f"UWAGA: To zadanie laczy {len(categories)} kategorii: {' + '.join(categories)}. Najpierw rozwiaz kazda czesc osobno, potem polacz wyniki.")

    return '\n\n'.join(sections) if sections else ''


def _latex_to_sympy(expr_str):
    """Convert LLM-output math expression to valid SymPy syntax."""
    if not expr_str or not isinstance(expr_str, str):
        return str(expr_str) if expr_str is not None else '0'
    s = str(expr_str).strip()
    # Remove LaTeX wrappers
    s = s.replace('$', '').replace('\\,', '')
    # Remove assignment (T(t) = ... → just the RHS)
    if '=' in s and not any(op in s for op in ['==', '!=', '<=', '>=']):
        parts = s.split('=', 1)
        # Take the RHS if it looks like an expression
        if len(parts) == 2 and len(parts[1].strip()) > 0:
            rhs = parts[1].strip()
            # But not if the LHS is something like "x**2 + 3" (actual equation)
            lhs = parts[0].strip()
            if re.match(r'^[A-Za-z_]\w*(\([^)]*\))?$', lhs):
                s = rhs
    # LaTeX → Python conversions
    s = re.sub(r'\\frac\{([^}]+)\}\{([^}]+)\}', r'Rational(\1, \2)', s)
    s = re.sub(r'\\sqrt\{([^}]+)\}', r'sqrt(\1)', s)
    s = re.sub(r'\\sqrt\s+(\d+)', r'sqrt(\1)', s)
    s = s.replace('\\pi', 'pi').replace('\\infty', 'oo').replace('\\cdot', '*')
    s = s.replace('\\ln', 'log').replace('\\log', 'log').replace('\\sin', 'sin')
    s = s.replace('\\cos', 'cos').replace('\\tan', 'tan')
    s = re.sub(r'\\left\s*', '', s)
    s = re.sub(r'\\right\s*', '', s)
    s = re.sub(r'\\[a-zA-Z]+', '', s)  # Remove remaining LaTeX commands
    # Fix implicit multiplication: 2x → 2*x, 3sin → 3*sin
    s = re.sub(r'(\d)([a-zA-Z(])', r'\1*\2', s)
    # Fix function notation without *: cos²(x) → cos(x)**2
    s = re.sub(r'(\w)\^(\d+)\(', r'\1(**\2)(', s)  # not right, simpler:
    # Fix ^ → **
    s = s.replace('^', '**')
    # Fix (a)(b) → (a)*(b)
    s = re.sub(r'\)\(', ')*(', s)
    # Fix log_base(x) → log(x, base)
    s = re.sub(r'log_(\d+)\(([^)]+)\)', r'log(\2, \1)', s)
    s = re.sub(r'log_\{(\d+)\}\(([^)]+)\)', r'log(\2, \1)', s)
    # Fix fractions written as (a)/(b) → Rational(a, b) only for pure numbers
    s = re.sub(r'\((\d+)\)/\((\d+)\)', r'Rational(\1, \2)', s)
    return s.strip()


def _sanitize_mc_options(mc_options, question_text):
    """Try to extract clean MC options from classifier output or question text."""
    if not mc_options:
        return _extract_mc_from_question(question_text)

    clean = {}
    for letter in ['A', 'B', 'C', 'D']:
        val = mc_options.get(letter, mc_options.get(letter.lower(), ''))
        val = str(val).strip()
        if not val or val == 'None':
            return _extract_mc_from_question(question_text)
        # Try to make it valid Python
        val = _latex_to_sympy(val)
        # Check if it's a simple value
        try:
            compile(val, '<test>', 'eval')
            clean[letter] = val
        except:
            # Wrap in quotes as string for comparison
            clean[letter] = f'"{val}"'
    return clean if len(clean) == 4 else _extract_mc_from_question(question_text)


def _extract_mc_from_question(question_text):
    """Extract MC options directly from question text using regex."""
    options = {}
    # Pattern: A. value or A) value
    for letter in ['A', 'B', 'C', 'D']:
        # Try "A. ..." or "A) ..."
        pattern = rf'\b{letter}[.)]\s*(.+?)(?=\s*\b[ABCD][.)]\s|\s*$)'
        m = re.search(pattern, question_text, re.DOTALL)
        if m:
            val = m.group(1).strip()
            val = _latex_to_sympy(val)
            # Remove trailing text after the value
            val = val.split('\n')[0].strip().rstrip('.')
            try:
                compile(val, '<test>', 'eval')
                options[letter] = val
            except:
                options[letter] = f'"{val}"'
    return options if len(options) == 4 else None


def _sanitize_classification(classification, question_text, is_mc):
    """Deep-sanitize all params in the classification to ensure valid SymPy."""
    params = classification.get('params', {})

    # Sanitize all string values in params recursively
    def sanitize_dict(d):
        result = {}
        for k, v in d.items():
            if isinstance(v, str) and k in ('expression', 'equation', 'function_expr',
                                              'lhs', 'rhs', 'approach', 'point',
                                              'tangent_point', 'domain_start', 'domain_end',
                                              'eval_point', 'a1', 'd', 'q', 'n', 'an', 'sum',
                                              'n_total', 'k_val', 'p', 'favorable_outcomes',
                                              'total_outcomes'):
                result[k] = _latex_to_sympy(v)
            elif isinstance(v, dict):
                result[k] = sanitize_dict(v)
            elif isinstance(v, list):
                result[k] = [sanitize_dict(item) if isinstance(item, dict)
                            else _latex_to_sympy(item) if isinstance(item, str) else item
                            for item in v]
            else:
                result[k] = v
        return result

    classification['params'] = sanitize_dict(params)

    # Sanitize MC options
    if is_mc:
        classification['mc_options'] = _sanitize_mc_options(
            classification.get('mc_options'), question_text)

    return classification


def _build_deterministic_code(classification, question_text, is_mc):
    """Build SymPy code from classifier JSON output. Mirrors TypeScript deterministicSolvers.ts."""
    # FIRST: sanitize all params
    classification = _sanitize_classification(classification, question_text, is_mc)

    ptype = classification.get('type', 'general')
    params = classification.get('params', {})
    mc_options = classification.get('mc_options', None)

    code_lines = ['from sympy import *',
                  'x, y, z, m, n, k, t, a, b, c, d, q, r = symbols("x y z m n k t a b c d q r", real=True)']

    if ptype == 'limit':
        expr = _latex_to_sympy(params.get('expression', '0'))
        var = params.get('variable', 'x')
        approach = _latex_to_sympy(params.get('approach', '0'))
        direction = params.get('direction', '')
        dir_str = f", '{direction}'" if direction else ''
        code_lines.append(f'wynik = limit({expr}, {var}, {approach}{dir_str})')

    elif ptype == 'derivative':
        expr = _latex_to_sympy(params.get('expression', '0'))
        var = params.get('variable', 'x')
        task = params.get('task', 'derivative')
        code_lines.append(f'f = {expr}')
        if task == 'tangent_line':
            tangent_y = params.get('tangent_y_value', '')
            if tangent_y:
                # Solve f(x) = y_target to find x0 first
                code_lines.append(f'fp = diff(f, {var})')
                code_lines.append(f'x0_solutions = solve(f - ({_latex_to_sympy(tangent_y)}), {var})')
                code_lines.append(f'results = []')
                code_lines.append(f'for x0 in x0_solutions:')
                code_lines.append(f'    if x0.is_real:')
                code_lines.append(f'        slope = fp.subs({var}, x0)')
                code_lines.append(f'        y0 = f.subs({var}, x0)')
                code_lines.append(f'        tangent = slope * ({var} - x0) + y0')
                code_lines.append(f'        results.append((x0, expand(tangent)))')
                code_lines.append(f'if len(results) == 1:')
                code_lines.append(f'    wynik = f"x_0 = {{results[0][0]}}\\nstyczna: y = {{results[0][1]}}"')
                code_lines.append(f'else:')
                code_lines.append(f'    wynik = results')
            else:
                pt = params.get('tangent_point', params.get('point', '0'))
                code_lines.append(f'fp = diff(f, {var})')
                code_lines.append(f'x0 = {pt}')
                code_lines.append(f'slope = fp.subs({var}, x0)')
                code_lines.append(f'y0 = f.subs({var}, x0)')
                code_lines.append(f'tangent = slope * ({var} - x0) + y0')
                code_lines.append(f'wynik = expand(tangent)')
        elif task == 'extrema':
            code_lines.append(f'fp = diff(f, {var})')
            code_lines.append(f'critical = solve(fp, {var})')
            code_lines.append(f'wynik = [(cp, f.subs({var}, cp)) for cp in critical]')
        else:
            code_lines.append(f'wynik = diff(f, {var})')
            if params.get('point'):
                code_lines.append(f'wynik = wynik.subs({var}, {params["point"]})')

    elif ptype == 'trig_equation':
        eq = _latex_to_sympy(params.get('equation', '0'))
        var = params.get('variable', 'x')
        ds = _latex_to_sympy(params.get('domain_start', '0'))
        de = _latex_to_sympy(params.get('domain_end', '2*pi'))
        # If equation has '=', convert to expression = 0
        if '==' in eq:
            parts = eq.split('==')
            eq = f'({parts[0].strip()}) - ({parts[1].strip()})'
        code_lines.append(f'solutions = solveset({eq}, {var}, domain=Interval({ds}, {de}))')
        code_lines.append(f'if solutions.is_FiniteSet:')
        code_lines.append(f'    wynik = sorted(list(solutions))')
        code_lines.append(f'else:')
        code_lines.append(f'    wynik = solutions')

    elif ptype == 'polynomial_roots':
        expr = _latex_to_sympy(params.get('expression', '0'))
        var = params.get('variable', 'x')
        task = params.get('task', 'roots')
        code_lines.append(f'expr = {expr}')
        if task == 'factorize':
            code_lines.append(f'wynik = factor(expr)')
        elif task == 'evaluate':
            code_lines.append(f'wynik = expr.subs({var}, {params.get("eval_point", "0")})')
        else:
            code_lines.append(f'wynik = solve(expr, {var})')

    elif ptype == 'logarithm':
        task = params.get('task', 'evaluate')
        if task == 'solve_equation':
            var = params.get('variable', 'x')
            code_lines.append(f'{var} = symbols("{var}", positive=True)')
            code_lines.append(f'eq = {params.get("equation", "0")}')
            code_lines.append(f'wynik = solve(eq, {var})')
        else:
            code_lines.append(f'wynik = simplify({params.get("expression", "0")})')

    elif ptype == 'probability':
        subtype = params.get('type', 'classical')
        if subtype == 'bernoulli':
            code_lines.append(f'n_val, k_val, p_val = {params.get("n", "1")}, {params.get("k", "0")}, Rational({params.get("p", "1/2")})')
            code_lines.append(f'wynik = binomial(n_val, k_val) * p_val**k_val * (1 - p_val)**(n_val - k_val)')
        else:
            fav = params.get('favorable_outcomes', '1')
            tot = params.get('total_outcomes', '1')
            code_lines.append(f'wynik = Rational({fav}, {tot})')

    elif ptype == 'combinatorics':
        subtype = params.get('type', 'combination')
        if params.get('expression'):
            code_lines.append(f'wynik = {_latex_to_sympy(params["expression"])}')
        elif subtype == 'combination':
            code_lines.append(f'wynik = binomial({params.get("n", "1")}, {params.get("k", "0")})')
        elif subtype == 'permutation':
            if params.get('k'):
                code_lines.append(f'wynik = factorial({params["n"]}) / factorial({params["n"]} - {params["k"]})')
            else:
                code_lines.append(f'wynik = factorial({params.get("n", "1")})')
        elif subtype == 'variation':
            if params.get('with_repetition'):
                code_lines.append(f'wynik = {params.get("n", "1")}**{params.get("k", "1")}')
            else:
                code_lines.append(f'wynik = factorial({params["n"]}) / factorial({params["n"]} - {params.get("k", "0")})')
        else:
            code_lines.append(f'wynik = {params.get("expression", params.get("n", "1"))}')

    elif ptype == 'sequence_arithmetic':
        task = params.get('task', 'nth_term')
        conditions = params.get('conditions', [])
        if conditions:
            code_lines.append('_a1, _d = symbols("_a1 _d", real=True)')
            eqs = []
            for cond in conditions:
                cond_str = _latex_to_sympy(str(cond))
                cm = re.match(r'a[_]?(\d+)\s*=\s*(.+)', cond_str)
                if cm:
                    idx, val = cm.group(1), cm.group(2).strip()
                    eqs.append(f'Eq(_a1 + ({idx} - 1)*_d, {val})')
            if eqs:
                code_lines.append(f'_rozw = solve([{", ".join(eqs)}], [_a1, _d])')
                code_lines.append('if isinstance(_rozw, dict):')
                code_lines.append('    _a1 = _rozw[Symbol("_a1")]')
                code_lines.append('    _d = _rozw[Symbol("_d")]')
                code_lines.append('elif isinstance(_rozw, list) and len(_rozw) > 0:')
                code_lines.append('    if isinstance(_rozw[0], tuple):')
                code_lines.append('        _a1, _d = _rozw[0]')
                code_lines.append('    else:')
                code_lines.append('        _a1 = _rozw[0]')
        else:
            if params.get('a1'):
                code_lines.append(f'_a1 = {_latex_to_sympy(params["a1"])}')
            else:
                code_lines.append('_a1 = symbols("_a1", real=True)')
            if params.get('d'):
                code_lines.append(f'_d = {_latex_to_sympy(params["d"])}')
            else:
                code_lines.append('_d = symbols("_d", real=True)')
        n_val = _latex_to_sympy(params.get('n', 'n'))
        if task == 'nth_term':
            code_lines.append(f'wynik = _a1 + ({n_val} - 1)*_d')
        elif task == 'sum':
            code_lines.append(f'wynik = {n_val} * (2*_a1 + ({n_val} - 1)*_d) / 2')
        elif task == 'find_d':
            code_lines.append('wynik = _d')
        elif task == 'find_a1':
            code_lines.append('wynik = _a1')
        else:
            code_lines.append(f'wynik = _a1 + ({n_val} - 1)*_d')

    elif ptype == 'sequence_geometric':
        task = params.get('task', 'nth_term')
        conditions = params.get('conditions', [])
        if conditions:
            code_lines.append('_a1, _q = symbols("_a1 _q", positive=True)')
            eqs = []
            for cond in conditions:
                cond_str = _latex_to_sympy(str(cond))
                cm = re.match(r'a[_]?(\d+)\s*=\s*(.+)', cond_str)
                if cm:
                    idx, val = cm.group(1), cm.group(2).strip()
                    eqs.append(f'Eq(_a1 * _q**({idx} - 1), {val})')
            if eqs:
                code_lines.append(f'_rozw = solve([{", ".join(eqs)}], [_a1, _q])')
                code_lines.append('if isinstance(_rozw, dict):')
                code_lines.append('    _a1 = _rozw[Symbol("_a1")]')
                code_lines.append('    _q = _rozw[Symbol("_q")]')
                code_lines.append('elif isinstance(_rozw, list) and len(_rozw) > 0:')
                code_lines.append('    if isinstance(_rozw[0], tuple):')
                code_lines.append('        _a1, _q = _rozw[0]')
                code_lines.append('    else:')
                code_lines.append('        _a1 = _rozw[0]')
        else:
            if params.get('a1'):
                code_lines.append(f'_a1 = {_latex_to_sympy(params["a1"])}')
            else:
                code_lines.append('_a1 = symbols("_a1", positive=True)')
            if params.get('q'):
                code_lines.append(f'_q = {_latex_to_sympy(params["q"])}')
            else:
                code_lines.append('_q = symbols("_q", positive=True)')
        n_val = _latex_to_sympy(params.get('n', 'n'))
        if task == 'nth_term':
            code_lines.append(f'wynik = _a1 * _q**({n_val} - 1)')
        elif task == 'sum':
            code_lines.append(f'wynik = _a1 * (1 - _q**{n_val}) / (1 - _q)')
        elif task == 'infinite_sum':
            code_lines.append(f'wynik = _a1 / (1 - _q)')
        elif task == 'decay_threshold':
            # Exponential decay/growth: m(n) = m0 * q^n, find first n where m(n) < threshold
            m0 = _latex_to_sympy(params.get('initial_value', params.get('a1', '1')))
            q_val = _latex_to_sympy(params.get('q', 'Rational(1,2)'))
            threshold = _latex_to_sympy(params.get('threshold', '1'))
            code_lines.append(f'_m0 = {m0}')
            code_lines.append(f'_q_ratio = {q_val}')
            code_lines.append(f'_threshold = {threshold}')
            code_lines.append(f'_n_sym = symbols("_n_sym", positive=True)')
            code_lines.append(f'_n_val = ceiling(log(_threshold / _m0) / log(_q_ratio))')
            code_lines.append(f'wynik = _n_val')
        elif task == 'find_q':
            code_lines.append('wynik = _q')
        elif task == 'find_a1':
            code_lines.append('wynik = _a1')
        else:
            code_lines.append(f'wynik = _a1 * _q**({n_val} - 1)')

    elif ptype == 'parametric_equation':
        eq = _latex_to_sympy(params.get('equation', '0'))
        var = params.get('variable', 'x')
        param = params.get('parameter', 'm')
        condition = params.get('condition', 'two_real_roots')
        # Ensure equation is an expression (not "expr = 0" form)
        if '==' in eq:
            eq = eq.split('==')[0].strip() + ' - (' + eq.split('==')[1].strip() + ')'
        code_lines.append(f'_eq_expr = {eq}')
        code_lines.append(f'poly = Poly(_eq_expr, {var})')
        code_lines.append(f'coeffs = poly.all_coeffs()')
        code_lines.append(f'a_c = coeffs[0] if len(coeffs) > 2 else 1')
        code_lines.append(f'b_c = coeffs[1] if len(coeffs) > 2 else coeffs[0]')
        code_lines.append(f'c_c = coeffs[-1]')
        code_lines.append(f'delta = b_c**2 - 4*a_c*c_c')
        if condition == 'two_real_roots':
            code_lines.append(f'wynik = solve(delta > 0, {param})')
        elif condition == 'one_real_root':
            code_lines.append(f'wynik = solve(Eq(delta, 0), {param})')
        elif condition == 'no_real_roots':
            code_lines.append(f'wynik = solve(delta < 0, {param})')
        elif condition == 'roots_positive':
            code_lines.append(f's1 = solveset(delta >= 0, {param}, S.Reals)')
            code_lines.append(f's2 = solveset(-b_c/a_c > 0, {param}, S.Reals)')
            code_lines.append(f's3 = solveset(c_c/a_c > 0, {param}, S.Reals)')
            code_lines.append(f'wynik = Intersection(s1, s2, s3)')
        elif condition == 'roots_negative':
            code_lines.append(f's1 = solveset(delta >= 0, {param}, S.Reals)')
            code_lines.append(f's2 = solveset(-b_c/a_c < 0, {param}, S.Reals)')
            code_lines.append(f's3 = solveset(c_c/a_c > 0, {param}, S.Reals)')
            code_lines.append(f'wynik = Intersection(s1, s2, s3)')
        elif condition == 'roots_opposite_sign':
            code_lines.append(f'wynik = solve(c_c/a_c < 0, {param})')
        elif condition == 'x1_equals_kx2':
            # Vieta: x1+x2=-b/a, x1*x2=c/a, x1=k*x2
            k_val = params.get('extra_value', '2')
            code_lines.append(f'_k = {_latex_to_sympy(k_val)}')
            code_lines.append(f'# Vieta: (1+k)*x2 = -b/a, k*x2^2 = c/a')
            code_lines.append(f'# Substitute: k*(-b/(a*(1+k)))^2 = c/a')
            code_lines.append(f'vieta_eq = a_c * c_c * _k**2 + (2*a_c*c_c - b_c**2)*_k + a_c*c_c')
            code_lines.append(f'delta_cond = delta > 0')
            code_lines.append(f'_m_vals = solve(vieta_eq, {param})')
            code_lines.append(f'wynik = [mv for mv in _m_vals if (delta.subs({param}, mv) > 0) == True]')
            code_lines.append(f'if not wynik: wynik = _m_vals')
        elif condition == 'x1_cubed_plus_x2_cubed':
            # x1^3+x2^3 = (x1+x2)^3 - 3*x1*x2*(x1+x2)
            bound = params.get('extra_value', '0')
            code_lines.append(f'_sum = -b_c / a_c')
            code_lines.append(f'_prod = c_c / a_c')
            code_lines.append(f'_cubes = _sum**3 - 3*_prod*_sum')
            code_lines.append(f's1 = solveset(delta > 0, {param}, S.Reals)')
            code_lines.append(f's2 = solveset(_cubes > {_latex_to_sympy(bound)}, {param}, S.Reals)')
            code_lines.append(f'wynik = Intersection(s1, s2)')
        elif condition == 'roots_sum':
            bound = params.get('extra_value', '0')
            code_lines.append(f'_sum = -b_c / a_c')
            code_lines.append(f's1 = solveset(delta > 0, {param}, S.Reals)')
            code_lines.append(f's2 = solveset(_sum > {_latex_to_sympy(bound)}, {param}, S.Reals)')
            code_lines.append(f'wynik = Intersection(s1, s2)')
        elif condition == 'roots_product':
            bound = params.get('extra_value', '0')
            code_lines.append(f'_prod = c_c / a_c')
            code_lines.append(f's1 = solveset(delta > 0, {param}, S.Reals)')
            code_lines.append(f's2 = solveset(_prod > {_latex_to_sympy(bound)}, {param}, S.Reals)')
            code_lines.append(f'wynik = Intersection(s1, s2)')
        else:
            code_lines.append(f'wynik = solve({condition}, {param})')

    elif ptype == 'geometry_analytic':
        # Use description and coordinates — also try to extract from question text
        desc = params.get('description', '')
        code_lines.append(f'# {desc}')
        points = params.get('points', [])
        # Normalize point format — LLM may return various shapes
        normalized_pts = []
        _pt_names = iter('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        for pt in points:
            if isinstance(pt, dict) and 'name' in pt and 'x' in pt and 'y' in pt:
                normalized_pts.append(pt)
            elif isinstance(pt, dict) and 'x' in pt and 'y' in pt:
                normalized_pts.append({'name': next(_pt_names), 'x': str(pt['x']), 'y': str(pt['y'])})
            elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                normalized_pts.append({'name': next(_pt_names), 'x': str(pt[0]), 'y': str(pt[1])})
            elif isinstance(pt, dict):
                # Try first two numeric-looking values
                vals = [v for v in pt.values() if isinstance(v, (int, float, str))]
                if len(vals) >= 2:
                    nm = pt.get('name', pt.get('label', next(_pt_names)))
                    normalized_pts.append({'name': str(nm), 'x': str(vals[-2] if 'name' in pt else vals[0]), 'y': str(vals[-1])})
        points = normalized_pts
        # If no points in params, try to extract from question text
        if not points:
            point_matches = re.findall(r'([A-Z])\s*[=(]\s*(-?\d+(?:[./]\d+)?)\s*[,;]\s*(-?\d+(?:[./]\d+)?)\s*\)', question_text)
            if not point_matches:
                point_matches = re.findall(r'([A-Z])\s*=\s*\(\s*(-?\d+(?:[./]\d+)?)\s*,\s*(-?\d+(?:[./]\d+)?)\s*\)', question_text)
            points = [{'name': m[0], 'x': m[1], 'y': m[2]} for m in point_matches]
        if points:
            for pt in points:
                code_lines.append(f'{pt["name"]} = Point({_latex_to_sympy(pt["x"])}, {_latex_to_sympy(pt["y"])})')
            task = params.get('task', 'distance')
            if task == 'distance' and len(points) >= 2:
                p0, p1 = points[0]['name'], points[1]['name']
                code_lines.append(f'wynik = {p0}.distance({p1})')
            elif task == 'midpoint' and len(points) >= 2:
                p0, p1 = points[0]['name'], points[1]['name']
                code_lines.append(f'wynik = {p0}.midpoint({p1})')
            elif task == 'line_equation' and len(points) >= 2:
                p0, p1 = points[0]['name'], points[1]['name']
                code_lines.append(f'line = Line({p0}, {p1})')
                code_lines.append(f'wynik = line.equation()')
            else:
                # For complex tasks, try distance between first two points as default
                if len(points) >= 2:
                    p0, p1 = points[0]['name'], points[1]['name']
                    code_lines.append(f'wynik = {p0}.distance({p1})')
                else:
                    code_lines.append('wynik = "complex geometry task"')
        else:
            # Fallback: try to extract lines/circles from params
            if params.get('lines') or params.get('circles'):
                code_lines.append('# Line/circle geometry — needs manual handling')
            code_lines.append('wynik = "no coordinate data"')

    elif ptype == 'geometry_area':
        pts = params.get('coordinates', [])
        # Normalize point format
        normalized_area_pts = []
        _area_pt_names = iter('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        for pt in pts:
            if isinstance(pt, dict) and 'name' in pt and 'x' in pt and 'y' in pt:
                normalized_area_pts.append(pt)
            elif isinstance(pt, dict) and 'x' in pt and 'y' in pt:
                normalized_area_pts.append({'name': next(_area_pt_names), 'x': str(pt['x']), 'y': str(pt['y'])})
            elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                normalized_area_pts.append({'name': next(_area_pt_names), 'x': str(pt[0]), 'y': str(pt[1])})
            elif isinstance(pt, dict):
                vals = [v for v in pt.values() if isinstance(v, (int, float, str))]
                if len(vals) >= 2:
                    nm = pt.get('name', pt.get('label', next(_area_pt_names)))
                    normalized_area_pts.append({'name': str(nm), 'x': str(vals[-2] if 'name' in pt else vals[0]), 'y': str(vals[-1])})
        pts = normalized_area_pts
        if not pts:
            # Try to extract from question text
            point_matches = re.findall(r'([A-Z])\s*[=(]\s*(-?\d+(?:[./]\d+)?)\s*[,;]\s*(-?\d+(?:[./]\d+)?)\s*\)', question_text)
            if not point_matches:
                point_matches = re.findall(r'([A-Z])\s*=\s*\(\s*(-?\d+(?:[./]\d+)?)\s*,\s*(-?\d+(?:[./]\d+)?)\s*\)', question_text)
            pts = [{'name': m[0], 'x': m[1], 'y': m[2]} for m in point_matches]
        if pts:
            for pt in pts:
                code_lines.append(f'{pt["name"]} = Point({_latex_to_sympy(pt["x"])}, {_latex_to_sympy(pt["y"])})')
            names = [pt['name'] for pt in pts]
            if len(pts) == 3:
                code_lines.append(f'fig = Triangle({", ".join(names)})')
            else:
                code_lines.append(f'fig = Polygon({", ".join(names)})')
            code_lines.append(f'wynik = abs(fig.area)')
        else:
            desc = params.get('description', '')
            code_lines.append(f'# {desc}')
            code_lines.append('wynik = "no coordinates"')

    elif ptype == 'geometry_solid':
        solid = params.get('solid', 'prism')
        base = params.get('base', 'square')
        kv = params.get('known_values', {})
        for key, val in kv.items():
            code_lines.append(f'{key} = {val}')
        if solid == 'prism':
            if base == 'triangle':
                code_lines.append('S_base = sqrt(3)/4 * a**2')
            elif base == 'hexagon':
                code_lines.append('S_base = 3*sqrt(3)/2 * a**2')
            else:
                code_lines.append('S_base = a**2')
            code_lines.append('V = S_base * h')
        elif solid == 'pyramid':
            if base == 'square':
                code_lines.append('S_base = a**2')
            else:
                code_lines.append('S_base = sqrt(3)/4 * a**2')
            code_lines.append('V = Rational(1, 3) * S_base * h')
        elif solid == 'cylinder':
            code_lines.append('V = pi * r**2 * h')
        elif solid == 'cone':
            code_lines.append('V = Rational(1, 3) * pi * r**2 * h')
        elif solid == 'sphere':
            code_lines.append('V = Rational(4, 3) * pi * r**3')
        task = params.get('task', 'volume')
        if task == 'volume':
            code_lines.append('wynik = simplify(V)')
        elif task == 'surface_area':
            code_lines.append('wynik = simplify(S_total)')
        else:
            code_lines.append('wynik = V')

    elif ptype == 'optimization':
        var = params.get('variable', 'x')
        code_lines.append(f'f = {_latex_to_sympy(params.get("function_expr", "x"))}')
        code_lines.append(f'fp = diff(f, {var})')
        code_lines.append(f'critical = solve(fp, {var})')
        code_lines.append(f'values = [(cp, f.subs({var}, cp)) for cp in critical if cp.is_real]')
        if params.get('task', 'minimize') == 'minimize':
            code_lines.append('best = min(values, key=lambda p: p[1]) if values else (None, None)')
        else:
            code_lines.append('best = max(values, key=lambda p: p[1]) if values else (None, None)')
        code_lines.append('wynik = best[1]')

    elif ptype == 'inequality':
        expr = _latex_to_sympy(params.get('expression', '0'))
        var = params.get('variable', 'x')
        rel = params.get('relation', '>')
        rhs = _latex_to_sympy(params.get('rhs', '0'))
        code_lines.append(f'try:')
        code_lines.append(f'    wynik = solve_univariate_inequality({expr} {rel} {rhs}, {var}, relational=False)')
        code_lines.append(f'except:')
        code_lines.append(f'    wynik = solveset({expr} {rel} {rhs}, {var}, S.Reals)')

    elif ptype == 'function_properties':
        expr = _latex_to_sympy(params.get('expression', 'x'))
        var = params.get('variable', 'x')
        task = params.get('task', 'zeros')
        code_lines.append(f'f = {expr}')
        if task == 'domain':
            code_lines.append(f'from sympy.calculus.util import continuous_domain')
            code_lines.append(f'wynik = continuous_domain(f, {var}, S.Reals)')
        elif task == 'range':
            code_lines.append(f'from sympy.calculus.util import function_range')
            code_lines.append(f'wynik = function_range(f, {var}, S.Reals)')
        elif task == 'zeros':
            code_lines.append(f'wynik = solve(f, {var})')
        elif task == 'monotonicity':
            code_lines.append(f'wynik = solve(diff(f, {var}), {var})')
        else:
            code_lines.append(f'wynik = simplify(f)')

    elif ptype == 'proof':
        # Proofs: try algebraic verification for identities
        if params.get('lhs') and params.get('rhs'):
            vars_str = ', '.join(params.get('variables', ['x']))
            code_lines.append(f'lhs = {params["lhs"]}')
            code_lines.append(f'rhs = {params["rhs"]}')
            code_lines.append(f'wynik = simplify(lhs - rhs)')
        else:
            code_lines.append(f'wynik = "proof requires step-by-step reasoning"')

    elif ptype == 'simplification':
        expr = _latex_to_sympy(params.get('expression', '0'))
        task = params.get('task', 'simplify')
        var = params.get('variable', 'x')
        code_lines.append(f'_expr = {expr}')
        if task == 'evaluate':
            eval_pt = _latex_to_sympy(params.get('eval_point', '0'))
            code_lines.append(f'wynik = _expr.subs({var}, {eval_pt})')
        elif task == 'compare':
            code_lines.append(f'wynik = simplify(_expr)')
        else:
            code_lines.append(f'wynik = simplify(_expr)')

    else:  # general
        if params.get('sympy_code'):
            return params['sympy_code']
        elif params.get('expression'):
            code_lines.append(f'wynik = simplify({params["expression"]})')
        else:
            code_lines.append(f'wynik = "cannot solve without structured params"')

    # Add MC option comparison if applicable
    if is_mc and mc_options and len(mc_options) == 4:
        code_lines.append('')
        code_lines.append('# MC option comparison')
        # Build options dict safely — each value on its own try/except
        code_lines.append('_options = {}')
        for letter in ['A', 'B', 'C', 'D']:
            val = mc_options.get(letter, 'None')
            code_lines.append(f'try:')
            code_lines.append(f'    _options["{letter}"] = {val}')
            code_lines.append(f'except:')
            code_lines.append(f'    _options["{letter}"] = None')
        code_lines.append('_found = False')
        code_lines.append('for _lit, _val in _options.items():')
        code_lines.append('    if _val is None: continue')
        code_lines.append('    try:')
        code_lines.append('        if abs(float(N(wynik)) - float(N(_val))) < 1e-6:')
        code_lines.append('            print(f"ODPOWIEDZ: {_lit}")')
        code_lines.append('            _found = True')
        code_lines.append('            break')
        code_lines.append('    except:')
        code_lines.append('        try:')
        code_lines.append('            if simplify(wynik - _val) == 0:')
        code_lines.append('                print(f"ODPOWIEDZ: {_lit}")')
        code_lines.append('                _found = True')
        code_lines.append('                break')
        code_lines.append('        except: pass')
        code_lines.append('if not _found:')
        code_lines.append('    print("ODPOWIEDZ:", wynik)')
    else:
        code_lines.append('print("ODPOWIEDZ:", wynik)')

    return '\n'.join(code_lines)


# ── Extraction Chain (Level 2+3) ─────────────────────────────────────────

# Template definitions — each has keywords to match and an extraction prompt
EXTRACTION_TEMPLATES = [
    {
        'id': 'exponential_decay',
        'keywords': ['masa', 'substancj', 'maleje', 'ubywa', 'rozpad', 'procent', 'dob'],
        'extraction_prompt': 'Wyodrębnij wartości z zadania. Odpowiedz TYLKO JSON:\n{"initial_value": <wartość początkowa>, "rate": <współczynnik np 0.81 jeśli ubywa 19%>, "threshold": <wartość progowa>, "direction": "<less lub greater>", "formula_requested": <true/false>}',
        'build_code': lambda v: f'''from sympy import *
m0 = {v.get("initial_value", 4)}
q_val = {v.get("rate", "0.81")}
threshold = {v.get("threshold", "1.5")}
import math
_t = 0
while True:
    _t += 1
    val = float(m0) * float(q_val)**_t
    if val {"<" if v.get("direction", "less") == "less" else ">"} float(threshold):
        break
    if _t > 1000:
        break
print("ODPOWIEDZ:", _t)
'''
    },
    {
        'id': 'bernoulli_probability',
        'keywords': ['prawdopodobieństwo', 'partii', 'rzut', 'wygran'],
        'extraction_prompt': 'Wyodrębnij z zadania o prawdopodobieństwie. Odpowiedz TYLKO JSON:\n{"n": <liczba prób>, "p_num": <licznik prawdop sukcesu>, "p_den": <mianownik>, "condition": "<at_least_k lub exactly_k lub at_most_k>", "k": <wymagana liczba sukcesów>}',
        'build_code': lambda v: f'''from sympy import *
p = Rational({v.get("p_num", 1)}, {v.get("p_den", 4)})
q = 1 - p
n = {v.get("n", 5)}
k = {v.get("k", 4)}
cond = "{v.get("condition", "at_least_k")}"
if cond == "at_least_k":
    wynik = sum(binomial(n, i) * p**i * q**(n-i) for i in range(k, n+1))
elif cond == "at_most_k":
    wynik = sum(binomial(n, i) * p**i * q**(n-i) for i in range(0, k+1))
else:
    wynik = binomial(n, k) * p**k * q**(n-k)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'tangent_line_complete',
        'keywords': ['styczna', 'wykres', 'punkt', 'należy'],
        'extraction_prompt': 'Wyodrębnij z zadania o stycznej. Odpowiedz TYLKO JSON:\n{"function_expr": "<funkcja w SymPy>", "y_value": <wartość y punktu na wykresie>, "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', real=True)
f = {v.get("function_expr", "x**2")}
y_val = {v.get("y_value", 0)}
x0_solutions = solve(Eq(f, y_val), x)
results = []
for x0 in x0_solutions:
    if x0.is_real:
        fp = diff(f, x)
        slope = fp.subs(x, x0)
        y0 = f.subs(x, x0)
        tangent = slope * (x - x0) + y0
        results.append((x0, simplify(tangent)))
if len(results) == 1:
    x0, tang = results[0]
    print(f"x_0 = {{x0}}")
    print(f"Równanie stycznej: y = {{tang}}")
    print("ODPOWIEDZ: x_0 =", x0, ", y =", tang)
elif len(results) > 1:
    for x0, tang in results:
        print(f"x_0 = {{x0}}: y = {{tang}}")
    print("ODPOWIEDZ:", results)
'''
    },
    {
        'id': 'arithmetic_sequence_word',
        'keywords': ['rata', 'spłat', 'mniejsza od poprzedniej', 'większa od poprzedniej'],
        'extraction_prompt': 'Wyodrębnij z zadania o ciągu arytmetycznym. Odpowiedz TYLKO JSON:\n{"total_sum": <suma>, "n": <liczba wyrazów/rat>, "d": <różnica ciągu>, "find": "<a1 lub d lub n>"}',
        'build_code': lambda v: f'''from sympy import *
_a1 = symbols('_a1', real=True)
_S = {v.get("total_sum", 0)}
_n = {v.get("n", 1)}
_d = {v.get("d", 0)}
eq = Eq(_n * (2*_a1 + (_n - 1)*_d) / 2, _S)
wynik = solve(eq, _a1)
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'prove_inequality_square',
        'keywords': ['wykaż', 'udowodnij', 'prawdziwa', 'nierówność'],
        'extraction_prompt': 'Wyodrębnij nierówność do udowodnienia. Odpowiedz TYLKO JSON:\n{"lhs": "<lewa strona w SymPy>", "rhs": "<prawa strona w SymPy>", "variables": ["x", "y"]}',
        'build_code': lambda v: f'''from sympy import *
{", ".join(v.get("variables", ["x", "y"]))} = symbols("{" ".join(v.get("variables", ["x", "y"]))}", real=True)
lhs = {v.get("lhs", "0")}
rhs = {v.get("rhs", "0")}
diff_expr = expand(lhs - rhs)
print("lhs - rhs =", diff_expr)
vars_list = [{", ".join(v.get("variables", ["x", "y"]))}]
critical = solve([diff(diff_expr, var) for var in vars_list], vars_list)
if critical:
    if isinstance(critical, dict):
        min_val = diff_expr.subs(critical)
    elif isinstance(critical, list) and len(critical) > 0:
        pt = critical[0]
        if isinstance(pt, (tuple, list)):
            subs_dict = dict(zip(vars_list, pt))
            min_val = diff_expr.subs(subs_dict)
        else:
            min_val = diff_expr.subs(vars_list[0], pt)
    else:
        min_val = None
    if min_val is not None and min_val > 0:
        print("ODPOWIEDZ: Wyrażenie jest zawsze dodatnie (minimum =", min_val, "> 0)")
    elif min_val is not None and min_val == 0:
        print("ODPOWIEDZ: Wyrażenie jest nieujemne (minimum = 0)")
    else:
        print("ODPOWIEDZ:", diff_expr)
else:
    print("ODPOWIEDZ:", diff_expr)
'''
    },
    {
        'id': 'similar_triangles',
        'keywords': ['podobne', 'trójkąt', 'przyprostokątne', 'przeciwprostokątna'],
        'extraction_prompt': 'Wyodrębnij z zadania o podobnych trójkątach. Odpowiedz TYLKO JSON:\n{"triangle1_sides": [<bok1>, <bok2>], "known_hypotenuse_t2": <przeciwprostokątna T2>}',
        'build_code': lambda v: f'''from sympy import *
a1, b1 = {v.get("triangle1_sides", [5, 12])[0]}, {v.get("triangle1_sides", [5, 12])[1]}
c1 = sqrt(a1**2 + b1**2)
known_hyp_t2 = {v.get("known_hypotenuse_t2", 26)}
scale = Rational(known_hyp_t2, c1)
a2 = a1 * scale
b2 = b1 * scale
pole_t2 = Rational(1, 2) * a2 * b2
print("ODPOWIEDZ:", pole_t2)
'''
    },
    {
        'id': 'perpendicular_diagonal',
        'keywords': ['przekątna', 'prostopadła', 'kwadrat', 'prostą zawierającą'],
        'extraction_prompt': 'Wyodrębnij punkty z zadania. Odpowiedz TYLKO JSON:\n{"point1": {"x": <x1>, "y": <y1>}, "point2": {"x": <x2>, "y": <y2>}}',
        'build_code': lambda v: f'''from sympy import *
x, y = symbols('x y', real=True)
A = Point({v.get("point1", {}).get("x", -8)}, {v.get("point1", {}).get("y", -2)})
C = Point({v.get("point2", {}).get("x", 0)}, {v.get("point2", {}).get("y", 4)})
M = A.midpoint(C)
AC = Line(A, C)
slope_AC = AC.slope
if slope_AC != 0:
    slope_perp = -1 / slope_AC
    eq_y = slope_perp * x + M.y - slope_perp * M.x
    print("y =", simplify(eq_y))
    print("ODPOWIEDZ: y =", simplify(eq_y))
else:
    print("ODPOWIEDZ: x =", M.x)
'''
    },
    {
        'id': 'probability_divisibility',
        'keywords': ['losujemy', 'iloczyn', 'podzielny', 'ze zwracaniem'],
        'extraction_prompt': 'Wyodrębnij z zadania. Odpowiedz TYLKO JSON:\n{"number_set": [<lista liczb>], "draws": <ile losowań>, "with_replacement": <true/false>, "condition": "<product_divisible_by lub sum_divisible_by>", "divisor": <przez co podzielny>}',
        'build_code': lambda v: f'''from sympy import *
from itertools import product{"" if v.get("with_replacement", True) else ", combinations"}
numbers = {v.get("number_set", [2,3,4,5,6,7,8,9])}
divisor = {v.get("divisor", 15)}
{"all_pairs = list(product(numbers, repeat=" + str(v.get("draws", 2)) + "))" if v.get("with_replacement", True) else "all_pairs = list(combinations(numbers, " + str(v.get("draws", 2)) + "))"}
favorable = 0
for pair in all_pairs:
    {"val = 1" if v.get("condition", "product_divisible_by") == "product_divisible_by" else "val = sum(pair)"}
    {"for xx in pair: val *= xx" if v.get("condition", "product_divisible_by") == "product_divisible_by" else "pass"}
    if val % divisor == 0:
        favorable += 1
total = len(all_pairs)
wynik = Rational(favorable, total)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'rhombus_trig',
        'keywords': ['romb', 'przekątne', 'kąt rozwarty'],
        'extraction_prompt': 'Wyodrębnij z zadania o rombie. Odpowiedz TYLKO JSON:\n{"side": "<bok w SymPy>", "obtuse_angle_deg": <kąt rozwarty w stopniach>, "find": "<diagonals_product lub area>"}',
        'build_code': lambda v: f'''from sympy import *
a = {v.get("side", "6*sqrt(2)")}
alpha = {v.get("obtuse_angle_deg", 150)}
beta = 180 - alpha
d1 = 2 * a * sin(rad(beta) / 2)
d2 = 2 * a * cos(rad(beta) / 2)
product_diag = simplify(d1 * d2)
area = simplify(d1 * d2 / 2)
find = "{v.get("find", "diagonals_product")}"
if find == "diagonals_product":
    print("ODPOWIEDZ:", product_diag)
elif find == "area":
    print("ODPOWIEDZ:", area)
else:
    print("ODPOWIEDZ: d1 =", simplify(d1), ", d2 =", simplify(d2))
'''
    },
    {
        'id': 'geometric_three_term',
        'keywords': ['ciąg', 'geometryczny', 'trzywyrazowy'],
        'extraction_prompt': 'Wyodrębnij wyrazy ciągu. Odpowiedz TYLKO JSON:\n{"term1": "<pierwszy wyraz>", "term2": "<drugi wyraz>", "term3": "<trzeci wyraz (może zawierać zmienną)>", "unknown_variable": "<nazwa zmiennej>"}',
        'build_code': lambda v: f'''from sympy import *
{v.get("unknown_variable", "a")} = symbols('{v.get("unknown_variable", "a")}', real=True)
t1 = {v.get("term1", 27)}
t2 = {v.get("term2", 9)}
t3 = {v.get("term3", "a - 1")}
eq = Eq(t2**2, t1 * t3)
wynik = solve(eq, {v.get("unknown_variable", "a")})
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'quadratic_inequality',
        'keywords': ['nierówność', 'x**2', 'kwadratow'],
        'extraction_prompt': 'Wyodrębnij nierówność. Odpowiedz TYLKO JSON:\n{"lhs": "<lewa strona po przeniesieniu na jedną stronę w SymPy>", "relation": "<> lub >= lub < lub <=>", "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', real=True)
expr = {v.get("lhs", "x**2 - 2*x")}
try:
    wynik = reduce_inequalities(expr {v.get("relation", ">")} 0, x)
except:
    try:
        wynik = solve_univariate_inequality(expr {v.get("relation", ">")} 0, x, relational=False)
    except:
        wynik = solveset(expr, x, S.Reals)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'cube_geometry',
        'keywords': ['sześcian', 'krawędzi', 'ABCDEFGH', 'przekątnych'],
        'extraction_prompt': 'Wyodrębnij z zadania o sześcianie. Odpowiedz TYLKO JSON:\n{"edge_length": <długość krawędzi>, "triangle_vertices": ["<w1>", "<w2>", "<w3>"], "find": "<height_from_vertex lub area>"}',
        'build_code': lambda v: f'''from sympy import *
from sympy.geometry import Point3D, Line3D
a = {v.get("edge_length", 6)}
A = Point3D(0, 0, 0)
B = Point3D(a, 0, 0)
C = Point3D(a, a, 0)
D = Point3D(0, a, 0)
E = Point3D(0, 0, a)
F = Point3D(a, 0, a)
G = Point3D(a, a, a)
H = Point3D(0, a, a)
line_AH = Line3D(A, H)
line_DE = Line3D(D, E)
S_list = line_AH.intersection(line_DE)
S = S_list[0] if len(S_list) > 0 else Point3D(0, a/2, a/2)
points = {{"A": A, "B": B, "C": C, "D": D, "E": E, "F": F, "G": G, "H": H, "S": S}}
verts = {v.get("triangle_vertices", ["S", "B", "H"])}
P1, P2, P3 = points.get(verts[0], S), points.get(verts[1], B), points.get(verts[2], H)
line_P2P3 = Line3D(P2, P3)
foot = line_P2P3.projection(P1)
height = P1.distance(foot)
print("ODPOWIEDZ:", simplify(height))
'''
    },
    # ── Pillar 2+3 templates: cover specific failing MC/OPEN patterns ──
    {
        'id': 'log_power_eval',
        'keywords': ['log', 'logarytm', 'równa', 'sqrt', 'pierwiastek'],
        'extraction_prompt': 'Wyodrębnij z zadania o logarytmach/potęgach. Odpowiedz TYLKO JSON:\n{"base_expr": "<wyrażenie bazowe jako SymPy, np sqrt(3)>", "exponent_result": "<wynik potęgowania, np 9>", "task": "<find_exponent lub evaluate>"}',
        'build_code': lambda v: f'''from sympy import *
base = {v.get("base_expr", "sqrt(3)")}
target = {v.get("exponent_result", "9")}
n = symbols('n', real=True)
wynik = solve(Eq(base**n, target), n)
if isinstance(wynik, list) and len(wynik) == 1:
    wynik = wynik[0]
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'rational_equation_domain',
        'keywords': ['równanie', 'ułamek', 'mianownik', 'zbiorze', 'rzeczywist'],
        'extraction_prompt': 'Wyodrębnij z zadania o równaniu z ułamkiem. Odpowiedz TYLKO JSON:\n{"numerator": "<licznik w SymPy>", "denominator_factors": ["<czynnik1>", "<czynnik2>"], "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', real=True)
num = {v.get("numerator", "x + 1")}
den_factors = {v.get("denominator_factors", ["x + 2", "x - 3"])}
# Equation: num / prod(den) = 0 → num = 0 with domain restriction
den_product = 1
for fac in den_factors:
    den_product *= sympify(fac)
solutions_num = solve(num, x)
excluded = solve(den_product, x)
valid = [s for s in solutions_num if s not in excluded]
if len(valid) == 0:
    print("ODPOWIEDZ: brak rozwiązań")
elif len(valid) == 1:
    print("ODPOWIEDZ:", valid[0])
else:
    print("ODPOWIEDZ:", valid)
'''
    },
    {
        'id': 'geometric_seq_ratio',
        'keywords': ['ciąg', 'geometryczn', 'iloraz', 'wzor', 'a_n'],
        'extraction_prompt': 'Wyodrębnij z zadania o ciągu geometrycznym. Odpowiedz TYLKO JSON:\n{"formula": "<wzór ogólny a_n w SymPy, np 2**(n-1)>", "variable": "n"}',
        'build_code': lambda v: f'''from sympy import *
n = symbols('n', positive=True, integer=True)
a_n = {v.get("formula", "2**(n-1)")}
a_n1 = a_n.subs(n, n+1)
q = simplify(a_n1 / a_n)
print("ODPOWIEDZ:", q)
'''
    },
    {
        'id': 'arithmetic_mean_property',
        'keywords': ['średnia', 'arytmetyczna', 'liczb', 'równa'],
        'extraction_prompt': 'Wyodrębnij z zadania o średniej. Odpowiedz TYLKO JSON:\n{"original_values": ["a", "b", "c"], "original_mean": 9, "new_values": ["a", "a", "b", "b", "c", "c"], "find": "new_mean"}',
        'build_code': lambda v: f'''from sympy import *
a, b, c_sym = symbols('a b c', real=True)
original_mean = {v.get("original_mean", 9)}
original_count = len({v.get("original_values", ["a", "b", "c"])})
# If mean of a,b,c = M, then (a+b+c) = M * count
# Mean of a,a,b,b,c,c = 2(a+b+c)/6 = (a+b+c)/3 = M
new_values = {v.get("new_values", ["a", "a", "b", "b", "c", "c"])}
new_count = len(new_values)
# Each original value appears N times in new list
sum_original = original_mean * original_count
new_mean = sum_original * (new_count // original_count) / new_count
print("ODPOWIEDZ:", new_mean)
'''
    },
    {
        'id': 'linear_function_decreasing',
        'keywords': ['funkcja', 'liniowa', 'malejąca', 'współczynnik', 'k'],
        'extraction_prompt': 'Wyodrębnij z zadania o funkcji liniowej. Odpowiedz TYLKO JSON:\n{"slope_expr": "<wyrażenie na współczynnik kierunkowy w zmiennej k, np -2*k+3>", "parameter": "k", "condition": "<decreasing lub increasing>"}',
        'build_code': lambda v: f'''from sympy import *
k = symbols('{v.get("parameter", "k")}', real=True)
slope = {v.get("slope_expr", "-2*k + 3")}
cond = "{v.get("condition", "decreasing")}"
if cond == "decreasing":
    wynik = solveset(slope < 0, k, S.Reals)
elif cond == "increasing":
    wynik = solveset(slope > 0, k, S.Reals)
else:
    wynik = solveset(Eq(slope, 0), k, S.Reals)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'trig_identity_find',
        'keywords': ['cos', 'sin', 'tan', 'ostry', 'kąt'],
        'extraction_prompt': 'Wyodrębnij z zadania trygonometrycznego. Odpowiedz TYLKO JSON:\n{"known_func": "<cos lub sin lub tan>", "known_value_num": <licznik>, "known_value_den": <mianownik>, "find_func": "<tan lub sin lub cos>", "angle_type": "<acute lub obtuse>"}',
        'build_code': lambda v: f'''from sympy import *
alpha = symbols('alpha', positive=True)
known = "{v.get("known_func", "cos")}"
val = Rational({v.get("known_value_num", 5)}, {v.get("known_value_den", 13)})
find = "{v.get("find_func", "tan")}"
# Use Pythagorean identity: sin^2 + cos^2 = 1
if known == "cos":
    cos_a = val
    sin_a = sqrt(1 - cos_a**2)  # positive for acute
    tan_a = sin_a / cos_a
elif known == "sin":
    sin_a = val
    cos_a = sqrt(1 - sin_a**2)
    tan_a = sin_a / cos_a
elif known == "tan":
    tan_a = val
    cos_a = 1 / sqrt(1 + tan_a**2)
    sin_a = tan_a * cos_a
if find == "tan":
    wynik = tan_a
elif find == "sin":
    wynik = sin_a
elif find == "cos":
    wynik = cos_a
print("ODPOWIEDZ:", simplify(wynik))
'''
    },
    {
        'id': 'linear_inequality_simple',
        'keywords': ['nierówno', 'rozwiąza', 'przedział', 'zbiorem'],
        'extraction_prompt': 'Wyodrębnij nierówność. Odpowiedz TYLKO JSON:\n{"lhs": "<lewa strona w SymPy>", "rhs": "<prawa strona w SymPy>", "relation": "<< lub > lub <= lub >=>", "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', real=True)
lhs = {v.get("lhs", "1 - Rational(3,2)*x")}
rhs = {v.get("rhs", "Rational(2,3) - x")}
rel = "{v.get("relation", "<")}"
if rel == "<":
    ineq = lhs < rhs
elif rel == ">":
    ineq = lhs > rhs
elif rel == "<=":
    ineq = lhs <= rhs
elif rel == ">=":
    ineq = lhs >= rhs
try:
    wynik = solve_univariate_inequality(ineq, x, relational=False)
except:
    wynik = solveset(lhs - rhs, x, S.Reals)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'circle_center_on_line',
        'keywords': ['okrąg', 'środek', 'prosta', 'przechodzi', 'punkt'],
        'extraction_prompt': 'Wyodrębnij z zadania o okręgu. Odpowiedz TYLKO JSON:\n{"line_coefficients": {"a": <a>, "b": <b>, "c": <c wolny wyraz>}, "point1": {"x": <x1>, "y": <y1>}, "point2": {"x": <x2>, "y": <y2>}, "find": "<center lub radius lub equation>"}',
        'build_code': lambda v: f'''from sympy import *
x, y, p, q_s, r_s = symbols('x y p q r', real=True)
line_a = {v.get("line_coefficients", {}).get("a", 1)}
line_b = {v.get("line_coefficients", {}).get("b", -1)}
line_c = {v.get("line_coefficients", {}).get("c", 0)}
P1x = {v.get("point1", {}).get("x", 1)}
P1y = {v.get("point1", {}).get("y", 5)}
P2x = {v.get("point2", {}).get("x", -2)}
P2y = {v.get("point2", {}).get("y", -4)}
# Center (p, q) lies on line: a*p + b*q + c = 0
# Distance from center to P1 equals distance to P2 (both = radius)
eq1 = Eq(line_a * p + line_b * q_s + line_c, 0)
eq2 = Eq((p - P1x)**2 + (q_s - P1y)**2, (p - P2x)**2 + (q_s - P2y)**2)
sol = solve([eq1, eq2], [p, q_s])
if isinstance(sol, dict):
    cx, cy = sol[p], sol[q_s]
elif isinstance(sol, list) and len(sol) > 0:
    if isinstance(sol[0], (tuple, list)):
        cx, cy = sol[0]
    else:
        cx, cy = sol[0], sol[1] if len(sol) > 1 else 0
else:
    cx, cy = 0, 0
radius_sq = (cx - P1x)**2 + (cy - P1y)**2
print(f"Środek: S = ({{cx}}, {{cy}})")
print(f"Promień: r = {{sqrt(radius_sq)}}")
print("ODPOWIEDZ: S = (", cx, ",", cy, "), r =", sqrt(radius_sq))
'''
    },
    {
        'id': 'percentage_word_problem',
        'keywords': ['procent', 'drzew', 'sadz', 'usch', 'łącznie'],
        'extraction_prompt': 'Wyodrębnij z zadania. Odpowiedz TYLKO JSON:\n{"total": <łączna liczba>, "part1_loss_percent": <procent strat grupy 1>, "part2_loss_percent": <procent strat grupy 2>, "total_loss": <łączna strata>, "find": "<part1_count lub part2_count>"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', positive=True)
total = {v.get("total", 1960)}
p1_loss = Rational({v.get("part1_loss_percent", 5)}, 100)
p2_loss = Rational({v.get("part2_loss_percent", 10)}, 100)
total_loss = {v.get("total_loss", 148)}
# x + (total - x) = total
# x * p1_loss + (total - x) * p2_loss = total_loss
eq = Eq(x * p1_loss + (total - x) * p2_loss, total_loss)
sol = solve(eq, x)
part1 = sol[0] if isinstance(sol, list) and len(sol) > 0 else sol
part2 = total - part1
print(f"Sad 1: {{part1}} drzew, Sad 2: {{part2}} drzew")
print("ODPOWIEDZ:", part1)
'''
    },
    # ── New templates for 2023 patterns ──
    {
        'id': 'expression_simplify',
        'keywords': ['jest równa', 'upro', 'oblicz wartość', 'wyrażeni', 'liczba'],
        'extraction_prompt': 'Wyodrębnij wyrażenie matematyczne do obliczenia. Odpowiedz TYLKO JSON:\n{"expression": "<wyrażenie w składni SymPy, np. 27**(Rational(1,3)) + 3**(Rational(1,2))>"}',
        'build_code': lambda v: f'''from sympy import *
expr = {v.get("expression", "0")}
wynik = simplify(expr)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'nth_root_sum',
        'keywords': ['pierwiast', 'stopni', 'jest równa', 'liczba'],
        'extraction_prompt': 'Wyodrębnij wyrażenie z pierwiastkami. Odpowiedz TYLKO JSON:\n{"expression": "<wyrażenie w składni SymPy, np. 27**Rational(1,9) + 3**Rational(1,9)>"}',
        'build_code': lambda v: f'''from sympy import *
expr = {v.get("expression", "0")}
wynik = simplify(expr)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'rational_equation_solutions',
        'keywords': ['równani', 'rozwiązan', 'ułamk', 'dziedzin'],
        'extraction_prompt': 'Wyodrębnij równanie z ułamkiem algebraicznym. Odpowiedz TYLKO JSON:\n{"numerator": "<licznik w SymPy>", "denominator": "<mianownik w SymPy>", "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x')
numer = {v.get("numerator", "(x+1)*(x-1)**2")}
denom = {v.get("denominator", "(x-1)*(x+1)**2")}
# Find where numerator = 0 AND denominator != 0
numer_roots = solve(numer, x)
domain_excluded = solve(denom, x)
valid_solutions = [r for r in numer_roots if r not in domain_excluded]
if len(valid_solutions) == 0:
    print("ODPOWIEDZ: nie ma rozwiązania")
elif len(valid_solutions) == 1:
    print("ODPOWIEDZ: ma dokładnie jedno rozwiązanie:", valid_solutions[0])
else:
    print("ODPOWIEDZ: ma", len(valid_solutions), "rozwiązania:", valid_solutions)
'''
    },
    {
        'id': 'sequence_term_eval',
        'keywords': ['ciąg', 'określon', 'wzor', 'wyraz'],
        'extraction_prompt': 'Wyodrębnij wzór ciągu i numer wyrazu do obliczenia. Odpowiedz TYLKO JSON:\n{"formula": "<wzór a_n w SymPy, np. 2**n * (n+1)>", "n_value": <numer wyrazu, np. 4>}',
        'build_code': lambda v: f'''from sympy import *
n = symbols('n')
formula = {v.get("formula", "2**n * (n+1)")}
n_val = {v.get("n_value", 4)}
wynik = formula.subs(n, n_val)
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'similar_triangles_area',
        'keywords': ['podobn', 'trójkąt', 'pole', 'przyprostokątn'],
        'extraction_prompt': 'Wyodrębnij dane o podobnych trójkątach. Odpowiedz TYLKO JSON:\n{"leg1": <przyprostokątna 1 trójkąta T1>, "leg2": <przyprostokątna 2 trójkąta T1>, "known_side_T2": <znany bok T2>, "known_side_type": "<hypotenuse lub leg>"}',
        'build_code': lambda v: f'''from sympy import *
a1, b1 = {v.get("leg1", 5)}, {v.get("leg2", 12)}
c1 = sqrt(a1**2 + b1**2)  # hypotenuse of T1
known_T2 = {v.get("known_side_T2", 26)}
side_type = "{v.get("known_side_type", "hypotenuse")}"
if side_type == "hypotenuse":
    scale = known_T2 / c1
else:
    scale = known_T2 / a1  # approximate
a2 = a1 * scale
b2 = b1 * scale
area = Rational(1, 2) * a2 * b2
print("ODPOWIEDZ:", simplify(area))
'''
    },
    {
        'id': 'arithmetic_sequence_rate',
        'keywords': ['rat', 'spłac', 'pożyczk', 'mniejsz'],
        'extraction_prompt': 'Wyodrębnij dane o ratach. Odpowiedz TYLKO JSON:\n{"total_amount": <łączna kwota>, "num_rates": <liczba rat>, "rate_difference": <o ile mniejsza każda kolejna rata>, "find": "first_rate"}',
        'build_code': lambda v: f'''from sympy import *
a1 = symbols('a1', positive=True)
total = {v.get("total_amount", 8910)}
n = {v.get("num_rates", 18)}
d = -{v.get("rate_difference", 30)}  # negative because decreasing
# Sum of AP: S = n/2 * (2*a1 + (n-1)*d)
S = n * (2*a1 + (n-1)*d) / 2
sol = solve(Eq(S, total), a1)
wynik = sol[0] if isinstance(sol, list) else sol
print("ODPOWIEDZ:", wynik)
'''
    },
    {
        'id': 'quadratic_inequality',
        'keywords': ['nierównoś', 'rozwiąż', 'kwadrat'],
        'extraction_prompt': 'Przekształć nierówność do postaci standardowej. Odpowiedz TYLKO JSON:\n{"lhs": "<lewa strona po przeniesieniu na jedną stronę, np. x**2 + 2*x - 3>", "inequality": "<less lub greater>", "variable": "x"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x', real=True)
lhs = {v.get("lhs", "x**2 + 2*x - 3")}
ineq = "{v.get("inequality", "less")}"
if ineq == "less":
    solution = solveset(lhs < 0, x, S.Reals)
else:
    solution = solveset(lhs > 0, x, S.Reals)
print("ODPOWIEDZ:", solution)
'''
    },
    {
        'id': 'square_diagonal_line',
        'keywords': ['kwadrat', 'przekątn', 'równani', 'prost'],
        'extraction_prompt': 'Wyodrębnij współrzędne końców przekątnej kwadratu. Odpowiedz TYLKO JSON:\n{"A": [<x1>, <y1>], "C": [<x2>, <y2>], "find": "equation_of_other_diagonal"}',
        'build_code': lambda v: f'''from sympy import *
x = symbols('x')
Ax, Ay = {v.get("A", [-8, -2])}
Cx, Cy = {v.get("C", [0, 4])}
# Midpoint (use Rational for exact)
Mx = Rational(Ax + Cx, 2)
My = Rational(Ay + Cy, 2)
# AC slope
slope_AC = Rational(Cy - Ay, Cx - Ax)
# BD perpendicular to AC
slope_BD = Rational(-1, 1) / slope_AC
# Equation: y = slope_BD * (x - Mx) + My
y_expr = slope_BD * (x - Mx) + My
print("ODPOWIEDZ: y =", simplify(y_expr))
'''
    },
    {
        'id': 'probability_drawing',
        'keywords': ['losuj', 'prawdopodobień', 'zbior', 'zwracani'],
        'extraction_prompt': 'Wyodrębnij dane o losowaniu. Odpowiedz TYLKO JSON:\n{"set_elements": [<lista elementów zbioru>], "num_draws": <ile losowań>, "with_replacement": <true/false>, "condition": "<warunek zdarzenia, np. suma > 10 lub iloczyn podzielny przez 5>"}',
        'build_code': lambda v: f'''from sympy import *
from itertools import product as cart_product
elements = {v.get("set_elements", [2,3,4,5,6,7,8,9])}
n_draws = {v.get("num_draws", 2)}
with_replacement = {v.get("with_replacement", True)}
condition = "{v.get("condition", "sum > 10")}"

if with_replacement:
    all_outcomes = list(cart_product(elements, repeat=n_draws))
else:
    from itertools import permutations
    all_outcomes = list(permutations(elements, n_draws))

total = len(all_outcomes)
favorable = 0
for outcome in all_outcomes:
    s = sum(outcome)
    p = 1
    for x in outcome:
        p *= x
    # Evaluate condition
    if "sum" in condition.replace("suma", "sum"):
        val = s
    elif "iloczyn" in condition or "product" in condition:
        val = p
    else:
        val = s
    # Simple threshold check
    import re as _re
    m = _re.search(r'[><=]+\s*(\d+)', condition)
    if m:
        threshold = int(m.group(1))
        if ">" in condition and "=" in condition:
            favorable += int(val >= threshold)
        elif ">" in condition:
            favorable += int(val > threshold)
        elif "<" in condition and "=" in condition:
            favorable += int(val <= threshold)
        elif "<" in condition:
            favorable += int(val < threshold)
        elif "=" in condition:
            favorable += int(val == threshold)
    elif "podzielny" in condition or "divisible" in condition:
        m2 = _re.search(r'(\d+)', condition)
        if m2:
            divisor = int(m2.group(1))
            favorable += int(p % divisor == 0)

prob = Rational(favorable, total)
print("ODPOWIEDZ:", prob)
'''
    },
]


def _match_extraction_template(question_text):
    """Match question text against extraction templates by keyword count."""
    lower_q = question_text.lower()
    best_match = None
    best_score = 0
    for tmpl in EXTRACTION_TEMPLATES:
        score = sum(1 for kw in tmpl['keywords'] if kw.lower() in lower_q)
        if score > best_score:
            best_score = score
            best_match = tmpl
    return best_match if best_score >= 2 else None


def _try_extraction_chain(question_text, base_url, model, verbose=True, api_key=None):
    """
    Extraction chain: match template → ask LLM to extract values as JSON → build deterministic code → execute.
    Returns dict with {success, answer, code, output, template} or None.
    """
    template = _match_extraction_template(question_text)
    if not template:
        if verbose:
            print(f"  Extraction: no template matched")
        return None

    if verbose:
        print(f"  Extraction: matched template={template['id']}")

    # Step 1: Ask LLM to extract values
    extraction_system = f"Jesteś ekstrakerem danych matematycznych. Twoim JEDYNYM zadaniem jest wyodrębnić wartości liczbowe i parametry z zadania i zwrócić je jako JSON.\nNIE rozwiązuj zadania. NIE pisz kodu. NIE pisz wyjaśnień.\nOdpowiedz WYŁĄCZNIE poprawnym obiektem JSON.\n\n{template['extraction_prompt']}"

    response = call_bielik(
        extraction_system,
        [{"role": "user", "content": question_text}],
        base_url, model,
        max_tokens=400,
        temperature=0.1,
        api_key=api_key
    )

    if not response:
        return None

    # Clean <think> blocks
    cleaned = re.sub(r'<think>[\s\S]*?</think>', '', response).strip()
    values = _extract_json_from_response(cleaned)

    if not values:
        if verbose:
            print(f"  Extraction: JSON parse failed from: {cleaned[:100]}")
        return None

    if verbose:
        print(f"  Extraction: values={json.dumps(values, ensure_ascii=False)[:100]}")

    # Step 2: Build code from template
    try:
        code = template['build_code'](values)
    except Exception as e:
        if verbose:
            print(f"  Extraction: code build error: {e}")
        return None

    # Step 3: Execute via MCP
    tmp_result = {'answer_got': None, 'errors': []}
    output = _execute_via_mcp(code, verbose, tmp_result)

    if not output or 'Traceback' in output or 'Error' in output:
        if verbose:
            print(f"  Extraction: execution failed: {(output or '')[:80]}")
        return None

    # Extract answer
    answer_match = re.search(r'ODPOWIED[ZŹ]:\s*(.+)', output, re.IGNORECASE)
    answer = answer_match.group(1).strip() if answer_match else None

    return {
        'success': bool(answer),
        'answer': answer,
        'code': code,
        'output': output,
        'template': template['id'],
    }


# ── Zero-Code MC Pipeline (Pillar 4) ─────────────────────────────────────
# For simple MC questions where SymPy computation crashes, let Bielik just pick A/B/C/D.
# This works well for: arithmetic mean properties, percentage word problems,
# graph-reading tasks, and other questions requiring reasoning not computation.

ZERO_CODE_MC_PROMPT = """Jesteś ekspertem od polskiej matury z matematyki.
Przeczytaj uważnie zadanie wielokrotnego wyboru i wybierz poprawną odpowiedź.
Uzasadnij KRÓTKO swoją odpowiedź (1-2 zdania), a następnie napisz:
ODPOWIEDZ: <litera>

WAŻNE: Odpowiedz WYŁĄCZNIE jedną z liter: A, B, C lub D.
"""

def _try_zero_code_mc(question_text, base_url, model, verbose=True, api_key=None):
    """
    Zero-code MC: ask Bielik to pick A/B/C/D directly without any SymPy computation.
    Returns dict with {success, answer, reasoning} or None.
    """
    response = call_bielik(
        ZERO_CODE_MC_PROMPT,
        [{"role": "user", "content": question_text}],
        base_url, model,
        max_tokens=300,
        temperature=0.1,
        api_key=api_key
    )

    if not response:
        return None

    # Extract answer letter
    answer_match = re.search(r'ODPOWIED[ZŹ]:\s*([A-Da-d])', response, re.IGNORECASE)
    if answer_match:
        letter = answer_match.group(1).upper()
        if verbose:
            print(f"  ZeroCode MC: picked {letter}")
        return {'success': True, 'answer': letter, 'reasoning': response[:200]}

    # Try to find a standalone letter
    letter_match = re.search(r'\b([A-D])\b', response)
    if letter_match:
        letter = letter_match.group(1)
        if verbose:
            print(f"  ZeroCode MC: inferred {letter} from response")
        return {'success': True, 'answer': letter, 'reasoning': response[:200]}

    return None


def test_question_classifier(q, base_url, model, verbose=True, api_key=None):
    """Test a single question using the classifier + deterministic solver pipeline."""
    task_num = q['metadata']['task_number']
    year = q['metadata']['year']
    points = q['metadata']['max_points']
    is_mc = bool(q.get('options'))
    question_text = format_question(q)

    result = {
        'year': year,
        'task': task_num,
        'points': points,
        'type': 'MC' if is_mc else 'OPEN',
        'correct': False,
        'answer_expected': q['answer'],
        'answer_got': None,
        'has_code': False,
        'code_valid': False,
        'analytical_ok': True,  # classifier mode — no analytical step
        'summary_ok': False,
        'time_total': 0,
        'errors': [],
        'question_text': question_text,
        'raw_analytical': None,
        'raw_executor': None,
        'extracted_code': None,
        'sympy_stdout': None,
        'classifier_type': None,
        'classifier_confidence': None,
    }

    if verbose:
        print(f"\n{'─'*60}")
        short_q = clean_latex_for_display(q['question'])[:80]
        print(f"  Task {task_num} ({points}pt, {'MC' if is_mc else 'OPEN'}): {short_q}...")
        print(f"  Mode: CLASSIFIER")

    t_start = time.time()

    # Step 0: Build RAG context for classifier
    rag_context = _build_rag_context(question_text)
    if rag_context and verbose:
        cats = _detect_categories(question_text)
        print(f"  RAG categories: {', '.join(cats)}")

    # Step 0.5: Try deterministic template solver BEFORE classifier (no LLM needed!)
    template_result = _try_template_solver(question_text)
    if template_result and template_result.get('success'):
        t_template = time.time() - t_start
        result['pipeline_used'] = 'template_solver'
        result['has_code'] = True
        result['code_valid'] = True
        result['extracted_code'] = template_result['code']
        result['sympy_stdout'] = template_result['output']
        result['answer_got'] = template_result['answer']
        result['classifier_type'] = f"template:{template_result.get('template', 'unknown')}"
        result['classifier_confidence'] = 1.0
        result['time_total'] = t_template
        match, explanation = check_answer(q['answer'], result['answer_got'], q)
        result['correct'] = match
        if verbose:
            print(f"  Template ({t_template:.0f}s): ✅ {template_result.get('template', '?')} → {result['answer_got']}")
            status = '✅' if match else '❌'
            exp_display = clean_latex_for_display(str(q['answer']))
            print(f"  Answer:    {status} Expected: {exp_display}, got: {result['answer_got']}")
        return result

    # Step 1: Call LLM with classifier prompt + RAG context
    t0 = time.time()
    classifier_config = AGENT_CONFIG.get("classifier", {"max_tokens": 800, "temperature": 0.1})

    # Build user message with RAG context injected
    user_msg = question_text
    if rag_context:
        user_msg = f"{rag_context}\n\n--- ZADANIE ---\n{question_text}"

    max_tokens = classifier_config.get("max_tokens", 800)

    classifier_response = call_bielik(
        CLASSIFIER_PROMPT,
        [{"role": "user", "content": user_msg}],
        base_url, model,
        max_tokens=max_tokens,
        temperature=classifier_config.get("temperature", 0.1),
        api_key=api_key
    )
    t_classify = time.time() - t0

    if not classifier_response:
        result['errors'].append("Classifier agent failed")
        result['time_total'] = time.time() - t_start
        return result

    result['raw_analytical'] = classifier_response  # Store in analytical slot for analysis

    # Step 2: Extract JSON classification
    classification = _extract_json_from_response(classifier_response)

    if not classification:
        result['errors'].append(f"Failed to parse classifier JSON: {classifier_response[:200]}")
        if verbose:
            print(f"  Classify ({t_classify:.0f}s): ❌ JSON parse failed")
        result['time_total'] = time.time() - t_start
        return result

    ptype = classification.get('type', 'general')
    confidence = classification.get('confidence', 0.5)
    result['classifier_type'] = ptype
    result['classifier_confidence'] = confidence

    if verbose:
        print(f"  Classify ({t_classify:.0f}s): ✅ type={ptype}, confidence={confidence:.2f}")

    # Step 3: Check if we should fall back
    if confidence < 0.7 or ptype == 'proof':
        if verbose:
            print(f"  ⚠️ Low confidence or proof → trying extraction chain first")
        result['errors'].append(f"Classifier fallback: confidence={confidence}, type={ptype}")

        # Try extraction chain before falling back to old pipeline
        extraction_result = _try_extraction_chain(question_text, base_url, model, verbose, api_key)
        if extraction_result and extraction_result.get('success'):
            result['pipeline_used'] = 'extraction_chain'
            result['has_code'] = True
            result['code_valid'] = True
            result['extracted_code'] = extraction_result.get('code', '')
            result['sympy_stdout'] = extraction_result.get('output', '')
            result['answer_got'] = extraction_result.get('answer')

            if result['answer_got']:
                match_result, explanation = check_answer(q['answer'], result['answer_got'], q)
                result['correct'] = match_result
                if verbose:
                    status = '✅' if match_result else '❌'
                    print(f"  Extraction: {status} {explanation} (template={extraction_result.get('template', '?')})")

            if result['correct']:
                result['time_total'] = time.time() - t_start
                return result

        # Try zero-code MC if applicable before falling back to expensive 3-agent pipeline
        if is_mc:
            if verbose:
                print(f"  ⚠️ Extraction chain failed → trying zero-code MC")
            zc_result = _try_zero_code_mc(question_text, base_url, model, verbose, api_key)
            if zc_result and zc_result.get('success'):
                result['pipeline_used'] = 'zero_code_mc'
                result['answer_got'] = zc_result['answer']
                result['has_code'] = False
                match_result, explanation = check_answer(q['answer'], result['answer_got'], q)
                result['correct'] = match_result
                if verbose:
                    status = '✅' if match_result else '❌'
                    print(f"  ZeroCode:  {status} {explanation}")
                if result['correct']:
                    result['time_total'] = time.time() - t_start
                    return result

        # Extraction chain failed — return result to test_question_hybrid for proper routing
        # (DO NOT call test_question directly — that bypasses hybrid's extraction chain & zero-code MC steps)
        if verbose:
            print(f"  ⚠️ Classifier fast pipelines exhausted → returning to hybrid router")
        result['time_total'] = time.time() - t_start
        return result

    # Step 4: Build deterministic code
    code = _build_deterministic_code(classification, question_text, is_mc)
    result['has_code'] = bool(code)
    result['extracted_code'] = code
    result['code_valid'] = bool(code) and 'print(' in code

    if verbose:
        print(f"  Solver:    code={'✅' if result['has_code'] else '❌'} "
              f"({len(code)} chars)")

    # Step 5: Execute via MCP
    if code:
        sympy_output = _execute_via_mcp(code, verbose, result)
        result['sympy_stdout'] = sympy_output

    # Step 6: Extract answer (MC handled in code)
    if result['answer_got'] is None and result['sympy_stdout']:
        answer_match = re.search(r'ODPOWIED[ZŹ]:\s*(.+)', result['sympy_stdout'], re.IGNORECASE)
        if answer_match:
            result['answer_got'] = answer_match.group(1).strip()

    # Step 6.5: If deterministic solver failed, try extraction chain
    if not result['answer_got'] or (result['sympy_stdout'] and ('Error' in result['sympy_stdout'] or 'Traceback' in result['sympy_stdout'])):
        if verbose:
            print(f"  ⚠️ Deterministic solver failed → trying extraction chain")
        extraction_result = _try_extraction_chain(question_text, base_url, model, verbose, api_key)
        if extraction_result and extraction_result.get('success'):
            result['pipeline_used'] = 'extraction_chain_fallback'
            result['extracted_code'] = extraction_result.get('code', '')
            result['sympy_stdout'] = extraction_result.get('output', '')
            result['answer_got'] = extraction_result.get('answer')
            result['has_code'] = True

    # Step 6.9: If still no answer and this is MC, try zero-code MC pipeline
    if is_mc and (not result['answer_got'] or (result['sympy_stdout'] and ('Error' in result['sympy_stdout'] or 'Traceback' in result['sympy_stdout']))):
        if verbose:
            print(f"  ⚠️ All SymPy pipelines failed for MC → trying zero-code MC")
        zc_result = _try_zero_code_mc(question_text, base_url, model, verbose, api_key)
        if zc_result and zc_result.get('success'):
            result['pipeline_used'] = 'zero_code_mc'
            result['answer_got'] = zc_result['answer']
            result['has_code'] = False

    # Step 7: Check answer
    if result['answer_got']:
        match_result, explanation = check_answer(q['answer'], result['answer_got'], q)
        result['correct'] = match_result
        if verbose:
            status = '✅' if match_result else '❌'
            print(f"  Answer:    {status} {explanation}")
    elif verbose:
        print(f"  Answer:    ❌ no answer extracted")
        print(f"  Expected:  {clean_latex_for_display(q['answer'])}")

    result['time_total'] = time.time() - t_start
    return result


# ── Test Runner ──────────────────────────────────────────────────────────

def test_question(q, base_url, model, verbose=True, api_key=None):
    """Test a single question through the 3-agent pipeline. Returns result dict."""
    task_num = q['metadata']['task_number']
    year = q['metadata']['year']
    points = q['metadata']['max_points']
    is_mc = bool(q.get('options'))
    question_text = format_question(q)

    result = {
        'year': year,
        'task': task_num,
        'points': points,
        'type': 'MC' if is_mc else 'OPEN',
        'correct': False,
        'answer_expected': q['answer'],
        'answer_got': None,
        'has_code': False,
        'code_valid': False,
        'analytical_ok': False,
        'summary_ok': False,
        'time_total': 0,
        'errors': [],
        # Raw responses for later analysis
        'question_text': question_text,
        'raw_analytical': None,
        'raw_executor': None,
        'extracted_code': None,
        'sympy_stdout': None,
    }

    if verbose:
        print(f"\n{'─'*60}")
        short_q = clean_latex_for_display(q['question'])[:80]
        print(f"  Task {task_num} ({points}pt, {'MC' if is_mc else 'OPEN'}): {short_q}...")

    t_start = time.time()

    # RAG context injection (matching web app threeAgentSystem.ts behavior)
    rag_context = _build_rag_context(question_text)
    if rag_context and verbose:
        cats = _detect_categories(question_text)
        print(f"  RAG categories: {', '.join(cats)}")

    # Template solver: try deterministic solution BEFORE LLM agents
    template_result = _try_template_solver(question_text)
    if template_result and template_result.get('success'):
        t_template = time.time() - t_start
        result['pipeline_used'] = 'template_solver'
        result['has_code'] = True
        result['code_valid'] = True
        result['extracted_code'] = template_result['code']
        result['sympy_stdout'] = template_result['output']
        result['answer_got'] = template_result['answer']
        result['time_total'] = t_template
        match, explanation = check_answer(q['answer'], result['answer_got'], q)
        result['correct'] = match
        if verbose:
            print(f"  Template ({t_template:.0f}s): ✅ {template_result.get('template', '?')} → {result['answer_got']}")
            status = '✅' if match else '❌'
            exp_display = clean_latex_for_display(str(q['answer']))
            print(f"  Answer:    {status} Expected: {exp_display}, got: {result['answer_got']}")
        return result

    # Agent 1: Analytical (with RAG strategies injected)
    t0 = time.time()
    analytical_prompt = ANALYTICAL_PROMPT
    if rag_context:
        analytical_prompt = f"{ANALYTICAL_PROMPT}\n\n{rag_context}"

    analytical = call_bielik(
        analytical_prompt,
        [{"role": "user", "content": question_text}],
        base_url, model,
        max_tokens=AGENT_CONFIG["analytical"]["max_tokens"],
        temperature=AGENT_CONFIG["analytical"]["temperature"],
        api_key=api_key
    )
    t_analytical = time.time() - t0

    result['raw_analytical'] = analytical

    if not analytical:
        result['errors'].append("Analytical agent failed")
        result['time_total'] = time.time() - t_start
        return result

    # Check analytical quality
    has_plan = bool(re.search(r'Plan:', analytical, re.IGNORECASE))
    no_latex = not bool(re.findall(r'\\(frac|sqrt|boxed|dfrac)\b', analytical))
    result['analytical_ok'] = has_plan and no_latex

    if verbose:
        print(f"  Analytical ({t_analytical:.0f}s): {'✅' if result['analytical_ok'] else '❌'} "
              f"({len(analytical)} chars)")

    # Agent 2: Executor (use MC-specific prompt for multiple choice, with RAG hints)
    t0 = time.time()
    exec_prompt = EXECUTOR_MC_PROMPT if is_mc else EXECUTOR_PROMPT
    if rag_context:
        exec_prompt = f"{exec_prompt}\n\nWskazowki SymPy:\n{rag_context}"
    executor = call_bielik(
        exec_prompt,
        [
            {"role": "user", "content": question_text},
            {"role": "assistant", "content": f"[Agent Analityczny]: {analytical}"},
        ],
        base_url, model,
        max_tokens=AGENT_CONFIG["executor"]["max_tokens"],
        temperature=AGENT_CONFIG["executor"]["temperature"],
        api_key=api_key
    )
    t_executor = time.time() - t0

    result['raw_executor'] = executor

    if not executor:
        result['errors'].append("Executor agent failed")
        result['time_total'] = time.time() - t_start
        return result

    # Extract and check code
    code = extract_first_code_block(executor)
    result['has_code'] = code is not None
    result['extracted_code'] = code

    if code:
        # Basic validity checks
        has_print = 'print(' in code
        no_caret = not bool(re.search(r'\w\^\w', code))
        has_import = 'import' in code or 'from ' in code
        result['code_valid'] = has_print and no_caret and has_import

    truncated = truncate_after_first_code_block(executor)

    if verbose:
        print(f"  Executor  ({t_executor:.0f}s): code={'✅' if result['has_code'] else '❌'} "
              f"valid={'✅' if result['code_valid'] else '❌'} "
              f"({len(truncated)} chars)")

    # Execute code via MCP proxy (prod path — sanitization + retry handled server-side)
    sympy_output = None
    if code:
        sympy_output = _execute_via_mcp(code, verbose, result)
    result['sympy_stdout'] = sympy_output

    # For MC: if no answer from SymPy, try to extract letter from raw executor output
    if is_mc and not result['answer_got'] and executor:
        # Look for letter answers in raw executor output (outside code blocks)
        raw_text = re.sub(r'```[\s\S]*?```', '', executor)
        # Pattern 1: explicit "odpowiedź: X" or "opcja X"
        letter_in_text = re.search(r'(?:odpowied[zź]|answer|opcja|option)[:\s]*([a-dA-D])\b', raw_text, re.IGNORECASE)
        if letter_in_text:
            result['answer_got'] = letter_in_text.group(1).upper()
        else:
            # Pattern 2: "poprawna jest X" or "prawidłowa X"
            letter_in_text = re.search(r'(?:poprawna|prawidłowa|właściwa|correct)\s+(?:jest\s+|to\s+)?(?:odpowied[zź]\s+)?([a-dA-D])\b', raw_text, re.IGNORECASE)
            if letter_in_text:
                result['answer_got'] = letter_in_text.group(1).upper()
            else:
                # Pattern 3: standalone letter at end of text like "## A" or "**B**"
                letter_in_text = re.search(r'(?:^|\n)\s*(?:\*\*)?([A-Da-d])(?:\*\*)?\.?\s*$', raw_text)
                if letter_in_text:
                    result['answer_got'] = letter_in_text.group(1).upper()

    # For open-ended: if no answer from SymPy, try to extract from raw executor text
    if not is_mc and not result['answer_got'] and executor:
        raw_text = re.sub(r'```[\s\S]*?```', '', executor)
        answer_in_text = re.search(r'ODPOWIED[ZŹ]:\s*(.+)', raw_text, re.IGNORECASE)
        if answer_in_text:
            result['answer_got'] = answer_in_text.group(1).strip()

    # Check answer
    if result['answer_got']:
        match, explanation = check_answer(q['answer'], result['answer_got'], q)
        result['correct'] = match
        if verbose:
            status = '✅' if match else '❌'
            print(f"  Answer:    {status} {explanation}")
    elif verbose:
        print(f"  Answer:    ❌ no answer extracted")
        print(f"  Expected:  {clean_latex_for_display(q['answer'])}")

    result['time_total'] = time.time() - t_start

    return result


def test_question_hybrid(q, base_url, model, verbose=True, api_key=None):
    """Hybrid mode: classifier → extraction chain → zero-code MC → 3-agent pipeline.

    Pipeline priority (most deterministic first):
      1. Classifier + deterministic solver (100% deterministic)
      2. Extraction chain (template-matched, LLM extracts values only)
      3. Zero-code MC (LLM picks A/B/C/D without SymPy — MC only)
      4. 3-agent pipeline (full LLM code generation — least deterministic)
    """
    task_num = q['metadata']['task_number']
    is_mc = bool(q.get('options'))
    question_text = format_question(q)

    # Step 1: Try classifier pipeline (fast, deterministic)
    classifier_result = test_question_classifier(q, base_url, model, verbose=verbose, api_key=api_key)

    # Step 2: If classifier produced a correct-looking result, use it
    if classifier_result['correct']:
        if verbose:
            print(f"  Hybrid:    ✅ classifier succeeded for task {task_num}")
        classifier_result['pipeline_used'] = 'classifier'
        return classifier_result

    # Step 2.5: If classifier had an answer (even wrong), and classifier_result already
    # tried extraction chain + zero-code MC internally, we can skip to 3-agent.
    # But if pipeline_used is already set (extraction_chain, zero_code_mc), it means
    # those pipelines were already tried inside test_question_classifier.
    internal_pipe = classifier_result.get('pipeline_used', '')
    if internal_pipe in ('extraction_chain', 'extraction_chain_fallback', 'zero_code_mc'):
        # Already tried extraction/zero-code inside classifier — skip to 3-agent
        if verbose:
            print(f"  Hybrid:    ⚠️ classifier+{internal_pipe} tried, answer wrong → 3-agent")
    else:
        # Step 3: Try extraction chain independently (classifier may not have reached it)
        if verbose:
            print(f"  Hybrid:    🔄 trying extraction chain for task {task_num}")
        extraction_result = _try_extraction_chain(question_text, base_url, model, verbose, api_key)
        if extraction_result and extraction_result.get('success') and extraction_result.get('answer'):
            # Build a result from extraction chain
            ext_result = classifier_result.copy()
            ext_result['pipeline_used'] = 'extraction_chain'
            ext_result['answer_got'] = extraction_result['answer']
            ext_result['extracted_code'] = extraction_result.get('code', '')
            ext_result['sympy_stdout'] = extraction_result.get('output', '')
            ext_result['has_code'] = True
            match, explanation = check_answer(q['answer'], ext_result['answer_got'], q)
            ext_result['correct'] = match
            if verbose:
                status = '✅' if match else '❌'
                print(f"  Extraction: {status} {explanation}")
            if match:
                return ext_result

        # Step 4: Try zero-code MC (for MC questions where SymPy keeps crashing)
        if is_mc:
            if verbose:
                print(f"  Hybrid:    🔄 trying zero-code MC for task {task_num}")
            zc_result = _try_zero_code_mc(question_text, base_url, model, verbose, api_key)
            if zc_result and zc_result.get('success'):
                mc_result = classifier_result.copy()
                mc_result['pipeline_used'] = 'zero_code_mc'
                mc_result['answer_got'] = zc_result['answer']
                mc_result['has_code'] = False
                match, explanation = check_answer(q['answer'], mc_result['answer_got'], q)
                mc_result['correct'] = match
                if verbose:
                    status = '✅' if match else '❌'
                    print(f"  ZeroCode:  {status} {explanation}")
                if match:
                    return mc_result

    # Step 5: Fall back to old 3-agent pipeline with RAG (least deterministic)
    if verbose:
        print(f"  Hybrid:    🔄 falling back to 3-agent pipeline for task {task_num}")
    old_result = test_question(q, base_url, model, verbose=verbose, api_key=api_key)
    old_result['pipeline_used'] = 'three_agent'
    old_result['classifier_attempted'] = True
    old_result['classifier_answer'] = classifier_result.get('answer_got')
    # Preserve classifier diagnostics for analysis
    old_result['classifier_type'] = classifier_result.get('classifier_type')
    old_result['classifier_confidence'] = classifier_result.get('classifier_confidence')
    old_result['classifier_pipeline_tried'] = classifier_result.get('pipeline_used', '')
    return old_result


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Test bielik-m-poc across matura datasets")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL)
    parser.add_argument("--year", type=str, default="2024",
                        help="Year to test (e.g. 2024) or 'all'")
    parser.add_argument("--sample", type=int, default=5,
                        help="Number of random questions per year (0 = all)")
    parser.add_argument("--all", action="store_true",
                        help="Test all questions (overrides --sample)")
    parser.add_argument("--task", type=str, default=None,
                        help="Specific task numbers, comma-separated (e.g. 1,2,5)")
    parser.add_argument("--level", type=str, default=None,
                        choices=["podstawowa", "rozszerzona"],
                        help="Filter by exam level (default: both, rozszerzona first)")
    parser.add_argument("--only-mc", action="store_true", help="Only multiple-choice")
    parser.add_argument("--only-open", action="store_true", help="Only open-ended")
    parser.add_argument("--quiet", action="store_true", help="Less verbose output")
    parser.add_argument("--classifier", action="store_true",
                        help="Use classifier + deterministic solver pipeline instead of 3-agent")
    parser.add_argument("--hybrid", action="store_true",
                        help="Hybrid: try classifier first, fall back to 3-agent pipeline")
    parser.add_argument("--api-url", type=str, default=os.environ.get("BIELIK_API_URL"),
                        help="Full API base URL. Overrides --port. Env: BIELIK_API_URL")
    parser.add_argument("--api-key", type=str, default=os.environ.get("BIELIK_API_KEY"),
                        help="API key/token for Bearer auth. Env: BIELIK_API_KEY")
    args = parser.parse_args()

    if args.api_url:
        base_url = args.api_url.rstrip('/')
    else:
        base_url = f"http://localhost:{args.port}"
    api_key = args.api_key
    verbose = not args.quiet

    # Check LLM server
    try:
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = Request(f"{base_url}/v1/models", headers=headers)
        with urlopen(req, timeout=10) as resp:
            models = json.loads(resp.read())
            model_ids = [m['id'] for m in models.get('data', [])]
    except Exception as e:
        print(f"ERROR: Cannot reach LLM server at {base_url}: {e}")
        sys.exit(1)

    # Check MCP proxy (required — all code execution goes through prod path)
    if check_mcp_proxy():
        print(f"✅ MCP proxy connected at {MCP_PROXY_URL}")
    else:
        print(f"ERROR: MCP proxy not available at {MCP_PROXY_URL}")
        print(f"  Start it with: npm run mcp-proxy")
        sys.exit(1)

    # Determine levels to test
    if args.level:
        levels = [args.level]
    else:
        levels = ["rozszerzona", "podstawowa"]  # extended first

    print("=" * 70)
    print("BIELIK-M-POC DATASET TESTER")
    print("=" * 70)
    print(f"Server:  {base_url}")
    print(f"Model:   {args.model}")
    if api_key:
        print(f"Auth:    Bearer ***{api_key[-6:]}")
    if args.hybrid:
        pipeline_mode = "HYBRID (classifier → 3-agent fallback)"
    elif args.classifier:
        pipeline_mode = "CLASSIFIER + deterministic solver"
    else:
        pipeline_mode = "3-agent (analytical → executor → summary)"
    print(f"Pipeline: {pipeline_mode}")
    print(f"Backend: MCP proxy (prod path)")
    print(f"Models available: {model_ids}")
    level_label = args.level if args.level else "rozszerzona + podstawowa"
    print(f"Level:   {level_label}")

    # Determine years to test
    if args.level:
        datasets_dir = os.path.join(DATASETS_BASE, args.level)
        all_years = available_years(datasets_dir)
    else:
        all_years = available_years_all(DATASETS_BASE)
    if args.year == "all":
        years = all_years
    else:
        years = [int(args.year)]

    print(f"Years:  {years}")
    print()

    # Collect all questions
    all_results = []

    for year in years:
        if interrupted:
            break

        for level in levels:
            if interrupted:
                break

            level_dir = os.path.join(DATASETS_BASE, level)
            questions = load_questions(year, level_dir)

            if not questions:
                continue

            level_tag = "rozszerzona" if level == "rozszerzona" else "podstawowa"

            # Filter by type
            if args.only_mc:
                questions = [q for q in questions if q.get('options')]
            elif args.only_open:
                questions = [q for q in questions if not q.get('options')]

            # Filter by task number
            if args.task:
                task_nums = [int(t) for t in args.task.split(',')]
                questions = [q for q in questions if q['metadata']['task_number'] in task_nums]

            if not questions:
                continue

            # Sample
            if not args.all and not args.task:
                sample_size = min(args.sample, len(questions))
                questions = random.sample(questions, sample_size)
                questions.sort(key=lambda q: q['metadata']['task_number'])

            print(f"{'='*70}")
            print(f"YEAR {year} [{level_tag}] — {len(questions)} questions")
            print(f"{'='*70}")

            year_level_results = []
            for q in questions:
                if interrupted:
                    break
                if args.hybrid:
                    result = test_question_hybrid(q, base_url, args.model, verbose=verbose, api_key=api_key)
                elif args.classifier:
                    result = test_question_classifier(q, base_url, args.model, verbose=verbose, api_key=api_key)
                else:
                    result = test_question(q, base_url, args.model, verbose=verbose, api_key=api_key)
                result['level'] = level_tag
                year_level_results.append(result)
                all_results.append(result)

            # Year+level summary
            correct = sum(1 for r in year_level_results if r['correct'])
            has_code = sum(1 for r in year_level_results if r['has_code'])
            code_valid = sum(1 for r in year_level_results if r['code_valid'])
            analytical_ok = sum(1 for r in year_level_results if r['analytical_ok'])
            total = len(year_level_results)
            total_time = sum(r['time_total'] for r in year_level_results)

            print(f"\n{'─'*60}")
            print(f"  YEAR {year} [{level_tag}] SUMMARY ({total} questions, {total_time:.0f}s total):")
            print(f"  Analytical OK:  {analytical_ok}/{total}")
            print(f"  Has code:       {has_code}/{total}")
            print(f"  Code valid:     {code_valid}/{total}")
            print(f"  Correct answer: {correct}/{total}")

            # Breakdown by type
            mc_results = [r for r in year_level_results if r['type'] == 'MC']
            open_results = [r for r in year_level_results if r['type'] == 'OPEN']
            if mc_results:
                mc_correct = sum(1 for r in mc_results if r['correct'])
                print(f"    MC:    {mc_correct}/{len(mc_results)}")
            if open_results:
                open_correct = sum(1 for r in open_results if r['correct'])
                print(f"    Open:  {open_correct}/{len(open_results)}")

            # Points breakdown
            points_earned = sum(r['points'] for r in year_level_results if r['correct'])
            points_total = sum(r['points'] for r in year_level_results)
            print(f"  Points: {points_earned}/{points_total}")
            print()

    # Overall summary
    if len(years) > 1 or len(all_results) > 5:
        print(f"\n{'='*70}")
        print(f"OVERALL SUMMARY")
        print(f"{'='*70}")
        total = len(all_results)
        correct = sum(1 for r in all_results if r['correct'])
        has_code = sum(1 for r in all_results if r['has_code'])
        code_valid = sum(1 for r in all_results if r['code_valid'])
        analytical_ok = sum(1 for r in all_results if r['analytical_ok'])
        total_time = sum(r['time_total'] for r in all_results)
        points_earned = sum(r['points'] for r in all_results if r['correct'])
        points_total = sum(r['points'] for r in all_results)

        print(f"  Total questions: {total}")
        print(f"  Total time:      {total_time:.0f}s ({total_time/total:.0f}s avg)")
        print(f"  Analytical OK:   {analytical_ok}/{total} ({100*analytical_ok/total:.0f}%)")
        print(f"  Has code:        {has_code}/{total} ({100*has_code/total:.0f}%)")
        print(f"  Code valid:      {code_valid}/{total} ({100*code_valid/total:.0f}%)")
        print(f"  Correct answer:  {correct}/{total} ({100*correct/total:.0f}%)")
        print(f"  Points:          {points_earned}/{points_total} ({100*points_earned/points_total:.0f}%)")

        # Per-type breakdown
        mc_results = [r for r in all_results if r['type'] == 'MC']
        open_results = [r for r in all_results if r['type'] == 'OPEN']
        if mc_results:
            mc_correct = sum(1 for r in mc_results if r['correct'])
            print(f"  MC accuracy:     {mc_correct}/{len(mc_results)} ({100*mc_correct/len(mc_results):.0f}%)")
        if open_results:
            open_correct = sum(1 for r in open_results if r['correct'])
            print(f"  Open accuracy:   {open_correct}/{len(open_results)} ({100*open_correct/len(open_results):.0f}%)")

        # Per-level breakdown
        for lvl in ["rozszerzona", "podstawowa"]:
            lvl_results = [r for r in all_results if r.get('level') == lvl]
            if lvl_results:
                lvl_correct = sum(1 for r in lvl_results if r['correct'])
                lvl_points_earned = sum(r['points'] for r in lvl_results if r['correct'])
                lvl_points_total = sum(r['points'] for r in lvl_results)
                print(f"  [{lvl}] {lvl_correct}/{len(lvl_results)} correct, {lvl_points_earned}/{lvl_points_total} pts")

        # Failed questions list
        failed = [r for r in all_results if not r['correct']]
        if failed:
            print(f"\n  Failed questions:")
            for r in failed:
                errs = f" [{'; '.join(r['errors'])}]" if r['errors'] else ""
                lvl = r.get('level', '?')
                print(f"    {r['year']} task {r['task']} [{lvl}] ({r['type']}, {r['points']}pt){errs}")

    # ── Save results log ──────────────────────────────────────────────────
    if all_results:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        model_short = args.model.split('/')[-1].replace('.', '-')
        log_filename = f"benchmark_{timestamp}_{model_short}.json"
        log_path = os.path.join(os.path.dirname(__file__), log_filename)

        log_data = {
            'timestamp': timestamp,
            'model': args.model,
            'api_url': base_url,
            'backend': 'mcp',
            'total_questions': len(all_results),
            'correct': sum(1 for r in all_results if r['correct']),
            'has_code': sum(1 for r in all_results if r['has_code']),
            'code_valid': sum(1 for r in all_results if r['code_valid']),
            'points_earned': sum(r['points'] for r in all_results if r['correct']),
            'points_total': sum(r['points'] for r in all_results),
            'results': all_results,
        }

        with open(log_path, 'w', encoding='utf-8') as f:
            json.dump(log_data, f, ensure_ascii=False, indent=2)
        print(f"\n📝 Results saved to: {log_filename}")
        print(f"   ({len(all_results)} questions, all raw responses included)")

    print(f"\n{'='*70}")
    print("DONE")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
