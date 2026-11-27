# Validación — Colección Postman

**Fecha de ejecución:** 2026-11-27 UTC (2026-11-26 America/Bogota).
**Worktree:** `<worktree-postman>`, rama `feature/api-postman-collection`.
**Alcance:** API local en `http://127.0.0.1:3000`, Cerbos en
`http://127.0.0.1:3592`, PostgreSQL local. Sin nube, sin Docker, sin Google OAuth real.

## Entorno

| Componente | Versión / estado |
|---|---|
| Node.js | v22.22.1 |
| Newman | 6.2.3 (`npx --yes newman`) |
| API | `GET /health/live` → `200 {"status":"ok"}` |
| Cerbos | `GET /_cerbos/health` → `200 {"status":"SERVING"}` |
| PostgreSQL | local, fixtures aplicados |
| Dependencias | No se agregó `newman` al `package.json`; `npx` funciona |

## Fixtures

La base ya contenía los fixtures de `apps/api/scripts/postman-fixtures.ts`.
La ejecución exitosa fue:

```bash
cd <repo>/apps/api

NODE_PATH=<repo>/apps/api/node_modules:<repo>/node_modules \
  <repo>/node_modules/.bin/ts-node --transpile-only \
  <worktree-postman>/apps/api/scripts/postman-fixtures.ts
```

Resultado real: `ok: true`, 6 usuarios, 2 establecimientos
(`postman-arena`, `postman-arena-2`) y 2 canchas (`cancha-1`, `cancha-2`).
El script es idempotente y no imprime tokens.

**Hallazgo de entorno:** `cd <repo> && npm run postman:fixtures`
falló con `npm ERR! Missing script: "postman:fixtures"` porque ese checkout
`develop` todavía no incluye el script de A0. El worktree sí lo incluye, pero no
tiene `node_modules`; por eso se ejecutó el mismo script con `--transpile-only`
usando los módulos del repo principal. Tras `npm install` en el worktree (o tras
el merge de A0), el comando canónico `npm run postman:fixtures` queda disponible.

## Comando Newman

```bash
cd <worktree-postman>

npx --yes newman run postman/api.postman_collection.json \
  -e postman/api.local.postman_environment.json \
  --reporters cli --reporter-cli-no-console \
  --reporter-cli-no-assertions --timeout-request 10000
```

La colección tiene **92 ítems**. Newman reporta **93 solicitudes HTTP** porque el
pre-request de disponibilidad ejecuta un `pm.sendRequest` auxiliar.

## Corrida inicial (fallida)

Resultado real de la primera corrida completa:

| Métrica | Ejecutadas | Fallidas |
|---|---:|---:|
| Iteraciones | 1 | 0 |
| Requests | 93 | 1 |
| Test scripts | 92 | 0 |
| Pre-request scripts | 10 | 0 |
| Assertions | 242 | 3 |

Fallos observados:

1. `Auth / Change password`: esperaba `200`, recibió `403`.
2. `ECONNREFUSED 127.0.0.1:5173` al seguir el redirect del callback OAuth.
3. `Auth / OAuth Google callback (invalid state)`: esperaba `302` y un header
   `Location`, pero Postman siguió el redirect y terminó sin `Location`.

### Correcciones aplicadas

- **Change password 403:** el login web deja la cookie `reservas_refresh`; el
  middleware CSRF exige `X-CSRF-Token` en *todo* método unsafe mientras esa cookie
  exista, no solo en refresh/logout. Se agregó `X-CSRF-Token: {{csrfToken}}` al
  request de cambio de contraseña. No se cambió ninguna aserción.
- **Redirect OAuth:** se agregó `protocolProfileBehavior.followRedirects = false`
  al callback para validar el `302` original y su `Location`. Se mantienen las
  aserciones de `302`, `oauth=error`, `reason=oauth_not_configured` y ausencia de
  tokens en la URL. No se debilitó ninguna aserción.

## Corridas finales (exitosas)

Se ejecutó la colección completa dos veces más, con datos dinámicos nuevos
(emails, slugs, claves de idempotencia y ventana de reserva) y esperando ~60 s
entre corridas por el rate limit de login.

| Corrida | Requests | Fallidas | Assertions | Fallidas | Pre-request | Duración |
|---|---:|---:|---:|---:|---:|---:|
| Final 1 | 93 | 0 | 242 | 0 | 10 | 2.3 s |
| Final 2 | 93 | 0 | 242 | 0 | 10 | 2.4 s |

Salida resumida real de la última corrida:

```text
┌─────────────────────────┬──────────┬─────────┐
│                         │ executed │  failed │
├─────────────────────────┼──────────┼─────────┤
│              iterations │        1 │       0 │
│                requests │       93 │       0 │
│            test-scripts │       92 │       0 │
│      prerequest-scripts │       10 │       0 │
│              assertions │      242 │       0 │
└─────────────────────────┴──────────┴─────────┘
total run duration: 2.4s
average response time: 11ms [min: 1ms, max: 44ms, s.d.: 9ms]
```

## Verificación funcional

Todos los escenarios siguientes quedaron cubiertos por aserciones que pasaron en
las dos corridas finales. Los nombres entre comillas son los tests reales de la
colección.

| Escenario requerido | Evidencia en la colección | Resultado |
|---|---|---|
| Login web setea cookies | `Auth / Login web (cookies + CSRF)` → `sets refresh and csrf cookies` (incluye `HttpOnly` en refresh) | OK |
| Refresh con `X-CSRF-Token` | `Refresh without CSRF token` → `403 CSRF_TOKEN_INVALID`; `Refresh with CSRF token` → `200`, token rotado | OK |
| Logout 204 | `Logout without CSRF token` → `403`; `Logout with CSRF token` → `204` y body vacío | OK |
| Owner lista membresías | `List memberships (owner)` → `200`, owner/staff activos | OK |
| Owner asigna owner → 403 | `Owner cannot assign owner` → `403 PERMISSION_DENIED` | OK |
| Último owner no se elimina | `Delete last active owner is rejected` → `409 INVALID_STATE`; el owner sigue activo | OK |
| Staff sin `membership:read` | `List memberships forbidden for staff` → `403 PERMISSION_DENIED` | OK |
| Jugador sin membresía | `List memberships forbidden for non-member player` → `403 TENANT_FORBIDDEN` | OK |
| Cross-tenant establecimiento | `Get establishment of another tenant` → `403 TENANT_FORBIDDEN` | OK |
| Establecimiento inexistente | `Get unknown establishment` → `404 ESTABLISHMENT_NOT_FOUND` | OK |
| Admin crea establecimiento | `Admin create establishment` → `201`, owner activo y slug único | OK |
| Owner inexistente al crear | `Admin create establishment with unknown owner` → `422 OWNER_NOT_FOUND` | OK |
| Owner no accede a admin | `Admin list forbidden for owner 1` → `403 PERMISSION_DENIED` | OK |
| Reserva propia 201 | `Create own booking` → `201`, `confirmed`, precio servidor `50000 COP` | OK |
| Replay idempotente | `Replay booking with same idempotency key` → `200`, header `Idempotent-Replay: true`, mismo ID | OK |
| Misma clave, otro payload | `Reuse idempotency key with different payload` → `409 IDEMPOTENCY_KEY_REUSED` | OK |
| Segunda jugadora misma franja | `Second player cannot book the same slot` → `409 SLOT_TAKEN` con alternativas | OK |
| Cross-tenant space en booking | `Tenant booking with another tenant space` → `404 SPACE_NOT_FOUND` | OK |
| Staff actualiza estado | `Staff checks in the player booking` → `200 checked_in` | OK |
| Transición inválida | `Invalid booking transition is rejected` → `409 INVALID_STATE` | OK |
| Cancelación propia | `Cancel own booking` → `200 cancelled`; repetir cancelar → `409 INVALID_STATE` | OK |
| Replay de reserva terminal | `Terminal idempotent replay is rejected` → `409 INVALID_STATE` | OK |
| Disponibilidad excluye franja | `Availability excludes active booked slots`: slots 1 y 2 ausentes; slot 3 presente | OK |
| Disponibilidad libera franjas | `Released slots return to public availability`: tras completar/cancelar, los 3 slots vuelven | OK |
| IDOR de reserva | Otro jugador `GET` y `POST /cancel` → `404 BOOKING_NOT_FOUND` | OK |
| `/me` de admin no se amplía | `Admin /me/bookings stays scoped to the admin (Q16)` → sin filas de player1 | OK |
| Disponibilidad pública y health | `Prepare dynamic booking window` (200), `Health / Live` y `Ready` (200) | OK |
| Fecha inválida | Disponibilidad tenant/pública → `400 VALIDATION_ERROR` | OK |
| 401 / 403 / 404 / 400 | Carpetas Auth, Error Scenarios y módulos → códigos y problem details verificados | OK |
| Origin no permitido | `Unsafe request with rejected origin` → `403 CSRF_ORIGIN_REJECTED` | OK |

## Cobertura de endpoints

**34/34 operaciones del inventario**:

- Auth: 14/14 (incluye OAuth start y callback inválido).
- Establishments/memberships: 8/8.
- Spaces/availability: 3/3.
- Bookings: 7/7.
- Health: 2/2.

Solicitudes por carpeta: Health 2, Auth 25, Establishments & Memberships 18,
Spaces & Availability 13, Bookings 25, Error Scenarios 9. Total: **92**.

## Discrepancias y matices del backend

No se encontró una discrepancia funcional que requiera modificar el backend.
Sí quedaron documentados estos matices observados:

1. **Mensaje de error 5xx enmascarado:** `GET /auth/oauth/google/start` devuelve
   `503` con `code: OAUTH_NOT_CONFIGURED`, pero el `message` es el genérico
   `"Ocurrió un error interno..."` porque `ProblemDetailsFilter` oculta mensajes
   de status >= 500. La colección valida `status`/`code`, no el texto. No se tocó
   el backend.
2. **400 vs 422 en registro:** un body inválido (por ejemplo contraseña de menos
   de 12) devuelve `400 VALIDATION_ERROR`; una contraseña que pasa el DTO pero
   viola la política devuelve `422 WEAK_PASSWORD`. La colección prueba el segundo
   caso, que es el `422` documentado en el inventario.
3. **OAuth local:** el start devuelve `503` (no `302`) porque Google no está
   configurado; es el comportamiento esperado del entorno local y está documentado
   como limitación. El callback inválido responde `302` a la web con
   `oauth=error&reason=oauth_not_configured`, sin tokens en la URL.
4. **Script de fixtures en `develop`:** el checkout principal no tiene aún
   `postman:fixtures`; es un tema de integración de ramas, no del backend.

## Limitaciones residuales

- No hay endpoint para crear canchas; la colección depende de los fixtures.
- No se ejecutó el intercambio real con Google ni el envío real de correos; se
  usaron tokens `dev` locales.
- No se probó concurrencia simultánea de dos inserts; solo conflicto secuencial.
  La garantía de exclusión vive en PostgreSQL.
- Cada corrida deja usuarios/establecimientos QA y eventos de auth; no hay
  endpoints de borrado.
- El rate limit de login (10/min) obliga a esperar ~60 s entre corridas completas.
- La colección se validó con Newman; no se ejecutó manualmente en la GUI de Postman.
- `followRedirects: false` es intencional para el callback OAuth; si se habilita,
  Newman intentará abrir `localhost:5173`.

## Redacción

No se copiaron access tokens, refresh tokens, cookies, claves JWT ni contraseñas
reales en este documento. El environment versionado deja tokens/IDs vacíos y
marca como `secret` las contraseñas de fixture y tokens. Las credenciales
`Postman-Fixture-2026!` son exclusivamente de fixture local y no deben reutilizarse.

## Validación post-merge

Corrida ejecutada desde el checkout principal (`develop`) después del merge `dff193e`:

```bash
npx --yes newman run postman/api.postman_collection.json \
  -e postman/api.local.postman_environment.json \
  --reporters cli --reporter-cli-no-console
```

Resultado real: **93 requests, 92 test-scripts, 242 assertions, 0 fallos**; duración 2.4 s.
Esto confirma que la colección y el comando canónico funcionan desde `develop`, no solo desde el worktree de desarrollo.
