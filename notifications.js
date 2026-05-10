const nodemailer = require('nodemailer');
const axios = require('axios');
const { pool } = require('./db');

const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/.+$/;

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendNotifications() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const usersResult = await pool.query('SELECT * FROM users');
  for (const user of usersResult.rows) {
    if (!user.notify_email && !user.notify_discord) continue;

    const watchResult = await pool.query(
      'SELECT * FROM watchlist WHERE user_id = $1',
      [user.id]
    );

    const toNotify = [];
    for (const item of watchResult.rows) {
      if (!item.item_deadline) continue;
      const deadline = new Date(item.item_deadline);
      const daysLeft = Math.ceil((deadline - today) / 86400000);
      if (daysLeft < 0 || daysLeft > (user.notify_days_before || 3)) continue;

      const alreadySent = await pool.query(
        'SELECT 1 FROM notifications_sent WHERE user_id = $1 AND item_key = $2',
        [user.id, item.item_key]
      );
      if (alreadySent.rows.length > 0) continue;

      toNotify.push({ ...item, daysLeft });
    }

    if (toNotify.length === 0) continue;

    const lines = toNotify.map(i =>
      `• ${i.item_name} — closes in ${i.daysLeft} day(s) (${i.item_deadline})`
    ).join('\n');

    const mailer = getTransporter();
    if (user.notify_email && mailer) {
      try {
        await mailer.sendMail({
          from: `"AnimeAlert" <${process.env.SMTP_USER}>`,
          to: user.notify_email,
          subject: `AnimeAlert: ${toNotify.length} pre-order(s) closing soon`,
          text: `Pre-order deadlines approaching:\n\n${lines}\n\nView your watchlist at your AnimeAlert account.`,
        });
      } catch (err) {
        console.error(`Email error for user ${user.id}:`, err.message);
      }
    }

    if (user.notify_discord && DISCORD_WEBHOOK_RE.test(user.notify_discord)) {
      try {
        await axios.post(user.notify_discord, {
          content: `**AnimeAlert** Pre-order deadlines approaching:\n${lines}`,
        }, { timeout: 5000 });
      } catch (err) {
        console.error(`Discord error for user ${user.id}:`, err.message);
      }
    }

    for (const item of toNotify) {
      await pool.query(
        'INSERT INTO notifications_sent (user_id, item_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.id, item.item_key]
      );
    }
  }
}

module.exports = { sendNotifications };
