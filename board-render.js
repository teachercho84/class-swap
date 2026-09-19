// 실제 시간표 그리드와 미리보기용 절반크기 시간표가 공유하는 렌더 로직.
function cellState(rec) {
  if (!rec) return 'empty';
  if (rec.isFree) return 'free';
  if (rec.isChangChe) return 'changche';
  if (rec.moveGroupId) return 'move';
  return 'normal';
}

// getRec(day,period)가 레코드를 돌려주고, opts.onCellClick이 있으면 그 셀에 클릭 핸들러를
// 붙인다(미리보기는 안 붙여서 읽기 전용이 됨). opts.diffMap이 있으면 "요일_교시" 키로
// 추가 CSS 클래스(slot-added/slot-covered)와 라벨을 얹는다(미리보기 diff 표시용).
// opts.dateMap이 있으면 같은 키의 칸 안에 작은 날짜 문구(예: "9/23")를 덧붙인다(인쇄용).
export function renderBoardInto(table, dayList, getRec, opts) {
  opts = opts || {};
  table.innerHTML = '';
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  dayList.forEach(function (day) {
    var th = document.createElement('th');
    th.textContent = day;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var period = 1; period <= 7; period++) {
    var tr = document.createElement('tr');
    var pCell = document.createElement('td');
    pCell.className = 'period-cell';
    pCell.textContent = period + '교시';
    tr.appendChild(pCell);

    dayList.forEach(function (day) {
      var rec = getRec(day, period);
      var td = document.createElement('td');
      td.className = 'slot';
      td.dataset.day = day;
      td.dataset.period = period;
      var state = cellState(rec);
      var diffInfo = opts.diffMap ? opts.diffMap[day + '_' + period] : null;
      if (diffInfo) td.className += ' slot-' + diffInfo.type;

      if (state === 'empty') {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'cell-empty';
        td.appendChild(emptyDiv);
      } else if (state === 'free') {
        var freeDiv = document.createElement('div');
        // 수요일 6·7교시는 학교 전체가 쉬는 시간이라 금요일 5·6교시(창체)와 같은 느낌으로
        // 보이도록 빗금 배경을 같이 준다 — 라벨은 그대로 "공강".
        var isWedLateFree = day === '수' && (period === 6 || period === 7);
        freeDiv.className = isWedLateFree ? 'cell-disabled changche' : 'cell-disabled';
        freeDiv.textContent = '공강';
        td.appendChild(freeDiv);
      } else if (state === 'changche') {
        var ccDiv = document.createElement('div');
        ccDiv.className = 'cell-disabled changche';
        ccDiv.textContent = '창체';
        td.appendChild(ccDiv);
      } else {
        if (state === 'move') td.className += ' cell-move';
        var btn = document.createElement('button');
        btn.className = 'cell-btn';
        btn.type = 'button';
        var subjSpan = document.createElement('span');
        subjSpan.className = 'subj';
        subjSpan.textContent = rec.subject;
        var clsSpan = document.createElement('span');
        clsSpan.className = 'cls';
        clsSpan.textContent = rec.className || '';
        btn.appendChild(subjSpan);
        btn.appendChild(clsSpan);
        var dateText = opts.dateMap ? opts.dateMap[day + '_' + period] : null;
        if (dateText) {
          var dateSpan = document.createElement('span');
          dateSpan.className = 'cell-date';
          dateSpan.textContent = dateText;
          btn.appendChild(dateSpan);
        }
        if (opts.onCellClick) {
          btn.addEventListener('click', (function (record, cellEl) {
            return function () { opts.onCellClick(record, cellEl); };
          })(rec, td));
        }
        td.appendChild(btn);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}
