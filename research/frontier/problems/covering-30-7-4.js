// A covering design C(30,7,4): blocks of 7 numbers from 1 to 30 such that every
// set of 4 numbers from 1 to 30 lies inside at least one block. Solution: one block per line,
// 7 distinct numbers from 1 to 30. Score: how many blocks (smaller is better).
function verify(solution) {
  const V = 30, K = 7, T = 4, blocks = [];
  for (const l of solution.split("\n").map(s => s.trim()).filter(Boolean)) {
    const b = l.split(/[\s,]+/).map(Number);
    if (b.length !== K || b.some(x => !Number.isInteger(x) || x < 1 || x > V) || new Set(b).size !== K) return { valid: false, score: 0, reason: `not ${K} distinct numbers from 1 to ${V}: ${l.slice(0, 40)}` };
    blocks.push(b.sort((x, y) => x - y));
  }
  if (!blocks.length || blocks.length > 50000) return { valid: false, score: 0, reason: "between 1 and 50000 blocks" };
  // each set of T numbers by its rank in the combinatorial number system
  const C = []; for (let n = 0; n <= V; n++) { C.push([]); for (let k = 0; k <= T; k++) C[n].push(k === 0 ? 1 : n === 0 ? 0 : C[n - 1][k - 1] + C[n - 1][k]); }
  const rank = s => { let r = 0; for (let i = 0; i < T; i++) r += C[s[i] - 1][i + 1]; return r; };
  const covered = new Uint8Array(C[V][T]);
  const sub = new Array(T);
  const each = (b, from, depth, f) => { if (depth === T) return f(sub); for (let i = from; i < b.length; i++) { sub[depth] = b[i]; if (each(b, i + 1, depth + 1, f)) return true; } return false; };
  for (const b of blocks) each(b, 0, 0, s => { covered[rank(s)] = 1; return false; });
  const all = Array.from({ length: V }, (_, i) => i + 1);
  let missing = null;
  each(all, 0, 0, s => { if (!covered[rank(s)]) { missing = s.join(" "); return true; } return false; });
  if (missing) return { valid: false, score: 0, reason: `${missing} isn't in any block` };
  return { valid: true, score: blocks.length };
}
