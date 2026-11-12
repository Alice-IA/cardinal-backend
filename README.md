# alice-backend

Módulo de autenticación con JWT para el backend de Alice.

- Node.js 20+ · Express 4 · TypeScript (`strict`)
- PostgreSQL 16 · Prisma ORM
- `jose` (HS256) para firmar/verificar · `argon2id` para contraseñas
- `zod` para validación de input y de entorno · `pino` para logs
- `vitest` + `supertest` contra un Postgres real

---

## Puesta en marcha

### 1. Requisitos

- Node.js 20.11 o superior
- Docker (para Postgres) o un PostgreSQL 16 propio

### 2. Dependencias y variables de entorno

```bash
npm install
cp .env.example .env
```

Edita `.env` y rellena los dos secretos. **Tienen que ser distintos y de 32+
caracteres**; si no, el proceso no arranca:

```bash
openssl rand -base64 48   # ACCESS_TOKEN_SECRET
openssl rand -base64 48   # REFRESH_TOKEN_SECRET
```

### 3. Base de datos

```bash
docker compose up -d
docker compose ps          # espera a que el healthcheck esté en "healthy"
```

El contenedor crea `alice_backend` (desde `POSTGRES_DB`) y `alice_backend_test`
(desde `docker/init/01-test-db.sql`). El script de init **sólo** corre cuando el
volumen está vacío; si ya tenías el volumen creado antes de añadirlo, créala a
mano:

```bash
docker compose exec postgres createdb -U alice alice_backend_test
```

### 4. Migraciones

```bash
npm run db:generate    # genera el cliente de Prisma
npm run db:migrate     # aplica migraciones en desarrollo (crea nuevas si faltan)
```

En producción/CI, sin prompt interactivo y sin generar migraciones nuevas:

```bash
npm run db:deploy
```

Para inspeccionar la base de datos: `npm run db:studio`.

### 5. Arrancar

```bash
npm run dev      # tsx watch
npm run build && npm start   # producción
```

### 6. Tests

```bash
npm test
```

Los tests corren contra **Postgres real** usando `TEST_DATABASE_URL`. Antes de
ejecutar nada:

- `tests/global-setup.ts` aplica `prisma migrate deploy` sobre esa base.
- `tests/setup.ts` **aborta** si la URL no termina en `_test`, porque cada test
  hace `TRUNCATE` de las tablas de dominio.
- Los archivos de test corren en serie (`fileParallelism: false`): comparten una
  única base de datos.

---

## API

Base: `/auth`. Todos los errores tienen la misma forma:

```json
{ "error": { "code": "TOKEN_INVALID", "message": "Token inválido", "details": [{ "field": "email", "issue": "Email inválido" }] } }
```

`details` sólo aparece en `VALIDATION_ERROR`.

| Código | HTTP | Cuándo |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Body inválido (Zod) |
| `INVALID_CREDENTIALS` | 401 | Email o contraseña incorrectos (mismo cuerpo siempre) |
| `TOKEN_EXPIRED` | 401 | Access/refresh token expirado |
| `TOKEN_INVALID` | 401 | Token ausente, malformado, revocado o reusado |
| `RATE_LIMITED` | 429 | 5 fallos de login en 15 min para la misma ip + email |
| `EMAIL_TAKEN` | 409 | Email ya registrado (mensaje genérico; el `code` es para el frontend) |
| `INTERNAL_ERROR` | 500 | Fallo no controlado (nunca expone detalles internos) |

### Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/auth/register` | Crea el usuario. `password` mínimo 12 caracteres. |
| `POST` | `/auth/login` | Devuelve `accessToken` en el body y el refresh en cookie. |
| `POST` | `/auth/refresh` | Rota el refresh token y devuelve un `accessToken` nuevo. |
| `POST` | `/auth/logout` | Revoca el refresh token actual y borra la cookie. `204`. |
| `GET` | `/auth/me` | Usuario actual. Requiere `Authorization: Bearer <accessToken>`. |

### Prueba manual con curl

```bash
BASE=http://localhost:3000
JAR=cookies.txt          # bóveda de cookies de curl (necesaria para el refresh)

# 1) Registro → 201
curl -i -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"jes@example.com","password":"contrasena-larga-123","name":"Jes"}'

# 2) Login → 200 + accessToken en el body, refresh_token en Set-Cookie
curl -i -c $JAR -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"jes@example.com","password":"contrasena-larga-123"}'

# Guarda el access token para los siguientes pasos
ACCESS=$(curl -s -c $JAR -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"jes@example.com","password":"contrasena-larga-123"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

# 3) Perfil → 200
curl -i $BASE/auth/me -H "Authorization: Bearer $ACCESS"

# 4) Refresh → 200 + nuevo accessToken, y la cookie del jar rota
curl -i -b $JAR -c $JAR -X POST $BASE/auth/refresh

# 5) Logout → 204
curl -i -b $JAR -c $JAR -X POST $BASE/auth/logout

# Comprobación: el refresh posterior falla con 401
curl -i -b $JAR -c $JAR -X POST $BASE/auth/refresh
```

---

## Decisiones de diseño

### Por qué la cookie es `Path=/auth` y no `Path=/auth/refresh`

`/auth/logout` necesita **leer** el refresh token para poder revocarlo en la
base de datos. Con `Path=/auth/refresh` el navegador no envía la cookie a
`/auth/logout`, y el servidor sólo podría borrar la cookie del cliente dejando
el token vivo en la DB hasta que expire (30 días). `Path=/auth` limita la cookie
a las rutas de autenticación y permite que refresh **y** logout la reciban.

`clearCookie` se llama con exactamente el mismo `path` y las mismas flags; si no
coinciden, el navegador ignora el borrado y la cookie se queda.

### Doble submit y login

`POST /auth/login` **ignora** cualquier refresh token entrante: no lo revoca ni
reutiliza su familia, siempre emite una familia nueva. Así, un doble click en
"Entrar" (o una pestaña vieja reenviando la cookie) no mata la sesión que ya
estaba viva en otro dispositivo.

### Rotación de refresh tokens

- Cada login abre una **familia** (`family_id`).
- Cada refresh marca el token actual con `used_at` y crea el siguiente en la
  misma familia, enlazado por `replaced_by_token_id`.
- En la DB sólo se guarda `sha256(token)`; el token en claro vive únicamente en
  la cookie del cliente.
- `family_id` = id del primer token de la familia, así que el `jti` de cada
  token coincide con su fila (`refresh_tokens.id`).

### Detección de reuso: el algoritmo

Cuando llega un token con `used_at IS NOT NULL` (ya se canjeó antes), se mira su
sucesor:

| Estado del sucesor | Interpretación | Acción |
| --- | --- | --- |
| Existe, `used_at` NULL y `revoked_at` NULL | Carrera benigna: dos requests concurrentes con el mismo token, el segundo llega después del commit del primero | `401 TOKEN_INVALID`, **sin** revocar |
| Ya usado, revocado o inexistente | Reuso real: alguien está reproduciendo un token viejo | `401` + revocar **toda** la familia |

No hay ventana de gracia por tiempo: una ventana temporal es explotable (basta
con retener el token y usarlo dentro de la ventana). La decisión depende sólo
del estado del sucesor en la base de datos.

### Concurrencia del refresh: `SELECT ... FOR UPDATE`

Elegido **row lock**, no `SERIALIZABLE`:

- `SERIALIZABLE` en Postgres aborta transacciones con `40001` y exige
  reintentar. Con dos refresh simultáneos, el perdedor tendría que reintentar y
  aun así el resultado sería "reuso", o habría que mapear un error de
  serialización a un 500/401 poco claro.
- `SELECT ... FOR UPDATE` sobre la fila del token presentado serializa el
  acceso a **ese** token: el segundo request espera el lock, y al leer ve
  `used_at` ya escrito. Entra por la rama de "ya usado", cuyo sucesor sigue
  virgen → carrera benigna → 401 sin revocar.
- El aislamiento es `ReadCommitted` (el default). Basta porque la decisión se
  toma sobre una fila que tenemos bloqueada.

Resultado esperado de dos refresh concurrentes con el mismo token: **uno
responde 200, el otro 401, y la sesión del ganador sigue viva** (test 6, y el
test verifica con un tercer refresh exitoso).

### Detalle fino: `throw` dentro de `$transaction`

La primera versión lanzaba `AppError` dentro de la transacción interactiva. Eso
hace **ROLLBACK**, así que la revocación de la familia se deshacía y el reuso
quedaba detectado pero no persistido. La implementación ahora devuelve un
estado (`rotated` / `benign_race` / `reuse` / `expired` / `invalid`) y el error
se lanza **después** del commit.

### Carrera benigna y `Set-Cookie`

Cuando el segundo request pierde la carrera, la respuesta 401 **no** borra la
cookie: el ganador acaba de escribir una válida y un `clearCookie` posterior
tiraría una sesión que sigue viva. El resto de los 401 de refresh sí la borran.

### Tiempos de respuesta constantes

- Login con email inexistente: se verifica contra un `DUMMY_HASH` precalculado
  con los mismos parámetros de argon2, así el costo de CPU es equivalente al de
  un usuario real con contraseña incorrecta.
- Registro con email duplicado: también ejecuta un `argon2.verify` contra el
  señuelo antes de responder el 409. Sin eso, el 409 (~1 ms) sería medible
  frente a un 201 (~30 ms) y delataría si el email existe.
- El código `EMAIL_TAKEN` sí distingue el caso, porque es para el frontend; el
  `message` es genérico para el usuario final.

### argon2id

Parámetros explícitos en `auth.service.ts`, no los defaults de la librería:

```
memoryCost: 19456 (19 MiB) · timeCost: 2 · parallelism: 1
```

(Recomendación OWASP para argon2id.)

### Rate limit

Tabla `login_attempts`, no memoria: si mañana hay más de una instancia, el
contador es compartido. Se cuenta `(ip, email)` con `success_at IS NULL` en los
últimos 15 minutos. Un login exitoso inserta su fila y **borra** los fallos
previos de esa combinación (el reset del contador).

### `lower(email)` fuera del schema

El schema no puede expresar índices funcionales, así que
`users_email_lower_key` (`UNIQUE (lower(email))`) está escrito a mano en la
migración. Lo mismo con los `CHECK` de `containers`. La app normaliza el email a
minúsculas antes de escribir; el índice es la garantía a nivel de base de datos.

---

## Estructura

```
src/
├── @types/express.d.ts          # Request.user
├── config/
│   ├── env.ts                   # validación Zod, exit 1 si falla
│   └── prisma.ts                # singleton
├── middlewares/
│   ├── auth.middleware.ts       # Bearer → req.user
│   ├── rate-limit.middleware.ts # 5 fallos / 15 min por ip+email
│   └── error.middleware.ts      # forma única de error
├── modules/auth/
│   ├── auth.routes.ts
│   ├── auth.controller.ts       # sólo HTTP
│   ├── auth.service.ts          # lógica de negocio
│   ├── auth.schema.ts           # Zod
│   └── token.service.ts         # emisión, rotación, revocación, familia
├── utils/
│   ├── async-handler.ts         # Express 4 no atrapa rechazos async
│   ├── errors.ts                # AppError(code, statusCode)
│   └── logger.ts                # pino + redacción
├── app.ts
└── server.ts
```

---

## Tareas pendientes (no implementadas a propósito, ver riesgos)

### Purga de `login_attempts`

Los registros de más de 24 h no aportan: fuera de la ventana de 15 min no
cuentan para el rate limit. Job sugerido (cron diario):

```sql
DELETE FROM login_attempts WHERE created_at < now() - interval '24 hours';
```

El índice `login_attempts_created_idx` existe justo para esto.

### Purga de `refresh_tokens`

Los tokens expirados y las familias revocadas se acumulan. Con el índice
`refresh_tokens_expires_idx`:

```sql
DELETE FROM refresh_tokens
WHERE expires_at < now() - interval '7 days'
   OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days');
```

Mantener una ventana de gracia permite auditar reusos recientes antes de borrar.

---

## Aprovisionamiento (fase provision)

El **backend** es la única fuente de verdad del estado. El **Sandbox Manager**
es un servicio aparte que solo habla Docker (ejecuta `alice-ops/scripts/deploy.sh`
como subproceso) y no importa `@prisma/client`.

Flujo:

1. `enqueueProvision` genera `jobId` (UUID) + un token **string** de 43 chars
   (base64url de 32 bytes), cifra ese string (`token_ciphertext`) y crea
   `containers` en `provisioning`. Devuelve en <100 ms.
2. `runProvision` (background) hace `POST /provision` al manager y espera el
   callback. Los fallos del manager incrementan SOLO `provision_attempts`
   (backoff 1 s / 4 s / 16 s; a los 3 → `error` + `MANAGER_UNAVAILABLE`).
3. El manager ejecuta `deploy.sh --json --node <nodo>` con el hash por **env**
   (nunca por argv) y llama a `POST /internal/provision/ready`.
4. `onManagerCallback` escribe la conexión y crea el agente con el SDK. Los
   fallos del agente incrementan SOLO `agent_creation_attempts` (3 intentos;
   si se agotan → `agent_failed` + `AGENT_CREATION_FAILED`, sin borrar el
   contenedor).
5. `POST /internal/provision/:jobId/retry` (decisión C) genera un `jobId` nuevo
   y regenera el token para recrear contenedor + agente.

### Hash del token (string, no bytes)

`WS_TOKEN_SHA256` es `sha256(utf8(tokenString))` del **string de 43 chars**
que viaja en `Authorization: Bearer <token>`; **NO** es el hash de los 32 bytes
crudos. La BD guarda `encryptToken(tokenString)`, es decir, el mismo string que
se envía. Letta calcula el hash del string que recibe, así que el sandbox debe
hashear el header tal cual, sin decodificar base64url.

`containers.container_port` **no es UNIQUE**: es el puerto interno del nodo
(p. ej. 4500) y se comparte entre todos los sandboxes de ese nodo; no se publica
en el host. Si algún día se publican puertos, el UNIQUE volvería a importar.

### Cola y locks: en memoria (una réplica)

La cola es `setImmediate` + un `Map` de locks por `jobId`. Sirve para **un solo
proceso**: evita dobles ejecuciones dentro del proceso y el
`UPDATE ... WHERE status = 'provisioning'` es la red de seguridad entre
procesos. **Con réplicas del backend hace falta mover la cola y los locks a
Redis** (por ejemplo `SET NX` con TTL por `jobId`); no se implementa aquí a
propósito.

### Backend caído entre el 202 y el callback

La fila queda `provisioning`. Al arrancar, `reconcileOnStartup` consulta
`GET /provision/:jobId`:

- `ready` → ejecuta el paso del agente y pasa a `running`.
- `failed` → `error`.
- `unknown` (el manager reinició y perdió su Map) → consulta
  `GET /provision/orphans`; si el contenedor con label `alice.jobId` existe,
  re-encola `runProvision`; si no, `error` + `JOB_LOST`.

El reporte `{ recovered, failed, orphaned }` se loguea con agregados y jobIds;
**nunca** tokens.

### Persona

`AGENT_SYSTEM_PROMPT_PATH` (default `assets/alice-persona.md`) se resuelve
desde el archivo compilado (`__dirname`), no desde `process.cwd()`. Si el
archivo falta, el proceso no arranca y no sirve provisiones; no hay placeholder.
Se loguea `{ chars }`, nunca el contenido.

> **Estado:** el backend de este bloque está implementado y probado
> (`tests/provision.test.ts`, `tests/agent-factory.test.ts`,
> `tests/internal-api.test.ts`). El servicio `sandbox-manager/` NO se implementa
> todavía: el checkout local de `alice-ops` no expone el contrato documentado
> (`ALICE_JOB_ID`, `containerName`, labels `alice.jobId`), así que primero hay
> que alinear la versión canónica.

