// Reads the sender's own short note, in the browser, and fills in what the note already says: the
// department, a full Chinese name that is on the authorization, an employee number that is on it. It
// runs only here. The note is never sent anywhere; the resolve request carries the fields it filled in
// and nothing else. Fixed keyword rules, a closed vocabulary, no model.
//
// It fills boxes and narrows the list; it never selects anyone. The sender still presses Find, and the
// server still applies the matching rule, the authorization and the failure limit.

// Common ways to say a department. The key is a department id as the directory writes it; a directory
// with other ids still works through the department's own id and display name below.
export const DEPARTMENT_WORDS = {
  sales: ['業務', '銷售', '業務部', 'sales'],
  accounting: ['會計', '財務', '帳務', 'accounting', 'finance'],
  hr: ['人事', '人資', '人力資源', 'hr'],
  management: ['管理', '主管', 'management'],
  ops: ['營運', 'ops', 'operations']
};
const HONORIFICS = ['先生', '小姐', '女士', '經理', '副理', '主任', '協理', '總監'];

const fold = value => (typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '').toLowerCase() : '');

// departments: [{ id, displayName }] as the directory lists them. people: the recipients on this
// authorization, as the picker already holds them.
export function classifyNote(note, people = [], departments = []) {
  const text = fold(note);
  const result = { department: null, departmentAmbiguous: false, nameZh: null, employeeId: null, surname: null };
  if (!text) return result;

  const hits = new Set();
  for (const department of departments) {
    const terms = [department.id, department.displayName, String(department.displayName || '').replace(/(部門|部)$/u, ''),
      ...(DEPARTMENT_WORDS[String(department.id).toLowerCase()] || [])].map(fold).filter(term => term.length >= 2);
    if (terms.some(term => text.includes(term))) hits.add(department.id);
  }
  if (hits.size === 1) result.department = [...hits][0];
  else if (hits.size > 1) result.departmentAmbiguous = true;

  // An employee number counts only when it is the whole token, so "e12" inside "e1234" is not found.
  const tokens = new Set(String(note).normalize('NFKC').split(/[^A-Za-z0-9_-]+/).filter(Boolean).map(token => token.toLowerCase()));
  const byId = people.filter(person => tokens.has(String(person.id).toLowerCase()));
  if (byId.length === 1) result.employeeId = byId[0].id;

  // A full Chinese name that someone on the authorization carries. Longest first, so a longer name is
  // not shadowed by a shorter one it contains; two different names found means the note is unclear.
  const names = [...new Set(people.map(person => person.nameZh).filter(name => typeof name === 'string' && fold(name).length >= 2))]
    .sort((a, b) => fold(b).length - fold(a).length);
  const found = names.filter(name => text.includes(fold(name)));
  const longest = found.filter(name => !found.some(other => other !== name && fold(other).includes(fold(name))));
  if (longest.length === 1) result.nameZh = longest[0];

  // A surname with an honorific ("劉先生") is not a name to match on; it only narrows the list.
  if (!result.nameZh) {
    const match = String(note).normalize('NFKC').match(new RegExp(`([\\u4e00-\\u9fff])(?:${HONORIFICS.join('|')})`, 'u'));
    if (match) result.surname = match[1];
  }
  return result;
}
