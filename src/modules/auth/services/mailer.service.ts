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

/** Display-ready booking fields; the caller resolves timezone and currency. */
export interface BookingEmailDetails {
  publicCode: string;
  establishmentName: string;
  spaceName: string;
  startsAt: string;
  amount: string;
  address?: string | null;
  cancellationPolicy?: string | null;
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

  async sendBookingCreatedEmail(
    to: string,
    details: BookingEmailDetails,
  ): Promise<void> {
    const rows = this.bookingRows(details);
    await this.send({
      to,
      subject: `Reserva confirmada · ${details.publicCode}`,
      text: [
        'Tu reserva quedó registrada.',
        '',
        ...rows.map(([label, value]) => `${label}: ${value}`),
        '',
        'Conserva este correo como comprobante de tu reserva.',
      ].join('\n'),
      html: this.bookingLayout(
        'Reserva confirmada',
        'Tu reserva quedó registrada con estos datos.',
        rows,
        'Conserva este correo como comprobante de tu reserva.',
      ),
    });
  }

  async sendBookingCancelledEmail(
    to: string,
    details: BookingEmailDetails,
  ): Promise<void> {
    const rows = this.bookingRows(details);
    await this.send({
      to,
      subject: `Reserva cancelada · ${details.publicCode}`,
      text: [
        'Tu reserva fue cancelada.',
        '',
        ...rows.map(([label, value]) => `${label}: ${value}`),
        '',
        'Si tienes dudas sobre la cancelación, contacta al establecimiento.',
      ].join('\n'),
      html: this.bookingLayout(
        'Reserva cancelada',
        'Tu reserva fue cancelada con estos datos.',
        rows,
        'Si tienes dudas sobre la cancelación, contacta al establecimiento.',
      ),
    });
  }

  private bookingRows(
    details: BookingEmailDetails,
  ): Array<[string, string]> {
    const rows: Array<[string, string]> = [
      ['Código', details.publicCode],
      ['Espacio', details.spaceName],
      ['Sede', details.establishmentName],
      ['Fecha y hora', details.startsAt],
      ['Valor', details.amount],
    ];

    const address = details.address?.trim();
    if (address) rows.push(['Dirección', address]);

    const policy = details.cancellationPolicy?.trim();
    if (policy) rows.push(['Política de cancelación', policy]);

    return rows;
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
    return this.shell(
      title,
      intro,
      `            <a href="${safeUrl}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${this.escapeHtml(button)}</a>
            <p style="font-size:11px;line-height:1.6;color:#7b8a80;margin:16px 0 0;word-break:break-all">${safeUrl}</p>`,
      footer,
    );
  }

  private bookingLayout(
    title: string,
    intro: string,
    rows: Array<[string, string]>,
    footer: string,
  ): string {
    const body = rows
      .map(
        ([label, value]) =>
          `            <tr><td style="padding:8px 12px 8px 0;font-size:13px;color:#5b6b60;vertical-align:top">${this.escapeHtml(label)}</td><td style="padding:8px 0;font-size:14px;color:#14231a">${this.escapeHtml(value)}</td></tr>`,
      )
      .join('\n');

    return this.shell(
      title,
      intro,
      `            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 8px">
${body}
            </table>`,
      footer,
    );
  }

  private shell(
    title: string,
    intro: string,
    body: string,
    footer: string,
  ): string {
    return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f6f3;font-family:Arial,sans-serif;color:#14231a">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
          <tr><td>
            <h1 style="font-size:22px;margin:0 0 12px">${this.escapeHtml(title)}</h1>
            <p style="font-size:15px;line-height:1.6;margin:0 0 24px">${this.escapeHtml(intro)}</p>
${body}
            <p style="font-size:12px;line-height:1.6;color:#5b6b60;margin:24px 0 0">${this.escapeHtml(footer)}</p>
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
