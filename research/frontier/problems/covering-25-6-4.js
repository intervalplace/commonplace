// A covering design C(25,6,4): blocks of 6 numbers from 1 to 25 such that every set of 4 numbers
// from 1 to 25 lies inside at least one block. Solution: one block per line, 6 distinct numbers
// from 1 to 25. Score: how many blocks (smaller is better).
function verify(solution) {
  const V = 25, K = 6, blocks = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const b = l.split(/[\s,]+/).map(Number);
    if (b.length !== K || b.some(x => !Number.isInteger(x) || x < 1 || x > V) || new Set(b).size !== K) return { valid: false, score: 0, reason: `not 6 distinct numbers from 1 to 25: ${l.slice(0, 40)}` };
    blocks.push(b.sort((x, y) => x - y));
  }
  if (!blocks.length || blocks.length > 20000) return { valid: false, score: 0, reason: "between 1 and 20000 blocks" };
  const key = (a, b, c, d) => ((a * 32 + b) * 32 + c) * 32 + d;
  const covered = new Uint8Array(32 ** 4);
  for (const b of blocks) for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) for (let k = j + 1; k < K; k++) for (let m = k + 1; m < K; m++) covered[key(b[i], b[j], b[k], b[m])] = 1;
  for (let a = 1; a <= V; a++) for (let b = a + 1; b <= V; b++) for (let c = b + 1; c <= V; c++) for (let d = c + 1; d <= V; d++)
    if (!covered[key(a, b, c, d)]) return { valid: false, score: 0, reason: `${a} ${b} ${c} ${d} isn't in any block` };
  return { valid: true, score: blocks.length };
}
