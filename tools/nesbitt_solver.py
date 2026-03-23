"""
Nesbitt solver: final version. Tries all generators, picks the one
that reaches an all-positive solution at the smallest multiple.
"""

from sympy import Rational, symbols, expand, Poly
from math import gcd as mgcd, isqrt
import time


def solve_nesbitt(N, max_mult=35, verbose=False):
    """
    Find positive integers (a,b,c) with a/(b+c) + b/(a+c) + c/(a+b) = N.
    Returns (a, b, c) or None.
    """
    n = Rational(N)
    np2, np3 = n + 2, n + 3

    z = symbols('z')
    dtd = expand((1 - z)**2 * (np3*z - np2) - 4*(np3*z**2*(1-z)-1) + 4*z*(1-z)*(np3*z - np2))
    p = Poly(dtd, z)
    C_coeffs = [Rational(c) for c in p.all_coeffs()]
    C3, C2, C1, C0 = C_coeffs

    def f_val(zv): return C3*zv**3 + C2*zv**2 + C1*zv + C0
    def fp_val(zv): return 3*C3*zv**2 + 2*C2*zv + C1
    def L_val(zv): return np3*zv - np2

    # Find ALL non-trivial generators
    gens = []
    seen_abc = set()
    for zn in range(-100, 101):
        for zd in range(1, 50):
            if zd > 1 and mgcd(abs(zn), zd) > 1:
                continue
            zv = Rational(zn, zd)
            lv = L_val(zv)
            if lv == 0:
                continue
            w2v = f_val(zv) / lv
            if w2v < 0:
                continue
            p_num, q_den = abs(int(w2v.p)), int(w2v.q)
            prod = p_num * q_den
            sr = isqrt(prod)
            if sr * sr == prod:
                wv = Rational(sr, q_den)
                if wv * wv == w2v and wv > 0:
                    if zv != -1 and zv != 1:
                        abc = _map_to_abc(zv, wv, np3, np2)
                        if abc and max(abs(v) for v in abc) > 1:
                            abc_key = tuple(sorted(map(abs, abc)))
                            if abc_key not in seen_abc:
                                seen_abc.add(abc_key)
                                gens.append((zv, wv))

    if not gens:
        return None

    if verbose:
        print(f"  Found {len(gens)} unique generators")

    # Group law functions
    def third_inter(z1, w1, z2, w2):
        if z1 == z2 and w1 == w2:
            if w1 == 0:
                return (z1, w1)
            m = (fp_val(z1) - w1**2 * np3) / (2 * w1 * L_val(z1))
        elif z1 == z2:
            return None
        else:
            m = (w2 - w1) / (z2 - z1)
        alpha = w1 - m * z1
        c3c = C3 - np3 * m**2
        c2c = C2 - ((-np2)*m**2 + 2*alpha*m*np3)
        if c3c == 0:
            return None
        z3 = -c2c / c3c - z1 - z2
        w3 = alpha + m * z3
        return (Rational(z3), Rational(w3))

    def neg_pt(zv, wv):
        if zv == -1 and wv == 0:
            return None
        r = third_inter(Rational(-1), Rational(0), zv, wv)
        if r is None:
            return (Rational(-1), Rational(0))
        return r

    def add_pt(p1, p2):
        if p1 is None:
            return p2
        if p2 is None:
            return p1
        r = third_inter(p1[0], p1[1], p2[0], p2[1])
        if r is None:
            return None
        return neg_pt(r[0], r[1])

    def pt_to_abc(zv, wv):
        return _map_to_abc(zv, wv, np3, np2)

    # Try each generator
    best_solution = None
    best_mult = float('inf')
    best_digits = float('inf')

    for gi, gen in enumerate(gens):
        current = gen
        for mult in range(1, max_mult + 1):
            if mult == 1:
                pass  # current = gen already
            else:
                current = add_pt(current, gen)
            if current is None:
                break

            abc = pt_to_abc(current[0], current[1])
            if abc and all(v > 0 for v in abc):
                a, b, c = abc
                check = Rational(a, b+c) + Rational(b, a+c) + Rational(c, a+b)
                if check == N:
                    digits = max(len(str(v)) for v in abc)
                    if verbose:
                        print(f"  gen{gi}: solution at {mult}P, {digits} digits")
                    if digits < best_digits:
                        best_solution = abc
                        best_mult = mult
                        best_digits = digits
                    break  # This generator found its solution, try next

    return best_solution


def _map_to_abc(zv, wv, np3, np2):
    lv = np3 * zv - np2
    if lv == 0:
        return None
    s2v = (np3 * zv**2 * (1-zv) - 1) / lv
    xyv = s2v - zv * (1-zv)
    xpyv = 1 - zv
    xv = (xpyv + wv) / 2
    yv = (xpyv - wv) / 2
    vals = [xv, yv, zv]
    denoms = [abs(int(v.q)) for v in vals]
    Lc = denoms[0]
    for d in denoms[1:]:
        Lc = Lc * d // mgcd(Lc, d)
    ivals = [int(v * Lc) for v in vals]
    g = abs(ivals[0])
    for iv in ivals[1:]:
        g = mgcd(g, abs(iv))
    if g > 0:
        ivals = [iv // g for iv in ivals]
    return tuple(sorted(ivals, reverse=True))


if __name__ == "__main__":
    for N_test in [2, 4, 6, 10, 12, 14, 23, 29]:
        t0 = time.time()
        sol = solve_nesbitt(N_test, max_mult=35, verbose=True)
        elapsed = time.time() - t0
        if sol:
            a, b, c = sol
            digits = max(len(str(v)) for v in sol)
            print(f"N={N_test}: FOUND, {digits} digits, {elapsed:.1f}s")
            if digits <= 100:
                print(f"  a={a}\n  b={b}\n  c={c}")
        else:
            print(f"N={N_test}: NO SOLUTION, {elapsed:.1f}s")
        print()
