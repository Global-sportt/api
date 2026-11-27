import './setup-env';
import { execFileSync } from 'node:child_process';

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

// La autorización requiere el catálogo y los grupos globales antes de que
// cualquier test cree usuarios (registro asigna el grupo `player`).
execFileSync('npx', ['prisma', 'db', 'seed'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

// F-04: el esquema Prisma no puede representar índices parciales ni todos los
// triggers. Esta verificación falla el e2e si una migración los pierde.
execFileSync('npx', ['ts-node', 'scripts/verify-db-constraints.ts'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

