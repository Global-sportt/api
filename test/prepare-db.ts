import './setup-env';
import { execFileSync } from 'node:child_process';

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
