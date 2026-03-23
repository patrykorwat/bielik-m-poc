from sympy import *

# The quartic for N=4: m^2 = q^4 - 26q^3 + 115q^2 - 26q + 1
# Discriminant under sqrt is: -2*xi^3 + 115*xi^2 - 336*xi + 223
# For x(xi) to be rational, this cubic must be a perfect square.
# So we need: W^2 = -2*xi^3 + 115*xi^2 - 336*xi + 223
# This IS our elliptic curve in (almost) Weierstrass form!

# Convert to standard Weierstrass Y^2 = X^3 + aX + b
# Current: W^2 = -2*xi^3 + 115*xi^2 - 336*xi + 223
# Multiply by -2: (-2W)^2 = 4xi^3 - 230xi^2 + 672xi - 446
# Set U = -2W, V = xi: U^2 = 4V^3 - 230V^2 + 672V - 446
# Substitute V = X/4 + 230/12 = X/4 + 115/6... 
# Actually, standard form: complete the cube.
# U^2 = 4(V^3 - (115/2)V^2 + 168V - 223/2)
# V = T + 115/6:
# T^3 + ... let sympy do it

xi_var, W = symbols('xi W')
cubic_rhs = -2*xi_var**3 + 115*xi_var**2 - 336*xi_var + 223

# Standard Weierstrass: multiply both sides by -4 to get
# (-2W)^2 = 4*(2*xi^3 - 115*xi^2 + 336*xi - 223)
# Set Y = 2W, then Y^2 = 4*(2xi^3 - 115xi^2 + 336xi - 223)
# Hmm, let me use a cleaner approach.

# W^2 = -2*xi^3 + 115*xi^2 - 336*xi + 223
# Multiply by (-2)^2 = 4: (2W)^2 = -8xi^3 + 460xi^2 - 1344xi + 892
# Set u = -2xi: (2W)^2 = u^3 + 460*(u^2/4) - 1344*(-u/2) + 892
# Nope, let me use substitution properly.

# For W^2 = a*xi^3 + b*xi^2 + c*xi + d where a = -2:
# Multiply by a^2: (aW)^2 = a^3*xi^3 + a^2*b*xi^2 + a^2*c*xi + a^2*d
# Set X = a*xi = -2*xi, Y = a*W = -2*W:
# (-2W)^2 = (-2)^3*xi^3 + (-2)^2*115*xi^2 + (-2)^2*(-336)*xi + (-2)^2*223
# 4W^2 = -8xi^3 + 460xi^2 - 1344xi + 892
# Y^2 = X^3 + 460*(X/-2)^2/??? 

# Let me just do it properly with sympy.
# W^2 = -2t^3 + 115t^2 - 336t + 223  (t = xi)
# Standard transform: set t = (X - b^2/3) / a ... 

t = symbols('t')
f = -2*t**3 + 115*t**2 - 336*t + 223

# Depress the cubic: substitute t = u + 115/6 to eliminate t^2 term
# f = -2(u + 115/6)^3 + 115(u + 115/6)^2 - 336(u + 115/6) + 223
u = symbols('u')
shift = Rational(115, 6)
f_shifted = f.subs(t, u + shift)
f_shifted_expanded = expand(f_shifted)
print("f after shift t = u + 115/6:")
print(f_shifted_expanded)

# Now multiply by -4 to get Y^2 = 4X^3 + ... form
# Actually, for W^2 = -2u^3 + ... form, multiply both sides by (-2)^2 = 4
# (2W)^2 = 4*(-2u^3 + ...) = -8u^3 + ...
# Set Y = 2W: Y^2 = -8u^3 + ...
# Set X = -2u: u = -X/2
# Y^2 = -8*(-X/2)^3 + ... = X^3 + ...

X_var, Y_var = symbols('X Y')
# W^2 = f_shifted = -2*u^3 + p*u + q (no u^2 term after shift)
# Extract coefficients
poly_u = Poly(f_shifted_expanded, u)
coeffs = poly_u.all_coeffs()
print(f"Coefficients (u^3, u^2, u^1, u^0): {coeffs}")

# Should be [-2, 0, p, q]
a3, a2, a1, a0 = coeffs
print(f"a3={a3}, a2={a2}, a1={a1}, a0={a0}")
assert a2 == 0, "u^2 term should be zero after depressing"

# W^2 = a3*u^3 + a1*u + a0
# Multiply by a3^2: (a3*W)^2 = a3^3*u^3 + a3^2*a1*u + a3^2*a0
# Set Y = a3*W = -2*W, X = a3*u = -2*u:
# Y^2 = X^3 + a3^2*a1*(X/a3) + a3^2*a0
#      = X^3 + a3*a1*X + a3^2*a0

a_weier = a3 * a1
b_weier = a3**2 * a0
print(f"\nWeierstrass form: Y^2 = X^3 + ({a_weier})*X + ({b_weier})")

# Now find rational points on E: Y^2 = X^3 + a*X + b
# First check the discriminant
disc = -16*(4*a_weier**3 + 27*b_weier**2)
print(f"Discriminant: {disc}")
print(f"j-invariant: {-1728*64*a_weier**3 / disc}")

# Map our known point (t=0, W=1) to Weierstrass coordinates
# t = u + 115/6 => u = t - 115/6 = 0 - 115/6 = -115/6
# X = a3*u = -2*(-115/6) = 115/3
# Y = a3*W = -2*1 = -2
X0 = a3 * (-shift)
Y0 = a3 * 1
print(f"\nKnown point on E: ({X0}, {Y0})")
# Verify
check = X0**3 + a_weier*X0 + b_weier - Y0**2
print(f"Verification (should be 0): {check}")

