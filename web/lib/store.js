// Decisions + audit log. Kept in localStorage so the hosted demo works with no backend;
// every entry is append-only and exportable as JSON. In production this module is the only
// thing that would change (POST /api/audit), the UI calls the same functions.

const KEY = 'fixdesk.v1';

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.audit && s.decisions) return s;
  } catch { /* storage blocked or corrupt: start clean */ }
  return { reviewer: '', decisions: {}, audit: [], replies: {} };
}

let state = read();
const listeners = new Set();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: keep in memory */ }
  listeners.forEach((fn) => fn(state));
}

export const store = {
  get: () => state,
  subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),

  reviewer: () => state.reviewer || 'Faculty',
  setReviewer(name) { state.reviewer = name.trim().slice(0, 40); save(); },

  decision: (caseId) => state.decisions[caseId] || null,
  reply: (reportId) => state.replies[reportId],

  /** Record a faculty action. Returns the audit entry (used for undo). */
  act(caseId, action, detail = {}) {
    const entry = {
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      by: this.reviewer(),
      caseId,
      action,
      ...detail,
    };
    entry.previous = state.decisions[caseId] || null;
    state.decisions[caseId] = { action, at: entry.at, by: entry.by, auditId: entry.id, edits: detail.edits, note: detail.note };
    state.audit.push(entry);
    for (const [rid, txt] of Object.entries(detail.replies || {})) state.replies[rid] = txt;
    save();
    return entry;
  },

  /** Undo is itself an audit entry: nothing is ever deleted from the log. */
  undo(entry) {
    if (entry.previous) state.decisions[entry.caseId] = entry.previous;
    else delete state.decisions[entry.caseId];
    state.audit.push({ id: `a_${Date.now().toString(36)}`, at: new Date().toISOString(), by: this.reviewer(), caseId: entry.caseId, action: 'undo', undoes: entry.id });
    save();
  },

  auditFor: (caseId) => state.audit.filter((a) => a.caseId === caseId),

  exportJson() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), reviewer: this.reviewer(), decisions: state.decisions, audit: state.audit }, null, 2);
  },

  reset() { state = { reviewer: state.reviewer, decisions: {}, audit: [], replies: {} }; save(); },
};
