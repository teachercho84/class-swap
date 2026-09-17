export var STATE = {
  records: [], dayList: [], teacherScheduleMap: {}, classScheduleMap: {},
  moveGroupIndex: {}, teacherSubjects: {}, teacherNames: [], weekSlots: [],
  currentTeacher: null, settings: {},
  absencesByTeacher: {}, // { [teacherName]: [{ day, period }, ...] } — 교사가 등록한 출장·결근
  preferSubstitute: false // true면 클릭한 셀의 1순위(맞교체·이동수업) 대신 2·3순위(대강)를 먼저 보여준다
};
