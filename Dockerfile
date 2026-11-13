# ── build: devDependencies + cliente de Prisma + tsc ────────────────────────
# Este stage se conserva SIN `npm prune` a propósito: también es el target que
# ejecuta las migraciones (`docker build --target build`), y ese contenedor
# necesita el CLI de Prisma. El runtime NO lo lleva (ver `runtime`).
FROM node:22-alpine AS build
WORKDIR /app
# Prisma necesita openssl también en build (para detectar libssl y bajar el
# engine correcto).
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ── prod-deps: sólo dependencias de producción (--omit=dev) ─────────────────
# Se instala aparte en vez de `npm prune` porque `npm prune` puede borrar
# node_modules/.prisma, que es exactamente el cliente generado que el runtime
# necesita. Aquí NO se copia prisma/ ni se genera nada.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
# openssl: sin él Prisma aborta con "could not locate the Query Engine".
# No se instala curl/wget: el HEALTHCHECK usa `node -e` + fetch nativo de Node 22.
RUN apk add --no-cache openssl
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
# El cliente generado se copia DESPUÉS de node_modules para que sus ficheros
# reales sobreescriban los stubs que deja el postinstall de @prisma/client.
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=app:app /app/dist ./dist
# assets/alice-persona.md cuelga de /app: el código lo resuelve con __dirname
# tres niveles arriba de dist/modules/provision. Sin este COPY el proceso NO
# arranca (loadSystemPrompt lanza si no puede leerlo).
COPY --chown=app:app assets ./assets
COPY --chown=app:app package.json ./
ENV NODE_ENV=production
USER app
EXPOSE 3000
# HTTP contra /readyz: readiness REAL (DB + Redis), no "puerto abierto". Si
# cualquiera falla el endpoint responde 503, así que un proceso atascado no
# pasa el check. start-period 20s da margen a la primera conexión a la DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Sin migraciones: con réplicas dos procesos ejecutarían `migrate deploy` a la
# vez. Se aplican aparte, con el servicio `migrate` del compose de control.
CMD ["node", "dist/server.js"]
