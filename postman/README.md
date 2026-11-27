# Colección Postman — API local

Colección Postman v2.1 para validar la API de reservas contra el entorno local
(API + PostgreSQL + Cerbos). **Solo local**: no usa nube, Docker ni credenciales
reales de Google.

## Archivos

| Archivo | Uso |
|---|---|
| `api.postman_collection.json` | 92 solicitudes en 6 carpetas: Health, Auth, Establishments & Memberships, Spaces & Availability, Bookings, Error Scenarios. |
| `api.local.postman_environment.json` | `baseUrl`, `healthUrl`, `origin`, credenciales de fixture, tokens/IDs vacíos y variables mutables. |
| `endpoint-inventory.md` | Inventario real de endpoints (OpenAPI + controllers/DTOs). |
| `validation.md` | Comandos, resultados Newman y evidencia de la última corrida. |

## Requisitos

- Node.js >= 22.12 (probado con v22.22.1).
- API en `http://127.0.0.1:3000`, Cerbos en `http://127.0.0.1:3592` y PostgreSQL local.
- `apps/api/.env` con `AUTH_DEV_EXPOSE_TOKENS=true` y
  `CORS_ORIGINS=http://localhost:5173,...` (solo desarrollo local).
- `npx --yes newman` (probado con Newman 6.2.3). No se agregó `newman` como
  dependencia porque `npx` funciona en este entorno.

## Preparación

```bash
cd /ruta/al/repo
npm install
npm run postman:fixtures
```

`postman:fixtures` ejecuta `apps/api/scripts/postman-fixtures.ts`. Es idempotente:
recrea/actualiza usuarios, establecimientos (`postman-arena`, `postman-arena-2`),
membresías y canchas (`cancha-1`, `cancha-2`). No borra datos de corridas previas.

Credenciales de fixture (solo pruebas locales, nunca reutilizar fuera de local):

| Usuario | Rol | Contraseña |
|---|---|---|
| `postman-admin@reservas.local` | platform-admin | `Postman-Fixture-2026!` |
| `postman-owner1@reservas.local` | owner de E1 | `Postman-Fixture-2026!` |
| `postman-owner2@reservas.local` | owner de E2 | `Postman-Fixture-2026!` |
| `postman-staff1@reservas.local` | staff de E1 | `Postman-Fixture-2026!` |
| `postman-player1@reservas.local` | player | `Postman-Fixture-2026!` |
| `postman-player2@reservas.local` | player | `Postman-Fixture-2026!` |

## Importar en Postman

1. Importar `api.postman_collection.json` y
   `api.local.postman_environment.json`.
2. Seleccionar el environment **Local**.
3. Ejecutar la colección completa con el Collection Runner, respetando el orden.
   Las carpetas tienen dependencias: Auth obtiene tokens, Establishments descubre
   IDs, Spaces prepara la ventana de reserva y Bookings consume esas variables.
   Ejecutar una carpeta aislada sin las anteriores puede fallar por variables vacías.

La colección usa bearer auth a nivel de colección (`{{ownerToken}}`), pero cada
solicitud declara explícitamente su rol: `admin`, `owner`, `owner2`, `staff`,
`player1`, `player2`, `web` o `noauth`. Las rutas públicas usan `noauth`.

## Ejecución con Newman

```bash
cd /ruta/al/repo

npx --yes newman run postman/api.postman_collection.json \
  -e postman/api.local.postman_environment.json \
  --reporters cli --reporter-cli-no-console \
  --reporter-cli-no-assertions --timeout-request 10000
```

Para ver el detalle de cada aserción, quitar `--reporter-cli-no-assertions`.
Resultado esperado: **0 fallos, 242 aserciones**. Newman puede reportar 93
solicitudes aunque la colección tenga 92: el pre-request de disponibilidad usa
`pm.sendRequest` y Newman lo contabiliza aparte.

Si se ejecuta dos veces seguidas en menos de un minuto, el rate limit de login
(10/minuto) puede devolver `429`. Esperar ~60 s entre corridas.

## Flujo de variables

- `baseUrl` = `http://127.0.0.1:3000/api/v1`; `healthUrl` =
  `http://127.0.0.1:3000/health`; `origin` = `http://localhost:5173`.
- Cada login móvil guarda su token (`adminToken`, `ownerToken`, `owner2Token`,
  `staffToken`, `player1Token`, `player2Token`) y el ID de usuario.
- El login web guarda `authAccessToken` y `csrfToken`; los tests validan
  `Set-Cookie` (`reservas_refresh` HttpOnly y `reservas_csrf`), refresco con
  `X-CSRF-Token`, logout 204 y CSRF inválido 403.
- Los IDs **no están hardcodeados**: `GET /admin/establishments` descubre E1/E2,
  `GET /establishments/:id/spaces` descubre `spaceId`/`space2Id`, y
  `GET /memberships` descubre las membresías. Las reservas creadas guardan sus IDs.
- Pre-request dinámicos:
  - Email de registro único y contraseñas aleatorias por corrida.
  - Slug único para el establecimiento QA creado por el admin.
  - Ventana de reserva: busca entre +30 y +44 días (America/Bogota) la primera
    fecha con al menos 3 franjas libres en `cancha-1`; guarda `bookingDate` y
    tres pares `bookingStart/End`.
  - Claves de idempotencia nuevas por corrida; el replay reutiliza la misma.
- La fecha se calcula en America/Bogota y las franjas se envían como ISO UTC.

## Carpetas y cobertura

| Carpeta | Solicitudes | Cobertura principal |
|---|---:|---|
| Health | 2 | `live`, `ready` |
| Auth | 25 | registro, verificación, login web/móvil, CSRF, refresh, logout, logout-all, password change/forgot/reset, providers, OAuth start/callback inválido |
| Establishments & Memberships | 18 | admin create/list, `/me`, getById, memberships list/add/patch/delete, escalamiento y último owner |
| Spaces & Availability | 13 | espacios, disponibilidad tenant/pública, fechas inválidas, cancha de otro tenant |
| Bookings | 25 | creación propia/tenant, replay idempotente, conflicto de franja, estados, cancelación, IDOR, exclusión de disponibilidad |
| Error Scenarios | 9 | 401 sin/invalid token, 403 de Origin, 404, 400, aislamiento cross-tenant |

Cobertura: **34/34 operaciones del inventario** (14 auth + 8 establishments +
3 spaces/availability + 7 bookings + 2 health). El callback OAuth se prueba solo
con `state` inválido; el intercambio real con Google no se ejecuta.

## Mantenimiento

1. Si cambia OpenAPI/controllers/DTOs, actualizar `endpoint-inventory.md` y luego
   la colección. Comparar con `curl http://127.0.0.1:3000/api/v1/docs-json`.
2. Mantener estables los emails/slugs/contraseña de fixture; si cambian, actualizar
   `postman-fixtures.ts`, el environment y los tests.
3. Ejecutar `npm run postman:fixtures` antes de la corrida. No hardcodear UUIDs:
   la colección debe seguir descubriéndolos por API.
4. No debilitar aserciones para hacer pasar la suite. Si el backend cambia el
   contrato, documentar la diferencia en `validation.md` y reportarla antes de
   ajustar el test.
5. Esperar >60 s entre corridas por el rate limit de login.
6. Las corridas dejan usuarios QA, establecimientos QA y eventos de auth. No hay
   endpoint de borrado; usar una base local desechable si se necesita limpiar.
7. Las reservas de la corrida se completan/cancelan al final para liberar las
   franjas; no borrar esa limpieza sin ajustar la preparación dinámica.
8. Si se agregan solicitudes después del login web, recordar que mientras exista
   la cookie `reservas_refresh` todo método unsafe exige `X-CSRF-Token`.

## Limitaciones conocidas

- **No existe endpoint para crear canchas**: la colección depende de los fixtures
  (`cancha-1`, `cancha-2`) y descubre sus IDs.
- **Google OAuth real no se ejecuta**: el start devuelve `503 OAUTH_NOT_CONFIGURED`
  en local; el callback solo se prueba con `state` inválido y redirección de error.
- **Entrega de correo no se prueba**: verificación y reset usan los tokens `dev`
  que expone la API local con `AUTH_DEV_EXPOSE_TOKENS=true`. En producción esos
  tokens no se exponen y el flujo requiere correo real.
- **Rate limits**: login 10/min, registro/forgot/reset/change 5/min. Corridas
  consecutivas rápidas pueden devolver 429.
- **Datos acumulativos**: no hay endpoints para borrar usuarios/establecimientos
  QA creados por la corrida.
- **Concurrencia**: se prueba el conflicto secuencial de franja, no dos inserts
  simultáneos; la garantía fuerte está en la constraint de exclusión de PostgreSQL.
- **Redirección OAuth**: el callback usa `followRedirects: false` para validar el
  302 original; la web (`localhost:5173`) no se levanta para Newman.
- El filtro de errores enmascara el `message` de respuestas 5xx; los tests validan
  `code`/`status`, no el texto interno.

## Seguridad

- Las credenciales del environment son **solo de fixture local**. No son secretos
  reales y no deben reutilizarse en staging/producción.
- No se commitean access tokens, refresh tokens, cookies ni claves JWT. El
  environment los deja vacíos y los scripts los llenan en memoria durante la corrida.
- `validation.md` no reproduce tokens; cualquier evidencia copiada debe redactarlos.
- No se modificó Google Cloud, SMTP ni infraestructura externa.
