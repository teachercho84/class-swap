import { STATE } from './state.js';

// ---------- 인쇄하기: 날짜 입력 → 출력 선택 ----------
// 앱 내부 데이터는 계속 "요일_교시"만 다룬다. 날짜는 이 모듈에서만, 인쇄를 위해 입력받아
// 보관한다(영구 저장 없음).
//
// 날짜의 단위는 "결시 수업 하나(슬롯 키) 안에서 바뀌는 시간대(요일_교시)" — 이걸 이벤트라 부른다.
// 같은 시간대는 그 교체에 얽힌 교사 모두에게 같은 실제 날짜이므로(A가 빠지는 월 2교시는
// 상대 B에겐 채워지는 월 2교시), 교사별이 아니라 이벤트별로 날짜를 들고 있어야 두 교사
// 카드가 서로 어긋나지 않는다. 주를 넘나드는 교체(이번 주/다음 주)는 이벤트 날짜를 직접
// 고쳐서 표현한다.

var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

var printState = { base: '', dates: {}, edited: {} };
var hooks = null;
var dialogData = null; // 팝업이 열려 있는 동안의 collectChangeData 결과

export function resetPrintState() {
  printState = { base: '', dates: {}, edited: {} };
}

// ---------- 날짜 유틸 ----------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function toIso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseIso(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  var ok = d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
  return ok ? d : null;
}
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function weekdayLabel(d) { return WEEKDAY_KO[d.getDay()]; }
function formatFull(iso) {
  var d = parseIso(iso);
  return d ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + weekdayLabel(d) + ')' : '';
}
function formatShort(iso) {
  var d = parseIso(iso);
  return d ? (d.getMonth() + 1) + '/' + d.getDate() : '';
}

// 기준일(요일 baseDay) 같은 주에서 day 요일의 날짜. 같은 주(dayList 순서 기준)라고 가정.
function defaultDateFor(baseIso, baseDay, day) {
  var base = parseIso(baseIso);
  if (!base) return '';
  var diff = STATE.dayList.indexOf(day) - STATE.dayList.indexOf(baseDay);
  return toIso(addDays(base, diff));
}

// 오늘 또는 그 이후 가장 가까운 baseDay 요일.
function nextDateOfWeekday(baseDay) {
  var today = new Date();
  var d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (var i = 0; i < 7; i++) {
    if (weekdayLabel(d) === baseDay) return toIso(d);
    d = addDays(d, 1);
  }
  return toIso(new Date());
}

// ---------- diff → 이벤트/교사별 쌍 ----------
function dayPeriodOrder(a, b) {
  var dd = STATE.dayList.indexOf(a.day) - STATE.dayList.indexOf(b.day);
  return dd !== 0 ? dd : a.period - b.period;
}
function eventId(key, day, period) { return key + '|' + day + '_' + period; }

// 슬롯 하나의 diff들에서 교사마다 "원래 칸 ↔ 옮겨간 칸" 쌍(교체·이동수업 세트간/조합 교체는
// 모두 buildSwapDiff/buildRelocateDiff 모양이라 교사마다 removed 1 + added 1), 대강
// (covered + 같은 칸의 added)은 단독 항목으로 뽑는다.
function derivePairs(key, diffs) {
  var byTeacher = {};
  var coveredCells = {};
  diffs.forEach(function (d) {
    if (!byTeacher[d.teacher]) byTeacher[d.teacher] = { removed: [], added: [], covered: [] };
    byTeacher[d.teacher][d.type].push(d);
    if (d.type === 'covered') coveredCells[d.day + '_' + d.period] = true;
  });
  var out = {};
  Object.keys(byTeacher).forEach(function (teacher) {
    var g = byTeacher[teacher];
    var list = [];
    g.covered.forEach(function (c) {
      list.push({ kind: 'covered', key: key, day: c.day, period: c.period });
    });
    var n = Math.min(g.removed.length, g.added.length);
    for (var i = 0; i < n; i++) {
      list.push({ kind: 'swap', key: key, from: { day: g.removed[i].day, period: g.removed[i].period }, to: { day: g.added[i].day, period: g.added[i].period } });
    }
    for (var j = n; j < g.added.length; j++) {
      var a = g.added[j];
      list.push({ kind: coveredCells[a.day + '_' + a.period] ? 'substitute' : 'single', key: key, day: a.day, period: a.period });
    }
    for (var k = n; k < g.removed.length; k++) {
      list.push({ kind: 'single', key: key, day: g.removed[k].day, period: g.removed[k].period });
    }
    out[teacher] = list;
  });
  return out;
}

// manualAssignState.diffsByCtxKey({'월_2': [diff...]})를 인쇄에 필요한 모양으로 정리한다.
// - slotKeys: 결시 슬롯 키(요일·교시 순)
// - events: 슬롯 키 → 그 슬롯에서 바뀌는 시간대 목록(날짜 입력 단위)
// - teacherOrder: 카드 순서(결근 교사 먼저, 나머지는 처음 담당하게 된 결시 시간 순)
// - teachers[교사].cells: '요일_교시' → { type, subject, className, key } (칸 강조·날짜용)
// - teachers[교사].pairs: 제목 문구용(derivePairs)
export function collectChangeData(diffsByCtxKey) {
  var slotKeys = Object.keys(diffsByCtxKey).sort(function (a, b) {
    var ap = a.split('_'), bp = b.split('_');
    return dayPeriodOrder({ day: ap[0], period: parseInt(ap[1], 10) }, { day: bp[0], period: parseInt(bp[1], 10) });
  });
  var teachers = {};
  var teacherOrder = [];
  var events = {};
  slotKeys.forEach(function (key) {
    var diffs = diffsByCtxKey[key];
    var seen = {};
    var list = [];
    diffs.forEach(function (d) {
      var cellKey = d.day + '_' + d.period;
      if (!seen[cellKey]) { seen[cellKey] = true; list.push({ day: d.day, period: d.period }); }
      if (!teachers[d.teacher]) { teachers[d.teacher] = { cells: {}, pairs: [] }; teacherOrder.push(d.teacher); }
      teachers[d.teacher].cells[cellKey] = { type: d.type, subject: d.subject, className: d.className, key: key };
    });
    list.sort(dayPeriodOrder);
    events[key] = list;
    var pairs = derivePairs(key, diffs);
    Object.keys(pairs).forEach(function (t) { teachers[t].pairs = teachers[t].pairs.concat(pairs[t]); });
  });
  teacherOrder.sort(function (a, b) {
    if (a === STATE.currentTeacher) return -1;
    if (b === STATE.currentTeacher) return 1;
    return 0;
  });
  return { slotKeys: slotKeys, events: events, teachers: teachers, teacherOrder: teacherOrder };
}

// ---------- 카드에 붙일 날짜 정보 ----------
function dateOf(key, day, period) { return printState.dates[eventId(key, day, period)] || ''; }

function allDatesPresent(data) {
  return data.slotKeys.every(function (key) {
    return data.events[key].every(function (e) { return !!parseIso(dateOf(key, e.day, e.period)); });
  });
}

function pairText(p) {
  if (p.kind === 'swap') {
    return formatFull(dateOf(p.key, p.from.day, p.from.period)) + ' <-> ' + formatFull(dateOf(p.key, p.to.day, p.to.period));
  }
  var d = formatFull(dateOf(p.key, p.day, p.period));
  if (p.kind === 'covered') return d + ' (대강)';
  if (p.kind === 'substitute') return d + ' (대강 수업)';
  return d;
}

// 이름 옆 문구(예: "9/21(월) <-> 9/23(수)")와 칸 안 날짜 맵을 돌려준다.
// 날짜가 하나라도 비어 있으면(아직 입력 전이거나, 입력 후 선택을 바꿔 새 시간대가 생긴 경우)
// null — 카드는 날짜 없이 기존 모양 그대로 그려진다.
export function getCardDateInfo(data, teacher) {
  if (!allDatesPresent(data)) return null;
  var t = data.teachers[teacher];
  if (!t) return null;
  var seen = {};
  var texts = [];
  t.pairs.forEach(function (p) {
    var s = pairText(p);
    if (s && !seen[s]) { seen[s] = true; texts.push(s); }
  });
  var dateMap = {};
  Object.keys(t.cells).forEach(function (cellKey) {
    var c = t.cells[cellKey];
    var parts = cellKey.split('_');
    var short = formatShort(dateOf(c.key, parts[0], parseInt(parts[1], 10)));
    if (short) dateMap[cellKey] = short;
  });
  return { titleParts: texts, dateMap: dateMap };
}

// ---------- 팝업 ----------
function $(id) { return document.getElementById(id); }

function firstAbsentDay(data) {
  var days = data.slotKeys.map(function (k) { return k.split('_')[0]; });
  days.sort(function (a, b) { return STATE.dayList.indexOf(a) - STATE.dayList.indexOf(b); });
  return days[0];
}

function setError(msg) { $('printDateError').textContent = msg || ''; }

function showStep(step) {
  $('printStepDate').hidden = step !== 'date';
  $('printStepChoose').hidden = step !== 'choose';
}

function buildEventList(data, baseDay) {
  var box = $('printEventList');
  box.innerHTML = '';
  data.slotKeys.forEach(function (key) {
    var ctx = hooks.getCtx(key);
    var group = document.createElement('div');
    group.className = 'print-event-group';
    var head = document.createElement('div');
    head.className = 'print-event-head';
    head.textContent = ctx
      ? ctx.day + ' ' + ctx.period + '교시 · ' + ctx.className + ' ' + ctx.subject + ' (' + ctx.teacher + ')'
      : key.replace('_', ' ') + '교시';
    group.appendChild(head);
    data.events[key].forEach(function (e) {
      var id = eventId(key, e.day, e.period);
      var row = document.createElement('label');
      row.className = 'print-event-row';
      var name = document.createElement('span');
      name.textContent = e.day + ' ' + e.period + '교시';
      var input = document.createElement('input');
      input.type = 'date';
      input.dataset.eventId = id;
      input.dataset.day = e.day;
      input.value = printState.dates[id] || defaultDateFor($('printBaseDate').value, baseDay, e.day);
      input.addEventListener('input', function () {
        printState.edited[id] = true;
        printState.dates[id] = input.value;
        input.classList.remove('is-invalid');
      });
      row.appendChild(name);
      row.appendChild(input);
      group.appendChild(row);
    });
    box.appendChild(group);
  });
}

function refreshUneditedFromBase(baseDay) {
  var base = $('printBaseDate').value;
  if (!parseIso(base)) return;
  $('printEventList').querySelectorAll('input[type="date"]').forEach(function (input) {
    var id = input.dataset.eventId;
    if (printState.edited[id]) return;
    input.value = defaultDateFor(base, baseDay, input.dataset.day);
    printState.dates[id] = input.value;
  });
}

function openDialog() {
  dialogData = collectChangeData(hooks.getDiffsByCtxKey());
  if (dialogData.slotKeys.length === 0) return;
  var baseDay = firstAbsentDay(dialogData);
  $('printBaseLabel').textContent = baseDay + '요일(첫 결근 요일) 날짜';
  $('printBaseDate').value = printState.base || nextDateOfWeekday(baseDay);
  buildEventList(dialogData, baseDay);
  setError('');
  showStep('date');
  $('printDialog').showModal();
}

function confirmDates() {
  var baseDay = firstAbsentDay(dialogData);
  var problems = [];
  var base = $('printBaseDate').value;
  var baseDate = parseIso(base);
  if (!baseDate) {
    problems.push('기준 날짜를 입력해 주세요.');
  } else if (weekdayLabel(baseDate) !== baseDay) {
    problems.push('기준 날짜는 ' + baseDay + '요일이어야 합니다(선택한 날짜: ' + weekdayLabel(baseDate) + '요일).');
  }
  var inputs = $('printEventList').querySelectorAll('input[type="date"]');
  var ok = true;
  inputs.forEach(function (input) {
    var d = parseIso(input.value);
    var bad = !d || weekdayLabel(d) !== input.dataset.day;
    input.classList.toggle('is-invalid', bad);
    if (bad) ok = false;
  });
  if (!ok) problems.push('빨간 칸을 확인해 주세요 — 날짜가 비어 있거나 요일이 맞지 않습니다.');
  if (problems.length > 0) { setError(problems.join(' ')); return; }

  printState.base = base;
  inputs.forEach(function (input) { printState.dates[input.dataset.eventId] = input.value; });
  hooks.onDatesConfirmed();
  $('printDateSummary').textContent = '기준 날짜: ' + formatFull(base);
  setError('');
  showStep('choose');
}

// A4 한 장에 카드 4개(2×2). 브라우저가 흐름대로 자르게 두면 카드 높이·프린터 여백에 따라
// 한 장에 2개만 놓이거나 잘리므로, 인쇄 직전에 화면 카드를 복제해 4개씩 "쪽" 단위로
// 다시 묶는다(쪽 높이는 CSS에서 고정). 화면의 원본 카드는 건드리지 않는다.
var CARDS_PER_PAGE = 4;

function buildPrintPages() {
  var cards = Array.prototype.slice.call(document.querySelectorAll('#manualAssignBoards .preview-col, #autoAssignBoards .preview-col'));
  var host = $('printPages');
  host.innerHTML = '';
  var totalPages = Math.ceil(cards.length / CARDS_PER_PAGE);
  for (var i = 0; i < totalPages; i++) {
    var page = document.createElement('div');
    page.className = 'print-page';
    var head = document.createElement('div');
    head.className = 'print-page-head';
    head.textContent = hooks.getAbsentTeacher() + ' 교사 결근 — 변경 시간표' + (totalPages > 1 ? ' (' + (i + 1) + '/' + totalPages + '쪽)' : '');
    var grid = document.createElement('div');
    grid.className = 'print-grid';
    cards.slice(i * CARDS_PER_PAGE, (i + 1) * CARDS_PER_PAGE).forEach(function (c) { grid.appendChild(c.cloneNode(true)); });
    page.appendChild(head);
    page.appendChild(grid);
    host.appendChild(page);
  }
}

// 쪽을 만든 뒤 "최종 변경 시간표"만 남기도록 body 클래스를 얹고 인쇄한다.
// 클래스와 복제한 쪽은 afterprint에서 정리한다.
function printBoards() {
  buildPrintPages();
  $('printDialog').close();
  document.body.classList.add('printing-boards');
  window.print();
}

export function initPrint(h) {
  hooks = h;
  $('printOpenBtn').addEventListener('click', openDialog);
  $('printBaseDate').addEventListener('input', function () {
    if (!dialogData) return;
    refreshUneditedFromBase(firstAbsentDay(dialogData));
  });
  $('printNextBtn').addEventListener('click', confirmDates);
  $('printCancelBtn').addEventListener('click', function () { $('printDialog').close(); });
  $('printCloseBtn').addEventListener('click', function () { $('printDialog').close(); });
  $('printBackBtn').addEventListener('click', function () { setError(''); showStep('date'); });
  $('printBoardsBtn').addEventListener('click', printBoards);
  window.addEventListener('afterprint', function () {
    document.body.classList.remove('printing-boards');
    $('printPages').innerHTML = '';
  });
}
