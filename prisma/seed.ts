import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const displayName = process.env.SEED_ADMIN_NAME?.trim() || 'Administrador';

  if (!email || !password) {
    console.log(
      'Seed omitido: define SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD para crear un admin.',
    );
    return;
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 12 caracteres.');
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      role: UserRole.admin,
      emailVerifiedAt: new Date(),
      profile: { create: { displayName } },
    },
    update: {
      passwordHash,
      role: UserRole.admin,
      emailVerifiedAt: new Date(),
      status: 'active',
      profile: {
        upsert: {
          create: { displayName },
          update: { displayName },
        },
      },
    },
  });

  console.log(`Admin listo: ${user.email} (${user.id})`);
}

main()
  .catch((error: unknown) => {
    console.error('No se pudo ejecutar el seed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
