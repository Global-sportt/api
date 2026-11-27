# Inventario de endpoints — API local

**Fuente:** OpenAPI real en `http://127.0.0.1:3000/api/v1/docs-json` + controllers/DTOs del repo.
**Prefijo:** `/api/v1`. **Health:** fuera del prefijo (`/health/live`, `/health/ready`).
**Fecha:** 2026-11-27.

## Convenciones

- `Auth` = `Authorization: Bearer <access token>` salvo rutas públicas.
- `Tenant` = `TenantGuard` valida membresía activa en `:establishmentId`/`:id`.
- `Origin` obligatorio en métodos unsafe: `http://localhost:5173`.
- CSRF: si hay cookie `reservas_refresh`, enviar `X-CSRF-Token` igual a `reservas_csrf`. Exentos: login, register, forgot, reset, verify-email y refresh/logout con token en body.
- Errores: `application/problem+json` con `code`, `message`, `trace_id`, timestamp y path.

## Auth

| Método | Ruta | Auth | Cuerpo / query | Respuestas |
|---|---|---|---|---|
| POST | `/auth/register` | Pública | `email`, `password` (12–128), `displayName?` | 201 `{message, dev?}`; 422; 429 |
| POST | `/auth/verify-email` | Pública | `token` | 200 `{message}`; 400 |
| POST | `/auth/login` | Pública | `email`, `password`, `client?` (`web`/`mobile`) | 200 `AuthResponse`; 401; 403; 429 |
| POST | `/auth/refresh` | Cookie o body | `refreshToken?`, `client?` | 200 `AuthResponse`; 401 |
| POST | `/auth/logout` | Cookie o body | `refreshToken?` | 204 |
| POST | `/auth/logout-all` | Bearer | — | 200 `{message}` |
| GET | `/auth/me` | Bearer | — | 200 `UserResponse`; 401 |
| POST | `/auth/password/change` | Bearer | `currentPassword`, `newPassword` (12–128) | 200; 409 |
| POST | `/auth/password/forgot` | Pública | `email` | 202 `{message, dev?}` |
| POST | `/auth/password/reset` | Pública | `token`, `password` (12–128) | 200 |
| GET | `/auth/csrf` | Pública | — | 200 `{csrfToken}` + cookie |
| GET | `/auth/providers` | Pública | — | 200 `{password, google}` |
| GET | `/auth/oauth/google/start` | Pública | `return_to?` | 302 a Google; 503 si no configurado |
| GET | `/auth/oauth/google/callback` | Pública | `code`, `state` (+ cookie binding) | 302 a la web |

**AuthResponse:** `accessToken`, `tokenType`, `expiresIn`, `accessTokenExpiresAt`, `user`; web añade `csrfToken`; mobile añade `refreshToken` y `refreshExpiresAt`.

## Establishments / memberships

| Método | Ruta | Auth / permiso | Cuerpo | Respuestas |
|---|---|---|---|---|
| POST | `/admin/establishments` | Bearer; `establishment:create` platform | `name`, `slug`, `timezone?`, `currency?`, `ownerUserId` | 201; 422 `OWNER_NOT_FOUND` |
| GET | `/admin/establishments` | Bearer; `establishment:read` platform | — | 200 |
| GET | `/me/establishments` | Bearer (sin Cerbos) | — | 200 |
| GET | `/establishments/:id` | Bearer + Tenant; `establishment:read` | — | 200; 403 T; 404 |
| GET | `/establishments/:establishmentId/memberships` | Bearer + Tenant; `membership:read` | — | 200; 403 P/T |
| POST | `/establishments/:establishmentId/memberships` | Bearer + Tenant; `membership:manage` | `userId`, `groupSlug` (`staff`/`owner`) | 201; 403 P; 404; 409 |
| PATCH | `/establishments/:establishmentId/memberships/:membershipId` | Bearer + Tenant; `membership:manage` | `status?`, `groupSlug?` | 200; 403 P/T; 404; 409 |
| DELETE | `/establishments/:establishmentId/memberships/:membershipId` | Bearer + Tenant; `membership:manage` | — | 200; 403 P/T; 404; 409 |

Reglas: solo `platform-admin` asigna `owner`; owner asigna `staff`; el último owner no se puede quitar/degradar/suspender (`409 INVALID_STATE`).

## Spaces / availability

| Método | Ruta | Auth / permiso | Query | Respuestas |
|---|---|---|---|---|
| GET | `/public/establishments/:slug/availability` | Pública | `date=YYYY-MM-DD`, `spaceId?` | 200; 400; 404 |
| GET | `/establishments/:id/spaces` | Bearer + Tenant; `space:read` | — | 200; 403 T/P; 404 |
| GET | `/establishments/:id/spaces/:spaceId/availability` | Bearer + Tenant; `space:read` | `date=YYYY-MM-DD` | 200; 400; 403 T/P; 404 |

La disponibilidad excluye reservas activas y holds `pending_payment` con `expires_at > now()`.

## Bookings

| Método | Ruta | Auth / permiso | Cuerpo / query | Respuestas |
|---|---|---|---|---|
| POST | `/bookings` | Bearer; `booking:create` own | `spaceId`, `startsAt`, `endsAt` + `Idempotency-Key?` | 201; 200 replay; 400; 409 `SLOT_TAKEN`/`IDEMPOTENCY_KEY_REUSED` |
| GET | `/me/bookings` | Bearer; `booking:read` own | `status?`, `spaceId?`, `playerId?` | 200 |
| GET | `/me/bookings/:id` | Bearer; `booking:read` own | — | 200; 404 |
| POST | `/me/bookings/:id/cancel` | Bearer; `booking:cancel` own | — | 200; 404; 409 `INVALID_STATE`/`CANCELLATION_WINDOW_CLOSED`/`BOOKING_EXPIRED` |
| GET | `/establishments/:establishmentId/bookings` | Bearer + Tenant; `booking:read` establishment | `status?`, `spaceId?`, `playerId?` | 200; 403 T/P |
| POST | `/establishments/:establishmentId/bookings` | Bearer + Tenant; `booking:create` establishment | `spaceId`, `playerId`, `startsAt`, `endsAt` + `Idempotency-Key?` | 201; 200 replay; 400; 404; 409 |
| PATCH | `/establishments/:establishmentId/bookings/:bookingId/status` | Bearer + Tenant; `booking:manage` | `status` | 200; 403 T/P; 404; 409 |

Estados: `pending_payment`, `confirmed`, `checked_in`, `completed`, `cancelled`, `expired`, `no_show`.
Precio: calculado por el servidor desde la franja T5; el cliente no envía precio.
Idempotencia: misma clave + mismo hash → 200 replay; misma clave + hash distinto → 409; reserva terminal → 409.

## Dashboard

| Método | Ruta | Auth / permiso | Query | Respuestas |
|---|---|---|---|---|
| GET | `/admin/dashboard` | Bearer; `report:read` platform | `from=YYYY-MM-DD?`, `to=YYYY-MM-DD?` | 200; 400; 403 P |

Periodo por defecto: últimos 30 días incluido hoy. Máximo 366 días y `from <= to`; las fronteras son días locales en `America/Bogota`. Respuesta: `period`, `establishments`, `users`, `bookings` (`period`, `today`, `byStatus`, `revenueMinor`, `currency`), `topEstablishments` (máx. 5) y `recentBookings` (máx. 10). `revenueMinor` suma `confirmed`, `checked_in`, `completed` y `no_show`; los BigInt se serializan como string. Un dueño/staff con scope `establishment` recibe 403: la ruta no lleva `establishmentId` y es solo de plataforma.

## Health

| Método | Ruta | Auth | Respuesta |
|---|---|---|---|
| GET | `/health/live` | Pública | 200 `{status, uptime, timestamp}` |
| GET | `/health/ready` | Pública | 200; 503 `DATABASE_UNAVAILABLE` |

## Variables de colección

`baseUrl`, `healthUrl`, `origin`, tokens por rol, `csrfToken`, IDs de establecimiento/espacio/membresía/reserva, `idempotencyKey`, `bookingDate`, `bookingStart`, `bookingEnd`.
