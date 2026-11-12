// The Ramsey number R(5,5): color every connection between n points red or blue so that no 5
// points are all joined in one color. Solution: the coloring as n lines of n characters, 1 for red
// and 0 for blue, symmetric, with 0 on the diagonal. Score: n, the number of points.
// R(5,5) is at most 46 (proven in 2024), so 45 is the most possible.
function verify(solution) {
  const rows = solution.split("\n").map(s => s.trim()).filter(Boolean);
  const n = rows.length;
  if (n < 5 || n > 60) return { valid: false, score: 0, reason: "between 5 and 60 points" };
  if (rows.some(r => r.length !== n || /[^01]/.test(r))) return { valid: false, score: 0, reason: `every line must be ${n} characters of 0 and 1` };
  const red = [], blue = [];
  for (let i = 0; i < n; i++) {
    if (rows[i][i] !== "0") return { valid: false, score: 0, reason: `the diagonal must be 0 (line ${i + 1})` };
    let r = 0n, b = 0n;
    for (let j = 0; j < n; j++) {
      if (rows[i][j] !== rows[j][i]) return { valid: false, score: 0, reason: `not symmetric at ${i + 1}, ${j + 1}` };
      if (i !== j) { if (rows[i][j] === "1") r |= 1n << BigInt(j); else b |= 1n << BigInt(j); }
    }
    red.push(r); blue.push(b);
  }
  // is there a set of `size` points all joined in this color, among `cand`?
  const clique = (adj, cand, size) => {
    if (size === 0) return true;
    for (let v = 0; v < n && cand; v++) {
      const bit = 1n << BigInt(v);
      if (!(cand & bit)) continue;
      cand &= ~bit;
      if (clique(adj, cand & adj[v], size - 1)) return true;
    }
    return false;
  };
  const all = (1n << BigInt(n)) - 1n;
  if (clique(red, all, 5)) return { valid: false, score: 0, reason: "5 points are all joined in red (1)" };
  if (clique(blue, all, 5)) return { valid: false, score: 0, reason: "5 points are all joined in blue (0)" };
  return { valid: true, score: n };
}
