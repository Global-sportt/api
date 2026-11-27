import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { AppConfigService } from '../../../config/app-config.service';
import { AppLogger } from '../../../common/logging/app-logger.service';
import { AppError } from '../../../common/errors/app-error';

interface MailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

@Injectable()
export class MailerService {
  private readonly transporter: Transporter | null;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    const smtp = config.smtp;
    this.transporter = smtp
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: smtp.user
            ? {
                user: smtp.user,
                pass: smtp.pass,
              }
            : undefined,
        })
      : null;
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = this.webUrl('/verify-email', token);
    await this.send({
      to,
      subject: 'Verifica tu correo',
      text: `Confirma tu correo en ${url}\n\nEl enlace vence en 24 horas.`,
      html: this.layout(
        'Verifica tu correo',
        'Confirma tu correo para activar tu cuenta.',
        url,
        'Verificar correo',
        'El enlace vence en 24 horas.',
      ),
    });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const url = this.webUrl('/reset-password', token);
    await this.send({
      to,
      subject: 'Restablece tu contraseña',
      text: `Restablece tu contraseña en ${url}\n\nEl enlace vence en 1 hora. Si no lo solicitaste, ignora este mensaje.`,
      html: this.layout(
        'Restablece tu contraseña',
        'Recibimos una solicitud para cambiar la contraseña de tu cuenta.',
        url,
        'Cambiar contraseña',
        'El enlace vence en 1 hora. Si no lo solicitaste, ignora este mensaje.',
      ),
    });
  }

  private async send(input: MailInput): Promise<void> {
    if (!this.transporter) {
      if (this.config.isProduction) {
        throw new AppError(
          503,
          'EMAIL_NOT_CONFIGURED',
          'El envío de correos no está configurado.',
        );
      }

      this.logger.raw.info(
        {
          event: 'email_preview',
          to: this.maskEmail(input.to),
          subject: input.subject,
          text: input.text,
        },
        'email_preview',
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.config.env.MAIL_FROM,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
    } catch (error) {
      this.logger.raw.error(
        {
          event: 'email_delivery_failed',
          to: this.maskEmail(input.to),
          subject: input.subject,
          err: error,
        },
        'email_delivery_failed',
      );
      throw new AppError(
        503,
        'EMAIL_DELIVERY_FAILED',
        'No pudimos enviar el correo. Intenta de nuevo en unos minutos.',
      );
    }
  }

  private webUrl(path: string, token: string): string {
    const url = new URL(path, this.config.env.WEB_APP_URL);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const visible = local.slice(0, 1);
    return `${visible}***@${domain}`;
  }

  private layout(
    title: string,
    intro: string,
    url: string,
    button: string,
    footer: string,
  ): string {
    const safeUrl = this.escapeHtml(url);
    return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f6f3;font-family:Arial,sans-serif;color:#14231a">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
          <tr><td>
            <h1 style="font-size:22px;margin:0 0 12px">${this.escapeHtml(title)}</h1>
            <p style="font-size:15px;line-height:1.6;margin:0 0 24px">${this.escapeHtml(intro)}</p>
            <a href="${safeUrl}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${this.escapeHtml(button)}</a>
            <p style="font-size:12px;line-height:1.6;color:#5b6b60;margin:24px 0 0">${this.escapeHtml(footer)}</p>
            <p style="font-size:11px;line-height:1.6;color:#7b8a80;margin:16px 0 0;word-break:break-all">${safeUrl}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
