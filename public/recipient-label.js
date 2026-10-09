// What the sender sees for one candidate recipient. The display name alone cannot tell two people
// apart when a large organisation has several with the same name, so the department and the unique
// directory id are always part of the label. The id is what the snapshot stores; the name is only a
// reading aid.
export function recipientLabel(person) {
  const department = typeof person.department === 'string' && person.department ? person.department : 'unassigned';
  const name = typeof person.displayName === 'string' && person.displayName ? person.displayName : person.id;
  const email = typeof person.email === 'string' && person.email ? ` (${person.email})` : '';
  const zh = typeof person.nameZh === 'string' && person.nameZh ? `${person.nameZh} · ` : '';
  const tags = person.tags && typeof person.tags === 'object'
    ? Object.values(person.tags).filter(value => typeof value === 'string' && value).join('/') : '';
  const title = typeof person.title === 'string' && person.title ? ` · ${person.title}` : '';
  return `${zh}${name} · ${department} · ${person.id}${tags ? ` [${tags}]` : ''}${title}${email}`;
}

// True when another person in the list carries the same Chinese name, so the sender is told to look at
// the employee number before ticking the box.
export function sharesChineseName(person, people) {
  const key = value => (typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '') : '');
  const mine = key(person.nameZh);
  return Boolean(mine) && people.some(other => other.id !== person.id && key(other.nameZh) === mine);
}
