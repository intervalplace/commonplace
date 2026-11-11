// Spread 24 points in the unit square as far apart as possible.
// Solution: 24 lines "x y" with 0 <= x, y <= 1. Score: the smallest distance between any two
// points (larger is better), to 9 decimal places.
function verify(solution) {
  const pts = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const m = /^(-?[0-9.eE+-]+)[\s,]+(-?[0-9.eE+-]+)$/.exec(l);
    if (!m) return { valid: false, score: 0, reason: `not "x y": ${l.slice(0, 30)}` };
    const x = Number(m[1]), y = Number(m[2]);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { valid: false, score: 0, reason: `outside the square: ${l}` };
    pts.push([x, y]);
  }
  if (pts.length !== 24) return { valid: false, score: 0, reason: `needs exactly 24 points, got ${pts.length}` };
  let d = Infinity;
  for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++) d = Math.min(d, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  return { valid: true, score: Math.floor(d * 1e9) / 1e9 };
}
