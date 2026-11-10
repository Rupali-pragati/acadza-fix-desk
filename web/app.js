import { sanitize, visibleText, escapeHtml as esc, applyEdits, markInContext, textDiff, diffHtml, splitOptions, keyLetters, plainMath } from './lib/content.js?v=5';
import { store } from './lib/store.js?v=5';

// ------------------------------------------------------------------ vocabulary
const REPAIR_TITLE = {
  answer_key: 'Answer key is wrong', type_mismatch: 'Stored as the wrong question type', unsound: 'No valid answer as written',
  stem_data: 'A value is missing from the question', option_repair: 'An option is missing or blank', identical_options: 'Two options are identical',
  diagram: 'The figure is missing', wrong_question: "Question and solution don't belong together", solution_fix: 'The solution is wrong',
  solution_missing: 'Solution missing or unusable', notation: 'A symbol or exponent got lost', spelling: 'Spelling mistake',
  noise: 'Stray text in the question', exam_reference: 'Exam tag left inside the question', markup_leak: 'Raw code is showing to students',
  answer_form: "Answer unit isn't stated", wrong_chapter: 'Filed under the wrong chapter', syllabus: 'Out-of-syllabus claim',
};
const VERDICT_TITLE = {
  no_error: 'Question is correct: student mis-solved', display_issue: 'Display problem, content is fine', app_issue: 'App problem, not this question',
  language_mode: 'Asked for another language', already_fixed: 'Already fixed before the AI looked', not_actionable: 'Nothing to act on',
};
const TYPE_LABEL = { scq: 'Single correct', mcq: 'Multiple correct', integerQuestion: 'Numerical' };
const TIER_COLOR = { 1: 'var(--bad)', 2: 'var(--warn)', 3: 'var(--warn)', 4: 'var(--accent)', 5: 'var(--idle)', 9: 'var(--border-strong)' };
const FIELD_LABEL = { question: 'Question text', solution: 'Solution', answer: 'Answer key', questionType: 'Question type', chapter: 'Chapter', subject: 'Subject', image: 'Figure' };
const TABS = [
  { id: 'review', label: 'Needs you', hint: 'Only a human can decide these. Worst harm to students first.' },
  { id: 'auto', label: 'Auto-fixed', hint: 'Already applied because every safety check passed. Spot-check, revert in one click.' },
  { id: 'closed', label: 'No change', hint: 'The question is fine. Confirm the reply the student gets.' },
  { id: 'done', label: 'Done', hint: 'Everything you acted on tonight. Click any case to change your mind.' },
  { id: 'unreported', label: 'Nobody reported', hint: 'Defects the engine found on its own, in questions no student flagged.' },
];
// Each guard as a sentence a faculty member can check at a glance: [when it passed, when it failed].
const CHECK_TEXT = {
  scope: (i) => [`Only the ${fieldsOf(i)} changes`, 'Touches a field this kind of fix may not change'],
  taxonomy_allows_auto: () => ['This kind of fix is allowed to apply automatically', 'This kind of fix always needs a faculty decision'],
  has_edit: () => ['A concrete edit is proposed', 'No concrete edit was proposed'],
  applies_cleanly: () => ['The edit matches the stored text exactly once', "The edit doesn't match the stored text"],
  confidence: (i) => [`Confidence ${pct(i.confidence)} clears the 85% bar`, `Confidence ${pct(i.confidence)} is below the 85% bar for auto-fix`],
  key_format_valid: () => ['The new key is in the right format', "The new key isn't in a valid format"],
  two_independent_solves: (i, c) => [`Two independent solves both give ${solveAns(c.solves.primary, c.questionType)}`, "The independent solves don't both support the new key"],
  stored_solution_consistent: () => ['The stored solution ends at the same answer', 'The stored solution points to a different answer'],
  solver_supports_key: (i, c) => [`An independent solve also gets ${solveAns(c.solves.primary, c.questionType)}`, 'The independent solve disagrees with this key'],
  format_only_change: () => ['Same correct answer; only the way it is stored is fixed', 'This changes which answer is correct'],
  surgical: () => ['The change is small and targeted', 'The change is too large to apply without review'],
  stem_unchanged: () => ['The question text itself is untouched', 'The question text would change'],
  options_complete: () => ['All four options are present after the fix', 'Options would still be incomplete'],
  new_distractor_is_wrong: () => ['The new option is a wrong answer, so there is still exactly one correct option', 'The new option could also be correct'],
  restored_key_matches_solve: () => ['The restored option matches the independent solve', "The restored option doesn't match the independent solve"],
  additive_only: () => ['Only adds the missing value; nothing is removed or reworded', 'Removes or rewords existing text'],
  value_from_solution: () => ['The added value comes from the stored solution', "The added value isn't in the stored solution"],
  solution_ends_in_key: () => ['The new solution ends at the keyed answer', "The new solution doesn't reach the keyed answer"],
  words_only: () => ['Only letters change: no numbers, symbols or maths', 'A number, symbol or formula would change'],
  targets_leak: () => ['The edit targets the code students can see', "The edit doesn't target the visible code"],
  leak_gone: () => ['No raw code is left after the fix', 'Raw code would still show after the fix'],
  values_preserved: () => ['Every number stays exactly the same', 'A number would change'],
  deletion_only: () => ['Only removes text, adds nothing', 'Adds text as well as removing it'],
  removes_exam_tag: () => ['What is removed is only the exam tag', 'Removes more than the exam tag'],
  injection_isolated: () => ["The report's instructions were ignored; the fix rests on independent solving", 'The report tried to instruct the system, so the key change is blocked'],
};
const fieldsOf = (i) => [...new Set((i.edits || []).map((e) => (FIELD_LABEL[e.field] || e.field).toLowerCase()))].join(' and ') || 'allowed fields';
const solveAns = (s, qtype) => (!s || s.answer == null ? 'the same answer' : qtype === 'integerQuestion' ? String(s.answer) : `(${[].concat(s.answer).join(', ')})`);
const REJECT_REASONS =['The AI is wrong: the question is fine', 'Right problem, wrong fix', 'Needs a different repair', 'Student is wrong', 'Other'];

let DATA = null;
const ui = { tab: 'review', selected: null, query: '', panel: null, side: 'after', qtab: 'question', toast: null };

// ------------------------------------------------------------------ case helpers
const mainIssue = (c) => c.issues.find((i) => i.verdict === 'defect') || c.issues[0];
const route = (c) => c.priority.route;
const decision = (id) => store.decision(id);
const flatRecord = (c) => ({ questionType: c.record.questionType, question: c.record.question, solution: c.record.solution, answer: c.record.answer });

function tabOf(c) {
  if (decision(c.questionId)) return 'done';
  return { faculty_review: 'review', auto_apply: 'auto', no_change: 'closed' }[route(c)];
}
function titleOf(c) {
  const i = mainIssue(c);
  if (i.verdict === 'defect') {
    if (i.repair === 'answer_key' && i.guards?.some((g) => g.name === 'format_only_change')) return 'Answer key is stored in a broken format';
    return REPAIR_TITLE[i.repair] || i.repair;
  }
  return VERDICT_TITLE[i.verdict] || i.verdict;
}
const stemText = (html) => splitOptions(visibleText(html)).stem;
const optionsOf = (html) => splitOptions(visibleText(html)).options;
function keyText(rec) {
  if (rec.questionType === 'integerQuestion') return esc(rec.answer);
  const letters = keyLetters(rec.answer);
  if (!letters) return `<code>${esc(JSON.stringify(rec.answer))}</code> <span class="chip bad">malformed</span>`;
  const opts = optionsOf(rec.question);
  return letters.map((L) => `(${L}) ${esc(opts[L] || '[blank]')}`).join(', ');
}
function ago(iso) {
  const ref = DATA?.meta?.now ? new Date(DATA.meta.now) : new Date();
  const d = Math.round((ref - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
function meter(x) {
  const c = x >= 0.85 ? 'var(--ok)' : x >= 0.6 ? 'var(--warn)' : 'var(--bad)';
  return `<span class="meter" title="AI confidence"><i style="--v:${pct(x)};--c:${c}"></i>${pct(x)}</span>`;
}

// ------------------------------------------------------------------ queue
function visibleCases(tab) {
  const q = ui.query.trim().toLowerCase();
  let list = DATA.cases.filter((c) => tabOf(c) === tab);
  if (q) list = DATA.cases.filter((c) => [c.questionId, c.subject, c.chapter, titleOf(c), stemText(c.record.question), ...c.reports.map((r) => r.comment + ' ' + r.reportId)]
    .join(' ').toLowerCase().includes(q));
  if (tab === 'auto') list.sort((a, b) => a.priority.tier - b.priority.tier || b.priority.score - a.priority.score);
  else if (tab === 'done') list.sort((a, b) => (decision(b.questionId)?.at || '').localeCompare(decision(a.questionId)?.at || ''));
  else list.sort((a, b) => b.priority.score - a.priority.score);
  return list;
}

function unreportedGroups() {
  const by = {};
  for (const f of DATA.findings.filter((f) => !f.reported && f.find != null && f.repair)) (by[f.questionId] ||= []).push(f);
  return Object.entries(by).map(([qid, fs]) => ({ qid, fs, rec: DATA.records?.[qid] }));
}

function renderTabs() {
  const counts = {};
  for (const t of TABS) counts[t.id] = t.id === 'unreported' ? unreportedGroups().length : DATA.cases.filter((c) => tabOf(c) === t.id).length;
  document.getElementById('tabs').innerHTML = TABS.map((t) => `
    <button class="tab" role="tab" aria-selected="${ui.tab === t.id}" data-tab="${t.id}">${t.label}
      <span class="count ${t.id === 'review' && counts[t.id] ? 'hot' : ''}">${counts[t.id]}</span></button>`).join('');
  document.getElementById('queue-hint').textContent = ui.query ? `Search results for “${ui.query}” across all tabs` : TABS.find((t) => t.id === ui.tab).hint;
  const done = DATA.cases.filter((c) => decision(c.questionId)).length;
  document.getElementById('progress').innerHTML = `<div class="progress-bar"><i style="width:${(done / DATA.cases.length) * 100}%"></i></div><span>${done} of ${DATA.cases.length} cases reviewed</span>`;
}

function renderList() {
  const el = document.getElementById('list');
  if (ui.tab === 'unreported' && !ui.query) {
    const groups = unreportedGroups();
    el.innerHTML = groups.length ? groups.map(({ qid, fs, rec }) => `
      <button class="item ${decision('F:' + qid) ? 'done' : ''}" style="--tier:var(--accent)" data-id="F:${qid}" aria-current="${ui.selected === 'F:' + qid}">
        <span class="row1"><span class="t">${esc(fs.length === 1 ? (REPAIR_TITLE[fs[0].repair] || fs[0].repair) : `${fs.length} issues found`)}</span>${decision('F:' + qid) ? '<span class="chip accent">done</span>' : ''}</span>
        <span class="meta">${esc(rec ? `${rec.subject} · ${rec.chapter}` : qid)}</span>
        <span class="snip">${esc(rec ? stemText(rec.question) : '')}</span>
      </button>`).join('') : '<div class="empty"><b>Nothing found</b>The audit found no unreported defects.</div>';
    return;
  }
  const list = visibleCases(ui.tab);
  if (!list.length) {
    el.innerHTML = ui.tab === 'review'
      ? '<div class="empty"><b>All clear for tonight</b>Nothing is waiting on you. Auto-fixes are in the next tab if you want to spot-check.</div>'
      : '<div class="empty"><b>Nothing here</b></div>';
    return;
  }
  el.innerHTML = list.map((c) => {
    const i = mainIssue(c), d = decision(c.questionId);
    const status = d ? `<span class="chip accent">${esc(d.action)}</span>` : i.verdict === 'defect' ? meterChip(i.confidence) : '';
    return `<button class="item ${d ? 'done' : ''}" style="--tier:${TIER_COLOR[c.priority.tier]}" data-id="${c.questionId}" aria-current="${ui.selected === c.questionId}">
      <span class="row1"><span class="t">${esc(titleOf(c))}</span>${status}</span>
      ${c.priority.tier === 1 && i.verdict === 'defect' ? `<span class="harm">${esc(c.priority.tierLabel)}</span>` : ''}
      <span class="meta">${esc(c.subject)} · ${esc(c.chapter)} · ${c.reports.length} report${c.reports.length > 1 ? 's' : ''} · ${ago(c.priority.oldest)}</span>
      <span class="snip">${esc(stemText(c.record.question))}</span>
    </button>`;
  }).join('');
}
const meterChip = (x) => `<span class="chip ${x >= 0.85 ? 'ok' : x >= 0.6 ? 'warn' : 'bad'}">${pct(x)}</span>`;

// ------------------------------------------------------------------ detail: the change
function renderEdit(e, before, after) {
  const label = `<div class="change-label">${esc(FIELD_LABEL[e.field] || e.field)}</div>`;
  if (e.field === 'answer') {
    return `<div class="change">${label}<div class="swap keyswap">
      <div class="side before"><small>Key now</small><span class="content">${keyText(before)}</span></div><div class="arrow">→</div>
      <div class="side after"><small>Key after</small><span class="content">${keyText(after)}</span></div></div></div>`;
  }
  if (e.field === 'questionType') {
    return `<div class="change">${label}<div class="swap keyswap">
      <div class="side before"><small>Now</small>${esc(TYPE_LABEL[e.find] || e.find)}</div><div class="arrow">→</div>
      <div class="side after"><small>After</small>${esc(TYPE_LABEL[e.replace] || e.replace)}</div></div></div>`;
  }
  const plain = !/[<&]/.test(e.find + e.replace);
  const long = (e.replace || '').length > 400;
  let frag;
  if (plain) frag = `<div class="inline-diff">${diffHtml(textDiff(e.find, e.replace))}</div>`;
  else if (!long) frag = `<div class="swap"><div class="side before"><small>Remove</small><div class="content">${sanitize(e.find) || '<i>(nothing)</i>'}</div></div><div class="arrow">→</div><div class="side after"><small>Insert</small><div class="content">${sanitize(e.replace) || '<i>(nothing - text removed)</i>'}</div></div></div>`;
  else frag = '';
  const ctx = `<div class="ctx"><div><small>Before</small><div class="content">${sanitize(markInContext(before[e.field], e.find, 'd-del'))}</div></div>
    <div><small>After</small><div class="content">${sanitize(markInContext(after[e.field], e.replace, 'd-ins'))}</div></div></div>`;
  return `<div class="change">${label}${frag}${ctx}</div>`;
}

function renderSuggestion(s) {
  if (!s) return '';
  const proposed = String(s.proposed ?? '');
  const body = /<\w/.test(proposed) ? sanitize(proposed) : esc(proposed);
  return `<div class="suggest"><div class="change-label">Suggested ${esc(FIELD_LABEL[s.field] || s.field || '')} · not applied, needs you</div>
    <div class="content">${body}</div>${s.note ? `<small style="color:var(--muted)">${esc(s.note)}</small>` : ''}</div>`;
}

function effectiveEdits(c, i) {
  const d = decision(c.questionId);
  return d?.action === 'edited' && d.edits ? d.edits : i.edits || [];
}

function renderChangeCard(c) {
  const blocks = c.issues.filter((i) => i.verdict === 'defect').map((i) => {
    const edits = effectiveEdits(c, i);
    const before = flatRecord(c);
    const after = edits.length ? applyEdits(before, edits).record : null;
    const parts = edits.map((e) => renderEdit(e, before, after)).join('');
    return parts + renderSuggestion(i.suggestion) || '<p style="margin:0;color:var(--muted)">No edit proposed.</p>';
  });
  if (!blocks.length) return '';
  const d = decision(c.questionId);
  return `<section class="card"><header><h2>Proposed change</h2>${d?.action === 'edited' ? '<span class="chip accent">edited by you</span>' : ''}</header><div class="body">${blocks.join('')}</div></section>`;
}

// ------------------------------------------------------------------ detail: why
function solveBox(name, s, qtype) {
  if (!s) return '';
  const ans = s.answer == null ? '—' : Array.isArray(s.answer) ? s.answer.join(', ') : s.answer;
  return `<div class="solve"><div style="color:var(--muted);font-size:12px;font-weight:600">${name}</div>
    <div class="ans">${esc(qtype === 'integerQuestion' ? ans : `(${ans})`)} <span style="font-weight:500;color:var(--muted);font-size:13px">${String(s.final_value ?? '').trim() === String(ans) ? '' : esc(plainMath(s.final_value || ''))}</span></div>
    ${s.answerable === false ? `<div class="chip warn" style="margin-top:4px">says not answerable: ${esc(s.problem || '')}</div>` : ''}
    <details><summary>Working</summary><pre>${esc(plainMath(s.working || ''))}${s.problem_detail ? '\n\n' + esc(plainMath(s.problem_detail)) : ''}</pre></details></div>`;
}

function renderWhyCard(c) {
  const i = mainIssue(c);
  const guards = (i.guards || []).filter((g) => !['taxonomy', 'no_edit_for_non_defect', 'repair_chosen'].includes(g.name))
    .sort((a, b) => a.ok - b.ok);
  const line = (g) => {
    const t = CHECK_TEXT[g.name]?.(i, c);
    if (!t) return `<b>${esc(g.name.replace(/_/g, ' '))}</b>`;
    // a failed check keeps the engine's detail, minus Python list syntax, so the reviewer sees exactly why
    return g.ok ? `<b>${esc(t[0])}</b>` : `<b>${esc(t[1])}</b><small>${esc(String(g.detail).replace(/[[\]']/g, ''))}</small>`;
  };
  const checks = guards.length ? `<ul class="checks">${guards.map((g) => `<li class="${g.ok ? 'y' : 'n'}"><span class="ic">${g.ok ? '✓' : '✕'}</span><div>${line(g)}</div></li>`).join('')}</ul>` : '';
  return `<section class="card"><header><h2>Evidence</h2>${meter(i.confidence)}</header><div class="body">
    <p class="evidence">${esc(plainMath(i.evidence))}</p>
    ${checks ? `<div class="change-label" style="margin-bottom:6px">Checked before anything is written</div>${checks}` : ''}
    <div class="solves">${solveBox("Independent solve · didn't see the key, solution or complaint", c.solves.primary, c.questionType)}${solveBox('Second independent solve', c.solves.check, c.questionType)}</div>
  </div></section>`;
}

// ------------------------------------------------------------------ detail: question
function renderQuestionCard(c) {
  const i = mainIssue(c);
  const edits = c.issues.flatMap((x) => (x.verdict === 'defect' ? effectiveEdits(c, x) : []));
  const before = flatRecord(c);
  const after = edits.length ? applyEdits(before, edits).record : null;
  const side = after && ui.side === 'after' ? 'after' : 'before';
  const rec = side === 'after' ? after : before;
  const html = ui.qtab === 'solution' ? rec.solution : rec.question;
  const imgs = ui.qtab === 'question' ? c.record.quesImages : c.record.solutionImages;
  return `<section class="card"><header><h2>As students see it</h2>
      <div class="seg" role="group" aria-label="Field"><button data-qtab="question" aria-pressed="${ui.qtab === 'question'}">Question</button><button data-qtab="solution" aria-pressed="${ui.qtab === 'solution'}">Solution</button></div>
      ${after ? `<div class="seg" role="group" aria-label="Version"><button data-side="before" aria-pressed="${side === 'before'}">Now</button><button data-side="after" aria-pressed="${side === 'after'}">After fix</button></div>` : ''}
    </header><div class="body">
      <div class="content">${sanitize(html) || '<i>(empty)</i>'}</div>
      ${(imgs || []).map((src) => `<img src="${esc(src)}" alt="figure" style="max-width:100%">`).join('')}
      <div class="keyrow"><span class="change-label">${esc(TYPE_LABEL[rec.questionType])} · Answer key</span><span class="k">${keyText(rec)}</span></div>
    </div></section>`;
}

// ------------------------------------------------------------------ detail: students
function renderStudents(c, editing) {
  return `<section class="card"><header><h2>Students (${c.reports.length})</h2></header><div class="body" style="padding-top:2px;padding-bottom:2px">
    ${c.reports.map((r) => {
      const flags = (r.flags || []).map((f) => ({
        injection_suspect: '<span class="chip bad">tried to instruct the system - ignored</span>',
        gibberish_comment: '<span class="chip idle">no information</span>',
        fixed_after_report: '<span class="chip accent">fixed after this report</span>',
      }[f] || '')).join('');
      const right = r.claim?.student_is_right;
      const rightChip = right === 'yes' ? '<span class="chip ok">student is right</span>' : right === 'partly' ? '<span class="chip warn">partly right</span>' : right === 'no' ? '<span class="chip idle">student is mistaken</span>' : '';
      const reply = store.reply(r.reportId) ?? r.reply;
      return `<div class="report"><div class="who"><b>${esc(r.reportId)}</b><span>${esc(r.source)}</span><span>${when(r.reportedAt)}</span>${rightChip}${flags}</div>
        <div class="quote">“${esc(r.comment)}”</div>
        <div class="reply"><span class="avatar">A</span>${editing
          ? `<textarea data-reply="${esc(r.reportId)}" aria-label="Reply to ${esc(r.reportId)}">${esc(reply)}</textarea>`
          : `<div class="bubble"><small>Reply the student will get</small>${esc(reply)}</div>`}</div></div>`;
    }).join('')}</div></section>`;
}

function renderAudit(id) {
  const entries = store.auditFor(id);
  if (!entries.length) return '';
  return `<section class="card"><header><h2>Audit trail</h2></header><div class="body"><ul class="timeline">
    ${entries.map((a) => `<li><span>${when(a.at)}</span><span><b>${esc(a.by)}</b> ${esc(a.action)}${a.reason ? ` · ${esc(a.reason)}` : ''}${a.note ? ` · “${esc(a.note)}”` : ''}</span></li>`).join('')}
  </ul></div></section>`;
}

// ------------------------------------------------------------------ detail: panels
function renderPanel(c) {
  if (ui.panel === 'reject') {
    const r = route(c);
    const title = r === 'auto_apply' ? 'Revert this auto-fix?' : r === 'no_change' ? 'Reopen this case?' : 'Reject the proposed fix?';
    return `<div class="panel" id="panel"><h3>${title}</h3><label>Why (one tap is enough)</label>
      <div class="reasons">${REJECT_REASONS.map((x) => `<button type="button" data-reason="${esc(x)}" aria-pressed="${ui.reason === x}">${esc(x)}</button>`).join('')}</div>
      <label for="note">Note for the record (optional)</label><input type="text" id="note" placeholder="e.g. the source paper has 5 m/s as option D">
      <div class="row"><button class="btn danger" data-act="confirm-reject">${r === 'auto_apply' ? 'Revert' : r === 'no_change' ? 'Reopen' : 'Reject'} <kbd>⏎</kbd></button><button class="btn" data-act="close">Cancel <kbd>Esc</kbd></button></div></div>`;
  }
  if (ui.panel === 'edit') {
    const i = mainIssue(c);
    const edits = effectiveEdits(c, i);
    const fields = edits.map((e, n) => {
      if (e.field === 'answer') {
        const t = (applyEdits(flatRecord(c), edits.filter((x) => x.field === 'questionType')).record.questionType);
        if (t === 'integerQuestion') return `<label>New answer key</label><input type="text" data-edit="${n}" value="${esc(e.replace)}">`;
        const cur = keyLetters(e.replace) || [];
        return `<label>New answer key ${t === 'mcq' ? '(tap all correct)' : ''}</label><div class="letters" data-letters="${n}" data-multi="${t === 'mcq'}">${'ABCD'.split('').map((L) => `<button type="button" data-letter="${L}" aria-pressed="${cur.includes(L)}">${L}</button>`).join('')}</div>`;
      }
      if (e.field === 'questionType') return `<label>Question type</label><input type="text" data-edit="${n}" value="${esc(e.replace)}">`;
      return `<label>${esc(FIELD_LABEL[e.field])}: replacement HTML for the marked span</label><textarea class="code" data-edit="${n}">${esc(e.replace)}</textarea><div class="preview content" data-preview="${n}">${sanitize(e.replace)}</div>`;
    }).join('');
    const sug = i.suggestion && !edits.length ? `<label>Your fix (${esc(FIELD_LABEL[i.suggestion.field] || i.suggestion.field)})</label><textarea class="code" data-suggest>${esc(i.suggestion.proposed)}</textarea>` : '';
    return `<div class="panel" id="panel"><h3>Edit before applying</h3>${fields}${sug}
      <p style="color:var(--muted);font-size:13px;margin:10px 0 0">You can also rewrite the student replies below.</p>
      <label for="note">Note for the record (optional)</label><input type="text" id="note">
      <div class="row"><button class="btn primary" data-act="save-edit">Save &amp; apply <kbd>⌘⏎</kbd></button><button class="btn" data-act="close">Cancel <kbd>Esc</kbd></button></div></div>`;
  }
  return '';
}

function banner(c) {
  const d = decision(c.questionId);
  const i = mainIssue(c);
  if (d) return `<div class="banner done"><div><b>${esc(d.action[0].toUpperCase() + d.action.slice(1))} by ${esc(d.by)} · ${when(d.at)}</b><span>${d.note ? '“' + esc(d.note) + '”' : 'Recorded in the audit log.'}</span></div></div>`;
  const r = route(c);
  if (r === 'auto_apply') return `<div class="banner ok"><div><b>Already applied automatically</b><span>Every safety check passed, so students see the fixed version now. Keep it, or revert in one click.</span></div></div>`;
  if (r === 'faculty_review') return `<div class="banner warn"><div><b>Waiting for you</b><span>${esc(i.routeReason || '')}</span></div></div>`;
  return `<div class="banner idle"><div><b>No change to the question</b><span>${esc(i.routeReason || '')} Confirm the reply below.</span></div></div>`;
}

function actionBar(c) {
  const d = decision(c.questionId);
  const r = route(c);
  const [ok, no] = r === 'auto_apply' ? ['Keep fix', 'Revert'] : r === 'no_change' ? ['Confirm & send replies', 'Reopen'] : mainIssue(c).verdict === 'defect' ? ['Approve & apply', 'Reject'] : ['Approve', 'Reject'];
  return `<div class="actions">
    <button class="btn primary" data-act="approve">${d ? 'Approve again' : ok} <kbd>A</kbd></button>
    <button class="btn" data-act="edit">Edit <kbd>E</kbd></button>
    <button class="btn danger" data-act="reject">${no} <kbd>R</kbd></button>
    <span class="hint"><kbd>J</kbd> <kbd>K</kbd> next / previous · <kbd>?</kbd> all shortcuts</span></div>`;
}

function renderCase(c) {
  const i = mainIssue(c);
  return `<div class="detail-inner">
    <button class="btn back" data-act="back">← Queue</button>
    <div class="eyebrow"><span>${esc(c.subject)} · ${esc(c.chapter)}</span><span>${TYPE_LABEL[c.questionType]}</span>${c.level ? `<span>${esc(c.level)}</span>` : ''}<code>${esc(c.questionId)}</code></div>
    <h1 class="title">${esc(titleOf(c))}</h1>
    <p class="subtitle">${esc(i.change ? i.change[0].toUpperCase() + i.change.slice(1) : '')}${i.change ? ' · ' : ''}${esc(c.priority.reason)}</p>
    ${banner(c)}${renderPanel(c)}${renderChangeCard(c)}${renderWhyCard(c)}${renderQuestionCard(c)}${renderStudents(c, ui.panel === 'edit')}
    ${c.findings?.length ? renderFindingsCard(c.findings, c.questionId) : ''}${renderAudit(c.questionId)}
    <p class="foot">Decided by the triage engine on ${esc(new Date(DATA.meta.generatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))} · prompts ${esc(DATA.meta.promptVersion)} · models: Gemini free tier, with a declared Claude stand-in after the quota ran out (see PROMPTS.md). This console shows precomputed engine output; it doesn't call an LLM. Actions are stored in this browser and exportable from the Audit log.</p>
  </div>${actionBar(c)}`;
}

function renderFindingsCard(fs, qid, standalone = false) {
  return `<section class="card"><header><h2>${standalone ? 'Found by the engine, not reported by anyone' : 'Also noticed in this question (not reported)'}</h2></header><div class="body">
    ${fs.map((f) => {
      const ok = f.applies !== false && f.find != null;
      const plain = ok && !/[<&]/.test(f.find + (f.replace || ''));
      const diff = !ok ? '' : plain ? `<div class="inline-diff">${diffHtml(textDiff(f.find, f.replace || ''))}</div>`
        : `<div class="swap"><div class="side before"><small>Remove</small><div class="content">${sanitize(f.find)}</div></div><div class="arrow">→</div><div class="side after"><small>Insert</small><div class="content">${sanitize(f.replace || '') || '<i>(removed)</i>'}</div></div></div>`;
      return `<div class="finding"><div class="who" style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="chip accent">${esc(REPAIR_TITLE[f.repair] || f.repair || 'note')}</span><span style="color:var(--muted);font-size:12.5px">${esc(FIELD_LABEL[f.field] || f.field || '')}</span></div>
        <div style="margin-bottom:6px">${esc(f.note || '')}</div>${diff}</div>`;
    }).join('')}
  </div></section>`;
}

function renderFindingDetail(id) {
  const qid = id.slice(2);
  const g = unreportedGroups().find((x) => x.qid === qid);
  if (!g) return renderEmptyDetail();
  const rec = g.rec || {};
  const d = decision(id);
  return `<div class="detail-inner"><button class="btn back" data-act="back">← Queue</button>
    <div class="eyebrow"><span>${esc(rec.subject)} · ${esc(rec.chapter)}</span><span>${TYPE_LABEL[rec.questionType] || ''}</span><code>${esc(qid)}</code></div>
    <h1 class="title">${g.fs.length === 1 ? esc(REPAIR_TITLE[g.fs[0].repair] || g.fs[0].repair) : `${g.fs.length} defects nobody reported`}</h1>
    <p class="subtitle">No student has flagged this yet. Nothing is applied automatically for unreported findings: the engine only proposes.</p>
    ${d ? `<div class="banner done"><div><b>${esc(d.action)} by ${esc(d.by)} · ${when(d.at)}</b></div></div>` : ''}
    ${ui.panel === 'reject' ? renderPanel({ priority: { route: 'faculty_review' }, issues: [{}] }) : ''}
    ${renderFindingsCard(g.fs, qid, true)}
    <section class="card"><header><h2>As students see it</h2><div class="seg"><button data-qtab="question" aria-pressed="${ui.qtab === 'question'}">Question</button><button data-qtab="solution" aria-pressed="${ui.qtab === 'solution'}">Solution</button></div></header>
      <div class="body"><div class="content">${sanitize(ui.qtab === 'solution' ? rec.solution : rec.question)}</div>
      <div class="keyrow"><span class="change-label">Answer key</span><span class="k">${rec.question ? keyText(rec) : ''}</span></div></div></section>
    ${renderAudit(id)}</div>
    <div class="actions"><button class="btn primary" data-act="approve">Approve fixes <kbd>A</kbd></button><button class="btn danger" data-act="reject">Reject <kbd>R</kbd></button><span class="hint"><kbd>J</kbd> <kbd>K</kbd> next / previous</span></div>`;
}

function renderEmptyDetail() {
  const n = DATA.cases.filter((c) => tabOf(c) === 'review').length;
  return `<div class="detail-inner"><div class="empty" style="padding-top:12vh"><b>${n ? `${n} case${n > 1 ? 's' : ''} need you tonight` : 'Nothing needs you'}</b>Pick one from the queue, or press <kbd>J</kbd> to start at the most urgent.</div></div>`;
}

// ------------------------------------------------------------------ render root
function render() {
  renderTabs();
  renderList();
  const det = document.getElementById('detail');
  const c = DATA.cases.find((x) => x.questionId === ui.selected);
  det.innerHTML = ui.selected?.startsWith('F:') ? renderFindingDetail(ui.selected) : c ? renderCase(c) : renderEmptyDetail();
  document.getElementById('main').classList.toggle('has-selection', !!ui.selected);
  const rv = document.getElementById('reviewer');
  rv.innerHTML = `Reviewing as <button id="who">${esc(store.reviewer())}</button>`;
  bindPreviews();
}

function bindPreviews() {
  document.querySelectorAll('[data-edit]').forEach((t) => t.addEventListener('input', () => {
    const p = document.querySelector(`[data-preview="${t.dataset.edit}"]`);
    if (p) p.innerHTML = sanitize(t.value);
  }));
}

// ------------------------------------------------------------------ navigation
function currentList() {
  if (ui.tab === 'unreported' && !ui.query) return unreportedGroups().map((g) => 'F:' + g.qid);
  return visibleCases(ui.tab).map((c) => c.questionId);
}
function select(id, { scroll = true } = {}) {
  ui.selected = id; ui.panel = null; ui.reason = null; ui.side = 'after'; ui.qtab = 'question';
  history.replaceState(null, '', id ? `#/case/${encodeURIComponent(id)}` : '#/');
  render();
  document.getElementById('detail').scrollTop = 0;
  if (scroll) document.querySelector(`.item[data-id="${CSS.escape(id || '')}"]`)?.scrollIntoView({ block: 'nearest' });
}
function step(dir) {
  const ids = currentList();
  if (!ids.length) return;
  const k = ids.indexOf(ui.selected);
  select(ids[k === -1 ? 0 : Math.min(ids.length - 1, Math.max(0, k + dir))]);
}
function advanceAfterAction(prevIds) {
  // stay in the same tab and go to what is now next, so a tired reviewer never has to hunt
  const ids = currentList();
  const k = prevIds.indexOf(ui.selected);
  const next = prevIds.slice(k + 1).find((id) => ids.includes(id)) || ids[0] || null;
  select(next);
}

// ------------------------------------------------------------------ actions
function collectReplies() {
  const out = {};
  document.querySelectorAll('[data-reply]').forEach((t) => { out[t.dataset.reply] = t.value.trim(); });
  return out;
}

function act(kind) {
  const id = ui.selected;
  if (!id) return;
  const c = DATA.cases.find((x) => x.questionId === id);
  const prevIds = currentList();
  const note = document.getElementById('note')?.value.trim() || undefined;
  let entry;
  if (id.startsWith('F:')) {
    const g = unreportedGroups().find((x) => 'F:' + x.qid === id);
    entry = store.act(id, kind === 'approve' ? 'approved' : 'rejected', { reason: ui.reason, note, findings: g?.fs.map((f) => ({ repair: f.repair, field: f.field, find: f.find, replace: f.replace })) });
  } else {
    const i = mainIssue(c);
    const base = { ai: { verdict: i.verdict, repair: i.repair, route: route(c), confidence: i.confidence }, note };
    if (kind === 'approve') {
      const labels = { auto_apply: 'kept', no_change: 'confirmed', faculty_review: 'approved' };
      entry = store.act(id, labels[route(c)], { ...base, edits: effectiveEdits(c, i), suggestion: i.suggestion || undefined });
    } else if (kind === 'reject') {
      const labels = { auto_apply: 'reverted', no_change: 'reopened', faculty_review: 'rejected' };
      entry = store.act(id, labels[route(c)], { ...base, reason: ui.reason });
    } else if (kind === 'edit') {
      const edits = effectiveEdits(c, i).map((e, n) => {
        const box = document.querySelector(`[data-edit="${n}"]`);
        const letters = document.querySelector(`[data-letters="${n}"]`);
        if (letters) {
          const on = [...letters.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.letter);
          return { ...e, replace: letters.dataset.multi === 'true' ? on : on[0] };
        }
        return box ? { ...e, replace: box.value } : e;
      });
      const err = applyEdits(flatRecord(c), edits).errors;
      if (err.length) { toast(`Can't apply: ${err[0]}`); return; }
      const sug = document.querySelector('[data-suggest]');
      entry = store.act(id, 'edited', { ...base, edits, suggestion: sug ? { ...i.suggestion, proposed: sug.value } : undefined, replies: collectReplies() });
    }
  }
  ui.panel = null;
  toast(`${entry.action[0].toUpperCase() + entry.action.slice(1)}${id.startsWith('F:') ? '' : ` · ${titleOf(c)}`}`, entry);
  advanceAfterAction(prevIds);
}

let toastTimer;
function toast(msg, entry) {
  clearTimeout(toastTimer);
  const o = document.getElementById('overlay');
  o.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${entry ? '<button>Undo</button>' : ''}`;
  t.querySelector('button')?.addEventListener('click', () => { store.undo(entry); t.remove(); select(entry.caseId); });
  o.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), 6000);
}

function openDrawer(kind) {
  const o = document.getElementById('overlay');
  const close = () => { o.querySelector('.scrim')?.remove(); o.querySelector('.drawer')?.remove(); };
  close();
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  scrim.addEventListener('click', close);
  const d = Object.assign(document.createElement('aside'), { className: 'drawer' });
  d.setAttribute('role', 'dialog');
  if (kind === 'audit') {
    const rows = [...store.get().audit].reverse();
    d.innerHTML = `<header><h2>Audit log · ${rows.length} entries</h2><button class="btn" id="exp">Export JSON</button><button class="btn danger" id="rst" title="Clear all demo decisions">Reset demo</button><button class="icon-btn" id="x" aria-label="Close">✕</button></header>
      <div class="scroll">${rows.length ? `<table class="audit-table"><thead><tr><th>When</th><th>Who</th><th>Case</th><th>Action</th><th>AI said</th></tr></thead><tbody>
      ${rows.map((a) => { const c = DATA.cases.find((x) => x.questionId === a.caseId); return `<tr><td>${when(a.at)}</td><td>${esc(a.by)}</td>
        <td><a href="#/case/${encodeURIComponent(a.caseId)}" data-goto="${esc(a.caseId)}">${esc(c ? titleOf(c) : a.caseId)}</a><br><small style="color:var(--faint)">${esc(a.caseId)}</small></td>
        <td><b>${esc(a.action)}</b>${a.reason ? `<br><small>${esc(a.reason)}</small>` : ''}${a.note ? `<br><small>“${esc(a.note)}”</small>` : ''}</td>
        <td>${a.ai ? `${esc(a.ai.verdict)}${a.ai.repair ? ' / ' + esc(a.ai.repair) : ''}<br><small>${pct(a.ai.confidence)} · ${esc(a.ai.route)}</small>` : ''}</td></tr>`; }).join('')}
      </tbody></table>` : '<div class="empty"><b>No actions yet</b>Every approve, edit, reject, revert and undo lands here with who and when.</div>'}</div>`;
    d.querySelector('#exp').onclick = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([store.exportJson()], { type: 'application/json' })), download: `fixdesk-audit-${new Date().toISOString().slice(0, 10)}.json` });
      a.click(); URL.revokeObjectURL(a.href);
    };
    d.querySelector('#rst').onclick = () => { if (confirm('Clear all decisions and the audit log in this browser?')) { store.reset(); close(); render(); } };
    d.querySelectorAll('[data-goto]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); close(); const c = DATA.cases.find((k) => k.questionId === x.dataset.goto); if (c) ui.tab = tabOf(c); select(x.dataset.goto); }));
  } else {
    d.innerHTML = `<header><h2>Keyboard shortcuts</h2><button class="icon-btn" id="x" aria-label="Close">✕</button></header><div class="scroll"><div class="help-grid">
      <kbd>J</kbd><span>Next case</span><kbd>K</kbd><span>Previous case</span><kbd>A</kbd><span>Approve / keep / confirm</span><kbd>E</kbd><span>Edit the fix or the replies</span>
      <kbd>R</kbd><span>Reject / revert / reopen</span><kbd>1</kbd>–<kbd>5</kbd><span>Switch tab</span><kbd>/</kbd><span>Search</span><kbd>D</kbd><span>Toggle before / after</span><kbd>T</kbd><span>Dark / light</span><kbd>Esc</kbd><span>Close panel</span>
      </div><h3 style="margin-top:24px;font-size:15px">How the queue is ordered</h3><p style="color:var(--muted)">Urgency = how badly one encounter hurts a student × how many are hitting it × whether a human is the only one who can stop it.
      Wrong keys come first (students lose marks right now), then questions that can't be solved as shown, then wrong solutions, then cosmetics and filing. Auto-fixed cases have already stopped the harm, so they wait in their own tab.</p></div>`;
  }
  d.querySelector('#x').onclick = close;
  o.append(scrim, d);
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.dataset.tab) { ui.tab = t.dataset.tab; ui.query = ''; document.getElementById('search').value = ''; const ids = currentList(); select(ids.includes(ui.selected) ? ui.selected : ids[0] || null); return; }
  if (t.dataset.id) { select(t.dataset.id, { scroll: false }); return; }
  if (t.dataset.side) { ui.side = t.dataset.side; render(); return; }
  if (t.dataset.qtab) { ui.qtab = t.dataset.qtab; render(); return; }
  if (t.dataset.reason) { ui.reason = t.dataset.reason; document.querySelectorAll('[data-reason]').forEach((b) => b.setAttribute('aria-pressed', b === t)); return; }
  if (t.dataset.letter) {
    const box = t.closest('[data-letters]');
    if (box.dataset.multi !== 'true') box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    t.setAttribute('aria-pressed', box.dataset.multi === 'true' ? String(t.getAttribute('aria-pressed') !== 'true') : 'true');
    return;
  }
  const a = t.dataset.act;
  if (a === 'approve') act('approve');
  else if (a === 'edit') { ui.panel = 'edit'; render(); document.getElementById('panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  else if (a === 'reject') { ui.panel = 'reject'; render(); document.getElementById('panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  else if (a === 'confirm-reject') act('reject');
  else if (a === 'save-edit') act('edit');
  else if (a === 'close') { ui.panel = null; render(); }
  else if (a === 'back') select(null);
  else if (t.id === 'who') { const n = prompt('Your name for the audit log:', store.reviewer()); if (n) { store.setReviewer(n); render(); } }
});

document.getElementById('search').addEventListener('input', (e) => { ui.query = e.target.value; renderTabs(); renderList(); });
document.getElementById('audit-btn').onclick = () => openDrawer('audit');
document.getElementById('help-btn').onclick = () => openDrawer('help');
document.getElementById('theme-btn').onclick = toggleTheme;
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('fixdesk.theme', document.documentElement.dataset.theme); } catch { /* ignore */ }
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (document.querySelector('.drawer')) { document.querySelector('.scrim')?.click(); return; }
    if (ui.panel) { ui.panel = null; render(); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if (ui.panel === 'reject' && e.key === 'Enter' && document.activeElement?.tagName !== 'TEXTAREA') { e.preventDefault(); act('reject'); return; }
  if (ui.panel === 'edit' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); act('edit'); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer')) return;
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (k === 'a' && ui.selected) act('approve');
  else if (k === 'e' && ui.selected && !ui.selected.startsWith('F:')) { ui.panel = 'edit'; render(); }
  else if (k === 'r' && ui.selected) { ui.panel = 'reject'; render(); }
  else if (k === 'd') { ui.side = ui.side === 'after' ? 'before' : 'after'; render(); }
  else if (k === 't') toggleTheme();
  else if (k === '/') { e.preventDefault(); document.getElementById('search').focus(); }
  else if (e.key === '?') openDrawer('help');
  else if (/^[1-5]$/.test(k)) { ui.tab = TABS[+k - 1].id; const ids = currentList(); select(ids[0] || null); }
});

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const r = await fetch('data/cases.json', { cache: 'no-cache' });
    DATA = await r.json();
  } catch (err) {
    document.getElementById('detail').innerHTML = `<div class="detail-inner"><div class="empty"><b>Couldn't load cases</b>${esc(err.message)}. Run <code>python -m engine run</code> to generate web/data/cases.json.</div></div>`;
    return;
  }
  DATA.meta.now ||= DATA.cases.reduce((m, c) => (c.reports.reduce((x, r) => (r.reportedAt > x ? r.reportedAt : x), m)), '');
  const m = location.hash.match(/^#\/case\/(.+)$/);
  const id = m && decodeURIComponent(m[1]);
  if (id) {
    const c = DATA.cases.find((x) => x.questionId === id);
    ui.tab = c ? tabOf(c) : id.startsWith('F:') ? 'unreported' : ui.tab;
    select(id);
  } else {
    const first = visibleCases('review')[0];
    if (first && matchMedia('(min-width: 861px)').matches) select(first.questionId); else render();
  }
}
store.subscribe(() => {});
boot();
