const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', `${location.pathname}${location.search}`);

const form = document.querySelector('#invitationForm');
const title = document.querySelector('#inviteTitle');
const description = document.querySelector('#inviteDescription');
const errorBox = document.querySelector('#inviteError');
const workspaceLink = document.querySelector('#workspaceLink');
let invitation = null;

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'انجام درخواست ناموفق بود.');
  return data;
}

async function inspect() {
  if (!token) throw new Error('توکن دعوت در لینک وجود ندارد.');
  invitation = await request('/api/v2/auth/invitations/inspect', { token });
  const selected = invitation.invitation || invitation;
  title.textContent = `دعوت به ${selected.organizationName || 'سازمان'}`;
  description.textContent = `این دعوت برای ${selected.email || 'ایمیل شما'} و نقش ${selected.roleLabel || selected.roleKey || 'عضو'} صادر شده است.`;
  form.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const fields = new FormData(form);
  if (fields.get('password') !== fields.get('passwordConfirm')) {
    errorBox.textContent = 'تکرار رمز با رمز شخصی یکسان نیست.';
    errorBox.hidden = false;
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/v2/auth/invitations/accept', {
      token,
      fullName: fields.get('fullName'),
      password: fields.get('password'),
    });
    title.textContent = 'عضویت شما فعال شد';
    description.textContent = 'اکنون می‌توانید با ایمیل و رمز شخصی وارد فضای کاری شوید.';
    form.hidden = true;
    workspaceLink.hidden = false;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

inspect().catch((error) => {
  title.textContent = 'این دعوت قابل استفاده نیست';
  description.textContent = 'ممکن است لینک منقضی، لغو یا قبلاً استفاده شده باشد.';
  errorBox.textContent = error.message;
  errorBox.hidden = false;
});
