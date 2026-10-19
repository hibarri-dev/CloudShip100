const nodemailer = require('nodemailer');
const { BrevoClient } = require('@getbrevo/brevo');
const httpStatus = require('http-status');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

const transport = nodemailer.createTransport(config.email.smtp);
const brevoApi = new BrevoClient({ apiKey: config.email.brevoApiKey });

const isSmtpConfigured = () => Boolean(config.email.smtp && config.email.smtp.host && config.email.from);



/* istanbul ignore next */
if (config.env !== 'test' && !config.email.useBrevo) {
  transport
    .verify()
    .then(() => logger.info('Connected to email server'))
    .catch((err) => {
      logger.error(`Unable to connect to email server: ${err.message}`);
    });
}

const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const brandedHtml = (heading, paragraphs, cta) => {
  const body = (paragraphs || [])
    .map((p) => `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
  const button = cta
    ? `<p style="margin:24px 0 8px"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#007bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:700">${escapeHtml(
        cta.label
      )}</a></p>`
    : '';
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;background:#f4f6fb;padding:24px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
      <p style="margin:0 0 8px;color:#007bff;font-weight:800;letter-spacing:0.22em;font-size:11px">CLOUDSHIP</p>
      <h1 style="margin:0 0 16px;font-size:22px;color:#0f172a">${escapeHtml(heading)}</h1>
      ${body}
      ${button}
      <p style="margin:28px 0 0;color:#64748b;font-size:12px;line-height:1.5">CloudShip logistics · <a href="${escapeHtml(
        config.frontendUrl
      )}">${escapeHtml(config.frontendUrl)}</a></p>
    </div>
  </body>
</html>`;
};

/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [html]
 * @returns {Promise}
 */
const sendEmail = async (to, subject, text, html) => {
  if (config.email.useBrevo) {
    if (!config.email.brevoApiKey) {
      throw new Error('Brevo API key is not configured');
    }
    const email = {
      sender: { name: config.email.fromName, email: config.email.from },
      to: [{ email: to }],
      subject,
      textContent: text,
    };
    if (html) email.htmlContent = html;
    await brevoApi.transactionalEmails.sendTransacEmail(email);
    return;
  }

  const msg = { from: config.email.from, to, subject, text };
  if (html) msg.html = html;
  await transport.sendMail(msg);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toEmailSendError = (err) => {
  const detail = (err && err.message) || 'unknown email provider error';
  const code = err && err.code ? ` [${err.code}]` : '';
  return new ApiError(httpStatus.BAD_GATEWAY, `Unable to send email: ${detail}${code}`);
};

const sendTemplatedEmail = async (to, subject, heading, paragraphs, cta) => {
  const textParts = [heading, '', ...(paragraphs || [])];
  if (cta && cta.href) textParts.push('', cta.label, cta.href);
  textParts.push('', `CloudShip · ${config.frontendUrl}`);
  const html = brandedHtml(heading, paragraphs, cta);
  const text = textParts.join('\n');
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await sendEmail(to, subject, text, html);
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleep(400 * (i + 1));
      }
    }
  }
  throw toEmailSendError(lastErr);
};

/**
 * Send reset password email
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendResetPasswordEmail = async (to, token) => {
  const resetPasswordUrl = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendTemplatedEmail(
    to,
    'Reset your CloudShip password',
    'Reset password',
    ['Use the button below to choose a new password. If you did not request this, you can ignore this email.'],
    { href: resetPasswordUrl, label: 'Reset password' }
  );
};

/**
 * Send verification email
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendVerificationEmail = async (to, token) => {
  const verificationEmailUrl = `${config.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await sendTemplatedEmail(
    to,
    'Verify your CloudShip email',
    'Verify your email',
    ['Confirm this address to finish creating your CloudShip account.'],
    { href: verificationEmailUrl, label: 'Verify email' }
  );
};

const sendOperatorInviteEmail = async (to, name, token) => {
  const inviteUrl = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}&next=ops`;
  await sendTemplatedEmail(
    to,
    'You are invited to CloudShip operations',
    'Operator invite',
    [`Hi ${name || 'there'},`, 'An administrator invited you to CloudShip operations. Set your password to activate the account.'],
    { href: inviteUrl, label: 'Set password' }
  );
};

const sendEmailSafe = async (to, subject, heading, paragraphs, cta) => {
  if (!to) return;
  try {
    await sendTemplatedEmail(to, subject, heading, paragraphs, cta);
  } catch (err) {
    logger.error(`Email to ${to} failed after retries: ${err.message}`);
  }
};

const trackingUrlFor = (booking) => {
  const token = booking.trackingToken || booking.code;
  const param = booking.trackingToken ? 'token' : 'code';
  return `${config.frontendUrl}/embed/track?${param}=${encodeURIComponent(token)}`;
};

// Sandbox (test-mode) bookings never email real people.
const isSandbox = (booking) => Boolean(booking) && booking.livemode === false;

const sendShipmentBookedEmails = async ({ booking, shopEmail, shopName }) => {
  if (isSandbox(booking)) return;
  const track = booking.trackingNumber || booking.logisticsBookingRef || booking.code;
  const widget = trackingUrlFor(booking);
  await sendEmailSafe(
    booking.buyerEmail,
    `Your delivery ${booking.code} is booked`,
    'Your delivery is booked',
    [
      `Booking: ${booking.code}`,
      `From: ${booking.pickup}`,
      `To: ${booking.dropoff}`,
      `Courier: ${booking.partnerName || booking.selectedPartner || 'CloudShip'}`,
      `Tracking number: ${track}`,
      booking.trackingUrl ? `Courier tracking: ${booking.trackingUrl}` : '',
      `Thank you for shopping with ${shopName || 'us'}.`,
    ].filter(Boolean),
    { href: widget, label: 'Track shipment' }
  );
  await sendEmailSafe(
    shopEmail,
    `CloudShip booked ${booking.code}`,
    'A shopper paid for delivery',
    [
      `Booking: ${booking.code}`,
      `Shop order: ${booking.externalOrderId || '-'}`,
      `Customer pays: ${booking.quotedPrice} ${booking.currency || ''}`,
      `Courier cost: ${booking.carrierCost != null ? booking.carrierCost : '-'}`,
      `From: ${booking.pickup}`,
      `To: ${booking.dropoff}`,
      `Tracking: ${track}`,
    ],
    { href: widget, label: 'Open tracking' }
  );
};

const sendBookingConfirmationEmail = async ({ booking, to }) => {
  if (isSandbox(booking)) return;
  await sendEmailSafe(
    to || booking.buyerEmail || booking.customerEmail,
    `Booking ${booking.code} confirmed`,
    'Booking confirmed',
    [
      `Booking: ${booking.code}`,
      `From: ${booking.pickup}`,
      `To: ${booking.dropoff}`,
      `Status: ${booking.status || 'booked'}`,
    ],
    { href: trackingUrlFor(booking), label: 'Track shipment' }
  );
};

const sendShipmentStatusEmail = async ({ booking, to, status, detail }) => {
  if (isSandbox(booking)) return;
  await sendEmailSafe(
    to || booking.buyerEmail || booking.customerEmail,
    `Shipment ${booking.code} is ${status}`,
    `Shipment ${status}`,
    [`Booking: ${booking.code}`, detail, `From: ${booking.pickup}`, `To: ${booking.dropoff}`].filter(Boolean),
    { href: trackingUrlFor(booking), label: 'Track shipment' }
  );
};

const sendDriverAssignedEmail = async ({ booking, to, driverName }) => {
  if (isSandbox(booking)) return;
  await sendEmailSafe(
    to,
    `You were assigned booking ${booking.code}`,
    'New assignment',
    [
      `Booking: ${booking.code}`,
      driverName ? `Driver: ${driverName}` : '',
      `From: ${booking.pickup}`,
      `To: ${booking.dropoff}`,
    ].filter(Boolean)
  );
};

const sendKycReminderEmail = async ({ to, documentType, expiresOn }) => {
  await sendEmailSafe(
    to,
    'CloudShip document reminder',
    'A compliance document needs attention',
    [`Document: ${documentType || 'KYC document'}`, expiresOn ? `Expires: ${expiresOn}` : 'Please review this document in your portal.'],
    { href: `${config.frontendUrl}/customer/documents`, label: 'Open documents' }
  );
};

const sendDriverApprovalEmail = async ({ to, driverName, approvalStatus }) => {
  const approved = approvalStatus === 'active';
  await sendEmailSafe(
    to,
    approved ? 'You are approved to drive for CloudShip' : 'CloudShip driver application update',
    approved ? 'Driver account approved' : 'Driver application update',
    [
      `Hi ${driverName || 'there'},`,
      approved
        ? 'An operator approved your driver account. You can now receive parcel assignments.'
        : `Your driver account is now ${approvalStatus}. Contact operations if you need help.`,
    ],
    { href: `${config.frontendUrl}/driver`, label: 'Open driver portal' }
  );
};

module.exports = {
  transport,
  sendEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
  sendOperatorInviteEmail,
  sendShipmentBookedEmails,
  sendBookingConfirmationEmail,
  sendShipmentStatusEmail,
  sendDriverAssignedEmail,
  sendKycReminderEmail,
  sendDriverApprovalEmail,
  sendEmailSafe,
  isSmtpConfigured,
};
