import { t } from './i18n.js';
import { rolePlan, HOME_OF, NAME_OF } from './role-plan.js';

// Each person sees the pages for their own role. A sender sees sending and the audit trail, an employee who
// receives sees receiving, an administrator sees administration. This only decides what is shown: the server
// refuses a wrong-role call whatever the page does. Before a token is verified the page shows only itself, so
// nobody is offered another role's page by default.
if (typeof document !== 'undefined') {
  const here = location.pathname === '/index.html' ? '/' : location.pathname;
  const pageRoles = (document.body.dataset.roles || '').split(/\s+/).filter(Boolean);
  const links = [...document.querySelectorAll('nav a.nav-link')].map(link => ({ link, href: new URL(link.href).pathname }));
  const main = document.querySelector('main');
  const notice = document.createElement('section');
  notice.className = 'panel role-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  main?.before(notice);

  const show = kind => {
    const plan = rolePlan(kind, here, pageRoles, links.map(item => item.href));
    for (const { link, href } of links) link.hidden = !plan.visible.includes(href);
    const bar = document.querySelector('header nav');
    if (bar) bar.hidden = plan.visible.length <= 1;
    for (const link of document.querySelectorAll('main a[href$="/admin.html"]')) link.hidden = kind !== 'administrator';
    if (main) main.hidden = plan.wrongPage;
    notice.hidden = !plan.wrongPage;
    if (!plan.wrongPage) return;
    notice.replaceChildren();
    const text = document.createElement('p');
    text.textContent = `${t('This page is not for your role')}: ${t(NAME_OF[kind] || 'Unknown role')}.`;
    notice.append(text);
    if (plan.home) {
      const go = document.createElement('a');
      go.className = 'button primary';
      go.href = (location.pathname.startsWith('/zh-TW/') ? '/zh-TW' : '') + plan.home;
      go.textContent = t('Go to your page');
      notice.append(go);
    }
  };

  window.addEventListener('identityverified', event => show(event.detail.kind));
  window.addEventListener('identitycleared', () => show(null));
  show(null);
}
