import { STATE } from './state.js';
import { renderBoardInto } from './board-render.js';

// ---------- 교체/대강 후 시간표 미리보기 ----------
// 기존 STATE.teacherScheduleMap을 건드리지 않고(저장/반영 없음, 순수 시뮬레이션 표시용),
// removals(그 칸을 비움)/additions(그 칸에 새 수업을 채움)/covered(칸 내용은 그대로 두되
// "OO 대강" 라벨만 얹음)를 적용한 5x7 스케줄 사본과, 어느 칸이 바뀐 건지 표시하는
// diff 맵을 함께 돌려준다.
function computeModifiedSchedule(teacherName, changes) {
  var removals = changes.removals || [];
  var additions = changes.additions || [];
  var covered = changes.covered || [];
  var base = STATE.teacherScheduleMap[teacherName] || {};
  var grid = {};
  STATE.dayList.forEach(function (day) {
    grid[day] = {};
    for (var p = 1; p <= 7; p++) {
      var rec = base[day] && base[day][p];
      if (rec) grid[day][p] = rec;
    }
  });
  var diff = {};
  removals.forEach(function (r) {
    // 칸을 지우지 않고 원래 내용을 그대로 둔 채 "사라지는 시간"으로만 표시 —
    // 빨간 점선으로 무엇이 없어지는지 눈에 보이게 하기 위함.
    diff[r.day + '_' + r.period] = { type: 'removed' };
  });
  additions.forEach(function (a) {
    if (!grid[a.day]) grid[a.day] = {};
    grid[a.day][a.period] = { teacher: teacherName, day: a.day, period: a.period, subject: a.subject, className: a.className, isFree: false, isChangChe: false, moveGroupId: null };
    diff[a.day + '_' + a.period] = { type: 'added' };
  });
  covered.forEach(function (c) {
    diff[c.day + '_' + c.period] = { type: 'covered' };
  });
  return { grid: grid, diff: diff };
}

function renderMiniBoardInto(tableEl, titleEl, titleText, schedule) {
  if (titleEl) titleEl.textContent = titleText;
  renderBoardInto(tableEl, STATE.dayList, function (day, period) {
    return schedule.grid[day] && schedule.grid[day][period];
  }, { diffMap: schedule.diff });
}

function renderMiniBoard(tableId, titleId, titleText, schedule) {
  renderMiniBoardInto(document.getElementById(tableId), document.getElementById(titleId), titleText, schedule);
}

// 조합 교체 미리보기(세로 N쌍)를 쓴 뒤 일반/대강/세트간 교체로 다시 돌아올 때 이전
// 조합 미리보기가 안 남도록, 고정 좌우 2장 구조를 보여줄 때마다 조합 행 컨테이너는 숨긴다.
function showStaticPreviewCols() {
  document.getElementById('previewComboRows').style.display = 'none';
  document.getElementById('previewStaticCols').style.display = '';
}

function showPreview(leftTeacher, leftChanges, leftLabel, rightTeacher, rightChanges, rightLabel) {
  var leftSchedule = computeModifiedSchedule(leftTeacher, leftChanges);
  var rightSchedule = computeModifiedSchedule(rightTeacher, rightChanges);
  renderMiniBoard('previewLeftBoard', 'previewLeftTitle', leftTeacher + ' 교사 — ' + leftLabel, leftSchedule);
  renderMiniBoard('previewRightBoard', 'previewRightTitle', rightTeacher + ' 교사 — ' + rightLabel, rightSchedule);
  showStaticPreviewCols();
  document.getElementById('previewSection').style.display = 'block';
}

export function hidePreview() {
  document.getElementById('previewSection').style.display = 'none';
}

// previewComboRows 안의 "라벨 + 좌우 2단 미리보기" 한 줄을 만드는 공용 헬퍼. leftInfo/
// rightInfo는 null이거나 { teacherName, titleText, changes } — null이면 그 쪽 칸은 빈
// 채로 둔다(세트간 교체처럼 두 세트의 인원수가 달라 자연스러운 상대가 없는 경우용).
function buildComboPreviewRow(labelText, leftInfo, rightInfo) {
  var row = document.createElement('div');

  var label = document.createElement('div');
  label.className = 'preview-combo-row-label';
  label.textContent = labelText;
  row.appendChild(label);

  var cols = document.createElement('div');
  cols.className = 'preview-cols';

  function buildCol(info) {
    var col = document.createElement('div');
    col.className = 'preview-col';
    var title = document.createElement('div');
    title.className = 'preview-col-title';
    var scroll = document.createElement('div');
    scroll.className = 'board-scroll';
    var table = document.createElement('table');
    table.className = 'board mini-board';
    scroll.appendChild(table);
    col.appendChild(title);
    col.appendChild(scroll);
    if (info) {
      var schedule = computeModifiedSchedule(info.teacherName, info.changes);
      renderMiniBoardInto(table, title, info.titleText, schedule);
    }
    return col;
  }

  cols.appendChild(buildCol(leftInfo));
  cols.appendChild(buildCol(rightInfo));
  row.appendChild(cols);
  return row;
}

// 세트간 교체 선택: 세트 A 전체가 원래 시간을 비우고 세트 B의 원래 시간으로, 세트 B
// 전체가 그 반대로 이동한다 — 개별 조합 교체와 마찬가지로 실제 개인 교사 시간표를 그대로
// 보여준다. 다만 세트 A와 세트 B 사이엔 "누가 누구와 자리를 바꾸는지"에 대한 자연스러운
// 1:1 대응이 없으므로(둘 다 그냥 통째로 서로의 시간대로 이동할 뿐), members 배열의
// 순서대로 나란히 짝지어 보여준다 — 인원수가 다르면 짧은 쪽은 그 줄의 반대편 칸을 비운다.
export function selectMoveSetSwap(ctx, groupA, swap) {
  var container = document.getElementById('previewComboRows');
  container.innerHTML = '';

  var header = document.createElement('div');
  header.className = 'preview-combo-row-label';
  header.textContent = ctx.day + '요일 ' + ctx.period + '교시 세트 ↔ ' + swap.targetDay + '요일 ' + swap.targetPeriod + '교시 세트 (세트간 교체)';
  container.appendChild(header);

  var membersA = groupA.members;
  var membersB = swap.otherMembers;
  var maxLen = Math.max(membersA.length, membersB.length);
  for (var i = 0; i < maxLen; i++) {
    var mA = membersA[i] || null;
    var mB = membersB[i] || null;
    var leftInfo = mA ? {
      teacherName: mA.teacher,
      titleText: mA.teacher + ' 교사 — 요청',
      changes: {
        removals: [{ day: ctx.day, period: ctx.period }],
        additions: [{ day: swap.targetDay, period: swap.targetPeriod, subject: mA.subject, className: mA.className }]
      }
    } : null;
    var rightInfo = mB ? {
      teacherName: mB.teacher,
      titleText: mB.teacher + ' 교사 — 상대',
      changes: {
        removals: [{ day: swap.targetDay, period: swap.targetPeriod }],
        additions: [{ day: ctx.day, period: ctx.period, subject: mB.subject, className: mB.className }]
      }
    } : null;
    var label = (mA ? mA.teacher : '') + ' ↔ ' + (mB ? mB.teacher : '');
    container.appendChild(buildComboPreviewRow(label, leftInfo, rightInfo));
  }

  document.getElementById('previewStaticCols').style.display = 'none';
  container.style.display = '';
  document.getElementById('previewSection').style.display = 'block';
}

// 개별 조합 교체 선택: 세트원 수(N)만큼 좌우 쌍(각 쌍은 selectNormalSwap과 완전히 같은
// 원리)을 세로로 나열한다. 각 쌍의 왼쪽은 세트원 교사 관점(원래 슬롯 제거, 후보 슬롯에
// 세트원 자기 과목 추가), 오른쪽은 후보 교사 관점(그 반대).
export function selectMoveComboSwap(ctx, groupA, combo) {
  var container = document.getElementById('previewComboRows');
  container.innerHTML = '';

  var header = document.createElement('div');
  header.className = 'preview-combo-row-label';
  header.textContent = ctx.day + '요일 ' + ctx.period + '교시 세트 → ' + combo.targetDay + '요일 ' + combo.targetPeriod + '교시로 이동';
  container.appendChild(header);

  combo.pairs.forEach(function (p) {
    var leftInfo = {
      teacherName: p.member.teacher,
      titleText: p.member.teacher + ' 교사 — 요청',
      changes: {
        removals: [{ day: ctx.day, period: ctx.period }],
        additions: [{ day: p.candidate.day, period: p.candidate.period, subject: p.member.subject, className: p.member.className }]
      }
    };
    var rightInfo = {
      teacherName: p.candidate.teacher,
      titleText: p.candidate.teacher + ' 교사 — 상대',
      changes: {
        removals: [{ day: p.candidate.day, period: p.candidate.period }],
        additions: [{ day: ctx.day, period: ctx.period, subject: p.candidate.subject, className: p.candidate.className }]
      }
    };
    container.appendChild(buildComboPreviewRow(p.member.teacher + ' ↔ ' + p.candidate.teacher, leftInfo, rightInfo));
  });

  document.getElementById('previewStaticCols').style.display = 'none';
  container.style.display = '';
  document.getElementById('previewSection').style.display = 'block';
}

// 1순위 맞교체 선택: 두 사람의 세션이 통째로 자리를 바꾼다 — 왼쪽(요청자)은 원래 칸이
// 비고 상대의 원래 칸에 자기 과목이 들어가며, 오른쪽(상대)은 그 반대.
export function selectNormalSwap(ctx, candidate) {
  var leftChanges = {
    removals: [{ day: ctx.day, period: ctx.period }],
    additions: [{ day: candidate.day, period: candidate.period, subject: ctx.subject, className: ctx.className }]
  };
  var rightChanges = {
    removals: [{ day: candidate.day, period: candidate.period }],
    additions: [{ day: ctx.day, period: ctx.period, subject: candidate.subject, className: candidate.className }]
  };
  showPreview(ctx.teacher, leftChanges, '요청', candidate.teacher, rightChanges, '상대');
}

// 2·3순위 대강 선택: 일방적인 호의라 상대방 시간표는 안 바뀌고, 요청자의 원래 칸은
// 점선 테두리로만 "대강으로 채워짐"을 표시한다(글자 라벨은 칸이 비좁아 넣지 않음 —
// 위 제목에 이미 어느 교사가 대강하는지 나와 있음). 상대방은 그 시간에 1회성으로
// 수업이 하나 추가된다.
export function selectSubstitute(ctx, candidateTeacher) {
  var leftChanges = {
    covered: [{ day: ctx.day, period: ctx.period }]
  };
  var rightChanges = {
    additions: [{ day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className }]
  };
  showPreview(ctx.teacher, leftChanges, '요청', candidateTeacher, rightChanges, '대강');
}
