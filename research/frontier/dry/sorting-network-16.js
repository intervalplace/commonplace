// idea: odd-even transposition sort, 16 rounds of neighbouring comparators
function solve(best) { const c = []; for (let r = 0; r < 16; r++) for (let i = r % 2; i + 1 < 16; i += 2) c.push(`${i} ${i + 1}`); return c.join("\n"); }
// ---
// idea: Batcher's odd-even merge sort
function solve(best) { const c = [], n = 16; for (let p = 1; p < n; p *= 2) for (let k = p; k >= 1; k = Math.floor(k / 2)) for (let j = k % p; j <= n - 1 - k; j += 2 * k) for (let i = 0; i <= Math.min(k - 1, n - j - k - 1); i++) if (Math.floor((i + j) / (p * 2)) === Math.floor((i + j + k) / (p * 2))) c.push(`${i + j} ${i + j + k}`); return c.join("\n"); }
