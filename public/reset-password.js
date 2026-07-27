const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', `${location.pathname}${location.search}`);

const form = document.querySelector('#resetForm');
const errorBox = document.querySelector('#resetError');
const title = document.querySelector('#resetTitle');
const loginLink = document.querySelector('#loginLink');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const fields = new FormData(form);
  const password = String(fields.get('password') || '');
  if (!token) {
    errorBox.textContent = 'توکن بازیابی در لینک وجود ندارد.';
    errorBox.hidden = false;
    return;
  }
  if (password !== fields.get('passwordConfirm')) {
    errorBox.textContent = 'تکرار رمز با رمز جدید یکسان نیست.';
    errorBox.hidden = false;
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch('/api/v2/auth/password-reset/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token, newPassword: password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'تغییر رمز ناموفق بود.');
    title.textContent = 'رمز شما تغییر کرد';
    form.hidden = true;
    loginLink.hidden = false;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});
