import { STATE } from './state.js';

// ---------- 수업교체 및 보강 계획서(서식1) ----------
// 확정된 교체 결과(diffsByCtxKey)를 양식의 표 행으로 바꾼다. 앱 내부는 "요일_교시"만 다루므로
// 날짜는 print.js의 날짜 모델(dateOf)을 그대로 받아 쓴다.
//
// diff 모양(app.js buildSwapDiff / buildRelocateDiff / buildSubstituteDiff)에서:
// - 내 쪽(왼쪽): 결강 칸(ctx)에서 removed 된 교사들. 학반·과목은 그 교사가 목표 칸에 added 될 때의 값.
// - 상대 쪽(오른쪽): 목표 칸에서 removed 된 교사들. 과목은 그 교사가 결강 칸에 added 될 때의 값.
// - 대강: 결강 교사는 covered, 같은 칸에 대신 들어온 교사가 added.
// 개별 조합 교체는 (내 쪽 반 ↔ 상대 교사)가 짝이라 한 줄에 나란히, 세트간 교체는 세트 통째로라
// 짝 없이 왼쪽(반 단위)·오른쪽(교사 단위)을 각자 세로로 쌓는다.

var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 양식 표의 12열 폭(HWPUNIT, 합 43936 ≈ 155mm). 1mm ≈ 283.46 HWPUNIT.
var COL_WIDTHS = [5669, 4251, 567, 5102, 2834, 2836, 5669, 5669, 895, 1939, 4748, 3757];

export var PLAN_MIN_SWAP_LINES = 8;
export var PLAN_MIN_COVER_LINES = 5;

// 한 쪽에 들어가는 데이터 줄(교체+보강) 예산. Safari(WebKit) 하니스로 잰 값: 줄 높이 7mm에서
// 교체 12 + 보강 5 = 17줄이 여유 약 4mm로 겨우 들어가고 18줄부터 2쪽이 된다. 그래서 줄 수 ×
// 줄 높이가 PLAN_LINE_BUDGET_MM(= 17×7 + 4 − 안전 여유 8)을 넘지 않게 줄 높이를 7mm → 최소
// 5mm까지 줄인다. 5mm에서도 넘치면 2쪽으로 넘어간다(줄 중간에서는 끊기지 않음).
var PLAN_MAX_ROW_MM = 7;
var PLAN_MIN_ROW_MM = 5;
var PLAN_LINE_BUDGET_MM = 115;
var PLAN_TIGHT_SWAP_LINES = 11; // 교체가 이만큼 넘으면 보강 빈 줄 채움을 2줄로 줄인다

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function parseIso(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// '2026-09-29' → '09. 29.'
function formatDot(iso) {
  var d = parseIso(iso);
  return d ? pad2(d.getMonth() + 1) + '. ' + pad2(d.getDate()) + '.' : '';
}

// '2026-09-29' → '2026. 09. 29.(화)'
function formatFullDot(iso) {
  var d = parseIso(iso);
  return d ? d.getFullYear() + '. ' + pad2(d.getMonth() + 1) + '. ' + pad2(d.getDate()) + '.(' + WEEKDAY_KO[d.getDay()] + ')' : '';
}

function byDayPeriod(a, b) {
  var dd = STATE.dayList.indexOf(a.day) - STATE.dayList.indexOf(b.day);
  return dd !== 0 ? dd : a.period - b.period;
}

function sameCell(d, cell) { return d.day === cell.day && d.period === cell.period; }

function addedOf(diffs, teacher, cell) {
  for (var i = 0; i < diffs.length; i++) {
    var d = diffs[i];
    if (d.type === 'added' && d.teacher === teacher && sameCell(d, cell)) return d;
  }
  return null;
}

// buildComboEntry가 만드는 diff는 [A removed@ctx, A added@목표, B removed@목표, B added@ctx]가
// 짝마다 반복된다. 세트간 교체는 릴레이트 쌍(2개씩)이 A쪽 전원 → B쪽 전원 순이라 이 모양이
// 아니다(세트원이 한 명씩일 때만 우연히 같아지는데, 그땐 짝 한 줄이라 결과도 같다).
function comboChunks(diffs, ctxCell, target) {
  if (diffs.length === 0 || diffs.length % 4 !== 0) return null;
  var chunks = [];
  for (var i = 0; i < diffs.length; i += 4) {
    var c = diffs.slice(i, i + 4);
    var ok = c[0].type === 'removed' && sameCell(c[0], ctxCell) &&
      c[1].type === 'added' && c[1].teacher === c[0].teacher && sameCell(c[1], target) &&
      c[2].type === 'removed' && sameCell(c[2], target) &&
      c[3].type === 'added' && c[3].teacher === c[2].teacher && sameCell(c[3], ctxCell);
    if (!ok) return null;
    chunks.push(c);
  }
  return chunks;
}

function groupByClass(items) {
  var out = [];
  var index = {};
  items.forEach(function (it) {
    if (index[it.className] === undefined) { index[it.className] = out.length; out.push({ className: it.className, subjects: [] }); }
    var g = out[index[it.className]];
    if (g.subjects.indexOf(it.subject) < 0) g.subjects.push(it.subject);
  });
  return out.map(function (g) { return { className: g.className, subject: g.subjects.join('/') }; });
}

// 슬롯 하나 → 교체 묶음 { leftDate, rightDate, period, targetPeriod, paired, left[], right[] }
function buildSwap(diffs, ctx, key, dateOf) {
  var ctxCell = { day: ctx.day, period: ctx.period };
  var target = null;
  diffs.forEach(function (d) {
    if (d.type === 'added' && d.teacher === ctx.teacher && !sameCell(d, ctxCell)) target = { day: d.day, period: d.period };
  });
  var swap = {
    leftDate: formatDot(dateOf(key, ctx.day, ctx.period)),
    rightDate: target ? formatDot(dateOf(key, target.day, target.period)) : '',
    leftIso: dateOf(key, ctx.day, ctx.period),
    rightIso: target ? dateOf(key, target.day, target.period) : '',
    period: ctx.period,
    targetPeriod: target ? target.period : '',
    paired: false,
    left: [],
    right: []
  };
  if (!target) {
    swap.left = [{ className: ctx.className, subject: ctx.subject }];
    return swap;
  }
  var chunks = comboChunks(diffs, ctxCell, target);
  if (chunks) {
    swap.paired = true;
    chunks.forEach(function (c) {
      swap.left.push({ className: c[1].className, subject: c[1].subject });
      swap.right.push({ subject: c[3].subject, teacher: c[2].teacher, className: c[3].className });
    });
    return swap;
  }
  var leftItems = [];
  var rightItems = [];
  diffs.forEach(function (d) {
    if (d.type !== 'removed') return;
    if (sameCell(d, ctxCell)) {
      var a = addedOf(diffs, d.teacher, target);
      leftItems.push({ className: a ? a.className : ctx.className, subject: a ? a.subject : ctx.subject });
    } else if (sameCell(d, target)) {
      var b = addedOf(diffs, d.teacher, ctxCell);
      rightItems.push({ subject: b ? b.subject : '', teacher: d.teacher, className: b ? b.className : '' });
    }
  });
  swap.left = groupByClass(leftItems);
  swap.right = rightItems;
  return swap;
}

// diffsByCtxKey({'월_2': [diff...]}) → 계획서 데이터.
// getCtx(key) → { teacher, day, period, subject, className } | null, dateOf(key, day, period) → ISO 날짜.
export function buildPlanData(diffsByCtxKey, getCtx, dateOf, absentTeacher) {
  var keys = Object.keys(diffsByCtxKey).sort(function (a, b) {
    var ap = a.split('_'), bp = b.split('_');
    return byDayPeriod({ day: ap[0], period: parseInt(ap[1], 10) }, { day: bp[0], period: parseInt(bp[1], 10) });
  });
  var swaps = [];
  var covers = [];
  var isos = [];
  keys.forEach(function (key) {
    var diffs = diffsByCtxKey[key];
    var ctx = getCtx(key);
    if (!ctx) {
      var p = key.split('_');
      ctx = { teacher: absentTeacher, day: p[0], period: parseInt(p[1], 10), subject: '', className: '' };
    }
    var iso = dateOf(key, ctx.day, ctx.period);
    if (iso) isos.push(iso);
    var isCover = diffs.some(function (d) { return d.type === 'covered'; });
    if (isCover) {
      var sub = null;
      diffs.forEach(function (d) {
        if (d.type === 'added' && d.teacher !== ctx.teacher && d.day === ctx.day && d.period === ctx.period) sub = d;
      });
      covers.push({ date: formatDot(iso), className: ctx.className, subject: ctx.subject, period: ctx.period, teacher: sub ? sub.teacher : '' });
    } else {
      swaps.push(buildSwap(diffs, ctx, key, dateOf));
    }
  });
  isos.sort();
  var first = isos[0] || '';
  var last = isos[isos.length - 1] || '';
  var range = first ? (first === last ? formatFullDot(first) : formatFullDot(first) + ' ~ ' + formatFullDot(last).replace(/^\d{4}\. /, '')) : '';
  return {
    teacher: absentTeacher,
    swaps: swaps,
    covers: covers,
    total: keys.length,
    swapCount: swaps.length,
    coverCount: covers.length,
    range: range
  };
}

// ---------- HTML ----------
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function td(text, opts) {
  opts = opts || {};
  var attrs = '';
  if (opts.col > 1) attrs += ' colspan="' + opts.col + '"';
  if (opts.row > 1) attrs += ' rowspan="' + opts.row + '"';
  if (opts.cls) attrs += ' class="' + opts.cls + '"';
  return '<td' + attrs + '>' + (opts.raw ? text : esc(text)) + '</td>';
}

function swapLineCount(swap) {
  return swap.paired ? swap.left.length : Math.max(swap.left.length, swap.right.length, 1);
}

// 항목 m개를 n줄에 배치할 때 j번째 항목이 차지하는 줄 수(마지막 항목이 남는 줄을 흡수).
function spanOf(j, m, n) { return j === m - 1 ? n - m + 1 : 1; }

function swapRowsHtml(swap) {
  var n = swapLineCount(swap);
  var mL = swap.left.length;
  var mR = swap.right.length;
  var out = '';
  for (var i = 0; i < n; i++) {
    var tr = '';
    if (i === 0) tr += td(swap.leftDate, { row: n });
    if (i < mL) {
      var sl = spanOf(i, mL, n);
      tr += td(swap.left[i].className, { row: sl }) + td(swap.left[i].subject, { col: 2, row: sl });
    } else if (mL === 0 && i === 0) {
      tr += td('', { row: n }) + td('', { col: 2, row: n });
    }
    if (i === 0) {
      tr += td(swap.period, { row: n }) + td('', { row: n }) + td(swap.rightDate, { row: n });
    }
    if (i < mR) {
      var sr = spanOf(i, mR, n);
      tr += td(swap.right[i].subject, { row: sr });
      if (i === 0) tr += td(swap.targetPeriod, { col: 2, row: n });
      tr += td(swap.right[i].teacher, { col: 2, row: sr });
    } else if (mR === 0 && i === 0) {
      tr += td('', { row: n }) + td(swap.targetPeriod, { col: 2, row: n }) + td('', { col: 2, row: n });
    }
    out += '<tr class="pl-data">' + tr + '</tr>';
  }
  return out;
}

function blankSwapRow() {
  return '<tr class="pl-data">' + td('') + td('') + td('', { col: 2 }) + td('') + td('') + td('') + td('') + td('', { col: 2 }) + td('', { col: 2 }) + '</tr>';
}

function coverRowHtml(c) {
  return '<tr class="pl-data">' +
    td(c.date) + td(c.className, { col: 2 }) + td(c.subject) + td(c.period + '교시', { col: 2 }) + td(c.teacher, { col: 6 }) +
    '</tr>';
}

function blankCoverRow() {
  return '<tr class="pl-data">' + td('') + td('', { col: 2 }) + td('') + td('', { col: 2 }) + td('', { col: 6 }) + '</tr>';
}

// 교체·보강 데이터 줄 수(빈 줄 채움 포함)와 그에 맞는 줄 높이(mm).
export function planLayout(data) {
  var swapLines = 0;
  data.swaps.forEach(function (s) { swapLines += swapLineCount(s); });
  var coverMin = swapLines > PLAN_TIGHT_SWAP_LINES ? 2 : PLAN_MIN_COVER_LINES;
  var swapTotal = Math.max(swapLines, PLAN_MIN_SWAP_LINES);
  var coverTotal = Math.max(data.covers.length, coverMin);
  var rowMm = Math.min(PLAN_MAX_ROW_MM, Math.max(PLAN_MIN_ROW_MM, PLAN_LINE_BUDGET_MM / (swapTotal + coverTotal)));
  return { swapTotal: swapTotal, coverTotal: coverTotal, rowMm: Math.floor(rowMm * 100) / 100 };
}

// opts: { reason, note }
export function renderPlanHtml(data, opts) {
  opts = opts || {};
  var layout = planLayout(data);
  var html = '';
  html += '<div class="pl-formno">&lt;서식1&gt;</div>';
  html += '<div class="pl-title">수업교체 및 보강 계획서</div>';
  html += '<table class="pl-table" style="--pl-row-h:' + layout.rowMm + 'mm"><colgroup>';
  COL_WIDTHS.forEach(function (w) { html += '<col style="width:' + (w / 283.46).toFixed(2) + 'mm">'; });
  html += '</colgroup><tbody>';

  html += '<tr class="pl-r9">' +
    td('교사명', { cls: 'pl-lab' }) + td(data.teacher, { col: 5 }) +
    td('사유', { cls: 'pl-lab' }) + td(opts.reason || '', { col: 5 }) + '</tr>';
  html += '<tr class="pl-r9">' +
    td('일 시', { cls: 'pl-lab' }) + td(data.range, { col: 11 }) + '</tr>';
  html += '<tr class="pl-r10">' +
    td('결강수업<br>총시수', { cls: 'pl-lab', raw: true }) + td(data.total, { col: 5 }) +
    td('교체수업<br>시수', { cls: 'pl-lab', raw: true }) + td(data.swapCount, { col: 2 }) +
    td('보강시수', { cls: 'pl-lab', col: 2 }) + td(data.coverCount) + '</tr>';

  html += '<tr class="pl-r10 pl-sec">' + td('교체 수업 시간', { col: 12, cls: 'pl-lab' }) + '</tr>';
  html += '<tr class="pl-r10">' +
    td('날 짜', { cls: 'pl-lab' }) + td('학 반', { cls: 'pl-lab' }) + td('과 목', { cls: 'pl-lab', col: 2 }) +
    td('교시', { cls: 'pl-lab' }) + td('⇔', { cls: 'pl-lab' }) + td('날 짜', { cls: 'pl-lab' }) +
    td('과 목', { cls: 'pl-lab' }) + td('교시', { cls: 'pl-lab', col: 2 }) + td('교 사', { cls: 'pl-lab', col: 2 }) + '</tr>';
  var lines = 0;
  data.swaps.forEach(function (s) { html += swapRowsHtml(s); lines += swapLineCount(s); });
  for (; lines < layout.swapTotal; lines++) html += blankSwapRow();

  html += '<tr class="pl-r10 pl-sec">' +
    td('결강 수업 시간', { col: 6, cls: 'pl-lab' }) + td('보강 교사', { col: 6, cls: 'pl-lab' }) + '</tr>';
  var cl = 0;
  data.covers.forEach(function (c) { html += coverRowHtml(c); cl++; });
  for (; cl < layout.coverTotal; cl++) html += blankCoverRow();

  html += '<tr class="pl-r10 pl-sec">' + td('결강 수업의 보강계획', { col: 12, cls: 'pl-lab' }) + '</tr>';
  html += '<tr class="pl-note"><td colspan="12" class="pl-notecell">' + esc(opts.note || '') + '</td></tr>';
  html += '</tbody></table>';
  return html;
}

// ---------- 서식2: 학급별 안내 내용 ----------
// 반마다 표 하나("교체 전 | 교체 후"). 교체 한 건은 서로 뒤집힌 두 줄이 된다 — 한 줄은
// (결강 칸 수업 | 목표 칸 수업), 다른 줄은 그 반대. 같은 반끼리만 바뀌므로(일반 맞교체는 같은 반,
// 이동수업 세트는 세트에 든 반 전체) 서식1의 교체 묶음(swaps)을 반 단위로 다시 묶으면 된다.
// 대강만 있는 반은 시간표가 바뀌지 않으므로 넣지 않는다.

export var PLAN2_MIN_LINES = 4;           // 표 하나의 최소 데이터 줄(빈 줄 채움)
var PLAN2_ROW_MM = 10;                    // 데이터 줄 높이. 양식은 11mm(3116 HWPUNIT)인데 첫 쪽에 표 3개가 들어가도록 10mm로 줄였다
var PLAN2_MIN_ROW_MM = 6;                 // 줄이 아주 많을 때 줄일 수 있는 하한
var PLAN2_FIXED_MM = 27;                  // 제목 11 + 교체 전/후 8 + 열 머리 8
var PLAN2_GAP_MM = 5;                     // 표 사이 간격
var PLAN2_HEAD_MM = 22;                   // 첫 쪽의 <서식2> + 소제목
var PLAN2_MAX_PER_PAGE = 3;
// 한 쪽에 쓸 높이 예산(mm). 서식1 측정으로 Safari 사용 가능 높이 ≈ 250mm에서 안전 여유 8mm를 뺐다.
// 서식2 구현 뒤 하니스로 다시 재서 확정한다.
var PLAN2_PAGE_BUDGET_MM = 243;

// '2026-09-29' → '9.29.(화)' (서식2는 0 패딩이 없다)
function formatShortDow(iso) {
  var d = parseIso(iso);
  return d ? (d.getMonth() + 1) + '.' + d.getDate() + '.(' + WEEKDAY_KO[d.getDay()] + ')' : '';
}

// 항목들을 반 단위로 묶어 { 반: '과목/과목' }과 등장 순서를 돌려준다.
function subjectsByClass(items) {
  var map = {};
  var order = [];
  items.forEach(function (it) {
    if (map[it.className] === undefined) { map[it.className] = []; order.push(it.className); }
    if (map[it.className].indexOf(it.subject) < 0) map[it.className].push(it.subject);
  });
  return { map: map, order: order };
}

function classKey(name) {
  var m = /^(\d+)-(\d+)$/.exec(name || '');
  return m ? { grade: +m[1], cls: +m[2] } : { grade: 0, cls: 0 };
}

// buildPlanData의 결과(data.swaps) → [{ className, grade, cls, rows: [[전 날짜, 전 교시, 전 과목, 후 날짜, 후 교시, 후 과목]] }]
export function buildClassNotices(data) {
  var byClass = {};
  var order = [];
  data.swaps.forEach(function (s) {
    if (s.targetPeriod === '') return; // 목표 칸을 못 찾은 교체는 안내할 수 없다
    var L = subjectsByClass(s.left);
    var R = subjectsByClass(s.right);
    var classes = L.order.slice();
    R.order.forEach(function (c) { if (classes.indexOf(c) < 0) classes.push(c); });
    var ctxSide = function (subject) { return [formatShortDow(s.leftIso), s.period + '교시', subject]; };
    var targetSide = function (subject) { return [formatShortDow(s.rightIso), s.targetPeriod + '교시', subject]; };
    classes.forEach(function (c) {
      var a = L.map[c] ? L.map[c].join('/') : '';
      var b = R.map[c] ? R.map[c].join('/') : '';
      if (byClass[c] === undefined) { byClass[c] = []; order.push(c); }
      if (a && b) {
        byClass[c].push(ctxSide(a).concat(targetSide(b)));
        byClass[c].push(targetSide(b).concat(ctxSide(a)));
      } else if (a) {
        byClass[c].push(ctxSide(a).concat(targetSide('-')));
      } else if (b) {
        byClass[c].push(targetSide(b).concat(ctxSide('-')));
      }
    });
  });
  return order
    .filter(function (c) { return c && byClass[c].length > 0; })
    .map(function (c) { var k = classKey(c); return { className: c, grade: k.grade, cls: k.cls, rows: byClass[c] }; })
    .sort(function (x, y) {
      if (x.grade !== y.grade) return x.grade - y.grade;
      if (x.cls !== y.cls) return x.cls - y.cls;
      return x.className < y.className ? -1 : x.className > y.className ? 1 : 0;
    });
}

// 표 하나의 줄 높이(mm): 기본 11mm, 줄이 아주 많으면 한 쪽에 들어가도록 6mm까지 줄인다.
function noticeRowMm(rowCount) {
  var lines = Math.max(rowCount, PLAN2_MIN_LINES);
  var avail = PLAN2_PAGE_BUDGET_MM - PLAN2_FIXED_MM;
  return Math.floor(Math.min(PLAN2_ROW_MM, Math.max(PLAN2_MIN_ROW_MM, avail / lines)) * 100) / 100;
}

function noticeHeightMm(n) {
  return PLAN2_FIXED_MM + Math.max(n.rows.length, PLAN2_MIN_LINES) * noticeRowMm(n.rows.length);
}

function noticeTitle(n) {
  var sp = '&nbsp;&nbsp;&nbsp;';
  return n.grade
    ? '&lt;시간표 변경' + sp + n.grade + ' 학년' + sp + n.cls + ' 반&gt;'
    : '&lt;시간표 변경' + sp + esc(n.className) + '&gt;';
}

function noticeTableHtml(n) {
  var html = '<div class="pl2-block"><table class="pl2-table" style="--pl2-row-h:' + noticeRowMm(n.rows.length) + 'mm"><colgroup>';
  for (var i = 0; i < 6; i++) html += '<col style="width:' + (42486 / 6 / 283.46).toFixed(2) + 'mm">';
  html += '</colgroup><tbody>';
  html += '<tr class="pl2-title"><td colspan="6">' + noticeTitle(n) + '</td></tr>';
  html += '<tr class="pl2-r8 pl2-lab"><td colspan="3">교체 전</td><td colspan="3">교체 후</td></tr>';
  html += '<tr class="pl2-r8 pl2-lab2">' + ['날짜(요일)', '교시', '과목', '날짜(요일)', '교시', '과목'].map(function (h) { return '<td>' + h + '</td>'; }).join('') + '</tr>';
  var lines = Math.max(n.rows.length, PLAN2_MIN_LINES);
  for (var r = 0; r < lines; r++) {
    var row = n.rows[r] || ['', '', '', '', '', ''];
    html += '<tr class="pl2-data">' + row.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
  }
  return html + '</tbody></table></div>';
}

// 표를 쪽에 채운다: 쪽당 최대 3개, 높이 합이 예산을 넘지 않을 때까지(첫 쪽은 머리만큼 덜). 표는 쪽을
// 넘어 잘리지 않는다. 모든 쪽은 새 쪽에서 시작한다(서식1과 반드시 다른 쪽).
export function renderClassNoticesHtml(notices) {
  if (notices.length === 0) return '';
  var pages = [];
  var cur = null;
  notices.forEach(function (n) {
    var h = noticeHeightMm(n);
    if (cur) {
      var budget = PLAN2_PAGE_BUDGET_MM - (pages.length === 1 ? PLAN2_HEAD_MM : 0);
      if (cur.tables.length >= PLAN2_MAX_PER_PAGE || cur.used + PLAN2_GAP_MM + h > budget) cur = null;
    }
    if (!cur) { cur = { tables: [], used: 0 }; pages.push(cur); }
    cur.used += (cur.tables.length ? PLAN2_GAP_MM : 0) + h;
    cur.tables.push(n);
  });
  return pages.map(function (p, i) {
    var head = i === 0
      ? '<div class="pl2-head"><div class="pl2-formno">&lt;서식2&gt;</div><div class="pl2-heading">학급별 안내 내용</div></div>'
      : '';
    return '<div class="pl2-page">' + head + p.tables.map(noticeTableHtml).join('') + '</div>';
  }).join('');
}
