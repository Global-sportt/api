import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppError } from '../../../common/errors/app-error';
import { randomToken } from '../../../common/utils/crypto.util';

const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789012345',
  '1234567890123456',
  'password1234',
  'password12345',
  'password123456',
  'contraseña123',
  'contrasena123',
  'qwertyuiop12',
  'qwertyuiop123',
  'iloveyou1234',
  'admin12345678',
  'welcome123456',
  'letmein123456',
  'changeme1234',
  'reservas1234',
  'futbol123456',
  'cancha123456',
  'colombia1234',
  'bogota123456',
  'medellin1234',
]);

export interface PasswordPolicyContext {
  email?: string;
  displayName?: string;
}

@Injectable()
export class PasswordService implements OnModuleInit {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  } as const;

  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomToken(24));
  }

  async hash(password: string): Promise<string> {
    return (await argon2.hash(
      this.normalize(password),
      this.options,
    )) as string;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.normalize(password));
    } catch {
      return false;
    }
  }

  async verifyDummy(password: string): Promise<boolean> {
    if (!this.dummyHash) return false;
    await this.verify(this.dummyHash, password);
    return false;
  }

  assertPolicy(password: string, context: PasswordPolicyContext = {}): void {
    const normalized = this.normalize(password);
    const lower = normalized.toLowerCase();
    const reasons: string[] = [];

    if (normalized.length < 12) {
      reasons.push('Debe tener al menos 12 caracteres.');
    }
    if (normalized.length > 128) {
      reasons.push('No puede superar 128 caracteres.');
    }
    if (!normalized.trim()) {
      reasons.push('No puede estar compuesta solo por espacios.');
    }
    if (COMMON_PASSWORDS.has(lower)) {
      reasons.push('Es una contraseña demasiado común.');
    }

    const localPart = context.email?.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
      reasons.push('No debe contener la parte principal de tu correo.');
    }

    if (reasons.length > 0) {
      throw new AppError(
        422,
        'WEAK_PASSWORD',
        'La contraseña no cumple la política de seguridad.',
        { reasons },
      );
    }
  }

  private normalize(password: string): string {
    return password.normalize('NFKC');
  }
}
