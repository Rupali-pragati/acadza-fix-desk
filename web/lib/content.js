// Content helpers shared by the console: sanitising production HTML, applying edits, diffing.
// Pure functions, no DOM state, so they are easy to test and reason about.

const ALLOWED = new Set([
  // html
  'b', 'i', 'em', 'strong', 'u', 'sup', 'sub', 'br', 'p', 'span', 'div', 'h3', 'h4', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'del', 'ins', 'small',
  // mathml core
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mfrac', 'msqrt', 'mroot', 'msup', 'msub',
  'msubsup', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom',
  'menclose', 'semantics', 'annotation', 'mmultiscripts', 'mprescripts', 'none',
]);
const ALLOWED_ATTR = new Set([
  'display', 'displaystyle', 'mathvariant', 'stretchy', 'fence', 'form', 'separator', 'lspace', 'rspace',
  'linethickness', 'accent', 'accentunder', 'width', 'height', 'depth', 'scriptlevel', 'columnalign',
  'rowspacing', 'columnspacing', 'notation', 'src', 'alt', 'class', 'colspan', 'rowspan', 'xmlns', 'data-diff',
]);

/** Parse untrusted production HTML and keep only content tags. Inline colours are dropped so dark mode works. */
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const walk = (node) => {
    for (const child of [...node.children]) {
      const tag = child.localName;
      if (!ALLOWED.has(tag)) {
        if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'].includes(tag)) child.remove();
        else child.replaceWith(...child.childNodes);
        continue;
      }
      for (const a of [...child.attributes]) {
        const name = a.name.toLowerCase();
        if (!ALLOWED_ATTR.has(name) || name.startsWith('on')) child.removeAttribute(a.name);
        else if (name === 'src' && !/^(https?:|data:image\/)/i.test(a.value)) child.removeAttribute(a.name);
        else if (name === 'class' && !/^(d-del|d-ins)$/.test(a.value)) child.removeAttribute(a.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

export function visibleText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  // block elements end a line too: '</h3><h3>(A)' must put (A) at the start of a line
  doc.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,li,tr').forEach((b) => b.append('\n'));
  return (doc.body.textContent || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The record body for a question, whatever its type key. */
export const bodyOf = (rec) => ({ question: rec.question, solution: rec.solution, answer: rec.answer });

/** Apply {field, find, replace} edits to a flat record ({questionType, question, solution, answer}). */
export function applyEdits(rec, edits) {
  const out = { ...rec };
  const errors = [];
  const ordered = [...(edits || [])].sort((a, b) => (a.field === 'questionType' ? -1 : 0) - (b.field === 'questionType' ? -1 : 0));
  for (const e of ordered) {
    if (e.field === 'questionType' || e.field === 'answer') {
      out[e.field] = e.replace;
    } else if (e.field === 'question' || e.field === 'solution') {
      const cur = out[e.field] || '';
      const n = cur.split(e.find).length - 1;
      if (n !== 1) { errors.push(`${e.field}: text to replace found ${n} times`); continue; }
      out[e.field] = cur.replace(e.find, () => e.replace ?? '');
    } else errors.push(`cannot edit ${e.field}`);
  }
  return { record: out, errors };
}

/** Wrap the edited span so the change is visible in context. */
export function markInContext(html, find, cls) {
  if (!find || !html || html.split(find).length !== 2) return html;
  return html.replace(find, () => `<span class="${cls}">${find}</span>`);
}

// ------------------------------------------------------------------ diff
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

/**
 * Word-level diff of two plain strings, refined to characters when a single word changed
 * (so "tisue -> tissue" highlights one letter). Returns [{op:'='|'-'|'+', text}].
 */
export function textDiff(before, after) {
  const tok = (s) => s.match(/\s+|[^\s]+/g) || [];
  const words = lcsDiff(tok(before), tok(after));
  const out = [];
  for (let k = 0; k < words.length; k++) {
    const [op, t] = words[k];
    const next = words[k + 1];
    if (op === '-' && next && next[0] === '+' && t.length < 40 && next[1].length < 40) {
      for (const [o, ch] of lcsDiff([...t], [...next[1]])) out.push({ op: o, text: ch });
      k++;
    } else out.push({ op, text: t });
  }
  // merge runs
  return out.reduce((acc, x) => {
    const last = acc[acc.length - 1];
    if (last && last.op === x.op) last.text += x.text; else acc.push({ ...x });
    return acc;
  }, []);
}

export function diffHtml(parts, side) {
  return parts.map((p) => {
    const t = escapeHtml(p.text);
    if (p.op === '=') return t;
    if (p.op === '-' && side !== 'after') return `<del class="d-del">${t}</del>`;
    if (p.op === '+' && side !== 'before') return `<ins class="d-ins">${t}</ins>`;
    return '';
  }).join('');
}

/** Split a question's visible text into stem + options, mirroring the engine's parser. */
export function splitOptions(text) {
  const re = /(?:^|\n)[ \t]*\(([A-D])\)[ \t]*/g;
  const marks = [...text.matchAll(re)];
  if (!marks.length) return { stem: text.trim(), options: {} };
  const options = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    options[m[1]] = text.slice(m.index + m[0].length, end).replace(/\s+/g, ' ').trim();
  });
  return { stem: text.slice(0, marks[0].index).trim(), options };
}

export function keyLetters(ans) {
  const parts = (Array.isArray(ans) ? ans : [ans]).flatMap((a) => String(a ?? '').split(/[,\s]+/)).filter(Boolean);
  return parts.every((p) => /^[A-D]$/i.test(p)) ? [...new Set(parts.map((p) => p.toUpperCase()))].sort() : null;
}

/** Model evidence sometimes arrives with inline LaTeX ($I = 4I_0\cos^2(\pi/4)$). Show it as readable plain text. */
const TEX = { pi: 'π', neq: '≠', ne: '≠', le: '≤', ge: '≥', times: '×', cdot: '·', phi: 'φ', theta: 'θ', lambda: 'λ', mu: 'μ',
  alpha: 'α', beta: 'β', gamma: 'γ', omega: 'ω', Delta: 'Δ', sqrt: '√', approx: '≈', to: '→', infty: '∞', circ: '°' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
export function plainMath(text) {
  return String(text ?? '').replace(/\$([^$]+)\$/g, (_, m) => m
    .replace(/\\(?:mathrm|text)\{([^}]*)\}/g, '$1')
    .replace(/\\([a-zA-Z]+)/g, (w, name) => TEX[name] ?? name)
    .replace(/\^\{?(-?\d+)\}?/g, (_, d) => [...d].map((c) => SUP[c] ?? c).join(''))
    .replace(/_\{?(\d+)\}?/g, (_, d) => [...d].map((c) => SUB[c] ?? c).join(''))
    .replace(/[{}]/g, ''));
}
