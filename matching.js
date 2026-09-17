import { getRecord, isEmpty, isEmptyOrOwnGroup } from './data.js';

// ---------- matching engine ----------
// absences는 { day, period } 배열 — 요청 교사가 등록해둔 출장·결근 시간대. 아래 세
// 함수(맞교체/세트간 교체/개별 조합 교체)는 전부 "요청 교사가 새로운 요일·교시로
// 옮겨가는" 결과이므로, 그 새 요일·교시가 결근일과 겹치면 후보로 낼 수 없다 — 실제로
// 그날 학교에 없기 때문. 대강(2·3순위)은 요청 교사의 원래 자리를 상대가 그대로
// 메워주는 것뿐이라 결근 여부와 무관해서 건드리지 않는다.
function isAbsentAt(absences, day, period) {
  for (var i = 0; i < absences.length; i++) {
    if (absences[i].day === day && absences[i].period === period) return true;
  }
  return false;
}
// 맞교체 = 반의 시간표는 그대로 두고, 그 시간에 들어가는 교사만 서로 바꾸는 것
// (반이 실제로 다른 시간으로 옮겨가는 게 아니므로 반 충돌 조건은 보지 않음). 단, 후보 X는
// 반드시 내 원래 반(className)을 다른 시간에 이미 가르치고 있는 교사여야 함 — 그래야 그
// 교사가 내 시간에 대신 들어와도 같은 반 학생들에게 낯선 과목이 갑자기 끼어들지 않음.
// 그 위에 교사 두 명의 시간만 서로 맞으면 됨: 나는 X의 원래 시간에 갈 수 있어야 하고,
// X는 내 원래 시간에 올 수 있어야 함.
export function findNormalSwapCandidates(ctx, teacherScheduleMap, teacherNames, weekSlots, absences) {
  absences = absences || [];
  var results = [];
  teacherNames.forEach(function (X) {
    if (X === ctx.teacher) return;
    weekSlots.forEach(function (slot) {
      var day = slot.day, period = slot.period;
      if (isAbsentAt(absences, day, period)) return;
      var xRec = getRecord(teacherScheduleMap, X, day, period);
      if (!xRec || xRec.isFree || xRec.isChangChe || xRec.moveGroupId) return;
      if (xRec.className !== ctx.className) return;
      if (!isEmpty(teacherScheduleMap, ctx.teacher, day, period)) return;
      if (!isEmpty(teacherScheduleMap, X, ctx.day, ctx.period)) return;
      results.push({ teacher: X, day: day, period: period, className: xRec.className, subject: xRec.subject });
    });
  });
  return results;
}

function allMembersFreeAt(members, day, period, teacherScheduleMap, classScheduleMap, excludeGroupId) {
  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    if (!isEmptyOrOwnGroup(teacherScheduleMap, m.teacher, day, period, excludeGroupId)) return false;
    if (!isEmptyOrOwnGroup(classScheduleMap, m.className, day, period, excludeGroupId)) return false;
  }
  return true;
}

// 두 세트가 교사를 한 명이라도 공유하면 안 됨 — 같은 이동수업 그룹이 주중에 여러 번
// (요일만 다르게) 반복되는 경우, moveGroupId는 요일별로 다르지만 실제로는 같은 사람들이라
// "세트간 교체"의 상대가 될 수 없다 (그 사람 본인과 바꾸는 셈이라 아무 의미가 없음).
function shareAnyTeacher(membersA, membersB) {
  for (var i = 0; i < membersA.length; i++) {
    for (var j = 0; j < membersB.length; j++) {
      if (membersA[i].teacher === membersB[j].teacher) return true;
    }
  }
  return false;
}

// 이동수업 세트는 "다른 세트와 맞바꾸는 것"만 후보로 삼는다. 예전엔 상대 없이 그냥 빈
// 시간대로 옮기는 방식(빈 시간대 이동)도 있었는데, 그러면 세트가 떠난 원래 시간대를
// 아무것도 대신 채우지 않아서 그 이동수업을 듣던 학생들은 원래 시간에 수업이 통째로
// 비어버린다 — 실제로 쓸 수 없는 결과라 완전히 제거했다. 세트간 교체는 두 세트가 서로의
// 시간을 정확히 맞바꾸므로 그 시간에 항상 뭔가 수업이 있어 이런 문제가 없다.
export function findMoveSwapCandidates(ctx, moveGroupIndex, teacherScheduleMap, classScheduleMap, absences) {
  absences = absences || [];
  var groupA = moveGroupIndex[ctx.moveGroupId];
  var origDay = ctx.day, origPeriod = ctx.period;
  var setSwaps = [];
  Object.keys(moveGroupIndex).forEach(function (gid) {
    if (gid === ctx.moveGroupId) return;
    var groupB = moveGroupIndex[gid];
    if (groupB.day === origDay && groupB.period === origPeriod) return;
    if (isAbsentAt(absences, groupB.day, groupB.period)) return;
    if (shareAnyTeacher(groupA.members, groupB.members)) return;
    if (!allMembersFreeAt(groupA.members, groupB.day, groupB.period, teacherScheduleMap, classScheduleMap, gid)) return;
    if (!allMembersFreeAt(groupB.members, origDay, origPeriod, teacherScheduleMap, classScheduleMap, ctx.moveGroupId)) return;
    setSwaps.push({ type: 'setSwap', otherGroupId: gid, otherMembers: groupB.members, targetDay: groupB.day, targetPeriod: groupB.period });
  });
  return { setSwaps: setSwaps };
}

function groupMoveMembersByClass(members) {
  var order = [];
  var byClass = {};
  members.forEach(function (m) {
    if (!byClass[m.className]) { byClass[m.className] = []; order.push(m.className); }
    byClass[m.className].push(m);
  });
  return order.map(function (cn) { return { className: cn, members: byClass[cn] }; });
}

// 세트에서 중요한 건 세트원(교사) 수가 아니라 세트 안의 서로 다른 반(className) 수다 —
// 한 반이 이동수업으로 여러 교사에게 동시에 나뉘어 있어도(예: 1반이 물리/생명 두 과목으로
// 분반) 그 반을 대신 채워줄 대체 교사는 반마다 딱 1명이면 된다. 반 C를 (day,period)에
// 정규(비이동) 수업으로 담당하는 교사 X를 찾되, 그 반을 담당하는 세트원 전원이 X의
// (day,period)에 개인적으로 비어있어야 다 같이 그 시간으로 옮겨갈 수 있다(6.2의 "후보 하나당
// 나 하나 비면 됨"을 "반 그룹 전원이 비어있어야 함"으로 일반화).
//
// xRec.moveGroupId가 없어야 한다는 조건이 핵심 불변식을 보장한다: 이동수업 태깅 관례(2.5)상
// 어떤 (day,period)에 한 반이 실제로 여러 교사에게 나뉘어 있다면 그 레코드들은 전부
// moveGroupId가 붙는다. 즉 moveGroupId가 없는 레코드는 그 반·그 시간의 유일한 정규
// 담당자이므로, 같은 (day,period)에 같은 className을 가진 비이동 레코드는 최대 1개뿐이다 —
// 그래서 byKey에는 항상 최대 1개 후보만 쌓인다(위반 시 데이터 이상 신호로 warn).
//
// 세트 A의 멤버는 그 누구도 이 함수의 후보가 될 수 없다 — 전원이 세트 A의 원래 시간에
// 이미 그 세트의 레코드로 바쁘므로 "X가 원래 시간에 비어있어야 함" 조건에서 자동 제외된다.
function findClassSubstituteCandidates(origDay, origPeriod, className, groupMembers, teacherScheduleMap, teacherNames, weekSlots) {
  var byKey = {};
  teacherNames.forEach(function (X) {
    weekSlots.forEach(function (slot) {
      var day = slot.day, period = slot.period;
      var xRec = getRecord(teacherScheduleMap, X, day, period);
      if (!xRec || xRec.isFree || xRec.isChangChe || xRec.moveGroupId) return;
      if (xRec.className !== className) return;
      if (!isEmpty(teacherScheduleMap, X, origDay, origPeriod)) return;
      var allFree = groupMembers.every(function (m) {
        return isEmpty(teacherScheduleMap, m.teacher, day, period);
      });
      if (!allFree) return;
      var key = day + '_' + period;
      if (byKey[key]) {
        console.warn('[findClassSubstituteCandidates] 같은 (day,period)/반에 비이동 후보가 2명 이상 — 데이터의 이동수업 태깅 관례 위반 가능성:', className, key, byKey[key].teacher, xRec.teacher);
      }
      byKey[key] = { teacher: X, day: day, period: period, className: xRec.className, subject: xRec.subject };
    });
  });
  return byKey;
}

// 세트 A를 "세트원 교사" 단위가 아니라 "서로 다른 반(className)" 단위로 묶은 뒤, 반마다
// 정확히 1명의 대체 교사를 찾고, 그 대체 교사들의 (day,period)가 모든 반에 걸쳐 완전히
// 같은 경우만 유효한 조합으로 채택한다 — 세트 전체가 통째로 "하나의 공통 시간대"로
// 옮겨가는 것이지, 반마다 제각각 다른 시간으로 흩어지는 게 아니기 때문이다.
export function findMoveComboCandidates(ctx, groupA, teacherScheduleMap, teacherNames, weekSlots, absences) {
  absences = absences || [];
  var classGroups = groupMoveMembersByClass(groupA.members);
  if (classGroups.length === 0) return [];

  var perClassMaps = classGroups.map(function (g) {
    return findClassSubstituteCandidates(ctx.day, ctx.period, g.className, g.members, teacherScheduleMap, teacherNames, weekSlots);
  });

  var commonKeys = Object.keys(perClassMaps[0]).filter(function (key) {
    return perClassMaps.every(function (m) { return !!m[key]; });
  });

  var combos = [];
  commonKeys.forEach(function (key) {
    if (isAbsentAt(absences, perClassMaps[0][key].day, perClassMaps[0][key].period)) return;
    var pairs = [];
    var teacherToClass = {}; // 방어적 체크: 같은 대체 교사가 같은 시간에 서로 다른 반의
                              // 대체로 동시 채택되면 안 됨(teacherScheduleMap이 교사당
                              // 슬롯 하나뿐이라 구조적으로 불가능하지만 안전망으로 확인).
    var conflict = false;
    classGroups.forEach(function (g, idx) {
      var candidate = perClassMaps[idx][key];
      if (teacherToClass[candidate.teacher] && teacherToClass[candidate.teacher] !== g.className) {
        conflict = true;
      }
      teacherToClass[candidate.teacher] = g.className;
      g.members.forEach(function (m) {
        pairs.push({ member: m, candidate: candidate });
      });
    });
    if (conflict) {
      console.warn('[findMoveComboCandidates] 동일 대체 교사가 같은 시간에 두 반의 대체로 중복 채택되어 조합에서 제외:', key);
      return;
    }
    combos.push({ targetDay: perClassMaps[0][key].day, targetPeriod: perClassMaps[0][key].period, pairs: pairs });
  });
  return combos;
}

export function findSubjectSubstituteCandidates(ctx, teacherSubjects, teacherScheduleMap, teacherNames) {
  var isCareer = ctx.subject.trim() === '진로';
  var mySubject = teacherSubjects[ctx.teacher] ? teacherSubjects[ctx.teacher].subject : null;
  var results = [];
  teacherNames.forEach(function (X) {
    if (X === ctx.teacher) return;
    if (!isEmpty(teacherScheduleMap, X, ctx.day, ctx.period)) return;
    if (isCareer) {
      results.push({ teacher: X });
    } else {
      var xSubject = teacherSubjects[X] ? teacherSubjects[X].subject : null;
      if (xSubject && mySubject && xSubject === mySubject) results.push({ teacher: X });
    }
  });
  return results;
}

export function findFallbackSubstituteCandidates(ctx, teacherScheduleMap, teacherNames) {
  var results = [];
  teacherNames.forEach(function (X) {
    if (X === ctx.teacher) return;
    if (!isEmpty(teacherScheduleMap, X, ctx.day, ctx.period)) return;
    results.push({ teacher: X });
  });
  return results;
}

// ---------- 결근 자동 배정용 working-copy 헬퍼 ----------
// 배치로 여러 수업을 한 번에 자동 배정할 때, 앞에서 이미 확정한 선택을 뒤에 오는
// 탐색에도 반영해야 같은 사람을 두 자리에 겹쳐 배정하는 걸 막을 수 있다. 실제
// STATE의 맵은 건드리지 않고, 이 사본에만 반영해가며 위 find* 함수들을 그대로
// 재사용한다(그 함수들은 이미 맵을 파라미터로 받으므로 엔진 자체는 손댈 필요 없음).
export function cloneScheduleMap(map) {
  return JSON.parse(JSON.stringify(map));
}

function setSlot(map, teacher, day, period, record) {
  if (record) {
    if (!map[teacher]) map[teacher] = {};
    if (!map[teacher][day]) map[teacher][day] = {};
    map[teacher][day][period] = record;
  } else if (map[teacher] && map[teacher][day]) {
    delete map[teacher][day][period];
  }
}

// 맞교체·개별 조합 교체는 둘 다 "두 사람이 시간을 맞바꾼다"는 같은 모양이라 이
// 한 함수로 처리한다. a, b: { teacher, day, period, subject, className }.
export function applySwapToWorkingMaps(teacherMap, classMap, a, b) {
  setSlot(teacherMap, a.teacher, a.day, a.period, null);
  setSlot(teacherMap, b.teacher, b.day, b.period, null);
  setSlot(teacherMap, a.teacher, b.day, b.period, { teacher: a.teacher, day: b.day, period: b.period, subject: a.subject, className: a.className, isFree: false, isChangChe: false, moveGroupId: null });
  setSlot(teacherMap, b.teacher, a.day, a.period, { teacher: b.teacher, day: a.day, period: a.period, subject: b.subject, className: b.className, isFree: false, isChangChe: false, moveGroupId: null });

  setSlot(classMap, a.className, a.day, a.period, null);
  setSlot(classMap, b.className, b.day, b.period, null);
  setSlot(classMap, a.className, b.day, b.period, { teacher: a.teacher, day: b.day, period: b.period, subject: a.subject, className: a.className, isFree: false, isChangChe: false, moveGroupId: null });
  setSlot(classMap, b.className, a.day, a.period, { teacher: b.teacher, day: a.day, period: a.period, subject: b.subject, className: b.className, isFree: false, isChangChe: false, moveGroupId: null });
}

// 세트간 교체는 groupA 전체 ↔ groupB 전체가 통째로 움직이는 것이라(멤버별 1:1 짝이
// 아님 — selectMoveSetSwap의 인덱스 매칭은 미리보기 표시용일 뿐), 배치 자동 배정에서는
// "내(ctx) 자리만 정확히 옮기면 된다"는 원칙으로 ctx 한 명만 이동시킨다 — 원래 자리는
// 비우고 targetDay/targetPeriod에 자기 과목으로 새로 채운다.
export function applyRelocateToWorkingMaps(teacherMap, classMap, ctx, newDay, newPeriod) {
  setSlot(teacherMap, ctx.teacher, ctx.day, ctx.period, null);
  setSlot(teacherMap, ctx.teacher, newDay, newPeriod, { teacher: ctx.teacher, day: newDay, period: newPeriod, subject: ctx.subject, className: ctx.className, isFree: false, isChangChe: false, moveGroupId: null });
  setSlot(classMap, ctx.className, ctx.day, ctx.period, null);
  setSlot(classMap, ctx.className, newDay, newPeriod, { teacher: ctx.teacher, day: newDay, period: newPeriod, subject: ctx.subject, className: ctx.className, isFree: false, isChangChe: false, moveGroupId: null });
}

// 대강은 원래 담당자의 레코드를 지우지 않는다("대강" 표시만, 실제로는 아무것도 안
// 없어진다는 기존 원칙과 동일) — 대강 교사 쪽에만 그 시간에 새 레코드가 추가된다.
export function applySubstituteToWorkingMaps(teacherMap, ctx, substituteTeacher) {
  setSlot(teacherMap, substituteTeacher, ctx.day, ctx.period, { teacher: substituteTeacher, day: ctx.day, period: ctx.period, subject: ctx.subject, className: ctx.className, isFree: false, isChangChe: false, moveGroupId: null });
}
