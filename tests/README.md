# Fase 0a — suite de contrato (tests primero)

Esta carpeta fija con tests el contrato del control plane, el gateway y el
sandbox **antes** de implementar la lógica de negocio. Los stubs deben estar
**rojos** hasta que se implementen. Los 6 archivos de auth originales y los 24
tests de regresión de auth deben estar **verdes contra la app Express real**
(la regresión todavía no corre contra Fastify, ver más abajo).

Estado de la corrida canónica (BD del LXC, con `phase1_constraints.sql`
aplicado): **42 rojos** (gateway/control plane/openapi/sandbox), **78 verdes**
(24 auth originales + 24 regression-auth + 9 ownership + 14 internal + 1 env +
6 ticket) y **5 todo** (4 `[docker-real]` + 1 deuda de Fastify en
regression-auth).

## Cómo correr

```bash
npm install
npm run db:generate
npm run db:deploy          # aplica la migración de fase 0a sobre DATABASE_URL
npm test
```

`npm test` necesita `TEST_DATABASE_URL` (la base debe terminar en `_test`) y las
dos variables de JWT. `tests/setup.ts` aborta si la URL no cumple la regla.

## Base de datos de test

La suite canónica corre contra la base del LXC:

```
postgresql://alice:Qwerty123@192.168.68.66:5432/alice_backend_test?schema=public
```

Esa base **ya tiene `prisma/migrations/phase1_constraints.sql` aplicado**, así
que `tests/ownership.test.ts` da **9/9** y la suite completa da
**42 failed | 78 passed | 5 todo**.

Una base nueva creada solo con `prisma migrate deploy` (sin aplicar el SQL
manual de `phase1_constraints.sql`) da **ownership 7/9**: los 2 rojos son las
garantías de DB que ese archivo añade (`agents_container_owner_fk` y el índice
parcial `agents_one_primary_per_container`). **Eso es correcto para una base
recién creada y no es un fallo ni una regresión de código**; con esa base la
suite completa da 44 failed | 76 passed. No apliques el SQL manual a una base
nueva solo para "arreglar" esos 2 tests.

## Qué se ha añadido

| Pieza | Estado |
| --- | --- |
| `prisma/migrations/20261106000000_phase0_contract` | Columnas/tablas mínimas para expresar los tests (`agents.is_primary`, `nodes`, `containers.node_id`, `containers.ws_secret_path`). |
| `prisma/migrations/phase1_constraints.sql` | SQL manual de fase 1 con la FK compuesta y el índice parcial único. **No está aplicado** ni forma parte de la migración automática; solo queda listo. Incluye el `UNIQUE (id, user_id)` previo que Postgres exige para la FK. |
| `src/modules/agents/ownership.service.ts` y `src/modules/tickets/ticket.service.ts` | **Implementados** en fase 1a. Ownership 7/9 en verde; los 2 rojos son las garantías de DB pendientes. Ticket 6/6 en verde. |
| Stubs `src/modules/sandbox/sandbox-manager.ts`, `src/gateway/app.ts`, `src/control-plane/app.ts` | Siguen lanzando `not implemented` o respondiendo `501`. No hay lógica de negocio. |
| Tests `tests/ownership/ticket/gateway/contract/openapi/sandbox-manager` | Ownership 7 verdes + 2 rojos; ticket 6 verdes; gateway/contract/openapi/sandbox-manager rojos por comportamiento. |
| `tests/regression-auth.test.ts` | **Verde contra la app Express real** con supertest; se mantiene así hasta la migración a Fastify. |

La migración automática **no** añade las dos restricciones que defienden los
tests 8 y 9 de ownership (`agents_container_owner_fk` y el índice parcial único).
Es deliberado: si se añaden ahora, esos tests pasan a verdes sin que exista la
garantía de aislamiento. El SQL manual está en
`prisma/migrations/phase1_constraints.sql`, **sin aplicar**. Ese archivo incluye
además `UNIQUE (id, user_id)` en `containers`, porque PostgreSQL exige un índice
único exacto sobre las columnas referenciadas por la FK compuesta.

## Matriz test | contrato que defiende | estado

Leyenda: **rojo** = debe fallar hoy por comportamiento; **verde** = ya
implementado; **todo** = no ejecutado en CI.

### `tests/ownership.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| alice resuelve su agente primario a la ruta del nodo | `resolveRoute(user, agent)` devuelve `{host, port, nodeId}` | verde |
| bob no puede resolver el agente de alice | **aislamiento de tenant**: usuario ajeno → `null` | verde |
| un agente inexistente devuelve null | no distinguir inexistente de ajeno | verde |
| un contenedor en creating devuelve SANDBOX_NOT_READY | no enrutar a un sandbox no listo | verde |
| un nodo down devuelve NODE_UNAVAILABLE | no enrutar a un nodo caído | verde |
| lista exactamente el agente primario de alice y no el subagente | `listPrimaryAgents` filtra `is_primary` | verde |
| la lista de bob no contiene el agente de alice | aislamiento en listados | verde |
| un agente no puede apuntar al contenedor de alice con el user_id de bob | FK compuesta `agents_container_owner_fk` → SQLSTATE 23503 | rojo (requiere aplicar `phase1_constraints.sql`) |
| no puede haber dos agentes is_primary=true en el mismo contenedor | índice parcial único → SQLSTATE 23505 | rojo (requiere aplicar `phase1_constraints.sql`) |

### `tests/ticket.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| emite base64url(payload).base64url(hmac) con exp = now + 30 | formato y TTL de 30 s | verde |
| el payload no filtra containerPort ni internalHost | no filtrar enrutamiento al cliente | verde |
| rechaza una firma alterada con TICKET_INVALID | autenticidad HMAC | verde |
| rechaza un ticket expirado con TICKET_EXPIRED | `exp` pasado | verde |
| el segundo consumo del mismo jti da TICKET_ALREADY_USED y deja TTL en Redis | replay protection + TTL 25–30 s | verde |
| devuelve solo userId, agentId y containerId; sin host ni port | el gateway re-resuelve contra DB | verde |

`jti` lo genera el servidor con `randomUUID()`; no existe camino para que el
cliente inyecte un `jti`, así que el test de colisión no aplica.
`issueTicket` es sin estado: no escribe en Redis y no depende de que Redis esté
arriba. Solo `consumeTicket` escribe `ticket:used:<jti>`.

### `tests/gateway-ws.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| sin Authorization responde 401 y no llega ningún upgrade al upstream | auth obligatoria antes del upstream | rojo |
| un token de bob no abre la conexión al contenedor de alice | ownership en WS → 404/NOT_FOUND | rojo |
| reenvía un JWT de contenedor con aud sandbox:\<containerId> y exp <= 60 s | token de contenedor correcto | rojo |
| no reenvía el Origin del cliente al upstream | no filtrar identidad/origen del navegador | rojo |
| un mensaje de texto del cliente llega al upstream y el eco vuelve | pipe texto | rojo |
| un Buffer de 64 KB va y vuelve íntegro | pipe binario sin corrupción | rojo |
| recibe los 5 stream_delta del upstream en orden | streaming en orden | rojo |
| rechaza el segundo WS del mismo usuario con 4409 y deja vivo el primero | `CONNECTION_LIMIT` / close 4409 | rojo |
| contenedor en creating cierra con 4503 y SANDBOX_NOT_READY | close 4503 | rojo |
| nodo down cierra con 4503 y NODE_UNAVAILABLE | close 4503 | rojo |
| si el upstream rechaza el upgrade con 401, el cliente recibe close 4401 | no colgarse ante upstream 401 | rojo |
| al cerrar el gateway se cierran todos los sockets cliente y upstream | apagado limpio | rojo |

### `tests/gateway-http.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| GET /v1/agents reenvía el JWT del contenedor y filtra a solo is_primary | proxy autenticado + filtro | rojo |
| aunque el upstream devuelva 5 agentes, al cliente le llega 1 | el filtro no es responsabilidad del upstream | rojo |
| GET /v1/agents/\<agente de bob\> con token de alice es 404 sin tocar el upstream | ownership antes del proxy | rojo |
| GET /app-server-info se reenvía y responde | passthrough permitido | rojo |
| DELETE /v1/agents/x responde 405 y no toca el upstream | superficie HTTP limitada | rojo |
| un 500 del upstream se transforma en 502 UPSTREAM_ERROR | no propagar errores crudos | rojo |
| un upstream más lento que UPSTREAM_TIMEOUT_MS devuelve 502 | timeout | rojo |
| reescribe Host al upstream y no reenvía el Origin del cliente | headers de infraestructura | rojo |

### `tests/contract-http.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| GET /api/agents sin token responde 401 TOKEN_INVALID | auth obligatoria | rojo |
| GET /api/agents con token de alice devuelve solo sus agentes (1) | aislamiento en listado | rojo |
| GET /api/agents/\<agente de bob\> con token de alice responde 404, no 403 | no revelar existencia ajena | rojo |
| POST /api/agents/\<agente de bob\>/ws-ticket con token de alice responde 404 | ownership en emisión de ticket | rojo |
| POST /api/agents/\<alice\>/ws-ticket devuelve ticket y expiresAt sin datos internos | forma del ticket | rojo |
| el body del ticket no tiene más de 2 campos top-level | no filtrar datos internos | rojo |
| GET /api/sandbox con contenedor creating responde 200 sin internalHost | estado de sandbox sin infraestructura | rojo |
| GET /api/sandbox con nodo down expone node.status sin datos internos | estado de nodo sin infraestructura | rojo |
| POST /api/sandbox/restart responde 202 sin bloquear más de 50 ms | operación asíncrona | rojo |
| POST /api/agents responde 404 o 405: el usuario no puede crear agentes | superficie de creación cerrada | rojo |

### `tests/openapi.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| GET /docs/json devuelve OpenAPI 3.1.x | documentación viva | rojo |
| documenta todas las rutas del control plane | contrato descubrible | rojo |
| cada endpoint no público declara security bearerAuth | auth documentada | rojo |
| ningún schema de respuesta expone infraestructura interna | no filtrar `internalHost`, `containerPort`, `wsSecretPath`, `nodeId` por docs | rojo |

### `tests/sandbox-manager.test.ts`

| Test | Contrato que defiende | Estado |
| --- | --- | --- |
| genera un secreto de 32 bytes y guarda la ruta, no el secreto | `ws_secret_path` apunta a un archivo, no al secreto | rojo |
| el comando de docker compose up no publica puertos | sin `-p`/`--publish`/`ports:` | rojo |
| el comando configura ws-auth signed-bearer-token y el archivo de secreto | auth del app-server por token firmado | rojo |
| es idempotente: dos llamadas no crean dos containers | provisioning idempotente | rojo |
| si /readyz nunca responde, deja status=error y error_message no nulo | timeout 90 s + CHECK de DB | rojo |
| remove es idempotente y borra memfs/\<agent_id\>/ | cleanup de datos del agente | rojo |
| restart no espera a que el contenedor esté listo | restart rápido | rojo |
| `[docker-real]` ×4 | casos que requieren Docker real | todo |

### `tests/regression-auth.test.ts`

Copia los 6 archivos de auth existentes con los mismos asserts, pero **contra la
app Express real** (`src/app.ts`), la misma que usan `tests/auth.*.test.ts`, con
supertest. **24/24 en verde.**

Corrección de fase 0a: la primera versión usaba `app.inject()` contra el stub
Fastify del control plane, que no monta `/auth/*`; esos 24 rojos verificaban el
stub, no auth. Se cambió a Express para verificar el comportamiento real. En
fase 1, cuando auth se porte a Fastify, este archivo pasará a `inject()` y debe
seguir verde sin tocar sus asserts. La deuda está dentro del archivo:
`it.todo('[fase 1] los 24 auth contra Fastify con inject() sin tocar asserts')`.

> Nota: se añadieron **2 precondiciones** (asserts nuevos sobre rutas de auth),
> no solo cambios de infraestructura. Los asserts originales siguen intactos:
> el de medianas y el de claims `['exp','iat','jti','sub']`.

| Suite | Tests | Contrato que defiende | Estado |
| --- | --- | --- | --- |
| `POST /auth/register` | 4 | registro, email duplicado, validación, hash argon2id | verde |
| registro: tiempo de respuesta | 1 | no filtrar existencia de email por timing | verde |
| `POST /auth/login` | 4 | access token, cookie httpOnly, credenciales, familias | verde |
| `POST /auth/refresh` | 6 | rotación, reuso, familia, concurrencia, cookie | verde |
| `POST /auth/logout` | 3 | revocación, cookie vieja, idempotencia | verde |
| `GET /auth/me` | 4 | token válido, expirado, ausente, firma ajena | verde |
| rate limit de login | 2 | 429 al sexto fallo, reset con login exitoso | verde |

Los archivos originales `tests/auth.*.test.ts` (supertest + Express) siguen
existiendo y deben quedar **verdes**: no se han modificado.

### Cambios de asserts en `regression-auth.test.ts`

**Se añadieron 2 precondiciones; los asserts originales no se cambiaron.** Las
precondiciones son asserts nuevos sobre rutas de auth, no simple
infraestructura:

1. En `registro: tiempo de respuesta`, `expect(warmup.status).toBe(201)` antes
   de medir. Sin ella, contra el stub 501 todas las respuestas tardaban lo mismo
   y el test pasaba en falso.
2. En `el access token sólo lleva sub, iat, exp y jti`,
   `expect(res.status).toBe(200)` antes de decodificar. Sin ella, el body 501 no
   tenía `accessToken` y el test reventaba con `TypeError`.

El assert de claims (`['exp','iat','jti','sub']`) y el de medianas siguen
exactamente igual.

### Wrapper de ownership: eliminado en fase 1a

En fase 0a el test central usaba `resolveRouteForPhase0a` para convertir el
`not implemented` del stub en un valor y añadía un guard
`expect(route).not.toHaveProperty('__phase0aStub')`. Con `resolveRoute`
implementado y devolviendo `null`, ese guard lanzaba `TypeError` porque
`toHaveProperty` no acepta `null`. Se eliminó el wrapper y el guard (autorizado
en fase 1a); el test central ahora llama directo:

```ts
const route = await resolveRoute(fixture.bob.id, fixture.alice.primaryAgentId);
expect(route, 'bob no debe resolver el agente de alice').toBeNull();
```

## Supuestos: decisiones pendientes de firma

El documento no fijaba estos puntos. No se implementa nada contra ellos hasta
que esta tabla se apruebe. La columna "Cumple estas reglas" se refiere a las
cuatro reglas duras: access token sin claims de routing, respuestas públicas sin
infraestructura, ajeno = `NOT_FOUND`, y `/v1/agents` solo `is_primary`.

| Supuesto | Decisión actual | Cumple estas reglas | Recomendación + motivo |
| --- | --- | --- | --- |
| Ruta WS | `GET /v1/agents/:agentId/ws` (`GATEWAY_WS_PATH`). | Sí. El `agentId` es un ID público de recurso; el access token sigue llevando solo `sub` y la autorización se resuelve contra la DB. No expone host, puerto ni secreto. | Mantener. Es la ruta natural del gateway y no introduce datos de infraestructura en el token ni en la URL. Pendiente de firma porque el documento no la nombra. |
| Envelope de `GET /api/agents` y `GET /v1/agents` | **Array plano `Agent[]`** en ambos. Antes los tests asumían `{ agents: [...] }`; se corrigió. | Sí. Es lo que consume el SDK de `letta-oss-ui`; no envuelve datos internos. | Mantener array plano. Si el app-server responde `{ agents: [...] }`, el gateway **desanida en el handler `GET /v1/agents`**, justo antes de filtrar `is_primary`; el control plane nunca envuelve. Así el contrato público es siempre `Agent[]` y el cliente del SDK no cambia. |
| Forma de `node` en `GET /api/sandbox` | `{ status, node: { status }, lastSeenAt }`; `node` es objeto con `status`, sin `id`, `host` ni `port`. | Sí. El test de sandbox ahora recorre la respuesta a cualquier profundidad y falla si aparece `internalHost`, `containerPort`, `wsSecretPath` o `nodeId`, incluido `node.nodeId`. | Mantener `node: { status }`. El test 8 del documento exige `node.status`; un string no serviría. No incluir `id` para no abrir la puerta a `nodeId`. |
| API interna del ticket | `issueTicket(input, { store, secret, now })` y `consumeTicket(ticket, deps)`. El payload no lleva `containerPort` ni `internalHost`; `consumeTicket` devuelve solo `{ userId, agentId, containerId }`, sin `host`/`port`. `issueTicket` no escribe en Redis. | Sí. No es una API HTTP pública; el ticket es opaco para el cliente y no filtra enrutamiento. | Mantener el seam inyectable para testear TTL/replay sin Redis real. En fase 1 vive en `packages/core` y lo importan backend (emite) y gateway (consume): una sola implementación, sin duplicar. |
| Protocolo de close WS para errores | Close `4503` (`SANDBOX_NOT_READY`/`NODE_UNAVAILABLE`), `4409` (`CONNECTION_LIMIT`) y `4401` (upstream 401); el `reason` del close (o un frame previo) contiene el código. | Sí. El close no incluye host, puerto ni secreto. | Mantener. Documentar que el `reason` es solo el código de error estable; el cliente no debe parsear infraestructura. Pendiente de firma porque el documento no fija el formato exacto del `reason`. |
| Claims del access token | `sub` + `iat`, `exp`, `jti`; **cero** `containerId`, `nodeId`, `agentId` o `containerPort`. El assert existente exige exactamente `['exp', 'iat', 'jti', 'sub']`. | Sí, interpretando "nada más" como ningún claim de routing/tenant: `iat`/`exp`/`jti` son metadata JWT, no destino. El test de auth ya prohíbe cualquier claim extra. | Mantener `sub` + claims registrados y añadir un assert negativo explícito de routing si se quiere blindar. Si la regla se interpreta literal (solo `sub`), hay que cambiar la implementación de auth y el assert existente; es un cambio de contrato y no se hace sin firma. |
| `UNIQUE (id, user_id)` en `containers` | Se añade `containers_id_user_id_key` en `phase1_constraints.sql` (no aplicado). | **Sí.** Requerido por PostgreSQL para aceptar `agents_container_owner_fk`. Inofensivo porque `id` ya es PK. | **Aceptar.** Consecuencia: la FK amarra el agente al par exacto `(id, user_id)`; si cambia el algoritmo de hash del container id, hay que migrar la fila. |

## No ejecutado en CI

Los casos marcados `it.todo("[docker-real] ...")` en
`tests/sandbox-manager.test.ts` requieren Docker real y **no se ejecutan en
CI**. El fake `FakeDocker` es obligatorio para el resto.

El App Server real (`/tmp/letta-app-server-token`) tampoco se usa en CI: todos
los tests de gateway corren contra `FakeAgentServer`. Para probar manualmente
contra el real, arranca el App Server y apunta el gateway a su host/puerto; no
hay ningún test automatizado que lo haga.
