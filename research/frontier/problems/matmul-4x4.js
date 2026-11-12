// Multiplying two 4 x 4 matrices with as few multiplications as possible, over the complex numbers.
// Solution: one multiplication per line, 48 numbers: u (16), v (16), w (16), each row by row. The
// line stands for: multiply (sum of u[p] A[p]) by (sum of v[q] B[q]), and add w[s] times that to
// C[s], where A, B, C = A B are read row by row. Numbers are exact: integers, fractions, and
// complex ones, like 1, -1/2, i, -i/2, 1/2+3/4i, -1-i.
// Valid if, for every pair of matrices, the result is exactly A B: that is, for every p, q, s,
//   sum over lines of u[p] v[q] w[s] = 1 if p = (i,k), q = (k,j), s = (i,j) for some i, j, k, else 0.
// Score: how many lines (multiplications).
function verify(solution) {
  const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
  const fr = (n, d) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return [n / g, d / g]; };
  const rat = s => { const m = /^([+-]?)([0-9]+)(?:\/([0-9]+))?$/.exec(s); if (!m || m[3] === "0") return null; return fr((m[1] === "-" ? -1n : 1n) * BigInt(m[2]), BigInt(m[3] ?? "1")); };
  // a complex number [re, im], each a fraction [n, d]
  const cx = t => {
    if (!t.endsWith("i")) { const r = rat(t); return r && [r, [0n, 1n]]; }
    const body = t.slice(0, -1);
    let cut = -1;
    for (let k = body.length - 1; k > 0; k--) if (body[k] === "+" || body[k] === "-") { cut = k; break; }
    if (cut > 0 && (body[cut - 1] === "+" || body[cut - 1] === "-")) cut--; // a sign written twice, like 1+-2i
    const reS = cut < 0 ? "0" : body.slice(0, cut);
    const imS0 = (cut < 0 ? body : body.slice(cut)).replace(/^([+-])([+-])/, (_, x, y) => (x === y ? "+" : "-"));
    const imS = imS0 === "" || imS0 === "+" ? "1" : imS0 === "-" ? "-1" : imS0;
    const re = rat(reS), im = rat(imS.replace(/^\+/, ""));
    return re && im && [re, im];
  };
  const terms = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const ts = l.split(/[\s,]+/);
    if (ts.length !== 48) return { valid: false, score: 0, reason: `not 48 numbers (u, v, w): ${l.slice(0, 60)}` };
    const xs = ts.map(cx);
    const bad = xs.findIndex(x => !x);
    if (bad >= 0) return { valid: false, score: 0, reason: `can't read "${ts[bad]}" as an exact number` };
    terms.push(xs);
  }
  if (!terms.length || terms.length > 64) return { valid: false, score: 0, reason: "between 1 and 64 multiplications" };
  const add = (a, b) => fr(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
  const mul = (a, b) => fr(a[0] * b[0], a[1] * b[1]);
  const neg = a => [-a[0], a[1]];
  const cmul = (x, y) => [add(mul(x[0], y[0]), neg(mul(x[1], y[1]))), add(mul(x[0], y[1]), mul(x[1], y[0]))];
  const isZ = x => x[0][0] === 0n && x[1][0] === 0n;
  const pre = terms.map(t => { const uv = []; for (let p = 0; p < 16; p++) for (let q = 0; q < 16; q++) uv.push(isZ(t[p]) || isZ(t[16 + q]) ? null : cmul(t[p], t[16 + q])); return uv; });
  for (let p = 0; p < 16; p++) for (let q = 0; q < 16; q++) for (let s = 0; s < 16; s++) {
    let sum = [[0n, 1n], [0n, 1n]];
    for (let r = 0; r < terms.length; r++) { const uv = pre[r][p * 16 + q], w = terms[r][32 + s]; if (uv && !isZ(w)) { const x = cmul(uv, w); sum = [add(sum[0], x[0]), add(sum[1], x[1])]; } }
    const i = p >> 2, k = p & 3, k2 = q >> 2, j = q & 3, i2 = s >> 2, j2 = s & 3;
    const want = k === k2 && i === i2 && j === j2 ? 1n : 0n;
    if (!(sum[0][0] === want && sum[0][1] === 1n && sum[1][0] === 0n)) return { valid: false, score: 0, reason: `the coefficient of A[${i},${k}] B[${k2},${j}] in C[${i2},${j2}] comes out wrong` };
  }
  return { valid: true, score: terms.length };
}
