const form = document.querySelector('#gateForm');
const status = document.querySelector('#gateStatus');

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.className = 'status-card';
  status.textContent = 'Checking...';
  const response = await fetch('/api/judge-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: document.querySelector('#gateUser').value, password: document.querySelector('#gatePassword').value })
  }).catch(() => null);
  if (response?.ok) { window.location.assign('/'); return; }
  status.className = 'status-card danger';
  status.textContent = response?.status === 429 ? 'Too many attempts. Wait a minute and try again.'
    : response?.status === 401 ? 'Username or password was not accepted.' : 'Sign-in is unavailable right now.';
});
