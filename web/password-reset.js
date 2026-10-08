// SPDX-License-Identifier: GPL-3.0-or-later
const requestForm = document.querySelector('#request-reset');
const completeForm = document.querySelector('#complete-reset');
const feedback = document.querySelector('#reset-feedback');
const intro = document.querySelector('#reset-intro');
const token = new URLSearchParams(location.hash.slice(1)).get('token');

if (token) {
  history.replaceState(null, '', location.pathname);
  requestForm.hidden = true;
  if (/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    completeForm.hidden = false;
    intro.textContent = 'Kies een nieuw wachtwoord van minimaal 14 tekens.';
  } else {
    feedback.textContent = 'Deze herstellink is ongeldig of verlopen. Vraag een nieuwe link aan.';
  }
}

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  feedback.textContent = '';
  const email = new FormData(requestForm).get('email');
  try {
    const response = await fetch('/api/auth/password-reset/request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('De aanvraag kon niet worden verwerkt. Probeer het later opnieuw.');
    feedback.textContent = result.data.message;
    feedback.classList.remove('error');
    requestForm.reset();
  } catch (error) {
    feedback.textContent = error.message || 'De aanvraag kon niet worden verwerkt.';
    feedback.classList.add('error');
  }
});

completeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  feedback.textContent = '';
  const form = new FormData(completeForm);
  const newPassword = form.get('password');
  if (newPassword !== form.get('confirm')) {
    feedback.textContent = 'De wachtwoorden zijn niet hetzelfde.';
    feedback.classList.add('error');
    return;
  }
  try {
    const response = await fetch('/api/auth/password-reset/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error === 'INVALID_NEW_PASSWORD'
      ? 'Gebruik minimaal 14 tekens voor het nieuwe wachtwoord.'
      : 'De herstellink is ongeldig of verlopen. Vraag een nieuwe link aan.');
    completeForm.reset();
    completeForm.hidden = true;
    intro.textContent = 'Je wachtwoord is aangepast. Je kunt nu inloggen.';
    feedback.textContent = 'Wachtwoord opgeslagen.';
    feedback.classList.remove('error');
  } catch (error) {
    feedback.textContent = error.message || 'Het wachtwoord kon niet worden aangepast.';
    feedback.classList.add('error');
  }
});
