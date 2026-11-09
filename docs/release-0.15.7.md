# Agent Hub 0.15.7 — Las actualizaciones automáticas vuelven a aplicarse

Versión menor sobre 0.15.6.

## Actualizaciones automáticas (macOS)

- Las sesiones de agentes abiertas antes de 0.15.5 ya no bloquean la actualización. Hasta
  0.15.6, el core posponía la parada mientras existieran procesos del Hub (gateway MCP,
  chat o hook) lanzados desde `/Applications/Agent Hub.app` en lugar del runtime
  versionado (`legacy_gateways`). Como esas sesiones pueden quedar abiertas durante días,
  la actualización no se aplicaba nunca. Ahora la parada sigue adelante: esos procesos no
  se cierran, pero pueden perder la conexión MCP con el Hub. En Claude Code se recupera
  con `/mcp`. El core registra cuántos había en `hub.log` (`legacy_gateways_ignored`).
- Una parada pospuesta ya no deja la actualización trabada hasta reiniciar la app. Antes,
  la transacción quedaba en `watchdog_ready` con el vigía terminado y cada intento
  respondía «hay una transacción anterior sin cerrar». Ahora el intento siguiente reutiliza
  esa transacción y el stage ya verificado, sin volver a descargar el DMG. Si el vigía
  terminó (vive 30 minutos sin intercambio), se prepara otro. La misma comprobación se
  repite justo antes del commit de la parada.
- Cuando de verdad queda otra transacción sin cerrar, Ajustes muestra «una actualización
  anterior quedó sin cerrar». Antes mostraba «falta la copia de ejecución de esta
  versión».

## Incluido desde main

- **Aprobaciones solo por la terminal del líder (#19).** Las órdenes del líder verificado
  y las aprobaciones que declara se toman como decisiones de la persona. `memory_chat_send`
  acepta `directive=true` para el coordinador de un equipo local activo. Se elimina la
  aprobación de planes desde la UI. `memory_chat_read_decide` y `memory_chat_read_revoke`
  reemplazan a `memory_chat_read_elevate`. Los pedidos de lectura en `pending_person` pasan
  a `cancelled`.
- **Medición de consumo por agente y por CLI (#20).** Pestaña Actividad › Consumo, con
  historial de 1 hora a 3 años. Cada CLI se informa en su unidad (tokens en Claude Code y
  Codex, créditos en Kiro lanzado por el Hub) y los tokens se convierten a costo
  equivalente de API. Herramientas nuevas: `memory_usage_self` y `memory_usage_team`.
  `memory_usage_status` no cambia.

## Compatibilidad

- La lógica de actualización que se ejecuta es la de la versión instalada. Un hub en
  0.15.5 o 0.15.6 que tenga sesiones abiertas desde antes de 0.15.5 no puede pasar solo a
  0.15.7. Hay dos salidas: cerrar esas sesiones y reiniciar Agent Hub, o instalar el DMG
  a mano. Las actualizaciones que parten de 0.15.7 usan la lógica nueva.
- Migraciones de #19 (`chat_read_requests`, `chat_messages`, reconstrucción de
  `chat_read_grants`) y de #20 (tablas de consumo). `BACKUP_SCHEMA_VERSION` pasa a 26.

## Límites conocidos

- No se probó una actualización real desde 0.15.7. El arreglo del updater se va a ejercer
  recién en la próxima release.
- No se probó qué pasa con un gateway anterior a 0.15.5 después del intercambio.
- De #20 queda sin verificar en vivo el recolector contra un Hub instalado con sesiones
  reales y con un miembro real de Kiro en la flota.

## Verificación

- El typecheck, el lint y el build terminaron sin errores en la rama de la release.
- Se adaptó un test existente de `update-drain` que esperaba el bloqueo por
  `legacy_gateways`: ahora usa `blockers_unknown` y conserva sus aserciones. No se
  corrieron tests en local; los corre la CI de la release.
