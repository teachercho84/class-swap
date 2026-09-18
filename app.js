import { STATE } from './state.js';
import {
  parseMatrixSheet, buildTeacherRecords, parseTeacherSubjects, parseSettings,
  buildTeacherScheduleMap, buildClassScheduleMap, buildMoveGroupIndex,
  getRecord, allWeekSlots
} from './data.js';
import {
  findNormalSwapCandidates, findMoveSwapCandidates, findMoveComboCandidates,
  findSubjectSubstituteCandidates, findFallbackSubstituteCandidates,
  cloneScheduleMap, applySwapToWorkingMaps, applyRelocateToWorkingMaps, applySubstituteToWorkingMaps
} from './matching.js';
import { renderBoardInto } from './board-render.js';
import {
  hidePreview, selectMoveSetSwap, selectMoveComboSwap, selectNormalSwap, selectSubstitute
} from './preview.js';

// ---------- render ----------
function showError(msg) {
  var el = document.getElementById('errorBanner');
  el.textContent = msg;
  el.style.display = 'block';
}

function renderTitle() {
  var s = STATE.settings;
  var title = (s.year || '') + '학년도 ' + (s.semester || '') + ' ' + (s.schoolName || '') + ' 수업 시간표 교체';
  document.title = title;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSub').textContent = '칸을 눌러 맞교체·대강 후보를 찾아보세요.';
}

function renderTeacherOptions() {
  var sel = document.getElementById('teacherSelect');
  sel.innerHTML = '';
  STATE.teacherNames.slice().sort(function (a, b) { return a.localeCompare(b, 'ko'); }).forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.disabled = false;
  sel.addEventListener('change', function () {
    STATE.currentTeacher = sel.value;
    renderGrid();
    clearResults();
    renderAbsenceTags();
  });
  if (STATE.teacherNames.length) {
    STATE.currentTeacher = sel.options[0].value;
    sel.value = STATE.currentTeacher;
  }
}

function renderGrid() {
  var table = document.getElementById('boardTable');
  renderBoardInto(table, STATE.dayList, function (day, period) {
    return getRecord(STATE.teacherScheduleMap, STATE.currentTeacher, day, period);
  }, { onCellClick: handleCellClick });
  document.getElementById('appBody').style.display = 'block';
}

function clearResults() {
  var panel = document.getElementById('sidePanel');
  panel.innerHTML = '<div class="placeholder">칸을 클릭하면 교체·대강 후보가 여기에 표시됩니다.</div>';
  hidePreview();
  // 교사 전환·결근 등록/삭제로 이전 배치 결과가 무효해질 수 있으므로 같이 비운다.
  var autoEl = document.getElementById('autoAssignResults');
  if (autoEl) autoEl.innerHTML = '';
  var autoBoardsEl = document.getElementById('autoAssignBoards');
  if (autoBoardsEl) autoBoardsEl.innerHTML = '';
  var manualEl = document.getElementById('manualAssignResults');
  if (manualEl) manualEl.innerHTML = '';
  var manualBoardsEl = document.getElementById('manualAssignBoards');
  if (manualBoardsEl) manualBoardsEl.innerHTML = '';
  manualAssignState = { total: 0, diffsByCtxKey: {} };
}

// ---------- 출장·결근 관리 ----------
// 교사별로 등록해둔 { day, period } 목록. 맞교체/이동수업 후보가 "내가 새로 옮겨가는
// 요일·교시"를 결근일과 겹치지 않게 걸러내는 데 쓰인다(matching.js로 전달).
var ABSENCE_STORAGE_KEY = 'classSwapAbsences';

function currentAbsences() {
  return STATE.absencesByTeacher[STATE.currentTeacher] || [];
}

function loadAbsencesFromStorage() {
  try {
    var raw = localStorage.getItem(ABSENCE_STORAGE_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') STATE.absencesByTeacher = parsed;
  } catch (e) {
    console.warn('[출장·결근] 저장된 데이터를 불러오지 못했습니다:', e);
  }
}

function saveAbsencesToStorage() {
  localStorage.setItem(ABSENCE_STORAGE_KEY, JSON.stringify(STATE.absencesByTeacher));
}

// localStorage.setItem은 아무 화면 반응이 없어서 눌렀는지 안 눌렀는지 헷갈리므로,
// 버튼 라벨을 잠깐 "저장됨"으로 바꿔 눌렸다는 걸 눈에 보이게 한다.
function handleSaveAbsence() {
  saveAbsencesToStorage();
  var btn = document.getElementById('absenceSaveBtn');
  if (btn.dataset.resetTimer) clearTimeout(Number(btn.dataset.resetTimer));
  var original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = '저장됨 ✓';
  var timer = setTimeout(function () {
    btn.textContent = original;
    delete btn.dataset.resetTimer;
  }, 1500);
  btn.dataset.resetTimer = String(timer);
}

function renderAbsenceDayOptions() {
  var sel = document.getElementById('absenceDaySelect');
  sel.innerHTML = '';
  STATE.dayList.forEach(function (day) {
    var opt = document.createElement('option');
    opt.value = day;
    opt.textContent = day + '요일';
    sel.appendChild(opt);
  });
}

// 등록된 결근을 요일별로 묶어 태그로 그린다 — 1~7교시가 다 등록돼 있으면 "OO요일 전체",
// 아니면 "OO요일 3,4,5교시"처럼 표시. 태그의 ✕는 그 요일에 등록된 항목을 전부 지운다.
function renderAbsenceTags() {
  var list = document.getElementById('absenceTagList');
  list.innerHTML = '';
  var byDay = {};
  var order = [];
  currentAbsences().forEach(function (a) {
    if (!byDay[a.day]) { byDay[a.day] = []; order.push(a.day); }
    byDay[a.day].push(a.period);
  });
  order.forEach(function (day) {
    var periods = byDay[day].slice().sort(function (x, y) { return x - y; });
    var label = periods.length >= 7 ? day + '요일 전체' : day + '요일 ' + periods.join(',') + '교시';

    var tag = document.createElement('span');
    tag.className = 'absence-tag';
    var text = document.createElement('span');
    text.textContent = label;
    tag.appendChild(text);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', label + ' 삭제');
    removeBtn.addEventListener('click', function () { removeAbsenceDay(day); });
    tag.appendChild(removeBtn);

    list.appendChild(tag);
  });
}

function removeAbsenceDay(day) {
  var list = STATE.absencesByTeacher[STATE.currentTeacher] || [];
  STATE.absencesByTeacher[STATE.currentTeacher] = list.filter(function (a) { return a.day !== day; });
  renderAbsenceTags();
  clearResults();
}

function handleAddAbsence() {
  var day = document.getElementById('absenceDaySelect').value;
  var checks = document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]');
  var periods = [];
  checks.forEach(function (cb) { if (cb.checked) periods.push(parseInt(cb.value, 10)); });
  if (!day || periods.length === 0) return;

  if (!STATE.absencesByTeacher[STATE.currentTeacher]) STATE.absencesByTeacher[STATE.currentTeacher] = [];
  var list = STATE.absencesByTeacher[STATE.currentTeacher];
  periods.forEach(function (period) {
    var exists = list.some(function (a) { return a.day === day && a.period === period; });
    if (!exists) list.push({ day: day, period: period });
  });
  renderAbsenceTags();
  clearResults();
}

// 초기화 버튼: 대체 배정 결과뿐 아니라 결근 등록 폼에 남아있는 요일/교시 선택도 비운다.
function resetAssignPanel() {
  clearResults();
  document.getElementById('absenceDaySelect').selectedIndex = 0;
  document.getElementById('absencePeriodAll').checked = false;
  document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]').forEach(function (cb) {
    cb.checked = false;
  });
}

function wireAbsencePanel() {
  document.getElementById('absenceAddBtn').addEventListener('click', handleAddAbsence);
  document.getElementById('absenceSaveBtn').addEventListener('click', handleSaveAbsence);
  document.getElementById('autoAssignBtn').addEventListener('click', runAutoAssign);
  document.getElementById('manualAssignBtn').addEventListener('click', renderManualAssignList);
  document.getElementById('assignResetBtn').addEventListener('click', resetAssignPanel);

  var allBox = document.getElementById('absencePeriodAll');
  var checks = document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]');
  allBox.addEventListener('change', function () {
    checks.forEach(function (cb) { cb.checked = allBox.checked; });
  });
}

// ---------- 결근 자동 배정 ----------
// 등록된 결근 요일·교시에 걸리는 현재 교사의 수업을 전부 찾아, 각각 맞교체·이동수업
// (preferSubstitute면 대강부터)·대강 순으로 맨 처음 후보를 자동 선택해 한 번에
// 보여준다. 이 앱은 실제로 저장/반영하지 않으므로 결과는 화면 요약일 뿐이고, STATE의
// 진짜 스케줄 맵은 건드리지 않는다 — 이번 배치 계산 전용 사본(teacherMap/classMap)에만
// 반영해가며 다음 수업을 찾는다(안 그러면 같은 사람이 두 자리에 겹쳐 배정될 수 있음).
function findAbsenceAffectedClasses(teacher) {
  var absences = STATE.absencesByTeacher[teacher] || [];
  var result = [];
  STATE.dayList.forEach(function (day) {
    for (var period = 1; period <= 7; period++) {
      var isAbsent = absences.some(function (a) { return a.day === day && a.period === period; });
      if (!isAbsent) continue;
      var rec = getRecord(STATE.teacherScheduleMap, teacher, day, period);
      if (!rec || rec.isFree || rec.isChangChe) continue;
      result.push({ teacher: rec.teacher, day: rec.day, period: rec.period, subject: rec.subject, className: rec.className, moveGroupId: rec.moveGroupId });
    }
  });
  return result;
}

// 그 교사가 사본(teacherMap)에서 해당 요일에 이미 몇 개의 수업을 갖고 있는지 —
// 새로 배정받는 쪽은 항상 ctx.day에 수업이 하나 늘어나므로, 후보가 여럿일 때 이
// 값이 가장 작은 쪽을 우선 선택해 특정 교사가 하루에 몰리는 걸 완화한다.
function countClassesOnDay(teacherMap, teacher, day) {
  var daySchedule = teacherMap[teacher] && teacherMap[teacher][day];
  if (!daySchedule) return 0;
  var count = 0;
  for (var period = 1; period <= 7; period++) {
    var rec = daySchedule[period];
    if (rec && !rec.isFree && !rec.isChangChe) count++;
  }
  return count;
}

function pickLeastLoaded(items, teacherMap, day, getTeacherName) {
  var best = items[0];
  var bestLoad = countClassesOnDay(teacherMap, getTeacherName(best), day);
  for (var i = 1; i < items.length; i++) {
    var load = countClassesOnDay(teacherMap, getTeacherName(items[i]), day);
    if (load < bestLoad) { best = items[i]; bestLoad = load; }
  }
  return best;
}

// 한 수업(ctx)의 대체를 찾아 사본(teacherMap/classMap)에 반영하고, 화면에 보여줄
// 설명 문구를 돌려준다(후보가 전혀 없으면 null).
// 반환값은 { text, diffs } — text는 목록에 보여줄 문구(후보 없으면 null), diffs는
// "누구의 어느 칸이 어떻게 바뀌는지"(preview.js의 removals/additions/covered와 같은
// 뜻의 added/removed/covered)를 담아, 배정이 다 끝난 뒤 관련 교사들의 전체 시간표를
// 그려서 눈으로 확인할 수 있게 한다.
// 세 가지 diff 모양 — 자동 배정과 수동 선택(아래 renderResults)이 공유한다.
// a, b: { teacher, day, period, subject, className }.
function buildSwapDiff(a, b) {
  return [
    { teacher: a.teacher, day: a.day, period: a.period, type: 'removed' },
    { teacher: a.teacher, day: b.day, period: b.period, type: 'added', subject: a.subject, className: a.className },
    { teacher: b.teacher, day: b.day, period: b.period, type: 'removed' },
    { teacher: b.teacher, day: a.day, period: a.period, type: 'added', subject: b.subject, className: b.className }
  ];
}
function buildRelocateDiff(ctx, targetDay, targetPeriod) {
  return [
    { teacher: ctx.teacher, day: ctx.day, period: ctx.period, type: 'removed' },
    { teacher: ctx.teacher, day: targetDay, period: targetPeriod, type: 'added', subject: ctx.subject, className: ctx.className }
  ];
}
function buildSubstituteDiff(ctx, substituteTeacher) {
  return [
    { teacher: ctx.teacher, day: ctx.day, period: ctx.period, type: 'covered' },
    { teacher: substituteTeacher, day: ctx.day, period: ctx.period, type: 'added', subject: ctx.subject, className: ctx.className }
  ];
}

function resolveAutoAssignFor(ctx, absences, teacherMap, classMap) {
  if (!STATE.preferSubstitute) {
    if (ctx.moveGroupId) {
      var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
      var setSwaps = findMoveSwapCandidates(ctx, STATE.moveGroupIndex, teacherMap, classMap, absences).setSwaps;
      if (setSwaps.length > 0) {
        // 세트간 교체는 ctx 본인만 이동시키는 단순화라(2부 참고) 상대 후보 교사가
        // 없어 부담 비교 대상이 없다 — 그대로 첫 옵션을 쓴다.
        var s = setSwaps[0];
        applyRelocateToWorkingMaps(teacherMap, classMap, ctx, s.targetDay, s.targetPeriod);
        return {
          text: '세트간 교체 — ' + s.targetDay + '요일 ' + s.targetPeriod + '교시로 이동',
          diffs: buildRelocateDiff(ctx, s.targetDay, s.targetPeriod)
        };
      }
      var combos = findMoveComboCandidates(ctx, groupA, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      var relevantCombos = combos.map(function (combo) {
        var pair = combo.pairs.filter(function (p) { return p.member.teacher === ctx.teacher; })[0];
        return pair ? { combo: combo, pair: pair } : null;
      }).filter(function (x) { return x; });
      if (relevantCombos.length > 0) {
        var picked = pickLeastLoaded(relevantCombos, teacherMap, ctx.day, function (x) { return x.pair.candidate.teacher; });
        var pair = picked.pair;
        applySwapToWorkingMaps(teacherMap, classMap,
          { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: pair.member.subject, className: pair.member.className },
          { teacher: pair.candidate.teacher, day: pair.candidate.day, period: pair.candidate.period, subject: pair.candidate.subject, className: pair.candidate.className }
        );
        return {
          text: pair.candidate.teacher + ' 교사 (개별 조합 교체, ' + pair.candidate.day + '요일 ' + pair.candidate.period + '교시)',
          diffs: buildSwapDiff(
            { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: pair.member.subject, className: pair.member.className },
            { teacher: pair.candidate.teacher, day: pair.candidate.day, period: pair.candidate.period, subject: pair.candidate.subject, className: pair.candidate.className }
          )
        };
      }
    } else {
      var normal = findNormalSwapCandidates(ctx, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      if (normal.length > 0) {
        var c = pickLeastLoaded(normal, teacherMap, ctx.day, function (x) { return x.teacher; });
        applySwapToWorkingMaps(teacherMap, classMap,
          { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className },
          { teacher: c.teacher, day: c.day, period: c.period, subject: c.subject, className: c.className }
        );
        return {
          text: c.teacher + ' 교사 (맞교체, ' + c.day + '요일 ' + c.period + '교시)',
          diffs: buildSwapDiff(
            { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className },
            { teacher: c.teacher, day: c.day, period: c.period, subject: c.subject, className: c.className }
          )
        };
      }
    }
  }

  var tier2 = findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, teacherMap, STATE.teacherNames);
  if (tier2.length > 0) {
    var pick2 = pickLeastLoaded(tier2, teacherMap, ctx.day, function (x) { return x.teacher; });
    applySubstituteToWorkingMaps(teacherMap, ctx, pick2.teacher);
    return { text: pick2.teacher + ' 교사 (대강)', diffs: buildSubstituteDiff(ctx, pick2.teacher) };
  }
  var tier3 = findFallbackSubstituteCandidates(ctx, teacherMap, STATE.teacherNames);
  if (tier3.length > 0) {
    var pick3 = pickLeastLoaded(tier3, teacherMap, ctx.day, function (x) { return x.teacher; });
    applySubstituteToWorkingMaps(teacherMap, ctx, pick3.teacher);
    return { text: pick3.teacher + ' 교사 (대강, 참고용)', diffs: buildSubstituteDiff(ctx, pick3.teacher) };
  }
  return { text: null, diffs: [] };
}

// diffsByTeacher의 { 'day_period': {type, subject?, className?} } 하나를 교사 이름을
// 받아 .preview-col 모양(제목+미리보기 표)의 카드로 그린다 — preview.js의 미리보기
// 카드와 같은 스타일을 그대로 재사용. working-copy 최종 상태를 그대로 읽지 않고
// STATE의 원본 스케줄을 기본으로 삼는다 — working-copy는 "제거"를 실제로 그 자리를
// 지워버리는 식으로 구현돼 있어서(matching.js), 그대로 읽으면 removed 자리가 그냥
// 빈 칸으로 보인다. preview.js의 computeModifiedSchedule과 똑같이, 원본은 그대로
// 두고(줄표시로 보이게) added 자리만 diff에 담아온 새 내용으로 덮어쓴다.
function buildScheduleCard(title, teacher, dayDiff) {
  var col = document.createElement('div');
  col.className = 'preview-col';
  var titleEl = document.createElement('div');
  titleEl.className = 'preview-col-title';
  titleEl.textContent = title;
  var scroll = document.createElement('div');
  scroll.className = 'board-scroll';
  var table = document.createElement('table');
  table.className = 'board mini-board';
  scroll.appendChild(table);
  col.appendChild(titleEl);
  col.appendChild(scroll);
  renderBoardInto(table, STATE.dayList, function (day, period) {
    var diffEntry = dayDiff[day + '_' + period];
    if (diffEntry && diffEntry.type === 'added') {
      return { teacher: teacher, day: day, period: period, subject: diffEntry.subject, className: diffEntry.className, isFree: false, isChangChe: false, moveGroupId: null };
    }
    return getRecord(STATE.teacherScheduleMap, teacher, day, period);
  }, { diffMap: dayDiff });
  return col;
}

function runAutoAssign() {
  clearResults(); // 수동 모드로 쌓인 결과가 같이 남아있지 않도록 먼저 싹 지운다
  var listEl = document.getElementById('autoAssignResults');
  var boardsEl = document.getElementById('autoAssignBoards');

  var affected = findAbsenceAffectedClasses(STATE.currentTeacher);
  if (affected.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '등록된 결근에 해당하는 수업이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  var absences = currentAbsences();
  var teacherMap = cloneScheduleMap(STATE.teacherScheduleMap);
  var classMap = cloneScheduleMap(STATE.classScheduleMap);
  var diffsByTeacher = {};

  affected.forEach(function (ctx) {
    var result = resolveAutoAssignFor(ctx, absences, teacherMap, classMap);

    var row = document.createElement('div');
    row.className = 'auto-assign-row';
    var label = document.createElement('div');
    label.className = 'auto-assign-label';
    label.textContent = ctx.day + '요일 ' + ctx.period + '교시 · ' + ctx.subject + (ctx.className ? ' · ' + ctx.className + '반' : '');
    row.appendChild(label);
    var outcome = document.createElement('div');
    outcome.className = 'auto-assign-outcome' + (result.text ? '' : ' auto-assign-outcome-empty');
    outcome.textContent = '→ ' + (result.text || '후보 없음');
    row.appendChild(outcome);
    listEl.appendChild(row);

    result.diffs.forEach(function (d) {
      if (!diffsByTeacher[d.teacher]) diffsByTeacher[d.teacher] = {};
      diffsByTeacher[d.teacher][d.day + '_' + d.period] = { type: d.type, subject: d.subject, className: d.className };
    });
  });

  Object.keys(diffsByTeacher).forEach(function (teacher) {
    var title = teacher + ' 교사' + (teacher === STATE.currentTeacher ? ' (결근)' : '');
    boardsEl.appendChild(buildScheduleCard(title, teacher, diffsByTeacher[teacher]));
  });
}

// 수동 모드 진행 상황 — 영향받는 수업 총 개수와, 지금까지 실제로 후보를 선택한
// 항목들의 diff를 day_period 키로 모아둔다. 전부 선택되면(개수가 같아지면) 자동
// 모드와 같은 방식으로 반영된 전체 시간표 카드를 그린다.
var manualAssignState = { total: 0, diffsByCtxKey: {} };

// "수동으로 대체 찾기": 영향받는 수업을 목록으로 보여주고, 하나를 클릭하면 그리드에서
// 그 칸을 직접 클릭한 것과 완전히 동일하게 동작한다(handleCellClick 재사용 — 새 로직
// 없음). 후보를 실제로 선택하면 recordManualResolution이 그 항목에 체크 표시를 남기고
// diff를 기록한다 — 전부 끝나면 전체 시간표를 보여준다.
function renderManualAssignList() {
  clearResults(); // 자동 모드로 쌓인 결과가 같이 남아있지 않도록 먼저 싹 지운다
  var listEl = document.getElementById('manualAssignResults');

  var affected = findAbsenceAffectedClasses(STATE.currentTeacher);
  manualAssignState = { total: affected.length, diffsByCtxKey: {} };
  if (affected.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '등록된 결근에 해당하는 수업이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  affected.forEach(function (ctx) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'manual-assign-row';
    row.dataset.day = ctx.day;
    row.dataset.period = ctx.period;

    var label = document.createElement('span');
    label.className = 'manual-assign-label';
    label.textContent = ctx.day + '요일 ' + ctx.period + '교시 · ' + ctx.subject + (ctx.className ? ' · ' + ctx.className + '반' : '');
    row.appendChild(label);

    var check = document.createElement('span');
    check.className = 'manual-assign-check';
    check.textContent = '✓';
    row.appendChild(check);

    row.addEventListener('click', function () {
      var cellEl = document.querySelector('#boardTable td[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
      var rec = getRecord(STATE.teacherScheduleMap, ctx.teacher, ctx.day, ctx.period);
      if (cellEl && rec) handleCellClick(rec, cellEl);
    });

    listEl.appendChild(row);
  });
}

function markManualAssignResolved(ctx) {
  if (!ctx) return;
  var listEl = document.getElementById('manualAssignResults');
  if (!listEl) return;
  var row = listEl.querySelector('[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
  if (row) row.classList.add('manual-assign-resolved');
}

// 실제로 후보를 골랐을 때 makeCandListItem의 클릭 핸들러가 호출한다 — 체크 표시 +
// 진행 상황 기록, 다 채워지면 전체 시간표를 그린다.
function recordManualResolution(ctx, diffs) {
  if (!ctx || !manualAssignState.total) return;
  markManualAssignResolved(ctx);
  manualAssignState.diffsByCtxKey[ctx.day + '_' + ctx.period] = diffs || [];
  if (Object.keys(manualAssignState.diffsByCtxKey).length === manualAssignState.total) {
    renderManualAssignBoards();
  }
}

function renderManualAssignBoards() {
  var boardsEl = document.getElementById('manualAssignBoards');
  boardsEl.innerHTML = '';
  var diffsByTeacher = {};
  Object.keys(manualAssignState.diffsByCtxKey).forEach(function (key) {
    manualAssignState.diffsByCtxKey[key].forEach(function (d) {
      if (!diffsByTeacher[d.teacher]) diffsByTeacher[d.teacher] = {};
      diffsByTeacher[d.teacher][d.day + '_' + d.period] = { type: d.type, subject: d.subject, className: d.className };
    });
  });
  Object.keys(diffsByTeacher).forEach(function (teacher) {
    var title = teacher + ' 교사' + (teacher === STATE.currentTeacher ? ' (결근)' : '');
    boardsEl.appendChild(buildScheduleCard(title, teacher, diffsByTeacher[teacher]));
  });
}

// ---------- 표시 옵션: 대강 우선 ----------
function wireOptionsPanel() {
  document.getElementById('preferSubstituteCheckbox').addEventListener('change', function (e) {
    STATE.preferSubstitute = e.target.checked;
    clearResults(); // 이미 열려있는 결과는 새 우선순위 기준으로 다시 클릭해야 하므로 접어둠
  });
}

var lastSelectedCell = null;
// 결근 자동 배정의 "수동으로 대체 찾기" 목록이 체크 표시를 남길 때, 지금 어떤
// 수업(day/period)이 선택돼 있는지 알아야 한다 — 후보 선택은 makeCandListItem의
// 클릭 핸들러 한 곳에서 일어나므로 거기서 이 값을 참조한다.
var lastSelectedCtx = null;

function handleCellClick(rec, cellEl) {
  if (lastSelectedCell) lastSelectedCell.classList.remove('cell-selected');
  cellEl.classList.add('cell-selected');
  lastSelectedCell = cellEl;
  hidePreview(); // 새 셀을 클릭하면 이전 미리보기는 더 이상 유효하지 않으므로 접어둠

  var ctx = { teacher: rec.teacher, day: rec.day, period: rec.period, subject: rec.subject, className: rec.className, moveGroupId: rec.moveGroupId };
  lastSelectedCtx = ctx;

  // "대강 우선"이 켜져 있으면 1순위(맞교체·이동수업) 계산·표시를 아예 건너뛰고
  // 곧장 2·3순위 폴백으로 간다.
  if (!STATE.preferSubstitute) {
    var absences = currentAbsences();
    var tier1, tier1NonEmpty;
    if (ctx.moveGroupId) {
      var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
      var setSwaps = findMoveSwapCandidates(ctx, STATE.moveGroupIndex, STATE.teacherScheduleMap, STATE.classScheduleMap, absences).setSwaps;
      var combos = findMoveComboCandidates(ctx, groupA, STATE.teacherScheduleMap, STATE.teacherNames, STATE.weekSlots, absences);
      tier1 = { setSwaps: setSwaps, combos: combos };
      tier1NonEmpty = setSwaps.length > 0 || combos.length > 0;
    } else {
      tier1 = findNormalSwapCandidates(ctx, STATE.teacherScheduleMap, STATE.teacherNames, STATE.weekSlots, absences);
      tier1NonEmpty = tier1.length > 0;
    }
    if (tier1NonEmpty) { renderResults(ctx, 1, tier1); return; }
  }

  var tier2 = findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, STATE.teacherScheduleMap, STATE.teacherNames);
  if (tier2.length > 0) { renderResults(ctx, 2, tier2); return; }

  var tier3 = findFallbackSubstituteCandidates(ctx, STATE.teacherScheduleMap, STATE.teacherNames);
  renderResults(ctx, 3, tier3);
}

// 후보 한 줄(<li>)을 만든다. onSelect가 있으면 클릭 가능한 버튼으로, 없으면(이동수업처럼
// 선택해서 미리보기를 만들 수 없는 경우) 그냥 텍스트로 렌더링.
function makeCandListItem(whoText, whereText, onSelect, diffs) {
  var li = document.createElement('li');
  if (onSelect) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cand-btn';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = whoText;
    btn.appendChild(who);
    if (whereText) {
      var where = document.createElement('span');
      where.className = 'where';
      where.textContent = whereText;
      btn.appendChild(where);
    }
    btn.addEventListener('click', function () {
      var list = btn.closest('.cand-list');
      if (list) {
        var prev = list.querySelector('.is-selected');
        if (prev) prev.classList.remove('is-selected');
      }
      btn.classList.add('is-selected');
      onSelect();
      recordManualResolution(lastSelectedCtx, diffs); // "수동으로 대체 찾기" 진행 기록
    });
    li.appendChild(btn);
  } else {
    var whoSpan = document.createElement('span');
    whoSpan.className = 'who';
    whoSpan.textContent = whoText;
    li.appendChild(whoSpan);
    if (whereText) {
      var whereSpan = document.createElement('span');
      whereSpan.className = 'where';
      whereSpan.textContent = whereText;
      li.appendChild(whereSpan);
    }
  }
  return li;
}

function appendTierBlock(container, tierClass, headingText, noteText, items) {
  var tierDiv = document.createElement('div');
  tierDiv.className = 'tier ' + tierClass;
  var h3 = document.createElement('h3');
  h3.textContent = headingText;
  tierDiv.appendChild(h3);
  if (noteText) {
    var note = document.createElement('div');
    note.className = 'note';
    note.textContent = noteText;
    tierDiv.appendChild(note);
  }
  if (items.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '가능한 교체·대강 후보가 없습니다.';
    tierDiv.appendChild(empty);
  } else {
    var ul = document.createElement('ul');
    ul.className = 'cand-list';
    items.forEach(function (li) { ul.appendChild(li); });
    tierDiv.appendChild(ul);
  }
  container.appendChild(tierDiv);
}

// combo.pairs(세트원 단위, 반이 같으면 같은 candidate가 여러 번 나타남)를 후보 목록 표시용으로
// 다시 반(className) 단위로 묶는다 — 반 하나에 세트원이 여러 명이어도 대체 교사는 한 번만
// 언급되도록.
function groupComboPairsByClass(pairs) {
  var order = [];
  var byClass = {};
  pairs.forEach(function (p) {
    var cn = p.member.className;
    if (!byClass[cn]) { byClass[cn] = { className: cn, members: [], candidate: p.candidate }; order.push(cn); }
    byClass[cn].members.push(p.member);
  });
  return order.map(function (cn) { return byClass[cn]; });
}

// 오른쪽 후보 패널에 후보 목록을 그린다. 1순위(일반)·2·3순위 후보는 클릭하면 선택되어
// 그리드 하단에 "교체/대강 후 시간표" 미리보기가 뜬다. 이동수업 세트(1순위, moveGroupId
// 있는 경우)는 교사가 여러 명 엮여 있어 미리보기 대상에서 제외 — 텍스트로만 보여준다.
function renderResults(ctx, tier, data) {
  var body = document.getElementById('sidePanel');
  body.innerHTML = '';

  var titleDiv = document.createElement('div');
  titleDiv.className = 'results-title';
  titleDiv.textContent = ctx.teacher + ' 교사 — ' + ctx.day + '요일 ' + ctx.period + '교시';
  body.appendChild(titleDiv);

  var metaDiv = document.createElement('div');
  metaDiv.className = 'results-meta';
  metaDiv.textContent = ctx.subject + (ctx.className ? ' · ' + ctx.className + '반' : '') + (ctx.moveGroupId ? ' · 이동수업 세트' : '');
  body.appendChild(metaDiv);

  if (tier === 1 && ctx.moveGroupId) {
    var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
    var items0 = [];
    data.setSwaps.forEach(function (s) {
      var subjList = s.otherMembers.map(function (m) { return m.subject; }).join('/');
      items0.push(makeCandListItem('세트간 교체', '"' + subjList + '" 세트 ↔ ' + s.targetDay + '요일 ' + s.targetPeriod + '교시', function () {
        selectMoveSetSwap(ctx, groupA, s);
      }, buildRelocateDiff(ctx, s.targetDay, s.targetPeriod)));
    });
    data.combos.forEach(function (combo) {
      var classText = groupComboPairsByClass(combo.pairs).map(function (g) {
        var memberText = g.members.map(function (m) { return m.teacher + '(' + m.subject + ')'; }).join('+');
        return g.className + '반 [' + memberText + '] ↔ ' + g.candidate.teacher + ' 교사';
      }).join(' · ');
      var whereText = combo.targetDay + '요일 ' + combo.targetPeriod + '교시로 이동 — ' + classText;
      // 개별 조합 교체는 세트 안 여러 반(멤버)이 동시에 움직이므로, 각 pair(멤버 ↔
      // 후보)의 diff를 전부 합쳐야 전체 시간표에 다 반영된다.
      var comboDiffs = [];
      combo.pairs.forEach(function (p) {
        comboDiffs = comboDiffs.concat(buildSwapDiff(
          { teacher: p.member.teacher, day: ctx.day, period: ctx.period, subject: p.member.subject, className: p.member.className },
          { teacher: p.candidate.teacher, day: p.candidate.day, period: p.candidate.period, subject: p.candidate.subject, className: p.candidate.className }
        ));
      });
      items0.push(makeCandListItem('개별 조합 교체', whereText, function () {
        selectMoveComboSwap(ctx, groupA, combo);
      }, comboDiffs));
    });
    appendTierBlock(body, 'tier-1', '1순위: 세트 이동/교체 가능', null, items0);
  } else if (tier === 1) {
    var items1 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', c.day + '요일 ' + c.period + '교시 (' + c.className + '반 ' + c.subject + ')', function () {
        selectNormalSwap(ctx, c);
      }, buildSwapDiff(
        { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className },
        { teacher: c.teacher, day: c.day, period: c.period, subject: c.subject, className: c.className }
      ));
    });
    appendTierBlock(body, 'tier-1', '1순위: 맞교체 가능', null, items1);
  } else if (tier === 2) {
    var note2 = ctx.subject.trim() === '진로' ? '담당교과 무관 — 진로 수업은 아무 교사나 대강 가능합니다.' : null;
    var items2 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      }, buildSubstituteDiff(ctx, c.teacher));
    });
    appendTierBlock(body, 'tier-2', '2순위: 동교과 대강 후보', note2, items2);
  } else if (tier === 3) {
    var items3 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      }, buildSubstituteDiff(ctx, c.teacher));
    });
    appendTierBlock(body, 'tier-3', '3순위: 전체 대강 후보 — 교과 무관, 참고용', '교과가 다를 수 있으니 참고만 하세요.', items3);
  }
}

// ---------- cross validation ----------
function crossValidateTeacherNames() {
  var subjTeacherNames = Object.keys(STATE.teacherSubjects);
  var scheduleTeacherNames = STATE.teacherNames;
  var onlyInSchedule = scheduleTeacherNames.filter(function (n) { return subjTeacherNames.indexOf(n) === -1; });
  var onlyInSubjects = subjTeacherNames.filter(function (n) { return scheduleTeacherNames.indexOf(n) === -1; });
  if (onlyInSchedule.length) console.warn('[검증] 전체 교사 시간표에만 있는 교사명:', onlyInSchedule);
  if (onlyInSubjects.length) console.warn('[검증] 교사_담당교과에만 있는 교사명:', onlyInSubjects);
}

// ---------- init ----------
function init() {
  fetch('data.xlsx')
    .then(function (resp) {
      if (!resp.ok) throw new Error('data.xlsx 파일을 불러올 수 없습니다 (HTTP ' + resp.status + ').');
      return resp.arrayBuffer();
    })
    .then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' });
      function sheetRows(name) {
        if (wb.Sheets[name] === undefined) throw new Error('필수 시트를 찾을 수 없습니다: ' + name);
        return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
      }

      STATE.settings = parseSettings(sheetRows('설정'));
      STATE.teacherSubjects = parseTeacherSubjects(sheetRows('교사_담당교과'));

      var teacherParsed = parseMatrixSheet(sheetRows('전체 교사 시간표'));

      STATE.dayList = teacherParsed.dayList || ['월', '화', '수', '목', '금'];
      STATE.records = buildTeacherRecords(teacherParsed.blocks);
      STATE.teacherScheduleMap = buildTeacherScheduleMap(STATE.records);
      STATE.classScheduleMap = buildClassScheduleMap(STATE.records);
      STATE.moveGroupIndex = buildMoveGroupIndex(STATE.records);
      STATE.teacherNames = Object.keys(STATE.teacherScheduleMap);
      STATE.weekSlots = allWeekSlots(STATE.dayList);

      crossValidateTeacherNames();

      renderTitle();
      renderTeacherOptions();
      renderGrid();
      renderAbsenceDayOptions();
      renderAbsenceTags();
    })
    .catch(function (err) {
      console.error(err);
      showError('데이터를 불러오는 중 문제가 발생했습니다.\n' + err.message + '\n\ndata.xlsx 파일이 index.html과 같은 위치에 있는지 확인해주세요.');
    });
}

function wireStaticUI() {
  document.getElementById('previewCloseBtn').addEventListener('click', hidePreview);
  wireAbsencePanel();
  wireOptionsPanel();
}

document.addEventListener('DOMContentLoaded', function () {
  wireStaticUI();
  loadAbsencesFromStorage();
  init();
});
