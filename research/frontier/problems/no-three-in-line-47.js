// No three in line on a 47 x 47 grid: as many grid points as possible, no three on one straight
// line (in any direction). Solution: one point per line as "x y", integers 0 to 46. Score: how
// many points (larger is better). Each row holds at most 2, so 94 is the most possible.
function verify(solution) {
  const N = 47, pts = [], seen = new Set();
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)[\s,]+(\d+)$/.exec(l);
    if (!m) return { valid: false, score: 0, reason: `not "x y": ${l.slice(0, 20)}` };
    const x = +m[1], y = +m[2];
    if (x >= N || y >= N) return { valid: false, score: 0, reason: `off the grid: ${l}` };
    if (seen.has(x * N + y)) return { valid: false, score: 0, reason: `repeated: ${l}` };
    seen.add(x * N + y); pts.push([x, y]);
  }
  if (pts.length > 2 * N) return { valid: false, score: 0, reason: "more points than can fit" };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const [a, b, c] = [pts[i], pts[j], pts[k]];
    if ((b[0] - a[0]) * (c[1] - a[1]) === (b[1] - a[1]) * (c[0] - a[0])) return { valid: false, score: 0, reason: `${a} ${b} ${c} are on one line` };
  }
  return { valid: true, score: pts.length };
}
