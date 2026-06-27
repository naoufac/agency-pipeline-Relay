// CLI: verify SMTP + send a production test. Usage: npm run mail:test -- <to@addr>
import { sendMail, verifyMailer, mailerReady } from './mailer.ts';

const to = process.argv[2] || 'nchobah@gmail.com';

(async () => {
  if (!mailerReady()) { console.error('SMTP not configured (SMTP_HOST/USER/PASS missing)'); process.exit(1); }
  try {
    console.log('verifying SMTP connection + auth…');
    await verifyMailer();
    console.log('verify ok — sending to', to);
    const id = await sendMail({
      to,
      subject: '✅ Relay mailer — production test (app path)',
      text: 'Sent through Relay’s built-in mailer (nodemailer → naples.agency SMTP).\n'
          + 'SPF + DKIM + DMARC are aligned to this server, so this is inbox-grade.\n\n— Relay',
    });
    console.log('SENT ok, message-id =', id);
    process.exit(0);
  } catch (e: any) {
    console.error('FAILED:', e?.message ?? e);
    process.exit(1);
  }
})();
