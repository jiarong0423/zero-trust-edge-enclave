// What the sender sees for one candidate recipient. The display name alone cannot tell two people
// apart when a large organisation has several with the same name, so the department and the unique
// directory id are always part of the label. The id is what the snapshot stores; the name is only a
// reading aid.
export function recipientLabel(person) {
  const department = typeof person.department === 'string' && person.department ? person.department : 'unassigned';
  const name = typeof person.displayName === 'string' && person.displayName ? person.displayName : person.id;
  const email = typeof person.email === 'string' && person.email ? ` (${person.email})` : '';
  return `${name} · ${department} · ${person.id}${email}`;
}
