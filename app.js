import { STATE } from './state.js';
import {
  parseMatrixSheet, buildTeacherRecords, parseTeacherSubjects, parseSettings,
  buildTeacherScheduleMap, buildClassScheduleMap, buildMoveGroupIndex,
  getRecord, allWeekSlots
} from './data.js';
import {
  findNormalSwapCandidates, findMoveSwapCandidates, findMoveComboCandidates,
  findSubjectSubstituteCandidates, findFallbackSubstituteCandidates
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

function wireAbsencePanel() {
  document.getElementById('absenceAddBtn').addEventListener('click', handleAddAbsence);
  document.getElementById('absenceSaveBtn').addEventListener('click', handleSaveAbsence);

  var allBox = document.getElementById('absencePeriodAll');
  var checks = document.querySelectorAll('#absencePeriodChecks input[type="checkbox"][value]');
  allBox.addEventListener('change', function () {
    checks.forEach(function (cb) { cb.checked = allBox.checked; });
  });
}

var lastSelectedCell = null;

function handleCellClick(rec, cellEl) {
  if (lastSelectedCell) lastSelectedCell.classList.remove('cell-selected');
  cellEl.classList.add('cell-selected');
  lastSelectedCell = cellEl;
  hidePreview(); // 새 셀을 클릭하면 이전 미리보기는 더 이상 유효하지 않으므로 접어둠

  var ctx = { teacher: rec.teacher, day: rec.day, period: rec.period, subject: rec.subject, className: rec.className, moveGroupId: rec.moveGroupId };

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

  var tier2 = findSubjectSubstituteCandidates(ctx, STATE.teacherSubjects, STATE.teacherScheduleMap, STATE.teacherNames);
  if (tier2.length > 0) { renderResults(ctx, 2, tier2); return; }

  var tier3 = findFallbackSubstituteCandidates(ctx, STATE.teacherScheduleMap, STATE.teacherNames);
  renderResults(ctx, 3, tier3);
}

// 후보 한 줄(<li>)을 만든다. onSelect가 있으면 클릭 가능한 버튼으로, 없으면(이동수업처럼
// 선택해서 미리보기를 만들 수 없는 경우) 그냥 텍스트로 렌더링.
function makeCandListItem(whoText, whereText, onSelect) {
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
      }));
    });
    data.combos.forEach(function (combo) {
      var classText = groupComboPairsByClass(combo.pairs).map(function (g) {
        var memberText = g.members.map(function (m) { return m.teacher + '(' + m.subject + ')'; }).join('+');
        return g.className + '반 [' + memberText + '] ↔ ' + g.candidate.teacher + ' 교사';
      }).join(' · ');
      var whereText = combo.targetDay + '요일 ' + combo.targetPeriod + '교시로 이동 — ' + classText;
      items0.push(makeCandListItem('개별 조합 교체', whereText, function () {
        selectMoveComboSwap(ctx, groupA, combo);
      }));
    });
    appendTierBlock(body, 'tier-1', '1순위: 세트 이동/교체 가능', null, items0);
  } else if (tier === 1) {
    var items1 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', c.day + '요일 ' + c.period + '교시 (' + c.className + '반 ' + c.subject + ')', function () {
        selectNormalSwap(ctx, c);
      });
    });
    appendTierBlock(body, 'tier-1', '1순위: 맞교체 가능', null, items1);
  } else if (tier === 2) {
    var note2 = ctx.subject.trim() === '진로' ? '담당교과 무관 — 진로 수업은 아무 교사나 대강 가능합니다.' : null;
    var items2 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      });
    });
    appendTierBlock(body, 'tier-2', '2순위: 동교과 대강 후보', note2, items2);
  } else if (tier === 3) {
    var items3 = data.map(function (c) {
      return makeCandListItem(c.teacher + ' 교사', null, function () {
        selectSubstitute(ctx, c.teacher);
      });
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
}

document.addEventListener('DOMContentLoaded', function () {
  wireStaticUI();
  loadAbsencesFromStorage();
  init();
});
