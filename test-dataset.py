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
    """Convert LaTeX to plain text for display (v2 — better coverage)."""
    t = text
    t = re.sub(r'\$\$?', '', t)
    # Remove \boxed{...} → content
    t = re.sub(r'\\boxed\{([^}]*)\}', r'\1', t)
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

        # 2b. Direct symbolic match against each option
        for opt_key, opt_latex in question['options'].items():
            opt_plain = clean_latex_for_display(opt_latex)
            if _sympy_compare(got_clean, opt_plain):
                if key_matches(opt_key):
                    return True, f"Symbolic option match: {got_clean} = option {opt_key}"
                else:
                    return False, f"Symbolic matched option {opt_key}, expected {expected_letter}"

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

    # String match
    if expected_plain.lower() in got_lower:
        return True, "Substring match"

    # Numeric match
    got_value = _sympy_eval(got_clean) or _try_float(got_clean)
    exp_value = _sympy_eval(expected_plain) or _try_float(expected_plain)
    if got_value is not None and exp_value is not None:
        if abs(got_value - exp_value) < 0.01:
            return True, f"Numeric match: {got_value}"
        # Also check ratio (for fractions like 13/25 = 0.52)
        if exp_value != 0 and abs(got_value / exp_value - 1.0) < 0.01:
            return True, f"Ratio match: {got_value} ≈ {exp_value}"

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

    # Agent 1: Analytical
    t0 = time.time()
    analytical = call_bielik(
        ANALYTICAL_PROMPT,
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

    # Agent 2: Executor (use MC-specific prompt for multiple choice)
    t0 = time.time()
    exec_prompt = EXECUTOR_MC_PROMPT if is_mc else EXECUTOR_PROMPT
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
