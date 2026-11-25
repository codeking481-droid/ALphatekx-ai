import nodemailer from 'nodemailer'

export async function sendPasswordResetEmail(email, url) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) {
    throw new Error('Password reset email is not configured on this server.')
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  })
  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Reset your AlphaTekx password',
    text: `Use this link to reset your AlphaTekx password: ${url}`,
  })
}
