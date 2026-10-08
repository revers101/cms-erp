// SPDX-License-Identifier: GPL-3.0-or-later

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function createResendEmailSender({ apiKey, from, origin, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof from !== 'string' || !from.trim() ||
      apiKey.length > 4096 || from.length > 254 || /[\r\n]/u.test(from) || typeof origin !== 'string') {
    throw new Error('Email delivery requires a Resend API key, sender, and exact site origin.');
  }
  const expectedOrigin = new URL(origin);
  if (expectedOrigin.origin !== origin || (expectedOrigin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(expectedOrigin.hostname))) {
    throw new Error('Email delivery requires an exact HTTPS site origin.');
  }
  const senderAddress = /<([^<>]+)>/u.exec(from)?.[1] ?? from;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(senderAddress)) throw new Error('Email delivery requires a sender email address.');

  async function sendMessage({ to, url, kind = 'password-reset' }) {
    if (typeof to !== 'string' || to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(to) || typeof url !== 'string') throw new Error('INVALID_EMAIL_MESSAGE');
    const link = new URL(url);
    const expectedPath = kind === 'invitation' ? '/invite' : '/password-reset';
    if (!['password-reset', 'invitation'].includes(kind) || link.origin !== expectedOrigin.origin || link.pathname !== expectedPath ||
        !/^#token=[A-Za-z0-9_-]{43}$/u.test(link.hash)) {
      throw new Error(kind === 'password-reset' ? 'INVALID_PASSWORD_RESET_URL' : 'INVALID_INVITATION_URL');
    }
    const safeUrl = escapeHtml(link.href);
    const subject = kind === 'invitation' ? 'Uitnodiging voor CMS/ERP' : 'Wachtwoord herstellen voor CMS/ERP';
    const text = kind === 'invitation'
      ? `Je bent uitgenodigd voor CMS/ERP. Gebruik deze eenmalige link om je account in te stellen. De link verloopt na zeven dagen.\n\n${link.href}\n\nHeb je dit niet verwacht? Negeer deze e-mail.`
      : `Gebruik deze link om je wachtwoord opnieuw in te stellen. De link verloopt na 30 minuten.\n\n${link.href}\n\nHeb je dit niet aangevraagd? Negeer deze e-mail.`;
    const html = kind === 'invitation'
      ? `<p>Je bent uitgenodigd voor CMS/ERP.</p><p><a href="${safeUrl}">Account instellen</a></p><p>De link is eenmalig en verloopt na zeven dagen. Heb je dit niet verwacht? Negeer deze e-mail.</p>`
      : `<p>Je hebt gevraagd om je CMS/ERP-wachtwoord opnieuw in te stellen.</p><p><a href="${safeUrl}">Stel mijn wachtwoord in</a></p><p>De link verloopt na 30 minuten. Heb je dit niet aangevraagd? Negeer deze e-mail.</p>`;
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('EMAIL_PROVIDER_REJECTED');
  }
  const sender = (message) => sendMessage(message);
  sender.sendInvitation = ({ to, url }) => sendMessage({ to, url, kind: 'invitation' });
  return sender;
}
