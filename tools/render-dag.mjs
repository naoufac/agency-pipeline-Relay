#!/usr/bin/env node
// Layered DAG renderer: columns = dependency layers (stages/waves), arrows = "unblocks".
// Usage: node render-dag.mjs dag.json out.svg
import { readFileSync, writeFileSync } from 'node:fs';
const [, , inPath, outPath] = process.argv;
const g = JSON.parse(readFileSync(inPath, 'utf8'));
// g: { title, subtitle, deptColors:{dept:hex}, stageLabels:{stageNum:label}, nodes:[{id,title,dept,stage}], edges:[[from,to]], gates:[id] }

const COLW = 224, NODE_W = 176, NODE_H = 44, ROWH = 80, MARGIN = 44, HEADER = 116, LEGEND_H = 64;
const FONT = "Inter, system-ui, -apple-system, Segoe UI, sans-serif";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const darken = (hex, k = .35) => { const n = parseInt(hex.slice(1), 16); const f = c => Math.round(c * (1 - k)); return "#" + [f((n>>16)&255), f((n>>8)&255), f(n&255)].map(c=>c.toString(16).padStart(2,"0")).join(""); };

const nodes = g.nodes, byId = new Map(nodes.map(n => [n.id, n]));
const gates = new Set(g.gates || []);
const stages = [...new Set(nodes.map(n => n.stage))].sort((a, b) => a - b);
const stageIdx = new Map(stages.map((s, i) => [s, i]));
const cols = stages.map(s => nodes.filter(n => n.stage === s));
cols.forEach(col => col.forEach((n, i) => n.slot = i));

const nbr = new Map(nodes.map(n => [n.id, []]));
g.edges.forEach(([a, b]) => { nbr.get(a).push(b); nbr.get(b).push(a); });

function assignY() { cols.forEach(col => { const h = col.length; col.forEach((n, i) => n.y = (i - (h - 1) / 2) * ROWH); }); }
assignY();
// barycenter relaxation to reduce edge crossings
for (let it = 0; it < 16; it++) {
  const target = new Map();
  nodes.forEach(n => { const ys = nbr.get(n.id).map(id => byId.get(id).y); target.set(n.id, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : n.y); });
  cols.forEach(col => { col.sort((a, b) => (target.get(a.id) - target.get(b.id)) || (a.slot - b.slot)); col.forEach((n, i) => n.slot = i); });
  assignY();
}

const maxRows = Math.max(...cols.map(c => c.length));
const W = MARGIN * 2 + (stages.length - 1) * COLW + NODE_W;
const H = HEADER + MARGIN + maxRows * ROWH + LEGEND_H;
const midY = HEADER + (maxRows * ROWH) / 2;
nodes.forEach(n => { n.X = MARGIN + stageIdx.get(n.stage) * COLW; n.CY = midY + n.y; });
const Lx = n => n.X, Rx = n => n.X + NODE_W;

// edges
let edgeSvg = "";
for (const [a, b] of g.edges) {
  const s = byId.get(a), t = byId.get(b);
  const sx = Rx(s), sy = s.CY, ex = Lx(t) - 3, ey = t.CY;
  const mx = (sx + ex) / 2;
  const col = g.deptColors[s.dept] || "#888";
  const toGate = gates.has(b);
  edgeSvg += `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${mx.toFixed(1)} ${sy.toFixed(1)}, ${mx.toFixed(1)} ${ey.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${toGate?2.4:1.7}" stroke-opacity="0.5" stroke-linecap="round"/>`;
  edgeSvg += `<path d="M ${ex.toFixed(1)} ${ey.toFixed(1)} l -8 -4.5 l 0 9 z" fill="${col}" fill-opacity="0.85"/>`;
}

// stage headers + faint guides
let headSvg = "";
stages.forEach((s, i) => {
  const cx = MARGIN + i * COLW + NODE_W / 2;
  const label = (g.stageLabels && g.stageLabels[s]) || `Layer ${i}`;
  headSvg += `<line x1="${cx}" y1="${HEADER-12}" x2="${cx}" y2="${H-LEGEND_H-10}" stroke="#E5E7EB" stroke-width="1" stroke-dasharray="3 5"/>`;
  headSvg += `<text x="${cx}" y="${HEADER-42}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="800" fill="#6B7280" letter-spacing="0.5">LAYER ${i}</text>`;
  headSvg += `<text x="${cx}" y="${HEADER-24}" text-anchor="middle" font-family="${FONT}" font-size="12.5" font-weight="700" fill="#111827">${esc(label)}</text>`;
});

// nodes
let nodeSvg = "";
for (const n of nodes) {
  const fill = g.deptColors[n.dept] || "#888", x = n.X, y = n.CY - NODE_H / 2;
  const isGate = gates.has(n.id);
  nodeSvg += `<g>`;
  if (isGate) nodeSvg += `<rect x="${x-3}" y="${y-3}" width="${NODE_W+6}" height="${NODE_H+6}" rx="11" fill="none" stroke="${darken(fill,.25)}" stroke-width="2.5" stroke-dasharray="5 3"/>`;
  nodeSvg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="9" fill="${fill}" stroke="${darken(fill,.2)}" stroke-width="1"/>`;
  nodeSvg += `<text x="${x+NODE_W/2}" y="${n.CY+4.5}" text-anchor="middle" font-family="${FONT}" font-size="12.5" font-weight="700" fill="#fff">${esc(n.title)}</text>`;
  if (isGate) nodeSvg += `<text x="${x+NODE_W-6}" y="${y-7}" text-anchor="end" font-family="${FONT}" font-size="9.5" font-weight="800" fill="${darken(fill,.25)}">⛔ GATE</text>`;
  nodeSvg += `</g>`;
}

// legend
const depts = [...new Set(nodes.map(n => n.dept))];
let legSvg = "";
const ly = H - LEGEND_H + 22; let lx = MARGIN;
legSvg += `<text x="${MARGIN}" y="${ly-16}" font-family="${FONT}" font-size="11" font-weight="700" fill="#6B7280">DEPARTMENTS</text>`;
depts.forEach(d => {
  const c = g.deptColors[d] || "#888"; const label = d;
  legSvg += `<rect x="${lx}" y="${ly-9}" width="12" height="12" rx="3" fill="${c}"/>`;
  legSvg += `<text x="${lx+17}" y="${ly+1}" font-family="${FONT}" font-size="11.5" fill="#374151">${esc(label)}</text>`;
  lx += 22 + label.length * 7 + 16;
  if (lx > W - 120) { lx = MARGIN; }
});

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}" font-family="${FONT}">
  <rect width="100%" height="100%" fill="#FBFBFD"/>
  <text x="${MARGIN}" y="30" font-family="${FONT}" font-size="21" font-weight="800" fill="#0B132B">${esc(g.title)}</text>
  ${g.subtitle ? `<text x="${MARGIN}" y="49" font-family="${FONT}" font-size="12" fill="#6B7280">${esc(g.subtitle)}</text>` : ""}
  <g>${headSvg}</g>
  <g>${edgeSvg}</g>
  <g>${nodeSvg}</g>
  <g>${legSvg}</g>
</svg>`;
writeFileSync(outPath, svg);
console.log("Wrote", outPath, `(${Math.ceil(W)}x${Math.ceil(H)})`);
