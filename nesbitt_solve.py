from sympy import *

x, y, xi = symbols('x y xi')

# Quartic: y^2 = x^4 - 26*x^3 + 115*x^2 - 26*x + 1
# Point P = (0, 1). Tangent at P: y = 1 - 13x
# Substitution: xi = (y - 1 + 13x) / x^2  =>  y = xi*x^2 - 13x + 1
lhs = expand((xi*x**2 - 13*x + 1)**2)
rhs = x**4 - 26*x**3 + 115*x**2 - 26*x + 1
residual = expand(lhs - rhs)

# Factor out x^2 (double point at x=0)
quadratic_in_x = simplify(residual / x**2)
print("Quadratic in x:", quadratic_in_x)

# Solve for x as function of xi
x_of_xi = solve(quadratic_in_x, x)
print("x(xi) =", x_of_xi)

# For each x(xi), compute y = xi*x^2 - 13x + 1
for xsol in x_of_xi:
    xsol_simplified = simplify(xsol)
    print(f"\nx = {xsol_simplified}")
    ysol = simplify(xi * xsol_simplified**2 - 13*xsol_simplified + 1)
    print(f"y = {ysol}")

