// A sorting network for 16 inputs with as few comparators as possible.
// Solution: one comparator per line as two wire numbers "i j" with 0 <= i < j <= 15; a comparator
// puts the smaller value on wire i. Valid if it sorts every input (checked on all 65536 inputs of
// 0s and 1s, which is enough). Score: how many comparators (smaller is better).
function verify(solution) {
  const cs = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s+(\d+)$/.exec(l);
    if (!m) return { valid: false, score: 0, reason: `not "i j": ${l.slice(0, 20)}` };
    const i = +m[1], j = +m[2];
    if (!(i >= 0 && i < j && j <= 15)) return { valid: false, score: 0, reason: `wires must be 0 <= i < j <= 15: ${l}` };
    cs.push([i, j]);
  }
  if (!cs.length || cs.length > 400) return { valid: false, score: 0, reason: "between 1 and 400 comparators" };
  for (let x = 0; x < 65536; x++) {
    let w = x;
    for (const [i, j] of cs) {
      const a = (w >> i) & 1, b = (w >> j) & 1;
      if (a > b) w ^= (1 << i) | (1 << j);
    }
    // sorted: all the 0s on low wires, then 1s; i.e. w is of the form 1...10...0 from wire 15 down
    if (((w + (1 << (16 - popcount(x)))) & 0xffff) !== 0 && popcount(x) !== 0) return { valid: false, score: 0, reason: `doesn't sort input ${x.toString(2).padStart(16, "0")}` };
  }
  return { valid: true, score: cs.length };
}
function popcount(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
