// Cap set in dimension 8: vectors of length 8 over {0,1,2}, no three distinct ones on a line,
// that is, no distinct x, y, z with x + y + z = 0 (mod 3) in every coordinate.
// Solution: one vector per line, as 8 digits from 0 to 2. Score: how many vectors (larger is better).
function verify(solution) {
  const lines = solution.split(/\s+/).filter(Boolean);
  if (lines.length > 6561) return { valid: false, score: 0, reason: "more vectors than exist" };
  const set = new Set();
  for (const l of lines) {
    if (!/^[012]{8}$/.test(l)) return { valid: false, score: 0, reason: `not a vector of 8 digits 0-2: ${l.slice(0, 20)}` };
    if (set.has(l)) return { valid: false, score: 0, reason: `repeated: ${l}` };
    set.add(l);
  }
  const v = [...set].map(s => [...s].map(Number));
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) {
    let z = "";
    for (let k = 0; k < 8; k++) z += (6 - v[i][k] - v[j][k]) % 3;
    if (set.has(z)) return { valid: false, score: 0, reason: `${lines[i]}, ${lines[j]} and ${z} are on a line` };
  }
  return { valid: true, score: v.length };
}
