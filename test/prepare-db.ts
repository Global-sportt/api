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

