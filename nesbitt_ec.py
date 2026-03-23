from sympy import Rational, sqrt, symbols, solve, gcd, Abs

def ec_double(Px, Py, A):
    """Double point on Y^2 = X^3 + AX + B"""
    lam = (3*Px**2 + A) / (2*Py)
    Rx = lam**2 - 2*Px
    Ry = lam*(Px - Rx) - Py
    return (Rational(Rx), Rational(Ry))

def ec_add(P, Q, A):
    """Add two points on Y^2 = X^3 + AX + B. None = point at infinity."""
    if P is None: return Q
    if Q is None: return P
    Px, Py = P
    Qx, Qy = Q
    if Px == Qx:
        return ec_double(Px, Py, A) if Py == Qy else None
    lam = (Qy - Py) / (Qx - Px)
    Rx = lam**2 - Px - Qx
    Ry = lam*(Px - Rx) - Py
    return (Rational(Rx), Rational(Ry))

def ec_mul(n, P, A):
    """Scalar multiplication n*P using double-and-add"""
    if n == 0 or P is None: return None
    if n < 0: return ec_mul(-n, (P[0], -P[1]), A)
    result = None
    current = P
    while n > 0:
        if n & 1:
            result = ec_add(result, current, A)
        current = ec_add(current, current, A)
        n >>= 1
    return result

def weierstrass_to_abc(V, S, N):
    """Convert Weierstrass point (V, S) back to (a, b, c) for Nesbitt N."""
    K = 2*N + 3
    # V -> T -> X_shifted -> xi -> q -> p -> (a, b, c)
    T = V - Rational(K*K - 2*K - 5, 3)  # generalized shift
    # Actually for N=4: shift was 97/3. Let me use the specific shift.
    return None  # placeholder

def solve_nesbitt(N):
    """Find positive integer (a,b,c) with a/(b+c)+b/(a+c)+c/(a+b)=N"""
    K = 2*N + 3
    
    # Quartic: m^2 = q^4 - (2K+4)q^3 + (K^2-6)q^2 - (2K+4)q + 1
    # comes from discriminant of (q+1)p^2 + (q^2-Kq+1)p + q(q+1) = 0
    
    c3 = -(2*K + 4)
    c2 = K**2 - 6
    c1 = c3  # palindromic!
    
    # Substitution xi = (m - 1 + (K+2)*q) / q^2 yields:
    # Quadratic residual in q: (xi^2-1)q^2 + (2-2K)(xi-1)q/(... ) ...
    # Actually, let me use the direct approach via the cubic.
    
    # The condition for rational q is: cubic in xi must be a perfect square.
    # W^2 = -2*xi^3 + c2*xi^2 + ... (derived from quartic discriminant)
    # I'll compute it symbolically.
    
    xi = symbols('xi')
    
    # From the quadratic in q after substitution:
    # (xi+1)(xi-1)q^2 - 2(K+2)(xi-1)q + 2(xi + K^2/2 - ...) = 0
    # The discriminant (in q) gives us the cubic.
    
    # Let me derive it directly for any N.
    # Quartic: m^2 = q^4 + c3*q^3 + c2*q^2 + c1*q + 1
    # Substitution m = xi*q^2 - (K+2)*q + 1 (tangent at q=0, m=1)
    # leads to residual / q^2 being quadratic in q.
    
    # m = xi*q^2 - (K+2)*q + 1
    # m^2 = xi^2*q^4 - 2(K+2)*xi*q^3 + (2*xi + (K+2)^2)*q^2 - 2(K+2)*q + 1
    # = q^4 + c3*q^3 + c2*q^2 + c1*q + 1
    
    # Matching: xi^2 = 1 (from q^4) => only at xi=1 (or -1)
    # That's why this was degenerate. Need different parametrization.
    
    # Let me use the PALINDROMIC TRICK properly.
    # Since c1 = c3, the quartic is palindromic: dividing by q^2:
    # (m/q)^2 = q^2 + c3*q + c2 + c1/q + 1/q^2
    #          = (q+1/q)^2 + c3*(q+1/q) + (c2 - 2)
    # Let u = q + 1/q, v = m/q:
    # v^2 = u^2 + c3*u + (c2 - 2)
    
    # Complete the square: v^2 = (u + c3/2)^2 + (c2 - 2 - c3^2/4)
    # (u + c3/2)^2 - v^2 = -(c2 - 2 - c3^2/4) = c3^2/4 - c2 + 2
    
    half_c3 = Rational(c3, 2)
    delta = Rational(c3**2, 4) - c2 + 2
    print(f"N={N}, K={K}, c3={c3}, c2={c2}, delta={delta}")
    
    # (u + c3/2 - v)(u + c3/2 + v) = delta
    # Parametrize: u + c3/2 - v = t, u + c3/2 + v = delta/t
    # u = -c3/2 + (t + delta/t)/2
    # v = (delta/t - t)/2
    
    # For q to be rational: u^2 - 4 >= 0 and u^2-4 = perfect square
    # (since q^2 - u*q + 1 = 0 => q = (u +/- sqrt(u^2-4))/2)
    
    # u^2 - 4 = (-c3/2 + (t+delta/t)/2)^2 - 4
    # This must be a perfect square w^2.
    
    # Clear denominators: multiply u by 2t:
    # 2t*u = -c3*t + t^2 + delta
    # (2tu)^2 = (t^2 - c3*t + delta)^2
    # (2tu)^2 - 4*(2t)^2 = (t^2 - c3*t + delta)^2 - 16t^2
    # Need this to be a perfect square.
    
    # Set F(t) = (t^2 - c3*t + delta)^2 - 16*t^2
    # F(t) = t^4 - 2*c3*t^3 + (c3^2 + 2*delta - 16)*t^2 - 2*c3*delta*t + delta^2
    
    # This is again a palindromic quartic (if we check...)
    # Actually: coeff of t^4 = 1, coeff of t^0 = delta^2. Not palindromic unless delta=1.
    
    # Find a rational point on F(t) = w^2:
    # t=0: w^2 = delta^2, w = +-delta. Point (0, delta).
    # But this gives u = -c3/2 + delta/(2*0) = infinity. Degenerate.
    
    # t=delta: F = (delta^2 - c3*delta + delta)^2 - 16*delta^2
    #        = (delta^2 + delta*(1-c3))^2 - 16*delta^2
    #        = delta^2*(delta + 1 - c3)^2 - 16*delta^2
    #        = delta^2*((delta+1-c3)^2 - 16)
    # Need (delta+1-c3)^2 - 16 to be a perfect square.
    
    val = delta + 1 - c3
    inner = val**2 - 16
    print(f"At t=delta={delta}: inner = {val}^2 - 16 = {inner}")
    
    # Let me try small t values
    import math
    
    t_sym = symbols('t_sym')
    F_expr = (t_sym**2 - c3*t_sym + delta)**2 - 16*t_sym**2
    
    rational_points = []
    for t_num in range(-50, 51):
        for t_den in range(1, 30):
            tv = Rational(t_num, t_den)
            if tv == 0: continue
            Fv = F_expr.subs(t_sym, tv)
            if Fv < 0: continue
            # Check if Fv is a perfect square of a rational
            # Fv = p/q, need p*q to be a perfect square
            p_val = int(Fv.p)
            q_val = int(Fv.q)
            prod = p_val * q_val
            if prod < 0: continue
            sr = int(math.isqrt(prod))
            if sr * sr == prod:
                w_val = Rational(sr, q_val)
                if w_val * w_val == Fv:
                    rational_points.append((tv, w_val))
                    if len(rational_points) <= 5:
                        print(f"  Rational point: t={tv}, w={w_val}")
    
    print(f"Found {len(rational_points)} rational points on the auxiliary quartic")
    
    # For each rational point, reconstruct a, b, c
    solutions = []
    for tv, wv in rational_points:
        u_val = -half_c3 + (tv + delta/tv) / 2
        v_val = (delta/tv - tv) / 2
        
        # q from: q^2 - u*q + 1 = 0
        disc_q = u_val**2 - 4
        if disc_q < 0: continue
        
        # Check if disc_q is a perfect square
        p_d = int(disc_q.p)
        q_d = int(disc_q.q)
        prod_d = p_d * q_d
        if prod_d < 0: continue
        sr_d = int(math.isqrt(prod_d))
        if sr_d * sr_d != prod_d: continue
        
        sqrt_disc = Rational(sr_d, q_d)
        
        for sign in [1, -1]:
            q_val = (u_val + sign * sqrt_disc) / 2
            if q_val <= 0: continue
            
            # m/q = v => m = v*q
            m_val = v_val * q_val
            
            # p from: (q+1)p^2 + (q^2-Kq+1)p + q(q+1) = 0
            A_p = q_val + 1
            B_p = q_val**2 - K*q_val + 1
            C_p = q_val * (q_val + 1)
            
            disc_p = B_p**2 - 4*A_p*C_p
            if disc_p < 0: continue
            
            # disc_p should equal m^2 (this is how we derived it)
            p_dp = int(disc_p.p)
            q_dp = int(disc_p.q)
            prod_dp = p_dp * q_dp
            sr_dp = int(math.isqrt(abs(prod_dp)))
            if sr_dp * sr_dp != prod_dp: continue
            
            sqrt_disc_p = Rational(sr_dp, q_dp)
            
            for sign2 in [1, -1]:
                p_val = (-B_p + sign2 * sqrt_disc_p) / (2 * A_p)
                if p_val <= 0: continue
                
                r_val = Rational(1)
                s_val = (p_val + q_val + r_val) / 2
                a_val = s_val - p_val
                b_val = s_val - q_val
                c_val = s_val - r_val
                
                if a_val > 0 and b_val > 0 and c_val > 0:
                    # Scale to integers
                    # Find LCD of a, b, c
                    from math import gcd as mgcd
                    def lcm(x, y): return x * y // mgcd(x, y)
                    
                    da = int(a_val.q)
                    db = int(b_val.q)
                    dc = int(c_val.q)
                    L = lcm(lcm(da, db), dc)
                    
                    ai = int(a_val * L)
                    bi = int(b_val * L)
                    ci = int(c_val * L)
                    g = mgcd(mgcd(abs(ai), abs(bi)), abs(ci))
                    ai, bi, ci = ai//g, bi//g, ci//g
                    
                    # Verify
                    check = Rational(ai, bi+ci) + Rational(bi, ai+ci) + Rational(ci, ai+bi)
                    if check == N:
                        print(f"\n*** SOLUTION FOUND ***")
                        print(f"a = {ai}")
                        print(f"b = {bi}")
                        print(f"c = {ci}")
                        print(f"Verification: {check}")
                        print(f"Digits: a={len(str(ai))}, b={len(str(bi))}, c={len(str(ci))}")
                        solutions.append((ai, bi, ci))
    
    return solutions

# Solve for N=4
print("=== Solving a/(b+c) + b/(a+c) + c/(a+b) = 4 ===\n")
sols = solve_nesbitt(4)
if not sols:
    print("\nNo solution found in search range.")
    
