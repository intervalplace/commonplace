// The kissing number in 11 dimensions: as many points as possible on a sphere in 11 dimensions with
// every two at least 60 degrees apart (so equal spheres at them all touch a central one without
// overlapping). Solution: one point per line, 11 integers (scale rational coordinates up to integers).
// Valid if every point has the same nonzero squared length N and every two have inner product at
// most N/2. Checked exactly, with integers of any size. Score: how many points.
function verify(solution) {
  const D = 11, pts = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const xs = l.split(/[\s,]+/);
    if (xs.length !== D || xs.some(x => !/^-?[0-9]+$/.test(x))) return { valid: false, score: 0, reason: `not 11 integers: ${l.slice(0, 60)}` };
    pts.push(xs.map(BigInt));
  }
  if (!pts.length || pts.length > 2000) return { valid: false, score: 0, reason: "between 1 and 2000 points" };
  const dot = (a, b) => { let s = 0n; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };
  const N = dot(pts[0], pts[0]);
  if (N === 0n) return { valid: false, score: 0, reason: "the first point is zero" };
  for (let i = 0; i < pts.length; i++) if (dot(pts[i], pts[i]) !== N) return { valid: false, score: 0, reason: `point ${i + 1} isn't the same length as the first` };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
    if (2n * dot(pts[i], pts[j]) > N) return { valid: false, score: 0, reason: `points ${i + 1} and ${j + 1} are less than 60 degrees apart` };
  return { valid: true, score: pts.length };
}
