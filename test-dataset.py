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
        return None


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
        else:
            code_lines.append(f'wynik = solve({condition}, {param})')

    elif ptype == 'geometry_analytic':
        # Use description and coordinates — also try to extract from question text
        desc = params.get('description', '')
        code_lines.append(f'# {desc}')
        points = params.get('points', [])
        # If no points in params, try to extract from question text
        if not points:
            point_matches = re.findall(r'([A-Z])\s*[=(]\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*\)', question_text)
            if not point_matches:
                point_matches = re.findall(r'([A-Z])\s*=\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)', question_text)
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
        if not pts:
            # Try to extract from question text
            point_matches = re.findall(r'([A-Z])\s*[=(]\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*\)', question_text)
            if not point_matches:
                point_matches = re.findall(r'([A-Z])\s*=\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)', question_text)
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

    # Step 1: Call LLM with classifier prompt
    t0 = time.time()
    classifier_config = AGENT_CONFIG.get("classifier", {"max_tokens": 500, "temperature": 0.1})
    classifier_response = call_bielik(
        CLASSIFIER_PROMPT,
        [{"role": "user", "content": question_text}],
        base_url, model,
        max_tokens=classifier_config.get("max_tokens", 500),
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
            print(f"  ⚠️ Low confidence or proof → falling back to standard pipeline")
        result['errors'].append(f"Classifier fallback: confidence={confidence}, type={ptype}")
        # Fall back to standard test_question
        return test_question(q, base_url, model, verbose, api_key)

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
    parser.add_argument("--classifier", action="store_true",
                        help="Use classifier + deterministic solver pipeline instead of 3-agent")
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
    pipeline_mode = "CLASSIFIER + deterministic solver" if args.classifier else "3-agent (analytical → executor → summary)"
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
                if args.classifier:
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
