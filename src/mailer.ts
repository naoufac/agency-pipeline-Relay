// Production mailer — authenticated SMTP submission via the naples.agency mail server
// (in the domain SPF, signs DKIM, DMARC set → inbox-aligned). Config comes from env:
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

export function mailerReady(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let _t: nodemailer.Transporter | null = null;
function transport(): nodemailer.Transporter {
  if (!mailerReady()) throw new Error('SMTP not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env');
  if (!_t) _t = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,        // STARTTLS upgrade on 587
    requireTLS: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return _t;
}

export interface Mail { to: string; subject: string; text?: string; html?: string; replyTo?: string; }

// Send one message. Returns the provider message-id. Throws on failure (caller decides what to do).
export async function sendMail(m: Mail): Promise<string> {
  const info = await transport().sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo,
  });
  return info.messageId;
}

// Verify the SMTP connection + auth without sending (for healthchecks).
export async function verifyMailer(): Promise<boolean> {
  return transport().verify();
}
