export var STATE = {
  records: [], dayList: [], teacherScheduleMap: {}, classScheduleMap: {},
  moveGroupIndex: {}, teacherSubjects: {}, teacherNames: [], weekSlots: [],
  currentTeacher: null, settings: {},
  absencesByTeacher: {} // { [teacherName]: [{ day, period }, ...] } — 교사가 등록한 출장·결근
};
