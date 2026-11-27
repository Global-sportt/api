import { Injectable } from '@nestjs/common';
import { GroupScope, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PLAYER_GROUP_SLUG } from '../../common/authz/permissions';
import { normalizeEmail } from '../../common/utils/crypto.util';

export const userWithProfile = {
  profile: true,
} satisfies Prisma.UserInclude;

export type UserWithProfile = Prisma.UserGetPayload<{
  include: typeof userWithProfile;
}>;

export interface PublicUser {
  id: string;
  email: string;
  status: UserStatus;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string;
  createdAt: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UserWithProfile | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: userWithProfile,
    });
  }

  async findByEmail(email: string): Promise<UserWithProfile | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: userWithProfile,
    });
  }

  async findOAuthAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<UserWithProfile | null> {
    const account = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId },
      },
      include: { user: { include: userWithProfile } },
    });
    return account?.user ?? null;
  }

  async createLocalUser(input: {
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<UserWithProfile> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizeEmail(input.email),
          passwordHash: input.passwordHash,
          profile: {
            create: {
              displayName: input.displayName?.trim() || this.defaultName(input.email),
            },
          },
        },
        include: userWithProfile,
      });

      await this.assignPlayerGroup(tx, user.id);
      return user;
    });
  }

  async createOAuthUser(input: {
    email: string;
    displayName?: string;
    avatarUrl?: string;
    provider: string;
    providerAccountId: string;
  }): Promise<UserWithProfile> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizeEmail(input.email),
          emailVerifiedAt: new Date(),
          profile: {
            create: {
              displayName:
                input.displayName?.trim() || this.defaultName(input.email),
              avatarUrl: input.avatarUrl,
            },
          },
          oauthAccounts: {
            create: {
              provider: input.provider,
              providerAccountId: input.providerAccountId,
              email: normalizeEmail(input.email),
              lastLoginAt: new Date(),
            },
          },
        },
        include: userWithProfile,
      });

      await this.assignPlayerGroup(tx, user.id);
      return user;
    });
  }

  async linkOAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
    email: string;
  }): Promise<void> {
    await this.prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      },
      create: {
        userId: input.userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        email: normalizeEmail(input.email),
        lastLoginAt: new Date(),
      },
      update: {
        userId: input.userId,
        email: normalizeEmail(input.email),
        lastLoginAt: new Date(),
      },
    });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }

  async setPassword(
    userId: string,
    passwordHash: string,
    markEmailVerified = false,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        ...(markEmailVerified ? { emailVerifiedAt: new Date() } : {}),
      },
    });
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  async updateOAuthLogin(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<void> {
    const now = new Date();
    const profileData: {
      displayName?: string;
      avatarUrl?: string;
    } = {};

    if (input.displayName) profileData.displayName = input.displayName;
    if (input.avatarUrl) profileData.avatarUrl = input.avatarUrl;

    const oauthUpdate = this.prisma.oAuthAccount.update({
      where: {
        provider_providerAccountId: {
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      },
      data: { lastLoginAt: now },
    });
    const userUpdate = this.prisma.user.update({
      where: { id: input.userId },
      data: { lastLoginAt: now },
    });

    if (Object.keys(profileData).length > 0) {
      await this.prisma.$transaction([
        oauthUpdate,
        userUpdate,
        this.prisma.profile.updateMany({
          where: {
            userId: input.userId,
            OR: [{ displayName: null }, { avatarUrl: null }],
          },
          data: profileData,
        }),
      ]);
      return;
    }

    await this.prisma.$transaction([oauthUpdate, userUpdate]);
  }

  toPublicUser(user: UserWithProfile): PublicUser {
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      displayName: user.profile?.displayName ?? null,
      avatarUrl: user.profile?.avatarUrl ?? null,
      locale: user.profile?.locale ?? 'es-CO',
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Q11: todo usuario registrado recibe el grupo global `player`, incluso si
   * más adelante es owner o staff de una sede. El seed es obligatorio; si el
   * grupo no existe, el alta falla en lugar de crear un usuario sin permisos.
   */
  private async assignPlayerGroup(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const playerGroup = await tx.securityGroup.findFirst({
      where: {
        establishmentId: null,
        slug: PLAYER_GROUP_SLUG,
        scope: GroupScope.global,
      },
      select: { id: true },
    });

    if (!playerGroup) {
      throw new Error(
        `No existe el grupo global "${PLAYER_GROUP_SLUG}". Ejecuta "npx prisma db seed" antes de registrar usuarios.`,
      );
    }

    await tx.userGlobalGroup.create({
      data: {
        userId,
        groupId: playerGroup.id,
        groupScope: GroupScope.global,
      },
    });
  }

  private defaultName(email: string): string {
    const local = normalizeEmail(email).split('@')[0] ?? 'Jugador';
    return local.replace(/[._-]+/g, ' ').trim() || 'Jugador';
  }
}
