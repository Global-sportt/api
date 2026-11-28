# Contribución y flujo de integración — API

Este repositorio sigue un flujo de Pull Request con **aprobación humana independiente**. Las reglas aplican a funcionalidades, correcciones, documentación y releases.

## Identidad

- GitHub: **`Dan1el71`**.
- Commits: **`Daniel Rangel <ddrmh1@gmail.com>`**.
- No se usan otras cuentas, correos, identidades ni bots.
- Los commits históricos con otro correo se normalizan con `.mailmap`; no se reescribe la historia para cambiar metadatos.

## Ramas

| Rama | Propósito |
|---|---|
| `main` | Versiones estables y releases |
| `develop` | Única rama de integración |
| `feature/<nombre>` | Nueva funcionalidad |
| `fix/<nombre>` | Corrección no urgente |
| `hotfix/<nombre>` | Corrección urgente |

- **No existe una rama `dev` independiente.** `dev` y `develop` son la misma rama: `develop`.
- Prohibido commitear directamente en `main` o `develop`.
- Una rama por unidad de trabajo.

## Flujo obligatorio

```text
feature/* o fix/*  →  push  →  PR a develop  →  revisión técnica  →  aprobación independiente  →  merge
hotfix/*           →  push  →  PR a main     →  revisión técnica  →  aprobación independiente  →  merge  →  back-merge a develop por PR
```

1. Crear la rama desde `develop` (o desde `main` para un hotfix).
2. Commits atómicos con Conventional Commits.
3. Publicar la rama y abrir un PR real contra `develop` (o `main` para hotfix).
4. Adjuntar pruebas, evidencias y riesgos.
5. A0 puede revisar técnicamente y solicitar cambios.
6. La aprobación final debe ser de un humano independiente.
7. Solo entonces se integra.

## Aprobación independiente

1. Ningún PR puede ser aprobado por su autor.
2. La cuenta `Dan1el71` no puede aprobar ningún PR, sea o no autora.
3. La aprobación debe realizarla otro usuario de GitHub autorizado e independiente.
4. A0 puede revisar técnicamente, solicitar cambios y preparar PRs, pero **nunca aprobarlos**.
5. Prohibido usar otra cuenta, bots o mecanismos equivalentes para simular una aprobación.
6. Si no hay revisor humano independiente, el PR queda abierto y pendiente.
7. La regla aplica a todos los PRs, incluidos documentación y releases.

**Estado actual:** el repositorio tiene un solo colaborador humano. Mientras no se añada otro revisor autorizado, los PRs nuevos deben permanecer abiertos. No se crean cuentas ni se usan bots para evitarlo.

## Protecciones

`main` y `develop` exigen:

- PR obligatorio.
- Al menos 1 aprobación independiente.
- Descartar aprobaciones obsoletas al recibir commits.
- Resolución de conversaciones.
- Sin force-push, sin borrado y sin bypass administrativo.
- `main` con historial lineal.

## Pruebas mínimas antes de pedir revisión

```bash
npm run typecheck
npm run lint --workspace=@reservas/api
npm test --workspace=@reservas/api -- --runInBand
E2E_REAL_CERBOS=1 npm run test:e2e --workspace=@reservas/api
.tools/cerbos/cerbos compile apps/api/cerbos/policies --tests=apps/api/cerbos/tests --no-color
```

En el repositorio de la API los comandos se ejecutan desde la raíz del repositorio, sin el prefijo `apps/api` del monorepo.

## Releases

- `develop` → `main` por PR, con aprobación independiente.
- Tag `vX.Y.Z` sobre el commit de `main`.
- `main` solo conserva versiones estables.
- No se hace release sin Gate 3 en GO y residuales aceptados por escrito.

## Referencias

- Política completa de coordinación: `docs/git-workflow.md` del monorepo.
- Auditoría de flujo: `docs/git-audit-2026-11-27.md` de este repositorio.
- Plantilla de PR: `.github/pull_request_template.md`.
