// Heilbronn's problem for 20 points in the unit square: place them so the smallest triangle any
// three of them make is as large as possible. Solution: 20 lines "x y" with 0 <= x, y <= 1.
// Score: the smallest triangle's area (larger is better), to 12 decimal places.
function verify(solution) {
  const p = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const m = /^(-?[0-9.eE+-]+)[\s,]+(-?[0-9.eE+-]+)$/.exec(l);
    if (!m) return { valid: false, score: 0, reason: `not "x y": ${l.slice(0, 30)}` };
    const x = Number(m[1]), y = Number(m[2]);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { valid: false, score: 0, reason: `outside the square: ${l}` };
    p.push([x, y]);
  }
  if (p.length !== 20) return { valid: false, score: 0, reason: `needs exactly 20 points, got ${p.length}` };
  let a = Infinity;
  for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) for (let k = j + 1; k < 20; k++)
    a = Math.min(a, Math.abs((p[j][0] - p[i][0]) * (p[k][1] - p[i][1]) - (p[j][1] - p[i][1]) * (p[k][0] - p[i][0])) / 2);
  return { valid: true, score: Math.floor(a * 1e12) / 1e12 };
}
