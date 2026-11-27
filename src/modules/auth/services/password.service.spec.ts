import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('hashea con Argon2id y verifica la contraseña correcta', async () => {
    const hash = await service.hash('frase-segura-2026');
    expect(hash).toContain('$argon2id$');
    await expect(service.verify(hash, 'frase-segura-2026')).resolves.toBe(true);
  });

  it('rechaza la contraseña incorrecta y los hashes corruptos', async () => {
    const hash = await service.hash('frase-segura-2026');
    await expect(service.verify(hash, 'otra-frase-2026')).resolves.toBe(false);
    await expect(service.verify('no-es-un-hash', 'x')).resolves.toBe(false);
  });

  it('rechaza contraseñas débiles o que contienen el correo', () => {
    expect(() =>
      service.assertPolicy('password1234', { email: 'persona@example.com' }),
    ).toThrow('política de seguridad');

    expect(() =>
      service.assertPolicy('mi-correo-camila-2026', {
        email: 'camila@example.com',
      }),
    ).toThrow('política de seguridad');

    expect(() =>
      service.assertPolicy('frase-segura-2026', {
        email: 'camila@example.com',
      }),
    ).not.toThrow();
  });

  it('usa un dummy hash para igualar el costo de usuarios inexistentes', async () => {
    await expect(service.verifyDummy('cualquier-cosa')).resolves.toBe(false);
  });
});
