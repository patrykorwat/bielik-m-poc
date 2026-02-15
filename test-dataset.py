#!/usr/bin/env python3
"""
Dataset test harness for bielik-m-poc multi-agent system.
Tests across the full Polish matura exam datasets.

Usage:
  python3 test-dataset.py                          # Test 5 random questions from 2024
  python3 test-dataset.py --year 2024              # Test 5 random from 2024
  python3 test-dataset.py --year 2024 --all        # Test ALL questions from 2024
  python3 test-dataset.py --year all --sample 3    # 3 random questions per year
  python3 test-dataset.py --year 2024 --task 1,2,5 # Specific tasks
  python3 test-dataset.py --only-mc                # Only multiple choice
  python3 test-dataset.py --only-open              # Only open-ended
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

DATASETS_DIR = os.path.join(os.path.dirname(__file__), "datasets")
PROMPTS_FILE = os.path.join(os.path.dirname(__file__), "prompts.json")

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
SUMMARY_PROMPT = _CONFIG["summary"]

# Per-agent settings
AGENT_CONFIG = _CONFIG["agents"]

# ── API Call ─────────────────────────────────────────────────────────────

def call_bielik(system_prompt, messages, base_url, model, max_tokens=2048, temperature=None):
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

    req = Request(url, data=payload, headers={"Content-Type": "application/json"})

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


# ── Helpers ──────────────────────────────────────────────────────────────

def clean_latex_for_display(text):
    """Convert LaTeX to plain text for display."""
    t = text
    t = re.sub(r'\$\$?', '', t)
    # Remove \boxed{...} → content
    t = re.sub(r'\\boxed\{([^}]*)\}', r'\1', t)
    # Fractions
    t = re.sub(r'\\d?frac\{([^}]*)\}\{([^}]*)\}', r'(\1)/(\2)', t)
    # Roots: \sqrt[n]{x} → x**(1/n), \sqrt{x} → sqrt(x)
    t = re.sub(r'\\sqrt\[(\d+)\]\{([^}]*)\}', r'(\2)**(1/\1)', t)
    t = re.sub(r'\\sqrt\{([^}]*)\}', r'sqrt(\1)', t)
    # Operators and formatting
    t = re.sub(r'\\(left|right|cdot|times|text|mathrm|quad|,|\\)', ' ', t)
    t = re.sub(r'\\langle', '<', t)
    t = re.sub(r'\\rangle', '>', t)
    t = re.sub(r'\\infty', 'inf', t)
    t = re.sub(r'\\leq', '<=', t)
    t = re.sub(r'\\geq', '>=', t)
    t = re.sub(r'\\in', ' in ', t)
    t = re.sub(r'\\log_\{([^}]*)\}', r'log_\1', t)
    # Remove remaining LaTeX commands
    t = re.sub(r'\\[a-zA-Z]+', '', t)
    # Clean braces and formatting
    t = re.sub(r'[{}]', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    # Strip leading labels like "|BC| =" from expected answers
    t = re.sub(r'^\|?\w+\|?\s*=\s*', '', t).strip()
    return t


def extract_first_code_block(text):
    """Extract first Python code block."""
    match = re.search(r'```python\s*\n([\s\S]*?)\n```', text)
    if match:
        return match.group(1).strip()
    match = re.search(r'```\s*\n([\s\S]*?)\n```', text)
    if match:
        return match.group(1).strip()
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
    """Extract ODPOWIEDZ/ODPOWIEDŹ value from SymPy output."""
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
        if answer.lower() in ('none', 'null', '[]', '{}', ''):
            return None
        return answer
    # Look for the last printed value
    lines = [l.strip() for l in output.strip().split('\n') if l.strip()]
    if lines:
        # Prefer lines with values (not just text)
        for line in reversed(lines):
            if re.search(r'[-\d.*/()a-z]', line, re.IGNORECASE):
                # Strip label prefix like "Wynik: " or "result: "
                cleaned = re.sub(r'^[A-Za-ząćęłńóśźż\s]+:\s*', '', line)
                if cleaned:
                    # Unwrap lists
                    cleaned = re.sub(r'^\[(.+)\]$', r'\1', cleaned)
                    if cleaned.lower() not in ('none', 'null', '[]', '{}', ''):
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
    path = os.path.join(datasets_dir, f"{year}_1.json")
    if not os.path.exists(path):
        print(f"ERROR: Dataset file not found: {path}")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def available_years(datasets_dir):
    """List available dataset years."""
    years = []
    for f in sorted(os.listdir(datasets_dir)):
        m = re.match(r'(\d{4})_1\.json', f)
        if m:
            years.append(int(m.group(1)))
    return years


def _sanitize_code(code):
    """Sanitize Python/SymPy code — fix common Bielik patterns."""
    lines = code.split('\n')

    # Remove assert statements
    lines = [l for l in lines if not l.strip().startswith('assert ')]

    # Fix ^ → **
    new_lines = []
    for line in lines:
        t = line.strip()
        if not t.startswith('#') and not t.startswith('"') and not t.startswith("'"):
            line = re.sub(r'(\w)\^(\w)', r'\1**\2', line)
            line = re.sub(r'\)\^(\w)', r')**\1', line)
            line = re.sub(r'(\w)\^\(', r'\1**(', line)
        new_lines.append(line)
    lines = new_lines

    # Fix wrong imports (Simplify → simplify, Greater → Gt, etc.)
    import_fixes = {
        'Simplify': 'simplify',
        'Greater': 'Gt',
        'Less': 'Lt',
        'GreaterEqual': 'Ge',
        'LessEqual': 'Le',
    }
    result_lines = []
    for line in lines:
        for old, new in import_fixes.items():
            if old in line:
                line = line.replace(old, new)
        result_lines.append(line)
    lines = result_lines

    return '\n'.join(lines)


def _fix_code_from_error(code, error_msg):
    """Try to fix code based on the error message."""
    fixed = code

    # Fix 1: NameError — add missing symbol definition
    name_match = re.search(r"NameError: name '(\w+)' is not defined", error_msg)
    if name_match:
        missing = name_match.group(1)
        # Add symbol definition after imports
        lines = fixed.split('\n')
        insert_idx = 0
        for i, line in enumerate(lines):
            if line.strip().startswith('from ') or line.strip().startswith('import '):
                insert_idx = i + 1
        lines.insert(insert_idx, f"{missing} = symbols('{missing}')")
        fixed = '\n'.join(lines)

    # Fix 2: IndexError on solve()[0] — use safe indexing
    if 'IndexError: list index out of range' in error_msg:
        fixed = re.sub(
            r'(\w+)\s*=\s*solve\(([^)]+)\)\[0\]',
            r'_sols = solve(\2)\n\1 = _sols[0] if _sols else None',
            fixed
        )
        # Also handle patterns like wynik[0]
        fixed = re.sub(
            r'(\w+)\[0\]',
            r'(\1[0] if \1 else None)',
            fixed
        )

    # Fix 3: 'And' object is not subscriptable/iterable — inequality result
    if "'And' object" in error_msg or "'Or' object" in error_msg:
        # Replace solve_univariate_inequality patterns with solve
        # Or wrap result printing
        if 'is not subscriptable' in error_msg or 'is not iterable' in error_msg:
            fixed = re.sub(
                r'for\s+\w+\s+in\s+(\w+)',
                r'for _item in ([\1] if not hasattr(\1, "__iter__") else \1)',
                fixed
            )

    # Fix 4: Wrong import names
    fixed = fixed.replace('from sympy import Simplify', 'from sympy import simplify')
    fixed = fixed.replace('from sympy import Greater', 'from sympy import Gt')

    # Fix 5: 'bool' object has no attribute 'subs' — comparison instead of equation
    if "'bool' object has no attribute 'subs'" in error_msg:
        # Replace == with Eq() in equation definitions
        fixed = re.sub(r'(\w+)\s*=\s*(.+?)\s*==\s*(.+)', r'\1 = Eq(\2, \3)', fixed)

    # Fix 6: tuple/dict indexing errors — variable name collision with symbol
    if 'tuple indices must be integers' in error_msg or 'list indices must be integers' in error_msg:
        # Pattern: solutions[symbol] → solutions[0] or solutions.values()
        fixed = re.sub(r'(\w+)\[(\w+)\](?!\s*if)', r'\1[0]', fixed, count=1)

    # Fix 7: Pi (capitalized) not defined — use pi
    if "name 'Pi' is not defined" in error_msg:
        fixed = fixed.replace('Pi', 'pi')

    # Fix N: Ensure print statement exists
    if 'print(' not in fixed:
        lines = fixed.strip().split('\n')
        # Find last assignment
        for i in range(len(lines) - 1, -1, -1):
            m = re.match(r'^(\w+)\s*=', lines[i].strip())
            if m and not lines[i].strip().startswith('from ') and not lines[i].strip().startswith('import '):
                lines.append(f'print("ODPOWIEDZ:", {m.group(1)})')
                break
        fixed = '\n'.join(lines)

    return fixed


def _run_sympy(code):
    """Run code with sympy, return (stdout, stderr, returncode)."""
    sanitized = _sanitize_code(code)
    full_code = f"from sympy import *\nimport sys\nsys.set_int_max_str_digits(0)\n\n{sanitized}"
    proc = subprocess.run(
        ["python3", "-c", full_code],
        capture_output=True, text=True, timeout=30
    )
    return proc.stdout.strip(), proc.stderr.strip(), proc.returncode


def _run_sympy_with_retry(code, verbose, result):
    """Run SymPy code with auto-retry on failure. Returns output or None."""
    MAX_RETRIES = 3
    current_code = code

    for attempt in range(MAX_RETRIES + 1):
        try:
            stdout, stderr, rc = _run_sympy(current_code)

            if rc == 0 and stdout:
                result['answer_got'] = extract_answer_from_output(stdout)
                if verbose:
                    answer_line = result['answer_got'] or stdout[-80:]
                    retry_tag = f" (retry {attempt})" if attempt > 0 else ""
                    print(f"  SymPy:     ✅ → {answer_line[:60]}{retry_tag}")
                return stdout
            elif rc == 0 and not stdout:
                # Code ran but produced no output
                if verbose:
                    print(f"  SymPy:     ❌ no output (code ran without print)")
                result['errors'].append("SymPy: no output produced")
                return None
            else:
                if attempt < MAX_RETRIES:
                    fixed_code = _fix_code_from_error(current_code, stderr)
                    if fixed_code == current_code:
                        # No fix found, don't retry
                        if verbose:
                            err = stderr[-120:] if stderr else "unknown error"
                            print(f"  SymPy:     ❌ {err}")
                        result['errors'].append(f"SymPy error: {stderr[:100]}")
                        return None
                    if verbose:
                        print(f"  SymPy:     ⚠️  retrying ({stderr[-60:].strip()})")
                    current_code = fixed_code
                    continue
                else:
                    if verbose:
                        err = stderr[-120:] if stderr else "no output"
                        print(f"  SymPy:     ❌ {err}")
                    result['errors'].append(f"SymPy error: {stderr[:100]}")
                    return None

        except subprocess.TimeoutExpired:
            result['errors'].append("SymPy timeout")
            if verbose:
                print(f"  SymPy:     ❌ timeout")
            return None
        except Exception as e:
            result['errors'].append(f"SymPy exception: {e}")
            if verbose:
                print(f"  SymPy:     ❌ exception: {e}")
            return None

    # Exhausted retries without fix
    if verbose:
        print(f"  SymPy:     ❌ unfixable error after {MAX_RETRIES} retries")
    return None


# ── Test Runner ──────────────────────────────────────────────────────────

def test_question(q, base_url, model, verbose=True):
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
        temperature=AGENT_CONFIG["analytical"]["temperature"]
    )
    t_analytical = time.time() - t0

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

    # Agent 2: Executor
    t0 = time.time()
    executor = call_bielik(
        EXECUTOR_PROMPT,
        [
            {"role": "user", "content": question_text},
            {"role": "assistant", "content": f"[Agent Analityczny]: {analytical}"},
        ],
        base_url, model,
        max_tokens=AGENT_CONFIG["executor"]["max_tokens"],
        temperature=AGENT_CONFIG["executor"]["temperature"]
    )
    t_executor = time.time() - t0

    if not executor:
        result['errors'].append("Executor agent failed")
        result['time_total'] = time.time() - t_start
        return result

    # Extract and check code
    code = extract_first_code_block(executor)
    result['has_code'] = code is not None

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

    # Try to execute code locally if sympy available (with auto-retry)
    sympy_output = None
    if code and SYMPY_AVAILABLE:
        sympy_output = _run_sympy_with_retry(code, verbose, result)

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
    parser.add_argument("--only-mc", action="store_true", help="Only multiple-choice")
    parser.add_argument("--only-open", action="store_true", help="Only open-ended")
    parser.add_argument("--quiet", action="store_true", help="Less verbose output")
    args = parser.parse_args()

    base_url = f"http://localhost:{args.port}"
    verbose = not args.quiet

    # Check server
    try:
        req = Request(f"{base_url}/v1/models")
        with urlopen(req, timeout=5) as resp:
            models = json.loads(resp.read())
            model_ids = [m['id'] for m in models.get('data', [])]
    except Exception as e:
        print(f"ERROR: Cannot reach server at {base_url}: {e}")
        sys.exit(1)

    print("=" * 70)
    print("BIELIK-M-POC DATASET TESTER")
    print("=" * 70)
    print(f"Server: {base_url}")
    print(f"Model:  {args.model}")
    print(f"Models available: {model_ids}")

    # Determine years to test
    all_years = available_years(DATASETS_DIR)
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
        questions = load_questions(year, DATASETS_DIR)

        # Filter by type
        if args.only_mc:
            questions = [q for q in questions if q.get('options')]
        elif args.only_open:
            questions = [q for q in questions if not q.get('options')]

        # Filter by task number
        if args.task:
            task_nums = [int(t) for t in args.task.split(',')]
            questions = [q for q in questions if q['metadata']['task_number'] in task_nums]

        # Sample
        if not args.all and not args.task:
            sample_size = min(args.sample, len(questions))
            questions = random.sample(questions, sample_size)
            questions.sort(key=lambda q: q['metadata']['task_number'])

        print(f"{'='*70}")
        print(f"YEAR {year} — {len(questions)} questions")
        print(f"{'='*70}")

        year_results = []
        for q in questions:
            if interrupted:
                break
            result = test_question(q, base_url, args.model, verbose=verbose)
            year_results.append(result)
            all_results.append(result)

        # Year summary
        correct = sum(1 for r in year_results if r['correct'])
        has_code = sum(1 for r in year_results if r['has_code'])
        code_valid = sum(1 for r in year_results if r['code_valid'])
        analytical_ok = sum(1 for r in year_results if r['analytical_ok'])
        total = len(year_results)
        total_time = sum(r['time_total'] for r in year_results)

        print(f"\n{'─'*60}")
        print(f"  YEAR {year} SUMMARY ({total} questions, {total_time:.0f}s total):")
        print(f"  Analytical OK:  {analytical_ok}/{total}")
        print(f"  Has code:       {has_code}/{total}")
        print(f"  Code valid:     {code_valid}/{total}")
        print(f"  Correct answer: {correct}/{total}")

        # Breakdown by type
        mc_results = [r for r in year_results if r['type'] == 'MC']
        open_results = [r for r in year_results if r['type'] == 'OPEN']
        if mc_results:
            mc_correct = sum(1 for r in mc_results if r['correct'])
            print(f"    MC:    {mc_correct}/{len(mc_results)}")
        if open_results:
            open_correct = sum(1 for r in open_results if r['correct'])
            print(f"    Open:  {open_correct}/{len(open_results)}")

        # Points breakdown
        points_earned = sum(r['points'] for r in year_results if r['correct'])
        points_total = sum(r['points'] for r in year_results)
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

        # Failed questions list
        failed = [r for r in all_results if not r['correct']]
        if failed:
            print(f"\n  Failed questions:")
            for r in failed:
                errs = f" [{'; '.join(r['errors'])}]" if r['errors'] else ""
                print(f"    {r['year']} task {r['task']} ({r['type']}, {r['points']}pt){errs}")

    print(f"\n{'='*70}")
    print("DONE")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
