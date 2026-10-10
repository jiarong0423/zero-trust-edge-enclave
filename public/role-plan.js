// Which pages a role sees, kept apart from the page script so it can be tested without a browser.
export const ROLE_OF = { '/': 'operator', '/audit.html': 'operator', '/decode.html': 'recipient', '/admin.html': 'administrator' };
export const HOME_OF = { operator: '/', recipient: '/decode.html', administrator: '/admin.html' };
export const NAME_OF = { operator: 'Sender', recipient: 'Recipient', administrator: 'Administrator', coordinator: 'Coordinator' };

// What to show for a verified role (or none yet): which nav links stay, and whether the page itself is for this role.
// The Chinese pages live under /zh-TW/ and are the same pages.
export const plain = path => path.replace(/^\/zh-TW(?=\/|$)/, '').replace(/^\/index\.html$/, '') || '/';

export function rolePlan(kind, here, pageRoles, hrefs) {
  const visible = hrefs.filter(href => kind ? ROLE_OF[plain(href)] === kind : plain(href) === plain(here));
  const wrongPage = Boolean(kind) && pageRoles.length > 0 && !pageRoles.includes(kind);
  return { visible, wrongPage, home: kind ? HOME_OF[kind] || null : null };
}

