// A small, safe Markdown reader for documents: headings, paragraphs, lists, quotes, code, and
// inline bold, italics, code and http(s) links. It builds React elements and never inserts
// HTML, so nothing in a document can run in the page.

import type { ReactNode } from "react";

function inline(s: string, k = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const key = `${k}-${m.index}`;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(m[2].slice(2, -2), k + 1)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(m[3].slice(1, -1), k + 1)}</em>);
    else if (m[4]) { const label = m[4].slice(1, m[4].indexOf("](")); out.push(<a key={key} href={m[5]} target="_blank" rel="noreferrer noopener nofollow">{label}</a>); }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith("```")) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++; blocks.push(<pre key={i}><code>{body.join("\n")}</code></pre>); continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { const n = Math.min(h[1].length + 1, 6); const H = `h${n}` as "h2"; blocks.push(<H key={i}>{inline(h[2])}</H>); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l), items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={i}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</L>); continue;
    }
    if (l.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={i}>{inline(q.join(" "))}</blockquote>); continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) p.push(lines[i++]);
    blocks.push(<p key={i}>{inline(p.join(" "))}</p>);
  }
  return <div className="cp-doc">{blocks}</div>;
}
