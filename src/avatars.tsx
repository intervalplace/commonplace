// Pictures. Everyone has one made from their key (free, the same everywhere, impossible to fake),
// and can instead pick one of the sixteen below, which costs one small entry: `cp:profile:<n>:<name>`.
// The pictures ship with the app, so a profile on chain is just a number and stays readable
// with nothing hosted anywhere.

import type { ReactNode } from "react";

type Pic = { name: string; bg: string; draw: ReactNode };
const C = "#FBF6EA"; // the light ink every picture draws with

export const PICTURES: Pic[] = [
  { name: "Moon", bg: "#2B3A67", draw: <path d="M24 9a12 12 0 1 0 7 21A10 10 0 1 1 24 9z" fill={C} /> },
  { name: "Sun", bg: "#D9902F", draw: <g fill={C}><circle cx="20" cy="20" r="7" />{[0, 45, 90, 135, 180, 225, 270, 315].map(a => <rect key={a} x="19" y="5" width="2" height="5" rx="1" transform={`rotate(${a} 20 20)`} />)}</g> },
  { name: "Wave", bg: "#2F7F86", draw: <g fill="none" stroke={C} strokeWidth="2.4" strokeLinecap="round"><path d="M7 17c3-3 6-3 9 0s6 3 9 0 6-3 8-1" /><path d="M7 25c3-3 6-3 9 0s6 3 9 0 6-3 8-1" /></g> },
  { name: "Mountain", bg: "#55606E", draw: <g><path d="M5 31 16 13l7 11 4-5 8 12z" fill={C} /><path d="M16 13l3.4 5.4-3.4-1.4-3.2 1.6z" fill="#55606E" opacity="0.35" /></g> },
  { name: "Leaf", bg: "#4E7F4A", draw: <g><path d="M10 30C10 16 19 9 31 9c0 13-7 21-21 21z" fill={C} /><path d="M11 29 25 15" stroke="#4E7F4A" strokeWidth="1.6" strokeLinecap="round" /></g> },
  { name: "Flower", bg: "#B85772", draw: <g fill={C}>{[0, 72, 144, 216, 288].map(a => <ellipse key={a} cx="20" cy="12.5" rx="4.2" ry="6" transform={`rotate(${a} 20 20)`} />)}<circle cx="20" cy="20" r="3.6" fill="#E9B44C" /></g> },
  { name: "Bird", bg: "#5E8FBF", draw: <path d="M7 21c4-4 8-4 11 0 3-6 8-8 15-7-5 1-8 4-10 9-3 3-8 3-11 0-2-2-3-2-5-2z" fill={C} /> },
  { name: "Fish", bg: "#C9672F", draw: <g><path d="M8 20c5-7 15-8 21 0-6 8-16 7-21 0z" fill={C} /><path d="M28 20l6-6v12z" fill={C} /><circle cx="14" cy="18.5" r="1.4" fill="#C9672F" /></g> },
  { name: "Star", bg: "#5B4A8B", draw: <path d="M20 7l3.8 8.2 8.9 1-6.6 6.1 1.8 8.8L20 26.8l-7.9 4.3 1.8-8.8-6.6-6.1 8.9-1z" fill={C} /> },
  { name: "Cloud", bg: "#7C8EA8", draw: <path d="M12 29a6 6 0 0 1-.5-12A8 8 0 0 1 27 15a6.5 6.5 0 0 1 1 14z" fill={C} /> },
  { name: "Tree", bg: "#3F6B4F", draw: <g fill={C}><circle cx="20" cy="16" r="9" /><rect x="18.5" y="22" width="3" height="11" rx="1.5" /></g> },
  { name: "Cat", bg: "#A87A33", draw: <g><path d="M10 31V15l5 4h10l5-4v16z" fill={C} /><circle cx="16" cy="24" r="1.5" fill="#A87A33" /><circle cx="24" cy="24" r="1.5" fill="#A87A33" /></g> },
  { name: "Book", bg: "#7E5240", draw: <g fill={C}><path d="M7 12c5-1 9 0 12 2v16c-3-2-7-3-12-2z" /><path d="M33 12c-5-1-9 0-12 2v16c3-2 7-3 12-2z" /></g> },
  { name: "Cup", bg: "#6B5246", draw: <g><path d="M10 15h17v8a7 7 0 0 1-7 7h-3a7 7 0 0 1-7-7z" fill={C} /><path d="M27 17h2.5a3.5 3.5 0 0 1 0 7H27" fill="none" stroke={C} strokeWidth="2.2" /><path d="M15 8c1 1.5-1 2.5 0 4M20 8c1 1.5-1 2.5 0 4" stroke={C} strokeWidth="1.6" strokeLinecap="round" fill="none" /></g> },
  { name: "Spiral", bg: "#94507A", draw: <path d="M20 20a2 2 0 0 1 4 0 4 4 0 0 1-8 0 6 6 0 0 1 12 0 8 8 0 0 1-16 0 10 10 0 0 1 20 0" fill="none" stroke={C} strokeWidth="2.2" strokeLinecap="round" /> },
  { name: "Planet", bg: "#3E5C8C", draw: <g><circle cx="20" cy="20" r="8" fill={C} /><ellipse cx="20" cy="20" rx="15" ry="4.5" fill="none" stroke={C} strokeWidth="2" transform="rotate(-20 20 20)" /></g> },
];

// The picture made from a key: a few stars and the lines between them, in a colour of its own
function generated(addr: string): { bg: string; draw: ReactNode } {
  const b = addr.replace(/^0x/, "").padEnd(40, "0");
  const n = (i: number) => parseInt(b.slice(i * 2, i * 2 + 2), 16);
  const hue = Math.round((n(0) * 256 + n(1)) / 65536 * 360);
  const ink = `hsl(${hue} 42% 30%)`;
  // one star per quarter of the tile, so they spread out, in an order from the key
  const quads = [[0, 0], [1, 0], [1, 1], [0, 1]].sort((a, c) => n(14 + a[0] + 2 * a[1]) - n(14 + c[0] + 2 * c[1]));
  const pts = quads.map(([qx, qy], k) => ({ x: 7 + qx * 14 + (n(2 + k * 2) / 255) * 12, y: 7 + qy * 14 + (n(3 + k * 2) / 255) * 12 }));
  const sizes = [0, 1, 2, 3].map(k => 1.8 + (n(10 + k) / 255) * 2.2);
  return {
    bg: `hsl(${hue} 38% 86%)`,
    draw: (
      <g>
        <path d={`M${pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L")}`} fill="none" stroke={ink} strokeWidth="1" opacity="0.55" />
        {pts.map((p, k) => <circle key={k} cx={p.x} cy={p.y} r={sizes[k]} fill={ink} />)}
      </g>
    ),
  };
}

export function Avatar({ addr, pic, size = 20, label }: { addr?: string; pic?: number; size?: number; label?: string }) {
  const p = pic && pic >= 1 && pic <= PICTURES.length ? PICTURES[pic - 1] : addr ? generated(addr) : { bg: "#E2DED4", draw: null };
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ flex: "none", borderRadius: size >= 40 ? 10 : 6, display: "block" }}>
      <rect width="40" height="40" fill={p.bg} />
      {p.draw}
    </svg>
  );
}
