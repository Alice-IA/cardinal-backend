# Reporte — provision: worker, callback, reconciliación y creación del agente

Fecha: 2026-11-12. Repo: `cardinal-backend` (rama `test/fase-0a`).

## Estado

- Backend de provision implementado y probado: **25 tests nuevos verdes**
  (`provision.test.ts` 16, `agent-factory.test.ts` 6, `internal-api.test.ts` +3).
- Suite completa: **42 failed | 148 passed | 5 todo (195)**. Los 42 rojos son
  exactamente los 5 archivos preexistentes (`gateway-ws`, `gateway-http`,
  `contract-http`, `openapi`, `sandbox-manager` de fase 0); no cambió ninguno.
- `npx tsc --noEmit` → exit 0.
- **Sandbox Manager NO implementado**: el `alice-ops` local no cumple el
  contrato documentado (ver más abajo). Queda bloqueado hasta alinear la
  versión canónica.

## Paso 0

```
$ git status
On branch test/fase-0a
Your branch is up to date with 'origin/test/fase-0a'.

nothing to commit, working tree clean

$ git log --oneline -5
1328a71 add: alice-persona file
21aa71a feat(credentials): Redis store, cifrado AES-256-GCM y /internal/credentials
c804ba1 feat(internal): agentId opcional en /internal/route (agente primario)
eaf4fd7 feat(db): FK compuesta y agente primario único + fake sin unhandled rejections
aac8b47 feat(internal): endpoints internos para el gateway con auth por token

$ Get-Item assets/alice-persona.md
FullName      : C:\Users\52452\Documents\Development\AliceAI\cardinal-backend\assets\alice-persona.md
Length        : 12950
LastWriteTime : 12/11/2026 12:05:43 a. m.

$ bytes/chars
bytes=12950
chars=12916
```

## alice-ops: comparación (motivo del bloqueo del manager)

```
$ Get-Item C:\Users\52452\Documents\Development\AliceAI\alice-ops\scripts\deploy.sh
FullName      : C:\Users\52452\Documents\Development\AliceAI\alice-ops\scripts\deploy.sh
Length        : 14095
LastWriteTime : 09/11/2026 12:38:48 a. m.

$ git -C C:\Users\52452\Documents\Development\AliceAI\alice-ops log --oneline -3
fatal: not a git repository (or any of the parent directories): .git
```

`grep -n 'ALICE_JOB_ID\|ALICE_SANDBOX_ID\|WS_TOKEN_SHA256\|containerName\|"instance"'` → 12 coincidencias:

```
263:    sandbox_id="$(read_env "$f" ALICE_SANDBOX_ID)"
264:    [ -n "$sandbox_id" ] || invalid "$f: falta ALICE_SANDBOX_ID (id único de la fila containers)"
266:      *[!A-Za-z0-9_.-]*|.*|-*) invalid "$f: ALICE_SANDBOX_ID inválido ('$sandbox_id')" ;;
271:      *" $sandbox_key "*) invalid "$f: ALICE_SANDBOX_ID '$sandbox_id' repetido; container_name debe ser único por sandbox" ;;
275:    hash="$(read_env "$f" WS_TOKEN_SHA256)"
277:      invalid "$f: WS_TOKEN_SHA256 debe ser 64 hex (SHA-256 del capability token)"
335:      RESULTS+=("$(printf '{"ok":true,"instance":"%s","containerId":"%s","internalHost":"%s","port":%s,"transport":"%s"}' \
342:      RESULTS+=("$(printf '{"ok":false,"instance":"%s","code":"%s","message":"%s","containerId":"%s"}' \
350:    sandbox_id="$(read_env "$envfile" ALICE_SANDBOX_ID)"
355:    # ALICE_SANDBOX_ID, WS_TOKEN_SHA256 o LITELLM_API_KEY global pise los de
358:    export ALICE_SANDBOX_ID="$sandbox_id"
360:    export WS_TOKEN_SHA256="$(read_env "$envfile" WS_TOKEN_SHA256)"
```

Conclusión: no hay `ALICE_JOB_ID`, no hay `containerName` (devuelve
`results[].instance`), y exige `instances/*.env` posicionales (un
`deploy.sh --json --node local` sin target sale con `INVALID_INPUT`). Es una
copia vieja/parcial: el manager NO se implementó.

## Tests nuevos: rojo

(Se pelan los stacks idénticos de `not implemented`; el log crudo completo está
en `red-provision-clean.log`.)

```
 RUN  v5.0.5 C:/Users/52452/Documents/Development/AliceAI/cardinal-backend
4 migrations found in prisma/migrations
No pending migrations to apply.
 ❯ tests/internal-api.test.ts (37 tests | 3 failed) 53511ms
   ...
    ❯ internal API: provision (3)
      × POST /internal/provision/ready sin token responde 401 INTERNAL_UNAUTHORIZED 971ms
      × POST /internal/provision/ready con jobId inexistente responde 200 e ignora 873ms
      × GET /internal/provision/:jobId proxea al manager con X-Internal-Token 874ms
 ❯ tests/provision.test.ts (16 tests | 16 failed) 14862ms
    ❯ enqueueProvision (2)
      × crea la fila provisioning y devuelve jobId en <100 ms sin esperar al manager 1012ms
      × el token descifrado son 32 bytes y su sha256 hex (64) coincide con el del manager 945ms
    ❯ runProvision (3)
      × con manager 202 el estado sigue provisioning (espera callback) 908ms
      × con manager 503 incrementa provision_attempts y guarda provision_error 883ms
      × tres fallos del manager dejan status=error y MANAGER_UNAVAILABLE 843ms
    ❯ onManagerCallback (4)
      × ok=false deja status=error con code y message 1010ms
      × ok=true escribe la conexión y crea el agente primario 841ms
      × un callback duplicado es idempotente: un solo agente 851ms
      × un callback de una fila ya running se ignora (200) 1091ms
    ❯ contadores separados (corrección 1) (2)
      × 2 fallos del agente y acierto al 3º: running, provision_attempts=0, agent_creation_attempts=3 848ms
      × 3 fallos del agente: agent_failed, contenedor intacto y AGENT_CREATION_FAILED 971ms
    ❯ POST /internal/provision/:jobId/retry (1)
      × genera jobId nuevo, regenera token y pone los dos contadores a 0 1040ms
    ❯ reconcileOnStartup (4)
      × fila provisioning + manager ready crea el agente y pasa a running 916ms
      × fila provisioning + manager unknown + huérfano con ese jobId reencola el job 925ms
      × fila provisioning + manager failed deja status=error 800ms
      × no loguea el token en claro (ni truncado) 976ms
 ❯ tests/agent-factory.test.ts (6 tests | 6 failed) 15ms
    ❯ createAgentOnSandbox (4)
      × construye el cliente con backend remote, url, authToken y el WebSocket inyectado 4ms
      × llama createAgent({name, systemPrompt}) y NO pasa persona 0ms
      × el systemPrompt es byte a byte el contenido de assets/alice-persona.md 4ms
      × cierra el cliente incluso si createAgent lanza 5ms
    ❯ system prompt (1)
      × sin AGENT_SYSTEM_PROMPT_PATH válido falla explícitamente, sin placeholder 1ms
    ❯ normalizeProvisionError (1)
      × trunca a 500 chars y elimina authToken, headers, config y url 0ms

 Failed Tests 25
 [1/25]  agent-factory: not implemented: createAgentOnSandbox
 [2/25]  agent-factory: not implemented: createAgentOnSandbox
 [3/25]  agent-factory: not implemented: createAgentOnSandbox
 [4/25]  agent-factory: expected 'createAgent falló', got 'not implemented: createAgentOnSandbox'
 [5/25]  system prompt: expected /AGENT_SYSTEM_PROMPT_PATH/, got 'not implemented: loadSystemPrompt'
 [6/25]  normalizeProvisionError: not implemented: normalizeProvisionError
 [7/25]  internal-api ready sin token: expected 501 to be 401
 [8/25]  internal-api ready jobId inexistente: expected 501 to be 200
 [9/25]  internal-api GET proxy: expected 501 to be 200
 [10/25] provision enqueue (<100 ms): not implemented: enqueueProvision
 [11/25] provision enqueue (sha256): not implemented: enqueueProvision
 [12/25] runProvision 202: not implemented: runProvision
 [13/25] runProvision 503: not implemented: runProvision
 [14/25] runProvision 3 fallos: not implemented: runProvision
 [15/25] callback ok=false: not implemented: onManagerCallback
 [16/25] callback ok=true: not implemented: onManagerCallback
 [17/25] callback duplicado: not implemented: onManagerCallback
 [18/25] callback running: not implemented: onManagerCallback
 [19/25] contadores 2 fallos + acierto: not implemented: onManagerCallback
 [20/25] contadores 3 fallos: not implemented: onManagerCallback
 [21/25] retry endpoint: expected 501 to be 202
 [22/25] reconcile ready: not implemented: reconcileOnStartup
 [23/25] reconcile unknown+huérfano: not implemented: reconcileOnStartup
 [24/25] reconcile failed: not implemented: reconcileOnStartup
 [25/25] reconcile no token en logs: not implemented: reconcileOnStartup

 Test Files  3 failed (3)
      Tests  25 failed | 34 passed (59)
   Start at  01:14:28
   Duration  72.46s
```

## Tests nuevos: verde

```
 RUN  v5.0.5 C:/Users/52452/Documents/Development/AliceAI/cardinal-backend
4 migrations found in prisma/migrations
No pending migrations to apply.
 ✓ tests/internal-api.test.ts (37 tests) 36613ms
   ✓ internal API: provision (3)
     ✓ POST /internal/provision/ready sin token responde 401 INTERNAL_UNAUTHORIZED 1022ms
     ✓ POST /internal/provision/ready con jobId inexistente responde 200 e ignora 1027ms
     ✓ GET /internal/provision/:jobId proxea al manager con X-Internal-Token 1083ms
 ✓ tests/provision.test.ts (16 tests) 25542ms
   ✓ enqueueProvision (2)
     ✓ crea la fila provisioning y devuelve jobId en <100 ms sin esperar al manager 1020ms
     ✓ el token descifrado son 32 bytes y su sha256 hex (64) coincide con el del manager 954ms
   ✓ runProvision (3)
     ✓ con manager 202 el estado sigue provisioning (espera callback) 1062ms
     ✓ con manager 503 incrementa provision_attempts y guarda provision_error 835ms
     ✓ tres fallos del manager dejan status=error y MANAGER_UNAVAILABLE 1048ms
   ✓ onManagerCallback (4)
     ✓ ok=false deja status=error con code y message 876ms
     ✓ ok=true escribe la conexión y crea el agente primario 1046ms
     ✓ un callback duplicado es idempotente: un solo agente 867ms
     ✓ un callback de una fila ya running se ignora (200) 942ms
   ✓ contadores separados (corrección 1) (2)
     ✓ 2 fallos del agente y acierto al 3º: running, provision_attempts=0, agent_creation_attempts=3 6014ms
     ✓ 3 fallos del agente: agent_failed, contenedor intacto y AGENT_CREATION_FAILED 6026ms
   ✓ POST /internal/provision/:jobId/retry (1)
     ✓ genera jobId nuevo, regenera token y pone los dos contadores a 0 1161ms
   ✓ reconcileOnStartup (4)
     ✓ fila provisioning + manager ready crea el agente y pasa a running 888ms
     ✓ fila provisioning + manager unknown + huérfano con ese jobId reencola el job 962ms
     ✓ fila provisioning + manager failed deja status=error 891ms
     ✓ no loguea el token en claro (ni truncado) 947ms
 ✓ tests/agent-factory.test.ts (6 tests) 10ms

 Test Files  3 passed (3)
      Tests  59 passed (59)
   Start at  01:17:26
   Duration  66.99s
```

## Suite completa

```
 Test Files  5 failed | 16 passed (21)
      Tests  42 failed | 148 passed | 5 todo (195)
   Duration  179.56s

 ❯ tests/gateway-ws.test.ts (12 tests | 12 failed) 12189ms
 ❯ tests/contract-http.test.ts (10 tests | 10 failed) 9550ms
 ❯ tests/gateway-http.test.ts (8 tests | 8 failed) 8252ms
 ❯ tests/sandbox-manager.test.ts (11 tests | 7 failed | 4 todo) 6308ms
 ❯ tests/openapi.test.ts (5 tests | 5 failed) 32ms
 ✓ tests/internal-api.test.ts (37 tests)
 ✓ tests/provision.test.ts (16 tests)
 ✓ tests/agent-factory.test.ts (6 tests)
 (resto de archivos verdes)
```

Baseline antes del bloque: **42 failed | 123 passed | 5 todo (170)**. Después:
**42 failed | 148 passed | 5 todo (195)**. Mismos 5 archivos rojos; +25 tests
nuevos verdes. `tests/sandbox-manager.test.ts` de fase 0 **no se reemplazó**
(manager bloqueado): sigue con 7 rojos + 4 todo.

## Tabla archivo | qué hace | tests

| Archivo | Qué hace | Tests |
| --- | --- | --- |
| `prisma/migrations/20261112000000_provision/migration.sql` | job_id UNIQUE, provider, transport, tls_servername, internal_host, container_id, 2 contadores, errores; container_port nullable; CHECK de status ampliado conservando `creating` | soporte de 1-16 |
| `prisma/schema.prisma` | modelo `Container` con las columnas nuevas | — |
| `src/config/env.ts` | `MANAGER_URL`, `AGENT_NAME`, `AGENT_SYSTEM_PROMPT_PATH`, `PROVISION_TIMEOUT_MS` | `env.test.ts` 3/3 sigue verde |
| `src/modules/provision/system-prompt.ts` | carga `assets/alice-persona.md` desde `__dirname`; falla si no existe | 30, 32 |
| `src/modules/provision/agent-factory.ts` | `createAgentOnSandbox` (backend remote + ws), `normalizeProvisionError` | 28-33 |
| `src/modules/provision/manager-client.ts` | cliente HTTP del manager con `X-Internal-Token`; 404 → `unknown` | 36 (proxy), usado por 3-5, 13-16 |
| `src/modules/provision/provision.service.ts` | enqueue, runProvision, callback, reconciliación, retry; dos contadores | 1-16 |
| `src/modules/internal/internal.routes.ts` | `/internal/provision/ready`, `GET /:jobId`, `POST /:jobId/retry` | 12, 34-36 |
| `src/control-plane/app.ts` | inyección opcional de `provisionDeps` | 34-36 |
| `src/server.ts` | carga persona al arrancar (`{chars}`), manager client, reconciliación | `server-bootstrap` 3/3 verde |
| `tests/provision.test.ts` | 16 tests del worker/callback/reconcile/retry | — |
| `tests/agent-factory.test.ts` | 6 tests del SDK/persona/normalizador | — |
| `tests/internal-api.test.ts` | +3 tests de las rutas internas (37 total) | — |
| `README.md`, `.env.example` | flujo, cola/Redis, reconciliación, env nuevas | — |

## Decisiones y desviaciones

1. **sandbox-manager dentro del repo** (propuesto, no implementado): su
   contrato es el mismo que el backend; versionarlo junto evita drift y usa el
   mismo CI. Debe tener su propio `package.json`/`tsconfig.json` y no importar
   `@prisma/client`. Alternativa: repo aparte si se despliega con otro ciclo.
2. **Cola**: `setImmediate` + `Map` de locks por `jobId`, más
   `UPDATE ... WHERE status='provisioning'` como red entre procesos. Sirve para
   una réplica; con réplicas hay que mover cola y locks a Redis (`SET NX` con
   TTL). Documentado en README, no implementado.
3. **Backend muerto entre 202 y callback**: la fila queda `provisioning`; al
   arrancar `reconcileOnStartup` consulta `GET /provision/:jobId`:
   `ready` → agente + running; `failed` → error; `unknown` → `/provision/orphans`
   y, si hay label `alice.jobId`, re-encola `runProvision`, si no → `error`
   (`JOB_LOST`). Reporte `{recovered, failed, orphaned}` sin tokens.
4. **Dos contadores**: `provision_attempts` solo lo incrementa `runProvision`;
   `agent_creation_attempts` solo `createAgent`. Test 10 verifica
   `provision_attempts=0` tras 2 fallos del agente.
5. **Persona**: archivo del repo; `__dirname` en vez de `import.meta.url`
   porque el build es CommonJS (TS1343). Semántica idéntica (relativa al
   archivo, nunca `process.cwd()`). El arranque falla si no existe; se loguea
   `{chars}`.
6. **Migración**: se añadieron `internal_host` y `container_id` (los exige el
   callback/test 7; confirmado) y `container_port` pasó a nullable (confirmado).
   El CHECK conserva `creating` porque tests previos lo usan; se añadieron
   `provisioning`, `agent_failed`, `removing`.
7. **tls_servername**: el callback documentado no lo trae; se deriva
   `wss → internalHost`, `ws → null`.
8. **Token**: 32 bytes crudos (`randomBytes(32)`), se cifra su representación
   base64url y el hash que viaja al manager es `sha256(bytes crudos)` hex de 64.
   El sandbox que valide `WS_TOKEN_SHA256` debe decodificar base64url antes de
   hashear; si no, hay que fijar otra codificación (riesgo de integración).

## Riesgos / pendientes

- **`container_port` UNIQUE**: el manager devuelve `SANDBOX_PORT` del nodo
  (p. ej. 4500) para todos los sandboxes del nodo. El UNIQUE puede estallar al
  segundo callback con el mismo puerto. Propuesta: quitar el UNIQUE (o pasar a
  `(node_id, container_port)`) en una migración aparte, con firma.
- **Nodo por defecto**: `enqueueProvision` usa el primer nodo `status='up'` por
  id; el manager usa `ALICE_NODE`. Pueden divergir. Propuesta: env
  `DEFAULT_NODE_ID` o derivarlo del manager.
- **Manager**: bloqueado por alice-ops. No existe `sandbox-manager/`, no se
  reemplazó `tests/sandbox-manager.test.ts` (7 rojos + 4 todo).
- **Dependencia nueva**: se instaló `@letta-ai/letta-agent-sdk@0.8.85`
  (package.json + lock; 373 paquetes transitivos, incluido el peer
  `letta-code`). Sin ella no compilan los tipos reales del SDK.
- `tests/README.md` sigue con los conteos de fase 0a (no se tocó `tests/`).

## Git

No se ejecutó `git add`, `git commit`, `git push` ni `git reset`. Solo
lectura (`status`, `log`, `diff`). El árbol queda con los cambios del bloque
sin commitear:

```
 M .env.example
 M README.md
 M package-lock.json
 M package.json
 M prisma/schema.prisma
 M src/config/env.ts
 M src/control-plane/app.ts
 M src/modules/internal/internal.routes.ts
 M src/server.ts
 M tests/internal-api.test.ts
?? prisma/migrations/20261112000000_provision/
?? src/modules/provision/
?? tests/agent-factory.test.ts
?? tests/provision.test.ts
```
