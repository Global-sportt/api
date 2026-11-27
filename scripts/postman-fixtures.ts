/**
 * Fixtures locales para la colección Postman.
 *
 * Crea usuarios, establecimientos, membresías y canchas con datos
 * deterministas. Es idempotente: se puede ejecutar antes de cada corrida.
 *
 * Requisitos:
 *   npx prisma migrate deploy
 *   npx prisma db seed
 *   ts-node scripts/postman-fixtures.ts
 *
 * No usa red, nube ni servicios externos.
 */
import 'dotenv/config';
import {
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  PrismaClient,
  SpaceStatus,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import { PLAYER_GROUP_SLUG, PLATFORM_ADMIN_GROUP_SLUG } from '../src/common/authz/permissions';

const prisma = new PrismaClient();

const PASSWORD = process.env.POSTMAN_FIXTURE_PASSWORD ?? 'Postman-Fixture-2026!';
const TIMEZONE = 'America/Bogota';
const CURRENCY = 'COP';
const PRICE_MINOR = 50_000n;

interface FixtureUser {
  key: string;
  email: string;
  name: string;
  platformAdmin?: boolean;
}

interface FixtureEstablishment {
  key: string;
  name: string;
  slug: string;
  owner: string;
  staff?: string;
}

interface FixtureSpace {
  key: string;
  establishment: string;
  name: string;
  slug: string;
  sport: string;
}

const USERS: FixtureUser[] = [
  { key: 'admin', email: 'postman-admin@reservas.local', name: 'Postman Admin', platformAdmin: true },
  { key: 'owner1', email: 'postman-owner1@reservas.local', name: 'Postman Owner 1' },
  { key: 'owner2', email: 'postman-owner2@reservas.local', name: 'Postman Owner 2' },
  { key: 'staff1', email: 'postman-staff1@reservas.local', name: 'Postman Staff 1' },
  { key: 'player1', email: 'postman-player1@reservas.local', name: 'Postman Player 1' },
  { key: 'player2', email: 'postman-player2@reservas.local', name: 'Postman Player 2' },
];

const ESTABLISHMENTS: FixtureEstablishment[] = [
  { key: 'e1', name: 'Postman Arena', slug: 'postman-arena', owner: 'owner1', staff: 'staff1' },
  { key: 'e2', name: 'Postman Arena 2', slug: 'postman-arena-2', owner: 'owner2' },
];

const SPACES: FixtureSpace[] = [
  { key: 's1', establishment: 'e1', name: 'Cancha 1', slug: 'cancha-1', sport: 'futbol' },
  { key: 's2', establishment: 'e2', name: 'Cancha 2', slug: 'cancha-2', sport: 'futbol' },
];

type UserMap = Record<string, { id: string; email: string }>;
type EstablishmentMap = Record<string, { id: string; slug: string }>;
type SpaceMap = Record<string, { id: string; slug: string; establishmentId: string }>;

async function hashPassword(): Promise<string> {
  return argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
}

async function ensureGlobalGroup(slug: string): Promise<string> {
  const group = await prisma.securityGroup.findFirst({
    where: { establishmentId: null, slug, scope: GroupScope.global },
    select: { id: true },
  });
  if (!group) {
    throw new Error(
      `Falta el grupo global "${slug}". Ejecuta "npx prisma db seed" antes de los fixtures.`,
    );
  }
  return group.id;
}

async function ensureUsers(passwordHash: string): Promise<UserMap> {
  const players = await ensureGlobalGroup(PLAYER_GROUP_SLUG);
  const platformAdmins = await ensureGlobalGroup(PLATFORM_ADMIN_GROUP_SLUG);
  const users: UserMap = {};

  for (const definition of USERS) {
    const user = await prisma.user.upsert({
      where: { email: definition.email },
      create: {
        email: definition.email,
        passwordHash,
        emailVerifiedAt: new Date(),
        status: UserStatus.active,
        profile: { create: { displayName: definition.name } },
      },
      update: {
        passwordHash,
        emailVerifiedAt: new Date(),
        status: UserStatus.active,
        profile: {
          upsert: {
            create: { displayName: definition.name },
            update: { displayName: definition.name },
          },
        },
      },
      select: { id: true, email: true },
    });

    for (const groupId of [players, ...(definition.platformAdmin ? [platformAdmins] : [])]) {
      await prisma.userGlobalGroup.upsert({
        where: { userId_groupId: { userId: user.id, groupId } },
        create: { userId: user.id, groupId, groupScope: GroupScope.global },
        update: { groupScope: GroupScope.global },
      });
    }

    users[definition.key] = user;
  }

  return users;
}

async function ensureEstablishments(users: UserMap): Promise<EstablishmentMap> {
  const establishments: EstablishmentMap = {};

  for (const definition of ESTABLISHMENTS) {
    const establishment = await prisma.$transaction(async (tx) => {
      const row = await tx.establishment.upsert({
        where: { slug: definition.slug },
        create: {
          name: definition.name,
          slug: definition.slug,
          timezone: TIMEZONE,
          currency: CURRENCY,
          status: EstablishmentStatus.active,
        },
        update: {
          name: definition.name,
          timezone: TIMEZONE,
          currency: CURRENCY,
          status: EstablishmentStatus.active,
        },
        select: { id: true, slug: true },
      });

      await provisionEstablishmentGroups(tx, row.id);

      const members = [
        { userId: users[definition.owner].id, slug: 'owner' },
        ...(definition.staff ? [{ userId: users[definition.staff].id, slug: 'staff' }] : []),
      ];

      for (const member of members) {
        const membership = await tx.membership.upsert({
          where: {
            userId_establishmentId: {
              userId: member.userId,
              establishmentId: row.id,
            },
          },
          create: {
            userId: member.userId,
            establishmentId: row.id,
            status: MembershipStatus.active,
          },
          update: { status: MembershipStatus.active },
          select: { id: true },
        });

        const group = await tx.securityGroup.findFirst({
          where: { establishmentId: row.id, slug: member.slug },
          select: { id: true },
        });
        if (!group) {
          throw new Error(`No se pudo provisionar el grupo ${member.slug} en ${row.slug}.`);
        }

        await tx.membershipGroup.deleteMany({ where: { membershipId: membership.id } });
        await tx.membershipGroup.create({
          data: {
            membershipId: membership.id,
            groupId: group.id,
            establishmentId: row.id,
          },
        });
      }

      return row;
    });

    establishments[definition.key] = establishment;
  }

  return establishments;
}

async function ensureSpaces(establishments: EstablishmentMap): Promise<SpaceMap> {
  const spaces: SpaceMap = {};

  for (const definition of SPACES) {
    const establishment = establishments[definition.establishment];
    const space = await prisma.space.upsert({
      where: {
        establishmentId_slug: {
          establishmentId: establishment.id,
          slug: definition.slug,
        },
      },
      create: {
        establishmentId: establishment.id,
        name: definition.name,
        slug: definition.slug,
        sport: definition.sport,
        slotMinutes: 60,
        bufferMinutes: 0,
        status: SpaceStatus.active,
      },
      update: {
        name: definition.name,
        sport: definition.sport,
        slotMinutes: 60,
        bufferMinutes: 0,
        status: SpaceStatus.active,
      },
      select: { id: true, slug: true, establishmentId: true },
    });

    for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
      await prisma.operatingHour.upsert({
        where: { spaceId_dayOfWeek: { spaceId: space.id, dayOfWeek } },
        create: {
          spaceId: space.id,
          dayOfWeek,
          opensAtMinutes: 8 * 60,
          closesAtMinutes: 22 * 60,
        },
        update: { opensAtMinutes: 8 * 60, closesAtMinutes: 22 * 60 },
      });
    }

    await prisma.priceRule.deleteMany({ where: { spaceId: space.id } });
    await prisma.priceRule.create({
      data: {
        spaceId: space.id,
        dayOfWeek: null,
        startsAtMinutes: 8 * 60,
        endsAtMinutes: 22 * 60,
        amountMinor: PRICE_MINOR,
        currency: CURRENCY,
        priority: 0,
      },
    });

    spaces[definition.key] = space;
  }

  return spaces;
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword();
  const users = await ensureUsers(passwordHash);
  const establishments = await ensureEstablishments(users);
  const spaces = await ensureSpaces(establishments);

  console.log(
    JSON.stringify(
      {
        ok: true,
        passwordHint: 'POSTMAN_FIXTURE_PASSWORD (ver docs/postman/README.md)',
        users,
        establishments,
        spaces,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error('No se pudieron crear los fixtures de Postman', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
