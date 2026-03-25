/**
 * Deterministic template solvers: regex-based pattern detection and SymPy code generation.
 * No LLM calls needed for detection or code building.
 */

// ============================================================================
// Helper: Unicode math normalization
// ============================================================================

function normalizeUnicodeMath(text) {
  return text.replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(65 + code - 0x1D400);
    if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(97 + code - 0x1D41A);
    if (code >= 0x1D434 && code <= 0x1D44D) return String.fromCharCode(65 + code - 0x1D434);
    if (code >= 0x1D44E && code <= 0x1D467) return String.fromCharCode(97 + code - 0x1D44E);
    if (code >= 0x1D468 && code <= 0x1D481) return String.fromCharCode(65 + code - 0x1D468);
    if (code >= 0x1D482 && code <= 0x1D49B) return String.fromCharCode(97 + code - 0x1D482);
    if (code >= 0x1D7CE && code <= 0x1D7D7) return String.fromCharCode(48 + code - 0x1D7CE);
    return ch;
  });
}

// ============================================================================
// Helper: Math text to SymPy conversion
// ============================================================================

function mathTextToSymPy(expr) {
  let e = expr;
  e = e.replace(/²/g, '**2').replace(/³/g, '**3');
  e = e.replace(/\^(\d+)/g, '**$1');
  e = e.replace(/−/g, '-');
  e = e.replace(/·/g, '*');
  e = e.replace(/(\d)([a-zA-Z])/g, '$1*$2');
  e = e.replace(/\)([a-zA-Z(])/g, ')*$1');
  e = e.replace(/([a-zA-Z])\(/g, '$1*(');
  e = e.replace(/\)(\d)/g, ')*$1');
  e = e.replace(/\)\(/g, ')*(');
  e = e.replace(/\s+/g, ' ').trim();
  return e;
}

// ============================================================================
// Pattern 1: Digit Counting (Polish "cyfry")
// ============================================================================

function detectDigitCountingParams(text) {
  const lower = text.toLowerCase();
  if (!/cyfr|zapisie dziesi[eę]tnym|liczb\w* naturaln/.test(lower)) return null;

  const polishNumbers = {
    'jedno': 1, 'jeden': 1, 'jedna': 1,
    'dwie': 2, 'dwa': 2, 'dwóch': 2, 'dwu': 2,
    'trzy': 3, 'trzech': 3,
    'cztery': 4, 'czterech': 4,
    'pięć': 5, 'pięciu': 5,
  };
  const numPat = '(\\d+|jedno|jeden|jedna|dwie|dwa|dwóch|dwu|trzy|trzech|cztery|czterech|pięć|pięciu)';

  const oddM = lower.match(new RegExp(`(?:dokładnie\\s+)?${numPat}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?nieparzyst`));
  const evenM = lower.match(new RegExp(`(?:dokładnie\\s+)?${numPat}\\s+(?:cyfr\\w*)\\s+(?:s[aą]\\s+)?parzyst`));
  if (!oddM || !evenM) return null;

  const nOdd = polishNumbers[oddM[1]] ?? parseInt(oddM[1]);
  const nEven = polishNumbers[evenM[1]] ?? parseInt(evenM[1]);
  if (isNaN(nOdd) || isNaN(nEven)) return null;
  if (nOdd < 1 || nOdd > 5 || nEven < 0 || nEven > 5) return null;

  const total = nOdd + nEven;
  if (total < 1 || total > 9) return null;
  return { nOdd, nEven };
}

function buildDigitCountingSolverCode(nOdd, nEven) {
  const total = nOdd + nEven;
  const hasZero = nEven > 0;
  let lines = [
    'from sympy import *', '',
    `# Krok 1: Wybór ${nOdd} cyfr nieparzystych z 5 dostępnych (1,3,5,7,9)`,
    `wybor_nieparzystych = binomial(5, ${nOdd})`,
    `print("Wybór ${nOdd} nieparzystych z 5:", wybor_nieparzystych)`, '',
    `# Krok 2: Wybór ${nEven} cyfr parzystych z 5 dostępnych (0,2,4,6,8)`,
    `wybor_parzystych = binomial(5, ${nEven})`,
    `print("Wybór ${nEven} parzystych z 5:", wybor_parzystych)`, '',
    `# Krok 3: Permutacje ${total} wybranych cyfr`,
    `permutacje = factorial(${total})`,
    `print("Permutacje ${total} cyfr:", permutacje)`, '',
    `# Krok 4: Wszystkie liczby bez ograniczeń`,
    `wszystkie = wybor_nieparzystych * wybor_parzystych * permutacje`,
    `print("Wszystkie kombinacje:", wszystkie)`,
  ];
  if (hasZero && total > 1) {
    lines.push(
      '', `# Krok 5: Odejmij przypadki gdy 0 jest na pierwszej pozycji`,
      `# Jeśli 0 jest na początku: 0 jest JUŻ WYBRANE, zostaje binomial(4, ${nEven - 1}) parzystych`,
      `przypadki_z_zerem = wybor_nieparzystych * binomial(4, ${nEven - 1}) * factorial(${total - 1})`,
      `print("Przypadki z 0 na początku:", przypadki_z_zerem)`, '',
      `# Krok 6: Wynik końcowy`,
      `wynik = wszystkie - przypadki_z_zerem`,
    );
  } else {
    lines.push('', `wynik = wszystkie`);
  }
  lines.push(`print("ODPOWIEDZ:", wynik)`);
  return lines.join('\n');
}

// ============================================================================
// Pattern 2: Triangle Optimization
// ============================================================================

function detectTriangleOptimizationParams(text) {
  const lower = normalizeUnicodeMath(text).toLowerCase();
  const hasTriangle = /tr[oó]jk[aą]t/.test(lower);
  if (!hasTriangle) return null;

  const hasArea = /pol[eua]|area/.test(lower);
  const hasMaximize = /największ|maksymal|najwększ|możliwie największ|najmniejsz/.test(lower);
  const hasCircle = /okr[ęeą]g/.test(lower);
  const hasInscribed = /wpisan/.test(lower);
  const hasIsosceles = /równoramienn/.test(lower);
  const hasPerimeter = /obw[oó]d/.test(lower);

  // Sub-pattern C: Direct Heron (given 3 numeric sides)
  if (hasArea && !hasMaximize) {
    const sidesM = lower.match(
      /bok(?:ach|i|ów)?\s+(?:o\s+długości(?:ach)?\s+)?(?:\$?(\d+(?:[.,]\d+)?)\$?\s*[,;]\s*\$?(\d+(?:[.,]\d+)?)\$?\s*(?:[,;i]\s*(?:i\s+)?)\$?(\d+(?:[.,]\d+)?)\$?)/
    );
    if (sidesM) {
      const a = parseFloat(sidesM[1].replace(',', '.'));
      const b = parseFloat(sidesM[2].replace(',', '.'));
      const c = parseFloat(sidesM[3].replace(',', '.'));
      if (!isNaN(a) && !isNaN(b) && !isNaN(c) && a + b > c && b + c > a && a + c > b) {
        return { subtype: 'direct_heron', sides: [a, b, c] };
      }
    }
  }

  if (!hasArea) return null;

  // Extract perimeter
  let perimeterValue = null;
  let perimeterMult = null;
  const perimM = lower.match(/obw[oó]d\w*\s+(?:równ\w*\s+|=\s*)?(\d+)/);
  if (perimM) {
    const after = lower.substring(perimM.index + perimM[0].length);
    if (/^[·*]?\s*r\b|^r\b/.test(after)) {
      perimeterMult = parseInt(perimM[1]);
    } else {
      perimeterValue = parseInt(perimM[1]);
    }
  }

  // Extract side ratio
  let sideRatio = null;
  const polishMults = {
    'dwukrotnie': 2, 'dwa razy': 2,
    'trzykrotnie': 3, 'trzy razy': 3,
    'czterokrotnie': 4, 'cztery razy': 4,
  };
  for (const [kw, mult] of Object.entries(polishMults)) {
    if (lower.includes(kw)) { sideRatio = mult; break; }
  }
  if (sideRatio === null) {
    const ratioM = lower.match(/(\d+)\s+raz[ey]\s+dłuż/);
    if (ratioM) sideRatio = parseInt(ratioM[1]);
  }

  if (hasCircle && hasInscribed && perimeterMult && sideRatio) {
    return { subtype: 'inscribed_circle', perimeterMult, sideRatio, radiusSymbol: 'R', maximize: hasMaximize };
  }
  if (hasIsosceles && hasPerimeter && perimeterValue !== null && hasMaximize) {
    return { subtype: 'isosceles_perimeter', perimeter: perimeterValue, maximize: true };
  }
  if (hasPerimeter && sideRatio && perimeterValue !== null && hasMaximize) {
    return { subtype: 'perimeter_ratio', perimeter: perimeterValue, sideRatio, maximize: true };
  }

  return null;
}

function buildDirectHeronCode(sides) {
  const [a, b, c] = sides;
  return `from sympy import *
a, b, c = Rational('${a}'), Rational('${b}'), Rational('${c}')
print(f"Boki: a={a}, b={b}, c={c}")
assert a+b>c and b+c>a and a+c>b, "Nierówność trójkąta!"
s = (a+b+c)/2
print(f"Półobwód: s={s}")
pole_sq = s*(s-a)*(s-b)*(s-c)
print(f"s(s-a)(s-b)(s-c) = {pole_sq}")
pole = simplify(sqrt(pole_sq))
print(f"Pole = {pole}")
print(f"ODPOWIEDZ: {pole}")
`;
}

function buildInscribedCircleCode(params) {
  const k = params.perimeterMult;
  const n = params.sideRatio;
  const R = params.radiusSymbol;
  const n1 = n + 1;
  return `from sympy import *
import warnings
warnings.filterwarnings('ignore')
${R} = symbols('${R}', positive=True)
t = symbols('t', positive=True)
a_expr = ${n}*t*${R}
b_expr = t*${R}
c_expr = (${k}-${n1}*t)*${R}
print("Boki: ${n}t*${R}, t*${R}, (${k}-${n1}t)*${R}")
t_min = Rational(${k}, ${2*n1})
t_max = Rational(${k}, ${2*n})
print("Zakres t: (" + str(t_min) + ", " + str(t_max) + ")")
s = Rational(${k},2)*${R}
Area_sq = expand(s*(s-a_expr)*(s-b_expr)*(s-c_expr))
print("Pole^2 (Heron): " + str(factor(Area_sq)))
abc = a_expr*b_expr*c_expr
eq = simplify(expand(abc**2-16*${R}**2*Area_sq)/${R}**6)
print("Rownanie: " + str(Poly(eq,t).as_expr()) + " = 0")
solutions = solve(eq, t)
valid = []
for sol in solutions:
    try:
        val = sol.evalf()
        if hasattr(val, 'is_real') and val.is_real:
            tv = float(val)
        else:
            cv = complex(val)
            if abs(cv.imag)<1e-8:
                tv = cv.real
            else:
                continue
        if float(t_min)<tv<float(t_max):
            valid.append((tv,sol))
            print("  t=" + str(round(tv,6)) + " ok")
    except: pass
best_area,best_sides=None,None
for tv,ts in valid:
    av,bv,cv=${n}*tv,tv,${k}-${n1}*tv
    sv=${k}/2
    asq=sv*(sv-av)*(sv-bv)*(sv-cv)
    if asq>0:
        area=asq**0.5
        print("  t=" + str(round(tv,6)) + ": boki (" + str(round(av,4)) + "${R}," + str(round(bv,4)) + "${R}," + str(round(cv,4)) + "${R}), Pole=" + str(round(area,6)) + "${R}^2")
        if best_area is None or area>best_area:
            best_area,best_sides=area,(av,bv,cv)
if best_area:
    af,bf,cf=best_sides
    print("")
    print("Trojkat o najwiekszym polu: boki =(" + str(round(af,4)) + "," + str(round(bf,4)) + "," + str(round(cf,4)) + ")*${R}")
    print("Pole = " + str(round(best_area,6)) + "*${R}^2")
    print("ODPOWIEDZ: " + str(round(best_area,6)) + "*${R}^2")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
}

function buildIsoscelesPerimeterCode(params) {
  const P = params.perimeter;
  return `from sympy import *
b = symbols('b', positive=True)
a_expr = ${P} - 2*b
print(f"Ramię: b, podstawa: a = ${P} - 2b")
print(f"Dziedzina: b ∈ (${P}/4, ${P}/2)")
h_sq = ${P}*b - Rational(${P**2}, 4)
P_area = Rational(1,2)*(${P}-2*b)*sqrt(h_sq)
P_sq = expand(Rational(1,4)*(${P}-2*b)**2*h_sq)
print(f"P²(b) = {P_sq}")
dP_sq = diff(P_sq, b)
print(f"d(P²)/db = {factor(dP_sq)}")
critical = solve(dP_sq, b)
print(f"Punkty krytyczne: b = {critical}")
best_area,best_b=None,None
for bc in critical:
    bv = float(bc)
    if ${P}/4 < bv < ${P}/2:
        av = float(P_area.subs(b, bc))
        if av > 0 and (best_area is None or av > best_area):
            best_area,best_b = av,bc
if best_b:
    a_val = ${P}-2*best_b
    area_exact = simplify(P_area.subs(b, best_b))
    print(f"Maksimum: b={best_b}, a={a_val}")
    print(f"Pole = {area_exact}")
    print(f"ODPOWIEDZ: {area_exact}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
}

function buildPerimeterRatioCode(params) {
  const P = params.perimeter;
  const n = params.sideRatio;
  const n1 = n + 1;
  return `from sympy import *
t = symbols('t', positive=True)
a = ${n}*t
b = t
c = ${P}-${n1}*t
print(f"Boki: ${n}t, t, ${P}-${n1}t")
t_min = Rational(${P},${2*n1})
t_max = Rational(${P},${2*n})
print(f"Zakres: t ∈ ({t_min}, {t_max})")
s = Rational(${P},2)
Area_sq = expand(s*(s-a)*(s-b)*(s-c))
print(f"Pole²(t) = {factor(Area_sq)}")
dA_sq = diff(Area_sq, t)
print(f"d(Pole²)/dt = {factor(dA_sq)}")
critical = solve(dA_sq, t)
print(f"Punkty krytyczne: {critical}")
best_area,best_tc=None,None
for tc in critical:
    try:
        tv = float(tc)
        if float(t_min)<tv<float(t_max):
            asq = float(Area_sq.subs(t, tc))
            if asq>0:
                area=asq**0.5
                sides=(${n}*tv,tv,${P}-${n1}*tv)
                print("  t=" + str(round(tv,4)) + ": boki (" + str(round(sides[0],4)) + "," + str(round(sides[1],4)) + "," + str(round(sides[2],4)) + "), Pole=" + str(round(area,6)))
                if best_area is None or area>best_area:
                    best_area,best_tc=area,tc
    except: pass
if best_tc:
    area_exact = simplify(sqrt(Area_sq.subs(t, best_tc)))
    sides=(${n}*best_tc, best_tc, ${P}-${n1}*best_tc)
    print(f"\\nMaks pole: boki=({sides[0]},{sides[1]},{sides[2]})")
    print(f"Pole = {area_exact}")
    print(f"ODPOWIEDZ: {area_exact}")
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
}

function buildTriangleOptimizationCode(params) {
  switch (params.subtype) {
    case 'direct_heron': return buildDirectHeronCode(params.sides);
    case 'inscribed_circle': return buildInscribedCircleCode(params);
    case 'isosceles_perimeter': return buildIsoscelesPerimeterCode(params);
    case 'perimeter_ratio': return buildPerimeterRatioCode(params);
    default: return null;
  }
}

// ============================================================================
// Pattern 3: Parametric Quadratic
// ============================================================================

function detectParametricQuadraticParams(text) {
  const normalized = normalizeUnicodeMath(text);
  const lower = normalized.toLowerCase();

  if (!/równani|rownan|pierwiast|rozwiązan|rozwiazan/.test(lower)) return null;
  if (!/x\s*[\^²]\s*2|x\s*\*\*\s*2/.test(lower)) return null;
  if (!/dw[aoóu].*(?:rozwiązan|rozwiazan|pierwiast|rzeczywist)/.test(lower)) return null;

  const paramMatch = lower.match(/parametr\w*\s+([a-z])\b/);
  if (!paramMatch) return null;
  const paramName = paramMatch[1];

  let rootMult = null;
  const relMatch = normalized.match(/x\s*[\^_]?\s*1\s*=\s*(\d+)\s*[·*]?\s*x/i);
  if (relMatch) rootMult = parseInt(relMatch[1]);

  if (!rootMult) {
    const polishMults = { 'dwukrotnie': 2, 'trzykrotnie': 3, 'czterokrotnie': 4 };
    for (const [kw, mult] of Object.entries(polishMults)) {
      if (lower.includes(kw)) { rootMult = mult; break; }
    }
  }

  if (!rootMult) return null;

  const eqMatch = normalized.match(/([^.;:!?]*x\s*[\^²]\s*2[^.;:!?]*?)\s*=\s*0/i);
  if (!eqMatch) return null;

  let eqText = eqMatch[1].trim();
  eqText = eqText.replace(/^.*?(?=[\d(]|−|-)/i, '');

  const eqExpr = mathTextToSymPy(eqText);
  if (!eqExpr) return null;

  if (!eqExpr.includes('x') || !eqExpr.includes(paramName)) return null;

  return { eqExpr, paramName, varName: 'x', rootMult };
}

function buildParametricQuadraticCode(params) {
  const { eqExpr, paramName, varName, rootMult } = params;
  const k = rootMult;
  const k1 = k + 1;

  return `from sympy import *

${paramName} = symbols('${paramName}', real=True)
${varName} = symbols('${varName}', real=True)

eq_expr = ${eqExpr}
print("Rownanie: " + str(expand(eq_expr)) + " = 0")

a_coeff = eq_expr.coeff(${varName}, 2)
b_coeff = eq_expr.coeff(${varName}, 1)
c_coeff = eq_expr.coeff(${varName}, 0)
print("a = " + str(a_coeff) + ", b = " + str(b_coeff) + ", c = " + str(c_coeff))

delta = expand(b_coeff**2 - 4*a_coeff*c_coeff)
print("Delta = " + str(delta))

${varName}2_expr = -b_coeff / (a_coeff * ${k1})
print("  ${varName}2 = -b/(a*${k1}) = " + str(simplify(${varName}2_expr)))

vieta_eq = simplify(${k} * ${varName}2_expr**2 - c_coeff / a_coeff)
vieta_eq_poly = simplify(vieta_eq * a_coeff * ${k1}**2)
print("  Rownanie: " + str(expand(vieta_eq_poly)) + " = 0")

${paramName}_solutions = solve(vieta_eq, ${paramName})
print("Rozwiazania ${paramName}: " + str(${paramName}_solutions))

valid_${paramName} = []
for ${paramName}_val in ${paramName}_solutions:
    d = delta.subs(${paramName}, ${paramName}_val)
    ${varName}2_val = ${varName}2_expr.subs(${paramName}, ${paramName}_val)
    ${varName}1_val = ${k} * ${varName}2_val
    if d > 0:
        valid_${paramName}.append(${paramName}_val)
        print("${paramName} = " + str(${paramName}_val) + ": delta = " + str(d) + " > 0")
        print("  ${varName}1 = " + str(${varName}1_val) + ", ${varName}2 = " + str(${varName}2_val))
    else:
        print("${paramName} = " + str(${paramName}_val) + ": delta = " + str(d) + " <= 0, odrzucamy")

if len(valid_${paramName}) == 1:
    print("ODPOWIEDZ: ${paramName} = " + str(valid_${paramName}[0]))
elif len(valid_${paramName}) > 1:
    print("ODPOWIEDZ: ${paramName} in " + str(set(valid_${paramName})))
else:
    print("ODPOWIEDZ: brak rozwiazania")
`;
}

// ============================================================================
// Pattern 4: Tetrahedron Sphere
// ============================================================================

function detectTetrahedronSphereParams(text) {
  const normalized = normalizeUnicodeMath(text);
  const lower = normalized.toLowerCase();

  if (!/czworo[sś]cian|tetraed/.test(lower)) return null;

  if (!/kraw[eę]d[zź].*(?:równ|takiej samej|jednakow|d[lł]ugo[sś])|foremnr?y/.test(lower)
      && !/(?:równ|takiej samej|jednakow).*kraw[eę]d[zź]/.test(lower)
      && !/wszystkie\s+kraw/.test(lower)) return null;

  let edge = null;
  const edgeMatch = normalized.match(/d[lł]ugo[sś][ctć]\w*\s+(\d+(?:[.,]\d+)?)/);
  if (edgeMatch) edge = parseFloat(edgeMatch[1].replace(',', '.'));
  if (!edge) {
    const edgeMatch2 = normalized.match(/kraw[eę]d[zź]\w*\s+.*?(\d+(?:[.,]\d+)?)/);
    if (edgeMatch2) edge = parseFloat(edgeMatch2[1].replace(',', '.'));
  }
  if (!edge || edge <= 0) return null;

  let volNum = null;
  let volDen = null;
  const fracMatch = normalized.match(/\\frac\{(\d+)\}\{(\d+)\}/);
  if (fracMatch) {
    volNum = parseInt(fracMatch[1]);
    volDen = parseInt(fracMatch[2]);
  }
  if (!volNum) {
    const plainFrac = lower.match(/(\d+)\s*[\/]\s*(\d+)/);
    if (plainFrac) {
      const n = parseInt(plainFrac[1]);
      const d = parseInt(plainFrac[2]);
      if (n > 0 && d > 0 && n < d) { volNum = n; volDen = d; }
    }
  }

  const hasPlane = /p[lł]aszczyzn|przekr[oó]j|dzieli|r[oó]wnole[gł]/.test(lower);
  const hasSphere = /kul[aeioy]|sfery|spher/.test(lower);

  let findWhat = 'all';
  if (hasPlane && hasSphere && /odleg[lł]o[sś][cć].*[sś]rodk/.test(lower)) findWhat = 'distance_center_to_plane';
  else if (hasPlane && hasSphere && /odleg[lł]o[sś]/.test(lower)) findWhat = 'distance_center_to_plane';
  else if (/promie[nń]\w*\s+kul\w*\s+wpisan/.test(lower) || /kul\w*\s+wpisan\w*.*promie/.test(lower)) findWhat = 'inradius';
  else if (/promie[nń]\w*\s+kul\w*\s+opisan/.test(lower) || /kul\w*\s+opisan\w*.*promie/.test(lower)) findWhat = 'circumradius';
  else if (/obj[eę]to[sś][cć]\w*\s+kul/.test(lower) || /kul\w*.*obj[eę]to[sś]/.test(lower)) findWhat = 'sphere_volume';
  else if (/pol[eua]\s+(?:powierzchni|czworo)/.test(lower)) findWhat = 'surface_area';
  else if (/pol[eua]\s+(?:pod|przek|tr[oó]jk)/.test(lower)) findWhat = 'base_area';
  else if (/wysoko[sś][cć]/.test(lower) && !hasPlane) findWhat = 'height';
  else if (/obj[eę]to[sś][cć]/.test(lower) && !hasPlane) findWhat = 'volume';
  else if (/obj[eę]to[sś][cć].*[sś]ci[eę]t/.test(lower) || /ostros[lł]up\w*\s+[sś]ci[eę]t/.test(lower)) findWhat = 'frustum_volume';
  else if (hasPlane && /pol[eua]\s+przek/.test(lower)) findWhat = 'cross_section_area';
  else if (hasSphere) findWhat = 'all_sphere';

  if (!hasSphere && findWhat === 'all') {
    if (!/wysoko|obj[eę]to|pol[eua]|przek[aą]tn|promie/.test(lower)) return null;
  }

  return { edgeLength: edge, volNum, volDen, hasPlane, findWhat };
}

function buildTetrahedronSphereCode(params) {
  const { edgeLength, volNum, volDen, hasPlane, findWhat } = params;

  const planeBlock = (hasPlane && volNum && volDen) ? `
# === Przekroj plaszczyzna rownoleglej do podstawy ===
vol_ratio = Rational(${volNum}, ${volDen})
print("Stosunek objetosci malego ostroslupa =", vol_ratio)
k_scale = cbrt(vol_ratio)
print("Wspolczynnik skali k =", simplify(k_scale))
small_h = k_scale * h
plane_height = h - small_h
plane_height = simplify(plane_height)
print("Plaszczyzna pi na wysokosci", plane_height, "od podstawy")
cross_edge = k_scale * a
cross_area = sqrt(3) / 4 * cross_edge**2
cross_area = simplify(cross_area)
print("Krawedz przekroju =", simplify(cross_edge))
print("Pole przekroju =", cross_area)
V_small = vol_ratio * V
V_frustum = V - V_small
print("Objetosc malego ostroslupa =", simplify(V_small))
print("Objetosc ostroslupa scietego =", simplify(V_frustum))
dist_S_plane = Abs(r_in - plane_height)
dist_S_plane = simplify(dist_S_plane)
dist_S_plane = radsimp(dist_S_plane)
print("Odleglosc srodka kuli od plaszczyzny =", dist_S_plane)
` : '';

  let answerBlock;
  switch (findWhat) {
    case 'distance_center_to_plane': answerBlock = 'answer = dist_S_plane'; break;
    case 'inradius': answerBlock = 'answer = r_in'; break;
    case 'circumradius': answerBlock = 'answer = R_out'; break;
    case 'sphere_volume': answerBlock = 'answer = V_sphere_in'; break;
    case 'surface_area': answerBlock = 'answer = S_total'; break;
    case 'base_area': answerBlock = 'answer = S_face'; break;
    case 'height': answerBlock = 'answer = h'; break;
    case 'volume': answerBlock = 'answer = V'; break;
    case 'frustum_volume': answerBlock = 'answer = V_frustum'; break;
    case 'cross_section_area': answerBlock = 'answer = cross_area'; break;
    default:
      answerBlock = (hasPlane && volNum && volDen) ? 'answer = dist_S_plane' : 'answer = r_in';
      break;
  }

  return `from sympy import *

a = Integer(${edgeLength})
print("=== Czworoscian foremny, krawedz a =", a, "===")
print()
h = a * sqrt(6) / 3
print("Wysokosc h =", simplify(h))
S_face = sqrt(3) / 4 * a**2
S_face = simplify(S_face)
print("Pole sciany =", S_face)
S_total = 4 * S_face
S_total = simplify(S_total)
print("Pole powierzchni calkowitej =", S_total)
V = a**3 * sqrt(2) / 12
V = simplify(V)
print("Objetosc V =", V)
r_in = a * sqrt(6) / 12
r_in = simplify(r_in)
print()
print("Promien kuli wpisanej r =", r_in)
print("Srodek kuli na wysokosci r =", r_in, "od podstawy (= h/4)")
V_sphere_in = Rational(4, 3) * pi * r_in**3
V_sphere_in = simplify(V_sphere_in)
print("Objetosc kuli wpisanej =", V_sphere_in)
R_out = a * sqrt(6) / 4
R_out = simplify(R_out)
print()
print("Promien kuli opisanej R =", R_out)
V_sphere_out = Rational(4, 3) * pi * R_out**3
V_sphere_out = simplify(V_sphere_out)
print("Objetosc kuli opisanej =", V_sphere_out)
print("R/r =", simplify(R_out / r_in))
${planeBlock}
print()
${answerBlock}
print("ODPOWIEDZ:", radsimp(simplify(answer)))
`;
}

// ============================================================================
// Main Export: Pattern Dispatcher
// ============================================================================

export function tryDeterministicSolver(problemText) {
  // Pattern 1: Digit counting
  const digitParams = detectDigitCountingParams(problemText);
  if (digitParams) {
    return { code: buildDigitCountingSolverCode(digitParams.nOdd, digitParams.nEven), template: 'digit_counting' };
  }

  // Pattern 2: Triangle optimization
  const triParams = detectTriangleOptimizationParams(problemText);
  if (triParams) {
    const code = buildTriangleOptimizationCode(triParams);
    if (code) return { code, template: `triangle_${triParams.subtype}` };
  }

  // Pattern 3: Parametric quadratic
  const quadParams = detectParametricQuadraticParams(problemText);
  if (quadParams) {
    const code = buildParametricQuadraticCode(quadParams);
    if (code) return { code, template: 'parametric_quadratic' };
  }

  // Pattern 4: Tetrahedron sphere
  const tetraParams = detectTetrahedronSphereParams(problemText);
  if (tetraParams) {
    const code = buildTetrahedronSphereCode(tetraParams);
    if (code) return { code, template: 'tetrahedron_sphere' };
  }

  return null;
}
