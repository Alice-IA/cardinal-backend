/**
 * pendiente: implementar TicketStore sobre ioredis; requiere
 * WS_TICKET_SECRET (>=32) y REDIS_URL. Se conecta en la sesión del control
 * plane.
 *
 * No se añade la dependencia todavía: sin cliente Redis, el secreto HMAC no
 * tiene consumidor real. El control plane recibe hoy `ticketDeps` inyectadas
 * (`buildControlPlaneApp({ ticketDeps })`).
 */
export {};
