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
import { collectChangeData, getCardDateInfo, initPrint, resetPrintState } from './print.js';
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
  document.getElementById('pageSub').textContent = '';
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
    resetAbsenceForm();
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
  manualWorkingState = { order: [], byKey: {}, teacherMap: null, classMap: null, conflicts: [] };
  resetPrintState();
  updateAssignResultVisibility();
}

// #assignResultSection은 CSS만으로 "비어있으면 숨기기"를 하면(:has()) 자동 찾기처럼
// DOM을 반복 갱신하는 동안 매번 재평가되어 눈에 띄게 느려진다 — 그 대신 보드가 실제로
// 채워지고/비워지는 지점에서 이 함수로 직접 display를 토글한다.
function updateAssignResultVisibility() {
  var section = document.getElementById('assignResultSection');
  var manual = document.getElementById('manualAssignBoards');
  var auto = document.getElementById('autoAssignBoards');
  var hasContent = (manual && manual.children.length > 0) || (auto && auto.children.length > 0);
  section.style.display = hasContent ? 'block' : 'none';
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

function renderAbsenceDayOptions() {
  var sel = document.getElementById('absenceDaySelect');
  sel.innerHTML = '';
  STATE.dayList.forEach(function (day) {
    var opt = document.createElement('option');
    opt.value = day;
    opt.textContent = day + '요일';
    sel.appendChild(opt);
  });

  // 요일 select는 실제 값 저장소로만 쓰고, 화면에는 교시 체크박스와 같은 톤의
  // 필 버튼으로 보여준다 — 하나만 활성화되는 단일 선택(라디오 방식)을 유지한다.
  var picks = document.getElementById('absenceDayPicks');
  picks.innerHTML = '';
  STATE.dayList.forEach(function (day, i) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'absence-day-pick' + (i === 0 ? ' is-active' : '');
    btn.textContent = day + '요일';
    btn.addEventListener('click', function () {
      sel.value = day;
      picks.querySelectorAll('.absence-day-pick').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
    });
    picks.appendChild(btn);
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
  saveAbsencesToStorage();
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
  saveAbsencesToStorage();
}

// 결근 등록 폼(요일 select + 교시 체크박스)만 처음 상태로 되돌린다 — 등록된 결근
// 데이터(STATE.absencesByTeacher)는 건드리지 않는다. 교사 전환 시 이전 교사가
// 선택해두었던 폼 상태가 그대로 남아 보이는 것을 막기 위해 쓰인다.
function resetAbsenceForm() {
  document.getElementById('absenceDaySelect').selectedIndex = 0;
  document.getElementById('absencePeriodAll').checked = false;
  document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]').forEach(function (cb) {
    cb.checked = false;
  });
  var picks = document.querySelectorAll('#absenceDayPicks .absence-day-pick');
  picks.forEach(function (b, i) { b.classList.toggle('is-active', i === 0); });
}

// 초기화 버튼: 현재 교사에 대해 패널 전체를 처음 상태로 되돌린다 — 대체 배정 결과,
// 결근 등록 폼의 요일/교시 선택, 추가해둔 결근 태그, 그리고 storage에 저장된 값까지
// 전부 지운다.
function resetAssignPanel() {
  clearResults();
  resetAbsenceForm();
  STATE.absencesByTeacher[STATE.currentTeacher] = [];
  renderAbsenceTags();
  saveAbsencesToStorage();
}

function wireAbsencePanel() {
  document.getElementById('absenceAddBtn').addEventListener('click', handleAddAbsence);
  document.getElementById('autoAssignBtn').addEventListener('click', runAutoAssign);
  document.getElementById('manualAssignBtn').addEventListener('click', renderManualAssignList);
  document.getElementById('assignResetBtn').addEventListener('click', resetAssignPanel);

  var allBox = document.getElementById('absencePeriodAll');
  var checks = document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]');
  allBox.addEventListener('change', function () {
    checks.forEach(function (cb) { cb.checked = allBox.checked; });
  });
}

// ---------- 결근 자동/수동 배정 ----------
// 등록된 결근 요일·교시에 걸리는 현재 교사의 수업을 전부 찾아 슬롯 목록으로 보여준다.
// 자동 배정은 각 슬롯의 첫 후보를 곧바로 골라주고, 수동 배정은 사용자가 슬롯을 클릭해
// 직접 후보를 고른다 — 어느 쪽이든 실제 STATE 스케줄 맵은 건드리지 않고, 이번 배치
// 전용 작업 사본(manualWorkingState)에만 반영해가며 다음 슬롯을 계산한다. 그래서 슬롯
// 하나의 선택이 다른 슬롯(먼저 확정됐든, 자동으로 채워졌든)의 후보 계산에도 그대로
// 반영되고, 나중 편집으로 이전 선택이 더 이상 유효하지 않게 되면 충돌(⚠)로 표시된다.
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

// ---------- 슬롯 선택을 작업 사본에 적용/검증하는 공용 factory ----------
// 각 factory는 { validate(tm,cm), apply(tm,cm), diffs }를 돌려준다. validate는 이
// 선택이 주어진 작업 사본 기준으로 "아직도 유효한 후보인지"를 원래 찾기에 썼던
// find* 함수를 그대로 재실행해서 확인한다 — 검증 로직을 따로 두지 않고 탐색
// 로직 자체를 진실의 근원으로 재사용한다. apply는 matching.js의 기존
// working-copy 헬퍼를 그대로 쓴다. 자동 배정(resolveAutoAssignFor)과 수동 선택
// (renderResults)이 이 네 factory를 동일하게 사용해 두 흐름이 같은 작업 사본
// 상태(manualWorkingState)를 공유할 수 있게 한다.
function buildNormalSwapEntry(ctx, c, absences) {
  var a = { teacher: ctx.teacher, day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className };
  var b = { teacher: c.teacher, day: c.day, period: c.period, subject: c.subject, className: c.className };
  return {
    validate: function (tm, cm) {
      var cands = findNormalSwapCandidates(ctx, tm, STATE.teacherNames, STATE.weekSlots, absences);
      return cands.some(function (x) { return x.teacher === c.teacher && x.day === c.day && x.period === c.period; });
    },
    apply: function (tm, cm) { applySwapToWorkingMaps(tm, cm, a, b); },
    diffs: buildSwapDiff(a, b)
  };
}

// 멤버 배열 안에서 ctx(본인) 항목을 맨 앞으로 옮긴다 — 여러 교사가 한꺼번에 바뀔 때
// diff 배열도 이 순서를 따르므로, 나중에 diffsByTeacher에 쌓일 때 본인 카드가 항상
// 맨 앞에 오게 된다.
function orderWithSelfFirst(members, teacherName) {
  return members.slice().sort(function (a, b) {
    var aMine = a.teacher === teacherName;
    var bMine = b.teacher === teacherName;
    if (aMine && !bMine) return -1;
    if (!aMine && bMine) return 1;
    return 0;
  });
}

// 세트간 교체는 세트 A 전체(ctx 포함 여러 명일 수 있음)와 세트 B 전체가 통째로 서로의
// 시간대로 맞바꾸는 것이다(selectMoveSetSwap의 미리보기가 이미 이렇게 보여준다) — 그래서
// 배정을 실제로 반영/기록할 때도 ctx 한 명이 아니라 두 세트 전원의 변화를 다뤄야 한다.
function buildSetSwapEntry(ctx, groupA, s, absences) {
  var orderedA = orderWithSelfFirst(groupA.members, ctx.teacher);
  var membersB = s.otherMembers;
  var diffs = [];
  orderedA.forEach(function (m) {
    diffs = diffs.concat(buildRelocateDiff(
      { teacher: m.teacher, day: ctx.day, period: ctx.period, subject: m.subject, className: m.className },
      s.targetDay, s.targetPeriod
    ));
  });
  membersB.forEach(function (m) {
    diffs = diffs.concat(buildRelocateDiff(
      { teacher: m.teacher, day: s.targetDay, period: s.targetPeriod, subject: m.subject, className: m.className },
      ctx.day, ctx.period
    ));
  });
  return {
    validate: function (tm, cm) {
      var setSwaps = findMoveSwapCandidates(ctx, STATE.moveGroupIndex, tm, cm, absences).setSwaps;
      return setSwaps.some(function (x) { return x.otherGroupId === s.otherGroupId && x.targetDay === s.targetDay && x.targetPeriod === s.targetPeriod; });
    },
    apply: function (tm, cm) {
      orderedA.forEach(function (m) {
        applyRelocateToWorkingMaps(tm, cm, { teacher: m.teacher, day: ctx.day, period: ctx.period, subject: m.subject, className: m.className }, s.targetDay, s.targetPeriod);
      });
      membersB.forEach(function (m) {
        applyRelocateToWorkingMaps(tm, cm, { teacher: m.teacher, day: s.targetDay, period: s.targetPeriod, subject: m.subject, className: m.className }, ctx.day, ctx.period);
      });
    },
    diffs: diffs
  };
}

function buildComboEntry(ctx, groupA, combo, absences) {
  var orderedPairs = orderWithSelfFirst(combo.pairs.map(function (p) { return p.member; }), ctx.teacher)
    .map(function (member) { return combo.pairs.filter(function (p) { return p.member === member; })[0]; });
  var comboDiffs = [];
  orderedPairs.forEach(function (p) {
    comboDiffs = comboDiffs.concat(buildSwapDiff(
      { teacher: p.member.teacher, day: ctx.day, period: ctx.period, subject: p.member.subject, className: p.member.className },
      { teacher: p.candidate.teacher, day: p.candidate.day, period: p.candidate.period, subject: p.candidate.subject, className: p.candidate.className }
    ));
  });
  return {
    validate: function (tm, cm) {
      var combos = findMoveComboCandidates(ctx, groupA, tm, STATE.teacherNames, STATE.weekSlots, absences);
      return combos.some(function (x) {
        if (x.targetDay !== combo.targetDay || x.targetPeriod !== combo.targetPeriod) return false;
        return combo.pairs.every(function (origPair) {
          return x.pairs.some(function (newPair) {
            return newPair.member.teacher === origPair.member.teacher && newPair.candidate.teacher === origPair.candidate.teacher;
          });
        });
      });
    },
    apply: function (tm, cm) {
      orderedPairs.forEach(function (p) {
        applySwapToWorkingMaps(tm, cm,
          { teacher: p.member.teacher, day: ctx.day, period: ctx.period, subject: p.member.subject, className: p.member.className },
          { teacher: p.candidate.teacher, day: p.candidate.day, period: p.candidate.period, subject: p.candidate.subject, className: p.candidate.className }
        );
      });
    },
    diffs: comboDiffs
  };
}

function buildSubstituteEntry(ctx, teacher, tier) {
  return {
    validate: function (tm, cm) {
      var cands = tier === 2
        ? findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, tm, STATE.teacherNames)
        : findFallbackSubstituteCandidates(ctx, tm, STATE.teacherNames);
      return cands.some(function (x) { return x.teacher === teacher; });
    },
    apply: function (tm, cm) { applySubstituteToWorkingMaps(tm, ctx, teacher); },
    diffs: buildSubstituteDiff(ctx, teacher)
  };
}

function resolveAutoAssignFor(ctx, absences, teacherMap, classMap) {
  if (!STATE.preferSubstitute) {
    if (ctx.moveGroupId) {
      var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
      var setSwaps = findMoveSwapCandidates(ctx, STATE.moveGroupIndex, teacherMap, classMap, absences).setSwaps;
      if (setSwaps.length > 0) {
        // 세트간 교체는 상대 후보 교사가 없어(세트 대 세트 이동이라 1:1 대응이 없음)
        // 부담 비교 대상이 없다 — 그대로 첫 옵션을 쓴다.
        var s = setSwaps[0];
        var entryS = buildSetSwapEntry(ctx, groupA, s, absences);
        entryS.apply(teacherMap, classMap);
        return {
          text: '세트간 교체 — ' + s.targetDay + ' ' + s.targetPeriod + '교시로 이동',
          diffs: entryS.diffs,
          entry: entryS
        };
      }
      var combos = findMoveComboCandidates(ctx, groupA, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      var relevantCombos = combos.map(function (combo) {
        var pair = combo.pairs.filter(function (p) { return p.member.teacher === ctx.teacher; })[0];
        return pair ? { combo: combo, pair: pair } : null;
      }).filter(function (x) { return x; });
      if (relevantCombos.length > 0) {
        var picked = pickLeastLoaded(relevantCombos, teacherMap, ctx.day, function (x) { return x.pair.candidate.teacher; });
        var entryC = buildComboEntry(ctx, groupA, picked.combo, absences);
        entryC.apply(teacherMap, classMap);
        return {
          text: picked.pair.candidate.teacher + ' (개별 조합 교체, ' + picked.pair.candidate.day + ' ' + picked.pair.candidate.period + '교시 · ' + picked.pair.candidate.subject + ')',
          diffs: entryC.diffs,
          entry: entryC
        };
      }
    } else {
      var normal = findNormalSwapCandidates(ctx, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      if (normal.length > 0) {
        var c = pickLeastLoaded(normal, teacherMap, ctx.day, function (x) { return x.teacher; });
        var entryN = buildNormalSwapEntry(ctx, c, absences);
        entryN.apply(teacherMap, classMap);
        return {
          text: c.teacher + ' (교체, ' + c.day + ' ' + c.period + '교시 · ' + c.subject + ')',
          diffs: entryN.diffs,
          entry: entryN
        };
      }
    }
  }

  var tier2 = findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, teacherMap, STATE.teacherNames);
  if (tier2.length > 0) {
    var pick2 = pickLeastLoaded(tier2, teacherMap, ctx.day, function (x) { return x.teacher; });
    var entry2 = buildSubstituteEntry(ctx, pick2.teacher, 2);
    entry2.apply(teacherMap, classMap);
    return { text: pick2.teacher + ' (대강)', diffs: entry2.diffs, entry: entry2 };
  }
  var tier3 = findFallbackSubstituteCandidates(ctx, teacherMap, STATE.teacherNames);
  if (tier3.length > 0) {
    var pick3 = pickLeastLoaded(tier3, teacherMap, ctx.day, function (x) { return x.teacher; });
    var entry3 = buildSubstituteEntry(ctx, pick3.teacher, 3);
    entry3.apply(teacherMap, classMap);
    return { text: pick3.teacher + ' (대강, 참고용)', diffs: entry3.diffs, entry: entry3 };
  }
  return { text: null, diffs: [], entry: null };
}

// diffsByTeacher의 { 'day_period': {type, subject?, className?} } 하나를 교사 이름을
// 받아 .preview-col 모양(제목+미리보기 표)의 카드로 그린다 — preview.js의 미리보기
// 카드와 같은 스타일을 그대로 재사용. working-copy 최종 상태를 그대로 읽지 않고
// STATE의 원본 스케줄을 기본으로 삼는다 — working-copy는 "제거"를 실제로 그 자리를
// 지워버리는 식으로 구현돼 있어서(matching.js), 그대로 읽으면 removed 자리가 그냥
// 빈 칸으로 보인다. preview.js의 computeModifiedSchedule과 똑같이, 원본은 그대로
// 두고(줄표시로 보이게) added 자리만 diff에 담아온 새 내용으로 덮어쓴다.
// dateInfo({ titleText, dateMap })가 있으면(인쇄용 날짜를 입력한 뒤) 이름 옆에 날짜 문구를
// 붙이고, 바뀐 칸 안에도 날짜를 넣는다.
function buildScheduleCard(title, teacher, dayDiff, dateInfo) {
  var col = document.createElement('div');
  col.className = 'preview-col';
  var titleEl = document.createElement('div');
  titleEl.className = 'preview-col-title';
  titleEl.textContent = title;
  if (dateInfo && dateInfo.titleText) {
    var datesEl = document.createElement('span');
    datesEl.className = 'card-dates';
    datesEl.textContent = dateInfo.titleText;
    titleEl.appendChild(document.createTextNode(' '));
    titleEl.appendChild(datesEl);
  }
  var scroll = document.createElement('div');
  scroll.className = 'board-scroll';
  var table = document.createElement('table');
  table.className = 'board mini-board' + (dateInfo ? ' has-dates' : '');
  scroll.appendChild(table);
  col.appendChild(titleEl);
  col.appendChild(scroll);
  renderBoardInto(table, STATE.dayList, function (day, period) {
    var diffEntry = dayDiff[day + '_' + period];
    if (diffEntry && diffEntry.type === 'added') {
      return { teacher: teacher, day: day, period: period, subject: diffEntry.subject, className: diffEntry.className, isFree: false, isChangChe: false, moveGroupId: null };
    }
    return getRecord(STATE.teacherScheduleMap, teacher, day, period);
  }, { diffMap: dayDiff, dateMap: dateInfo ? dateInfo.dateMap : null });
  return col;
}

// 자동/수동 배정 결과 화면이 각각 자기 컨테이너(#autoAssignResults/#autoAssignBoards
// vs #manualAssignResults/#manualAssignBoards)를 갖지만, 슬롯 목록·후보 선택·작업
// 사본 갱신 로직은 완전히 동일하므로 "지금 어느 화면이 활성 상태인지"만 이 변수로
// 구분해서 공용 함수들이 알맞은 DOM에 렌더링하게 한다.
var ASSIGN_SURFACES = {
  manual: { results: 'manualAssignResults', boards: 'manualAssignBoards' },
  auto: { results: 'autoAssignResults', boards: 'autoAssignBoards' }
};
var activeAssignSurface = 'manual';

function runAutoAssign() {
  clearResults(); // 수동 모드로 쌓인 결과가 같이 남아있지 않도록 먼저 싹 지운다
  activeAssignSurface = 'auto';

  var affected = findAbsenceAffectedClasses(STATE.currentTeacher);
  manualAssignState = { total: affected.length, diffsByCtxKey: {} };
  renderAffectedSlotList(affected);
  if (affected.length === 0) return;

  var absences = currentAbsences();
  var teacherMap = cloneScheduleMap(STATE.teacherScheduleMap);
  var classMap = cloneScheduleMap(STATE.classScheduleMap);

  // 결근에 걸리는 수업을 순서대로 하나씩 자동 배정하되, 앞에서 확정한 선택을
  // teacherMap/classMap 사본에 반영해가며 다음 수업을 찾는다(같은 사람이 두 자리에
  // 겹쳐 배정되는 걸 방지). 이렇게 순차적으로 쌓은 결과를 그대로 manualWorkingState의
  // "정본" 순서·사본으로 삼는다 — 이후 사용자가 특정 슬롯만 골라 수동으로 바꿔도
  // (아래 renderAffectedSlotList의 행 클릭 → commitManualSelection) 같은 사본을
  // 이어서 갱신하므로 자동/수동 어느 쪽으로 채워졌든 서로 영향을 주고받는다.
  affected.forEach(function (ctx) {
    var result = resolveAutoAssignFor(ctx, absences, teacherMap, classMap);
    var key = ctx.day + '_' + ctx.period;
    manualWorkingState.order.push(key);
    if (result.entry) {
      manualWorkingState.byKey[key] = { ctx: ctx, validate: result.entry.validate, apply: result.entry.apply, diffs: result.diffs, label: result.text, conflicted: false, source: 'auto' };
      manualAssignState.diffsByCtxKey[key] = result.diffs;
      markManualAssignResolved(ctx, result.text);
    } else {
      manualWorkingState.byKey[key] = { ctx: ctx, validate: function () { return false; }, apply: function () {}, diffs: [], label: null, conflicted: true, source: 'auto' };
      markManualAssignOutcome(ctx, '후보 없음', true);
    }
  });

  manualWorkingState.teacherMap = teacherMap;
  manualWorkingState.classMap = classMap;
  manualWorkingState.conflicts = manualWorkingState.order.filter(function (key) { return manualWorkingState.byKey[key].conflicted; });

  renderManualConflictBadges(manualWorkingState.conflicts);
  maybeRenderManualAssignBoards(manualWorkingState.conflicts);
}

// 수동 모드 진행 상황 — 영향받는 수업 총 개수와, 지금까지 실제로 후보를 선택한
// 항목들의 diff를 day_period 키로 모아둔다. 전부 선택되면(개수가 같아지면) 자동
// 모드와 같은 방식으로 반영된 전체 시간표 카드를 그린다.
var manualAssignState = { total: 0, diffsByCtxKey: {} };

// 슬롯 간 상호 반영 + 충돌 감지용 작업 사본 상태. order는 슬롯이 "최초로" 확정된
// 순서를 고정 보관(자동 배정이면 배정 순서, 수동이면 사용자가 처음 고른 순서) —
// 나중에 어떤 슬롯의 선택을 바꿔도 이 순서 자체는 바뀌지 않는다. byKey는 슬롯마다
// { ctx, validate(tm,cm), apply(tm,cm), diffs, label, conflicted, source } 를 담아,
// rebuildManualWorkingMaps가 이 순서대로 재생하며 각 선택이 여전히 유효한지 검증하고
// 유효한 것만 작업 사본에 반영한다.
var manualWorkingState = { order: [], byKey: {}, teacherMap: null, classMap: null, conflicts: [] };

// order 순서대로 각 슬롯의 선택을 원본 스케줄 위에 재생해 작업 사본을 다시 만든다.
// excludeKey를 주면 그 슬롯 자신의 선택은 건너뛴다 — 이미 확정된 슬롯을 다시 열어
// 후보를 재계산할 때, 그 슬롯 자신이 비워놓은 흔적이 후보 계산에 섞이지 않게 하기
// 위해서다. 각 슬롯은 자신을 만들어냈던 find* 함수를 그대로 재실행해(validate) 아직도
// 유효한 후보인지 확인하고, 유효하면 apply해서 이후 슬롯 계산에 반영하고, 무효하면
// (다른 슬롯 편집의 여파로 더 이상 성립하지 않으면) 적용하지 않은 채 conflicts에
// 기록한다 — 마치 아직 아무것도 선택 안 한 것처럼 취급해 이후 계산을 오염시키지 않는다.
function rebuildManualWorkingMaps(excludeKey) {
  var teacherMap = cloneScheduleMap(STATE.teacherScheduleMap);
  var classMap = cloneScheduleMap(STATE.classScheduleMap);
  var conflicts = [];
  manualWorkingState.order.forEach(function (key) {
    if (key === excludeKey) return;
    var entry = manualWorkingState.byKey[key];
    if (!entry) return;
    var ok = entry.validate(teacherMap, classMap);
    entry.conflicted = !ok;
    if (ok) {
      entry.apply(teacherMap, classMap);
    } else {
      conflicts.push(key);
    }
  });
  return { teacherMap: teacherMap, classMap: classMap, conflicts: conflicts };
}

// 슬롯 행을 클릭한 것과 완전히 동일하게 동작한다(handleCellClick 재사용) — 행 클릭
// 핸들러뿐 아니라 선택 해제 직후 그 슬롯을 바로 다시 여는 데도 쓴다.
function openManualSlot(ctx) {
  var cellEl = document.querySelector('#boardTable td[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
  var rec = getRecord(STATE.teacherScheduleMap, ctx.teacher, ctx.day, ctx.period);
  if (cellEl && rec) handleCellClick(rec, cellEl);
}

// "수동으로 대체 찾기"·"자동으로 대체 찾기" 둘 다 영향받는 수업을 이 목록으로 보여준다.
// 각 행을 클릭하면 그리드에서 그 칸을 직접 클릭한 것과 동일하게 동작한다
// (handleCellClick 재사용 — 새 로직 없음). 자동 배정 직후에도 이 목록이 그대로
// 쓰이므로, 자동으로 채워진 슬롯도 똑같이 클릭해서 다른 후보로 바꿀 수 있다.
function renderAffectedSlotList(affected) {
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  listEl.innerHTML = '';
  if (affected.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '등록된 결근에 해당하는 수업이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  affected.forEach(function (ctx) {
    var row = document.createElement('div');
    row.className = 'manual-assign-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.day = ctx.day;
    row.dataset.period = ctx.period;

    // 라벨/결과/아이콘/버튼을 전부 일반 인라인 흐름으로 이어 붙인다(flex 아님) —
    // 그래야 글이 한 문장처럼 자연스럽게 줄바꿈되면서, ✓/✕도 마지막 글자 바로 뒤에
    // 붙어 있다가 정말 자리가 없을 때만 다음 줄로 넘어간다. 별도의 "아이콘 줄"을
    // 만들지 않으므로 줄 수(세로 높이)가 늘지 않는다.
    var label = document.createElement('span');
    label.className = 'manual-assign-label';
    label.textContent = ctx.day + ' ' + ctx.period + '교시 · ' + ctx.subject + (ctx.className ? ' · ' + ctx.className : '');
    row.appendChild(label);

    var outcome = document.createElement('span');
    outcome.className = 'manual-assign-outcome';
    row.appendChild(outcome);

    var warn = document.createElement('span');
    warn.className = 'manual-assign-warn';
    warn.textContent = '⚠';
    row.appendChild(warn);

    var check = document.createElement('span');
    check.className = 'manual-assign-check';
    check.textContent = '✓';
    row.appendChild(check);

    var unresolveBtn = document.createElement('button');
    unresolveBtn.type = 'button';
    unresolveBtn.className = 'manual-assign-unresolve';
    unresolveBtn.textContent = '✕';
    unresolveBtn.title = '선택 해제';
    unresolveBtn.setAttribute('aria-label', '선택 해제');
    unresolveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      unresolveManualSlot(ctx);
    });
    row.appendChild(unresolveBtn);

    row.addEventListener('click', function () { openManualSlot(ctx); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openManualSlot(ctx); }
    });

    listEl.appendChild(row);
  });
}

// 행의 "→ 결과" 텍스트만 갱신한다(체크 표시는 건드리지 않음) — 자동 배정에서
// 후보가 아예 없었던 슬롯(label 없음)에 "후보 없음"을 표시할 때 쓴다.
function markManualAssignOutcome(ctx, outcomeText, isEmpty) {
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  if (!listEl) return;
  var row = listEl.querySelector('[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
  if (!row) return;
  var outcome = row.querySelector('.manual-assign-outcome');
  if (outcome) {
    outcome.textContent = outcomeText ? '→ ' + outcomeText : '';
    outcome.classList.toggle('manual-assign-outcome-empty', !!isEmpty);
  }
}

function markManualAssignResolved(ctx, outcomeText) {
  if (!ctx) return;
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  if (!listEl) return;
  var row = listEl.querySelector('[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
  if (!row) return;
  row.classList.add('manual-assign-resolved');
  row.classList.remove('manual-assign-conflicted');
  markManualAssignOutcome(ctx, outcomeText, false);
}

// 슬롯 목록 중 conflicts(rebuildManualWorkingMaps가 돌려준, 더 이상 유효하지 않은
// 선택들)에 해당하는 행에 ⚠ 표시를 켠다 — 자동 취소하지 않고 경고만 남겨 사용자가
// 직접 다시 확인하게 한다.
function renderManualConflictBadges(conflicts) {
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  if (!listEl) return;
  listEl.querySelectorAll('.manual-assign-row').forEach(function (row) {
    var key = row.dataset.day + '_' + row.dataset.period;
    row.classList.toggle('manual-assign-conflicted', conflicts.indexOf(key) !== -1);
  });
}

function renderManualConflictBanner(conflicts) {
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  if (!listEl) return;
  var banner = listEl.querySelector('.manual-conflict-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'manual-conflict-banner';
    listEl.insertBefore(banner, listEl.firstChild);
  }
  var labelTexts = conflicts.map(function (key) {
    var parts = key.split('_');
    var row = listEl.querySelector('[data-day="' + parts[0] + '"][data-period="' + parts[1] + '"]');
    var labelEl = row && row.querySelector('.manual-assign-label');
    return labelEl ? labelEl.textContent : key;
  });
  banner.textContent = '⚠ 충돌 발생 — 다시 확인이 필요합니다: ' + labelTexts.join(', ');
}

function clearManualConflictBanner() {
  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  var banner = listEl && listEl.querySelector('.manual-conflict-banner');
  if (banner) banner.remove();
}

// 실제로 후보를 골랐을 때 makeCandListItem의 클릭 핸들러가 호출한다 — 체크 표시 +
// 진행 상황 기록, 작업 사본 재계산, 열려있는 다른 슬롯 패널 갱신, 충돌 표시,
// 전체 시간표 갱신까지 한 번에 처리한다.
function commitManualSelection(ctx, entry, label) {
  if (!ctx || !manualAssignState.total) return;
  var key = ctx.day + '_' + ctx.period;
  if (manualWorkingState.byKey[key] === undefined) manualWorkingState.order.push(key);
  manualWorkingState.byKey[key] = { ctx: ctx, validate: entry.validate, apply: entry.apply, diffs: entry.diffs, label: label, conflicted: false, source: 'manual' };
  manualAssignState.diffsByCtxKey[key] = entry.diffs;

  var working = rebuildManualWorkingMaps();
  manualWorkingState.teacherMap = working.teacherMap;
  manualWorkingState.classMap = working.classMap;
  manualWorkingState.conflicts = working.conflicts;

  markManualAssignResolved(ctx, label);
  renderManualConflictBadges(working.conflicts);
  refreshOpenSidePanelIfStale(ctx);
  maybeRenderManualAssignBoards(working.conflicts);
}

// 이미 확정된 슬롯의 선택을 취소한다("✕ 선택 해제"). 이후 슬롯들에 영향을 줄 수
// 있으므로 작업 사본을 다시 계산하고, 지금 열려있는 후보 패널도 무조건 다시
// 그린다(어느 슬롯이 열려있든 상관없이 — 다른 슬롯의 선택 취소도 그 슬롯의 후보에
// 영향을 줄 수 있기 때문).
function unresolveManualSlot(ctx) {
  var key = ctx.day + '_' + ctx.period;
  delete manualWorkingState.byKey[key];
  var idx = manualWorkingState.order.indexOf(key);
  if (idx !== -1) manualWorkingState.order.splice(idx, 1);
  delete manualAssignState.diffsByCtxKey[key];

  var working = rebuildManualWorkingMaps();
  manualWorkingState.teacherMap = working.teacherMap;
  manualWorkingState.classMap = working.classMap;
  manualWorkingState.conflicts = working.conflicts;

  var listEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].results);
  var row = listEl && listEl.querySelector('[data-day="' + ctx.day + '"][data-period="' + ctx.period + '"]');
  if (row) {
    row.classList.remove('manual-assign-resolved', 'manual-assign-conflicted');
    var outcome = row.querySelector('.manual-assign-outcome');
    if (outcome) { outcome.textContent = ''; outcome.classList.remove('manual-assign-outcome-empty'); }
  }
  renderManualConflictBadges(working.conflicts);
  openManualSlot(ctx); // 선택 해제한 슬롯을 바로 활성화해 다시 고를 수 있게 한다
  maybeRenderManualAssignBoards(working.conflicts);
}

// 지금 오른쪽 패널에 열려있는 후보 목록(lastSelectedCtx)이 방금 바뀐 슬롯과 다르면,
// 최신 작업 사본 기준으로 다시 계산해서 다시 그린다 — 캐싱 없이 방문할 때마다
// 재계산하므로 항상 최신 상태를 보여준다(학교 규모 데이터라 비용 문제 없음).
function refreshOpenSidePanelIfStale(justChangedCtx) {
  if (!lastSelectedCtx) return;
  if (justChangedCtx && lastSelectedCtx.day === justChangedCtx.day && lastSelectedCtx.period === justChangedCtx.period) return;
  hidePreview();
  computeAndRenderTiers(lastSelectedCtx);
}

// 충돌(⚠)이 하나라도 남아있으면 전체 시간표 미리보기 자체를 만들지 않고 경고 배너만
// 보여준다 — 충돌이 모두 해소되고 전체 슬롯이 다 채워졌을 때만 실제 합쳐진 시간표를
// 그린다.
function maybeRenderManualAssignBoards(conflicts) {
  if (conflicts && conflicts.length > 0) {
    renderManualConflictBanner(conflicts);
    return;
  }
  clearManualConflictBanner();
  if (Object.keys(manualAssignState.diffsByCtxKey).length === manualAssignState.total) {
    renderManualAssignBoards();
  }
}

function renderManualAssignBoards() {
  var boardsEl = document.getElementById(ASSIGN_SURFACES[activeAssignSurface].boards);
  if (!boardsEl) return;
  boardsEl.innerHTML = '';
  // 슬롯 순서·교사별 칸 집계·"본인 우선" 정렬은 print.js의 collectChangeData가 맡는다 —
  // 인쇄 팝업(날짜 입력)도 같은 집계를 써야 카드와 날짜 목록이 어긋나지 않는다.
  var data = collectChangeData(manualAssignState.diffsByCtxKey);
  data.teacherOrder.forEach(function (teacher) {
    var title = teacher + ' 교사' + (teacher === STATE.currentTeacher ? ' (결근)' : '');
    boardsEl.appendChild(buildScheduleCard(title, teacher, data.teachers[teacher].cells, getCardDateInfo(data, teacher)));
  });
  updateAssignResultVisibility();
}

function renderManualAssignList() {
  clearResults(); // 자동 모드로 쌓인 결과가 같이 남아있지 않도록 먼저 싹 지운다
  activeAssignSurface = 'manual';
  var affected = findAbsenceAffectedClasses(STATE.currentTeacher);
  manualAssignState = { total: affected.length, diffsByCtxKey: {} };
  renderAffectedSlotList(affected);
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

  computeAndRenderTiers(ctx);
}

// handleCellClick과 슬롯 목록 재갱신(refreshOpenSidePanelIfStale) 둘 다 이 함수를
// 통해 후보를 계산한다. 이 슬롯 자신의 현재 선택은 제외한(rebuildManualWorkingMaps의
// excludeKey) 작업 사본 기준으로 계산하므로, 다른 슬롯들의 확정된 선택은 반영하면서도
// 이미 확정된 슬롯을 다시 열었을 때 자기 자신이 비워놓은 자리 때문에 후보가 이상하게
// 나오는 일은 없다.
function computeAndRenderTiers(ctx) {
  var key = ctx.day + '_' + ctx.period;
  var working = rebuildManualWorkingMaps(key);
  var teacherMap = working.teacherMap;
  var classMap = working.classMap;

  // "대강 우선"이 켜져 있으면 1순위(맞교체·이동수업) 계산·표시를 아예 건너뛰고
  // 곧장 2·3순위 폴백으로 간다.
  if (!STATE.preferSubstitute) {
    var absences = currentAbsences();
    var tier1, tier1NonEmpty;
    if (ctx.moveGroupId) {
      var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
      var setSwaps = findMoveSwapCandidates(ctx, STATE.moveGroupIndex, teacherMap, classMap, absences).setSwaps;
      var combos = findMoveComboCandidates(ctx, groupA, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      tier1 = { setSwaps: setSwaps, combos: combos };
      tier1NonEmpty = setSwaps.length > 0 || combos.length > 0;
    } else {
      tier1 = findNormalSwapCandidates(ctx, teacherMap, STATE.teacherNames, STATE.weekSlots, absences);
      tier1NonEmpty = tier1.length > 0;
    }
    if (tier1NonEmpty) { renderResults(ctx, 1, tier1); return; }
  }

  var tier2 = findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, teacherMap, STATE.teacherNames);
  if (tier2.length > 0) { renderResults(ctx, 2, tier2); return; }

  var tier3 = findFallbackSubstituteCandidates(ctx, teacherMap, STATE.teacherNames);
  renderResults(ctx, 3, tier3);
}

// 후보 한 줄(<li>)을 만든다. onSelect가 있으면 클릭 가능한 버튼으로, 없으면(이동수업처럼
// 선택해서 미리보기를 만들 수 없는 경우) 그냥 텍스트로 렌더링. entry는 이 후보를
// 골랐을 때 작업 사본에 반영할 {validate, apply, diffs}(commitManualSelection이 씀).
function makeCandListItem(whoText, whereText, onSelect, entry, label) {
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
      // "대체 찾기"(수동/자동) 진행 중에도 슬롯 하나를 고를 때마다 그 슬롯과 관련된
      // 교사만 좌우로 보여주는 미리보기 스트립을 띄운다 — 다음 슬롯을 열면
      // handleCellClick이 hidePreview()로 접는다. 마지막 슬롯까지 다 채워져도 이
      // 스트립은 그대로 두고(강제로 닫지 않음), 그 아래에 전체 최종 시간표
      // (maybeRenderManualAssignBoards)가 함께 뜬다 — 둘 다 항상 같이 보여준다.
      onSelect();
      commitManualSelection(lastSelectedCtx, entry, label); // "수동으로 대체 찾기" 진행 기록 + 작업 사본 반영
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
  var absences = currentAbsences();

  var titleDiv = document.createElement('div');
  titleDiv.className = 'results-title';
  titleDiv.textContent = ctx.teacher + ' 교사 — ' + ctx.day + ' ' + ctx.period + '교시 ' +
    ctx.subject + (ctx.className ? ' · ' + ctx.className : '') + (ctx.moveGroupId ? ' · 이동수업 세트' : '');
  body.appendChild(titleDiv);

  if (tier === 1 && ctx.moveGroupId) {
    var groupA = STATE.moveGroupIndex[ctx.moveGroupId];
    var items0 = [];
    data.setSwaps.forEach(function (s) {
      var subjList = s.otherMembers.map(function (m) { return m.subject; }).join('/');
      var entryS = buildSetSwapEntry(ctx, groupA, s, absences);
      var labelS = '세트간 교체 — ' + s.targetDay + ' ' + s.targetPeriod + '교시로 이동';
      items0.push(makeCandListItem('세트간 교체', '"' + subjList + '" 세트 ↔ ' + s.targetDay + ' ' + s.targetPeriod + '교시', function () {
        selectMoveSetSwap(ctx, groupA, s);
      }, entryS, labelS));
    });
    data.combos.forEach(function (combo) {
      var classText = groupComboPairsByClass(combo.pairs).map(function (g) {
        var memberText = g.members.map(function (m) { return m.teacher + '(' + m.subject + ')'; }).join('+');
        return g.className + ' [' + memberText + '] ↔ ' + g.candidate.teacher + ' 교사';
      }).join(' · ');
      var whereText = combo.targetDay + ' ' + combo.targetPeriod + '교시로 이동 — ' + classText;
      var entryC = buildComboEntry(ctx, groupA, combo, absences);
      var myPair = combo.pairs.filter(function (p) { return p.member.teacher === ctx.teacher; })[0];
      var labelC = myPair
        ? myPair.candidate.teacher + ' (개별 조합 교체, ' + myPair.candidate.day + ' ' + myPair.candidate.period + '교시 · ' + myPair.candidate.subject + ')'
        : '개별 조합 교체 — ' + combo.targetDay + ' ' + combo.targetPeriod + '교시';
      items0.push(makeCandListItem('개별 조합 교체', whereText, function () {
        selectMoveComboSwap(ctx, groupA, combo);
      }, entryC, labelC));
    });
    appendTierBlock(body, 'tier-1', '1순위: 세트 이동/교체 가능', null, items0);
  } else if (tier === 1) {
    var sorted1 = data.slice().sort(function (a, b) {
      var dayDiff = STATE.dayList.indexOf(a.day) - STATE.dayList.indexOf(b.day);
      if (dayDiff !== 0) return dayDiff;
      return a.period - b.period;
    });
    var items1 = sorted1.map(function (c) {
      var entryN = buildNormalSwapEntry(ctx, c, absences);
      var labelN = c.teacher + ' (교체, ' + c.day + ' ' + c.period + '교시 · ' + c.subject + ')';
      return makeCandListItem(c.teacher + ' 교사', c.day + ' ' + c.period + '교시 (' + c.className + ' ' + c.subject + ')', function () {
        selectNormalSwap(ctx, c);
      }, entryN, labelN);
    });
    appendTierBlock(body, 'tier-1', '1순위: 맞교체 가능', null, items1);
  } else if (tier === 2) {
    var note2 = ctx.subject.trim() === '진로' ? '담당교과 무관 — 진로 수업은 아무 교사나 대강 가능합니다.' : null;
    var items2 = data.map(function (c) {
      var entry2 = buildSubstituteEntry(ctx, c.teacher, 2);
      var label2 = c.teacher + ' (대강)';
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      }, entry2, label2);
    });
    appendTierBlock(body, 'tier-2', '2순위: 동교과 대강 후보', note2, items2);
  } else if (tier === 3) {
    var items3 = data.map(function (c) {
      var entry3 = buildSubstituteEntry(ctx, c.teacher, 3);
      var label3 = c.teacher + ' (대강, 참고용)';
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      }, entry3, label3);
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
  initPrint({
    getDiffsByCtxKey: function () { return manualAssignState.diffsByCtxKey; },
    getCtx: function (key) { return manualWorkingState.byKey[key] ? manualWorkingState.byKey[key].ctx : null; },
    getAbsentTeacher: function () { return STATE.currentTeacher; },
    onDatesConfirmed: renderManualAssignBoards
  });
}

document.addEventListener('DOMContentLoaded', function () {
  wireStaticUI();
  loadAbsencesFromStorage();
  init();
});
