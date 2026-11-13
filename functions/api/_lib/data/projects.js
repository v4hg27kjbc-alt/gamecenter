// 项目（深度研究报告）登记表：券码可关联的项目白名单
// key 一旦上线不可修改（券码记录里持久化保存 key）
export const PROJECTS = [
  {
    key: 'c919',
    title: '国产大型客机 C919：研制历程、技术体系与产业化进程综合研究报告',
    short: 'C919 综合研究报告',
    file: '/projects/c919.md',
    builtin: true
  },
  {
    key: 'a320',
    title: '空客 A320 系列综合研究报告',
    short: 'A320 系列报告',
    file: '/projects/a320.md',
    builtin: false
  },
  {
    key: 'b737',
    title: '波音 737 系列综合研究报告',
    short: '737 系列报告',
    file: '/projects/b737.md',
    builtin: false
  }
];

export const PROJECT_KEYS = PROJECTS.map(function (p) { return p.key; });

// 规范化前端传入的项目 key 列表：去空、去重、只保留白名单内
export function normProjectKeys(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const out = [];
  arr.forEach(function (k) {
    const v = String(k || '').trim().toLowerCase();
    if (!v) return;
    if (PROJECT_KEYS.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

// 券码是否允许用于该项目：空列表 = 不限制（通用券）
export function couponAllowsProject(rec, projectKey) {
  const list = Array.isArray(rec && rec.projectKeys) ? rec.projectKeys : [];
  if (!list.length) return true;
  const k = String(projectKey || '').trim().toLowerCase();
  if (!k) return false;
  return list.indexOf(k) >= 0;
}

export function projectTitle(key) {
  const hit = PROJECTS.filter(function (p) { return p.key === key; })[0];
  return hit ? hit.short : key;
}
