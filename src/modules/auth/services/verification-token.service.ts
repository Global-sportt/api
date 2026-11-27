import { Injectable } from '@nestjs/common';
import { VerificationTokenType } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error';
import { randomToken, sha256 } from '../../../common/utils/crypto.util';
import { PrismaService } from '../../../prisma/prisma.service';

const TOKEN_TTL_MS: Record<VerificationTokenType, number> = {
  [VerificationTokenType.verify_email]: 24 * 60 * 60 * 1000,
  [VerificationTokenType.reset_password]: 60 * 60 * 1000,
};

@Injectable()
export class VerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    userId: string,
    type: VerificationTokenType,
  ): Promise<string> {
    const raw = randomToken(32);
    const tokenHash = sha256(raw);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[type]);

    await this.prisma.$transaction([
      this.prisma.verificationToken.deleteMany({
        where: { userId, type, consumedAt: null },
      }),
      this.prisma.verificationToken.create({
        data: { userId, type, tokenHash, expiresAt },
      }),
    ]);

    return raw;
  }

  async consume(
    rawToken: string,
    expectedType: VerificationTokenType,
  ): Promise<string> {
    const token = await this.resolve(rawToken, expectedType);

    const consumed = await this.prisma.verificationToken.updateMany({
      where: { id: token.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (consumed.count !== 1) {
      throw new AppError(
        400,
        'TOKEN_INVALID',
        'El enlace no es válido o ya expiró.',
      );
    }

    return token.userId;
  }

  async resolve(
    rawToken: string,
    expectedType: VerificationTokenType,
  ): Promise<{ id: string; userId: string }> {
    const tokenHash = sha256(rawToken);
    const token = await this.prisma.verificationToken.findUnique({
      where: { tokenHash },
    });

    if (
      !token ||
      token.type !== expectedType ||
      token.consumedAt !== null ||
      token.expiresAt <= new Date()
    ) {
      throw new AppError(
        400,
        'TOKEN_INVALID',
        'El enlace no es válido o ya expiró.',
      );
    }

    return { id: token.id, userId: token.userId };
  }
}
