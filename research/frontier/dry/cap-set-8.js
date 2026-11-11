// idea: every vector with coordinates only 0 and 1
function solve(best) { const v = []; for (let i = 0; i < 256; i++) v.push(i.toString(2).padStart(8, "0")); return v.join("\n"); }
