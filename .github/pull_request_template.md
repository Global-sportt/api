# Pull Request

## Rama

`feature/<dominio-funcional>` — sin identificadores internos del plan.

## Objetivo

<!-- Qué problema resuelve y por qué ahora. -->

## Tareas

- Refs: CU-<id>
- Hito: <!-- enlace o nombre del hito -->

## Cambios

-

## Pruebas

| Comando | Resultado |
|---|---|
| `npm run typecheck` | |
| `npm run lint` | |
| `npm test -- --runInBand` | |
| `E2E_REAL_CERBOS=1 npm run test:e2e` | |
| `cerbos compile cerbos --tests` | |
| `npm run build` | |
| `bash scripts/ci/check-migration-drift.sh` | |

## Evidencia

<!-- Salidas reales, enlace del run de CI, consultas SQL. -->

## Riesgos / residuales

-

## Checklist

- [ ] Rama propia y commits atómicos con Conventional Commits
- [ ] Sin secretos, sin servicios externos ni credenciales versionadas
- [ ] Migraciones revisadas; deriva de esquema verificada
- [ ] Typecheck, lint, unitarios, e2e con Cerbos real y build ejecutados
- [ ] PR apunta a `develop` y está vinculado a la tarea de ClickUp
- [ ] Aprobación independiente registrada (no autoaprobación)
