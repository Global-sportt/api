# Pull Request

## Resumen

<!-- Qué cambia, por qué y qué problema resuelve. -->

## Tipo

- [ ] `feature/*`
- [ ] `fix/*`
- [ ] `hotfix/*`

## Rama y trazabilidad

- Rama:
- Tarea externa:
- Commits:
- Base: `develop` <!-- `main` solo para hotfix o release -->

## Cambios

-

## Pruebas

| Comando | Resultado |
|---|---|
| `npm run typecheck` | |
| `npm run lint --workspace=@reservas/api` | |
| `npm test --workspace=@reservas/api -- --runInBand` | |
| `E2E_REAL_CERBOS=1 npm run test:e2e --workspace=@reservas/api` | |
| `cerbos compile ... --tests` | |

## Evidencia

<!-- Salidas reales, conteos, consultas, enlaces. No inventar resultados. -->

## Riesgos y residuales

-

## Aprobación independiente

- [ ] El autor no aprobó este PR.
- [ ] La aprobación es de un humano distinto del autor.
- [ ] La aprobación **no** proviene de la cuenta `Dan1el71`.
- [ ] A0 hizo revisión técnica, sin aprobar.
- [ ] No se usaron bots, cuentas alternativas ni mecanismos equivalentes.
- [ ] Si no hay revisor independiente, el PR queda abierto.

## Checklist

- [ ] Rama creada desde `develop` (o `main` para hotfix), sin commits directos en `main`/`develop`.
- [ ] Commits atómicos con Conventional Commits.
- [ ] Sin secretos ni credenciales.
- [ ] Migraciones revisadas y aplicadas.
- [ ] Documentación y trazabilidad actualizadas.
- [ ] No se modificó `main` ni se movió un tag de release.
