#!/usr/bin/env node
// Offline static SVG mind-map renderer (right-growing tidy tree).
// Usage: node render-mindmap.mjs outline.json out.svg
// outline.json: { title, central, branches:[{label, children:[{label, children?:[]}]}] }
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
const data = JSON.parse(readFileSync(inPath, 'utf8'));

const PALETTE = ["#D64045","#1D3557","#E9B44C","#2D6A4F","#7B2D8E","#E07A5F","#457B9D","#118AB2","#C44536","#3D5A80"];
const ROOT_FILL = "#0B132B", ROOT_TEXT = "#FFFFFF";
const FONT = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const MARGIN = 40, COL_GAP = 56, ROW = 54;

const FS = d => (d === 0 ? 18 : d === 1 ? 14 : 12.5);
const CHARW = d => FS(d) * 0.60;
const PADX = d => (d === 0 ? 22 : d === 1 ? 16 : 13);

function mix(hex, white = 0.80) { // lighten toward white
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = c => Math.round(c + (255 - c) * white);
  return "#" + [m(r), m(g), m(b)].map(c => c.toString(16).padStart(2, "0")).join("");
}
function darken(hex, k = 0.45) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = c => Math.round(c * (1 - k));
  return "#" + [m(r), m(g), m(b)].map(c => c.toString(16).padStart(2, "0")).join("");
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// greedy wrap into <=2 lines, ~maxchars per line
function wrap(label, d) {
  const max = d === 0 ? 22 : d === 1 ? 20 : 26;
  const words = String(label).split(/\s+/);
  const lines = []; let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= max) cur = (cur + " " + w).trim();
    else { if (cur) lines.push(cur); cur = w; }
    if (lines.length === 2) break;
  }
  if (cur && lines.length < 2) lines.push(cur);
  // if leftover words got dropped, append ellipsis
  return lines.slice(0, 2);
}

// build node tree
let id = 0;
function mk(label, children) { return { id: id++, label, children: (children || []).map(c => mk(c.label, c.children)) }; }
const root = mk(data.central || data.title || "Root", data.branches || []);

// layout: depth + y
let yCursor = 0;
function pillH(lines) { return lines.length === 2 ? 46 : 32; }
function measure(node, depth) {
  node.depth = depth;
  node.lines = wrap(node.label, depth);
  node.h = pillH(node.lines);
  node.w = Math.max(...node.lines.map(l => l.length)) * CHARW(depth) + PADX(depth) * 2;
  node.w = Math.max(node.w, depth === 0 ? 120 : 70);
  if (!node.children.length) { node.y = yCursor * ROW + ROW / 2; yCursor++; }
  else { node.children.forEach(c => measure(c, depth + 1)); node.y = (node.children[0].y + node.children[node.children.length - 1].y) / 2; }
}
measure(root, 0);

// column x by max width per depth
const maxDepth = 2;
const maxW = [];
function colMax(node) { maxW[node.depth] = Math.max(maxW[node.depth] || 0, node.w); node.children.forEach(colMax); }
colMax(root);
const colX = []; colX[0] = MARGIN;
for (let d = 1; d <= maxDepth; d++) colX[d] = colX[d - 1] + (maxW[d - 1] || 0) + COL_GAP;
function setX(node) { node.x = colX[node.depth]; node.children.forEach(setX); } // left edge of pill
setX(root);

const totalH = yCursor * ROW + MARGIN * 2 + 40;
const totalW = colX[maxDepth] + (maxW[maxDepth] || 0) + MARGIN;
const TITLE_H = 44;

// assign colors: each level-1 branch a palette color, descendants tint
function color(node, branchColor) {
  if (node.depth === 0) { node.fill = ROOT_FILL; node.text = ROOT_TEXT; node.stroke = "#0B132B"; }
  else if (node.depth === 1) { node.fill = branchColor; node.text = "#FFFFFF"; node.stroke = darken(branchColor, .18); }
  else { node.fill = mix(branchColor, .82); node.text = darken(branchColor, .55); node.stroke = mix(branchColor, .55); }
  node.children.forEach((c, i) => color(c, node.depth === 0 ? PALETTE[i % PALETTE.length] : branchColor));
}
color(root);

const OFFY = TITLE_H + 6;
function cx(n) { return n.x; }                 // left
function rx(n) { return n.x + n.w; }            // right edge
function cyOf(n) { return n.y + OFFY; }

// edges (parent right edge -> child left edge), cubic bezier
let edges = "";
function drawEdges(node) {
  for (const c of node.children) {
    const x1 = rx(node), y1 = cyOf(node), x2 = cx(c), y2 = cyOf(c);
    const mx = (x1 + x2) / 2;
    const col = c.depth === 1 ? node.fill === ROOT_FILL ? c.fill : c.fill : (c.stroke);
    const sw = c.depth === 1 ? 2.4 : 1.6;
    const op = c.depth === 1 ? 0.85 : 0.6;
    const strokeColor = c.depth === 1 ? c.fill : darken(PALETTE[0], 0); // override below
    edges += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${c.depth===1?c.fill:c.stroke}" stroke-width="${sw}" stroke-opacity="${op}" stroke-linecap="round"/>\n`;
    drawEdges(c);
  }
}
drawEdges(root);

let pills = "";
function drawNode(node) {
  const x = node.x, y = cyOf(node) - node.h / 2, w = node.w, h = node.h;
  const rxr = node.depth === 0 ? 14 : 9;
  pills += `<g>`;
  pills += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${rxr}" fill="${node.fill}" stroke="${node.stroke}" stroke-width="1"/>`;
  const fs = FS(node.depth), fw = node.depth === 0 ? 800 : node.depth === 1 ? 700 : 500;
  const tx = x + PADX(node.depth);
  if (node.lines.length === 2) {
    pills += `<text x="${tx.toFixed(1)}" y="${(cyOf(node)-4).toFixed(1)}" font-family="${FONT}" font-size="${fs}" font-weight="${fw}" fill="${node.text}">${esc(node.lines[0])}</text>`;
    pills += `<text x="${tx.toFixed(1)}" y="${(cyOf(node)+fs).toFixed(1)}" font-family="${FONT}" font-size="${fs}" font-weight="${fw}" fill="${node.text}">${esc(node.lines[1])}</text>`;
  } else {
    pills += `<text x="${tx.toFixed(1)}" y="${(cyOf(node)+fs*0.35).toFixed(1)}" font-family="${FONT}" font-size="${fs}" font-weight="${fw}" fill="${node.text}">${esc(node.lines[0])}</text>`;
  }
  pills += `</g>\n`;
  node.children.forEach(drawNode);
}
drawNode(root);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(totalW)}" height="${Math.ceil(totalH)}" viewBox="0 0 ${Math.ceil(totalW)} ${Math.ceil(totalH)}" font-family="${FONT}">
  <rect width="100%" height="100%" fill="#FBFBFD"/>
  <text x="${MARGIN}" y="30" font-family="${FONT}" font-size="22" font-weight="800" fill="#0B132B">${esc(data.title || data.central || "Mind Map")}</text>
  ${data.subtitle ? `<text x="${MARGIN}" y="${TITLE_H}" font-family="${FONT}" font-size="12.5" fill="#6B7280">${esc(data.subtitle)}</text>` : ""}
  <g>${edges}</g>
  <g>${pills}</g>
</svg>`;
writeFileSync(outPath, svg);
console.log("Wrote", outPath, `(${Math.ceil(totalW)}x${Math.ceil(totalH)})`);
