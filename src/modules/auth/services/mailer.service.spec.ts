jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

import nodemailer from 'nodemailer';
import type { AppLogger } from '../../../common/logging/app-logger.service';
import type { AppConfigService } from '../../../config/app-config.service';
import { MailerService, type BookingEmailDetails } from './mailer.service';

const createTransport = nodemailer.createTransport as unknown as jest.Mock;

const details: BookingEmailDetails = {
  publicCode: 'BK0123456789ABCDEF0123',
  establishmentName: 'Sede Norte',
  spaceName: 'Cancha 1',
  startsAt: 'martes, 1 de diciembre de 2026, 09:30',
  amount: '$\u00a025.000',
};

function buildMailer() {
  const sendMail = jest.fn().mockResolvedValue(undefined);
  createTransport.mockReturnValue({ sendMail });

  const config = {
    smtp: {
      host: 'smtp.test',
      port: 587,
      secure: false,
      from: 'no-reply@example.com',
    },
    env: {
      MAIL_FROM: 'no-reply@example.com',
      WEB_APP_URL: 'http://localhost:5173',
    },
    isProduction: false,
  };
  const logger = {
    raw: { info: jest.fn(), error: jest.fn() },
    error: jest.fn(),
  };

  const service = new MailerService(
    config as unknown as AppConfigService,
    logger as unknown as AppLogger,
  );

  return { service, sendMail };
}

function sentMessage(sendMail: jest.Mock): {
  text: string;
  html: string;
  subject: string;
} {
  expect(sendMail).toHaveBeenCalledTimes(1);
  return sendMail.mock.calls[0][0] as {
    text: string;
    html: string;
    subject: string;
  };
}

describe('MailerService booking emails', () => {
  beforeEach(() => {
    createTransport.mockReset();
  });

  it('includes the address and cancellation policy rows when present', async () => {
    const { service, sendMail } = buildMailer();

    await service.sendBookingCreatedEmail('jugador@example.com', {
      ...details,
      address: 'Calle 12 #34-56',
      cancellationPolicy: 'Cancelación gratuita hasta 24 horas antes.',
    });

    const message = sentMessage(sendMail);
    expect(message.subject).toBe('Reserva confirmada · BK0123456789ABCDEF0123');
    expect(message.text).toContain('Dirección: Calle 12 #34-56');
    expect(message.text).toContain(
      'Política de cancelación: Cancelación gratuita hasta 24 horas antes.',
    );
    expect(message.html).toContain('Dirección');
    expect(message.html).toContain('Calle 12 #34-56');
    expect(message.html).toContain('Política de cancelación');
  });

  it('omits both rows when the fields are null, undefined or blank', async () => {
    const { service, sendMail } = buildMailer();

    await service.sendBookingCreatedEmail('jugador@example.com', {
      ...details,
      address: null,
      cancellationPolicy: '   ',
    });

    const message = sentMessage(sendMail);
    expect(message.text).not.toContain('Dirección');
    expect(message.text).not.toContain('Política de cancelación');
    expect(message.html).not.toContain('Dirección');
    expect(message.html).not.toContain('Política de cancelación');
    // The core rows are always present.
    expect(message.text).toContain('Código: BK0123456789ABCDEF0123');
    expect(message.text).toContain('Valor: $\u00a025.000');
  });

  it('escapes HTML in the address and policy values', async () => {
    const { service, sendMail } = buildMailer();

    await service.sendBookingCancelledEmail('jugador@example.com', {
      ...details,
      address: '<script>alert(1)</script>',
      cancellationPolicy: 'Sin reembolso & sin cambios',
    });

    const message = sentMessage(sendMail);
    expect(message.subject).toBe('Reserva cancelada · BK0123456789ABCDEF0123');
    expect(message.text).toContain('Tu reserva fue cancelada.');
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(message.html).toContain('Sin reembolso &amp; sin cambios');
  });
});
