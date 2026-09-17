// ---------- parsing ----------
function computeMoveGroupId(subject, className, day, period) {
  if (!subject) return null;
  var ch = subject.trim().slice(-1);
  var isMove = /^[A-Z]$/.test(ch) && ch !== 'I' && ch !== 'V';
  if (!isMove) return null;
  var grade = className ? className.trim().charAt(0) : null;
  if (!grade) return null;
  return day + '_' + period + '_' + grade + '_' + ch;
}

// '전체 교사 시간표'(매트릭스, 학교 시간표 프로그램이 직접 내보내는 원본)를 파싱한다.
// buildTeacherRecords가 기대하는 { blocks: [{key, tuples}], dayList } 모양으로 돌려주므로
// 아래 인덱스 빌더·매칭 함수·렌더링은 전혀 손댈 필요가 없다.
// 교사 한 명당 정확히 2행(과목행+반정보행)이고, 요일별 교시 수가 다를 수 있어(금요일만
// 6교시) 헤더 두 줄을 직접 스캔해서 열 구조를 동적으로 읽는다. 교사 수는 절대 하드코딩하지
// 않고 시트에 실제로 있는 행 수(rows2D.length)만큼 끝까지 순회 — 학기마다 교사가 늘거나
// 줄어서 행이 추가/삭제돼도 코드 수정 없이 그대로 파싱된다.
export function parseMatrixSheet(rows2D) {
  var dayRow = rows2D[2] || [];
  var periodRow = rows2D[3] || [];
  // 요일 헤더 행엔 월~금 뒤에 시수/교사/담임/비고 같은 요약 열 이름도 같은 줄에 이어져
  // 있다. 그 요약 열들은 교시번호(4행)가 비어있다는 게 유일한 구분점이라, dayList는
  // "교시번호가 실제로 파싱된 열"에서만 뽑아야 한다 — 그냥 텍스트가 있다고 다 요일로
  // 넣으면 시수/교사/담임/비고가 가짜 요일 열로 그리드에 붙어버린다.
  var cols = [];
  var currentDay = null;
  for (var c = 2; c < dayRow.length; c++) {
    if (dayRow[c] != null && String(dayRow[c]).trim() !== '') {
      currentDay = String(dayRow[c]).trim();
    }
    var p = periodRow[c];
    if (p == null || p === '') continue;
    var period = parseInt(p, 10);
    if (isNaN(period)) continue;
    cols.push({ col: c, day: currentDay, period: period });
  }
  if (!cols.length) throw new Error('전체 교사 시간표에서 요일/교시 헤더를 찾을 수 없습니다.');
  var dayList = [];
  cols.forEach(function (cd) {
    if (dayList.indexOf(cd.day) === -1) dayList.push(cd.day);
  });

  var blocks = [];
  var r = 4;
  while (r < rows2D.length) {
    var row = rows2D[r];
    if (row && row[1] != null && String(row[1]).trim() !== '') {
      var teacher = String(row[1]).trim();
      var infoRow = rows2D[r + 1] || [];
      var tuples = [];
      cols.forEach(function (cd) {
        var subjRaw = row[cd.col];
        var subject = subjRaw == null ? '' : String(subjRaw).trim().replace(/\n/g, '');
        if (!subject) return;
        var infoRaw = infoRow[cd.col];
        var info = infoRaw == null ? '' : String(infoRaw).trim();
        tuples.push({ key: teacher, day: cd.day, period: cd.period, subject: subject, info: info });
      });
      blocks.push({ key: teacher, tuples: tuples });
      r += 2;
    } else {
      r += 1;
    }
  }
  return { blocks: blocks, dayList: dayList };
}

export function buildTeacherRecords(blocks) {
  var records = [];
  blocks.forEach(function (block) {
    block.tuples.forEach(function (t) {
      records.push({
        teacher: t.key,
        day: t.day,
        period: t.period,
        subject: t.subject,
        className: t.info || null,
        isFree: t.subject === '공강',
        isChangChe: t.subject === '창체',
        moveGroupId: computeMoveGroupId(t.subject, t.info, t.day, t.period)
      });
    });
  });
  return records;
}

export function parseTeacherSubjects(rows2D) {
  var headerIdx = -1;
  for (var r = 0; r < rows2D.length; r++) {
    var c0 = rows2D[r] && rows2D[r][0];
    if (c0 != null && String(c0).trim() === '교사명') { headerIdx = r; break; }
  }
  if (headerIdx === -1) throw new Error('교사_담당교과 시트에서 헤더(교사명) 행을 찾을 수 없습니다.');
  var map = {};
  for (var i = headerIdx + 1; i < rows2D.length; i++) {
    var row = rows2D[i];
    if (!row) continue;
    var name = row[0] == null ? '' : String(row[0]).trim();
    if (!name) continue;
    var subject = row[1] == null ? '' : String(row[1]).trim();
    var note = row[2] == null ? '' : String(row[2]).trim();
    if (map[name]) console.warn('[parseTeacherSubjects] 중복 교사명: ' + name);
    map[name] = { subject: subject, note: note };
  }
  return map;
}

export function parseSettings(rows2D) {
  var headerIdx = -1;
  for (var r = 0; r < rows2D.length; r++) {
    var c0 = rows2D[r] && rows2D[r][0];
    if (c0 != null && String(c0).trim() === '항목') { headerIdx = r; break; }
  }
  var labelMap = { '학교명': 'schoolName', '학년도': 'year', '학기': 'semester' };
  var result = {};
  var start = headerIdx === -1 ? 0 : headerIdx + 1;
  for (var i = start; i < rows2D.length; i++) {
    var row = rows2D[i];
    if (!row) continue;
    var label = row[0] == null ? '' : String(row[0]).trim();
    var key = labelMap[label];
    if (key) result[key] = row[1] == null ? '' : String(row[1]).trim();
  }
  return result;
}

// ---------- indices ----------
export function buildTeacherScheduleMap(records) {
  var map = {};
  records.forEach(function (rec) {
    if (!map[rec.teacher]) map[rec.teacher] = {};
    if (!map[rec.teacher][rec.day]) map[rec.teacher][rec.day] = {};
    map[rec.teacher][rec.day][rec.period] = rec;
  });
  return map;
}

export function buildClassScheduleMap(records) {
  var map = {};
  records.forEach(function (rec) {
    if (!rec.className) return;
    if (!map[rec.className]) map[rec.className] = {};
    if (!map[rec.className][rec.day]) map[rec.className][rec.day] = {};
    map[rec.className][rec.day][rec.period] = rec;
  });
  return map;
}

export function buildMoveGroupIndex(records) {
  var index = {};
  records.forEach(function (rec) {
    if (!rec.moveGroupId) return;
    if (!index[rec.moveGroupId]) {
      var grade = rec.className.trim().charAt(0);
      var tag = rec.subject.trim().slice(-1);
      index[rec.moveGroupId] = { day: rec.day, period: rec.period, grade: grade, tag: tag, members: [] };
    }
    index[rec.moveGroupId].members.push({ teacher: rec.teacher, subject: rec.subject, className: rec.className });
  });
  return index;
}

export function getRecord(map, key, day, period) {
  return map[key] && map[key][day] && map[key][day][period];
}
export function isEmpty(map, key, day, period) {
  var rec = getRecord(map, key, day, period);
  return !rec || rec.isFree === true;
}
export function isEmptyOrOwnGroup(map, key, day, period, excludeGroupId) {
  var rec = getRecord(map, key, day, period);
  if (!rec || rec.isFree) return true;
  if (excludeGroupId && rec.moveGroupId === excludeGroupId) return true;
  return false;
}
export function allWeekSlots(dayList) {
  var slots = [];
  dayList.forEach(function (day) {
    for (var period = 1; period <= 7; period++) slots.push({ day: day, period: period });
  });
  return slots;
}
