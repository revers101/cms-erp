// SPDX-License-Identifier: GPL-3.0-or-later
const form = document.getElementById('accept-invitation');
const feedback = document.getElementById('invitation-feedback');
let token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);

if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
  form.hidden = true;
  feedback.textContent = 'Deze uitnodigingslink is ongeldig of verlopen. Vraag een beheerder om een nieuwe uitnodiging.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = form.elements.password.value;
  const confirm = form.elements.confirm.value;
  if (password.length < 14 || password.length > 1024) {
    feedback.textContent = 'Kies een uniek wachtwoord van minimaal 14 tekens.';
    return;
  }
  if (password !== confirm) {
    feedback.textContent = 'De wachtwoorden zijn niet gelijk.';
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/invitations/accept', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
    token = '';
    form.reset();
    form.hidden = true;
    feedback.textContent = 'Je account is geactiveerd. Je kunt nu inloggen.';
  } catch (error) {
    feedback.textContent = error.message === 'INVALID_OR_EXPIRED_INVITATION'
      ? 'Deze uitnodiging is al gebruikt of verlopen. Vraag een beheerder om een nieuwe uitnodiging.'
      : 'Account activeren is niet gelukt. Probeer het later opnieuw.';
    button.disabled = false;
  }
});
