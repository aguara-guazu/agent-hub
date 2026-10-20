# Agent Hub 0.10.0 — Colaboración sin proyecto

Esta versión incorpora canales virtuales descartables para colaborar en una carpeta sin crear un proyecto ni inicializar Git, mejora la administración de agentes y recupera conexiones de Antigravity copiadas de Gemini CLI.

## Panel de agentes

- La lista empieza oculta. **Mostrar agentes** abre una columna a la derecha con scroll propio; **Ocultar agentes** devuelve el espacio a la conversación.
- Los agentes expulsados desaparecen del listado, de los totales y de la paginación. Sus mensajes y autoría permanecen en el historial.
- Los miembros desconectados siguen visibles. En pantallas estrechas, los paneles se apilan.

## Canales virtuales descartables

- Abrí los agentes en una misma carpeta común y pedile explícitamente al que será líder que cree un canal virtual.
- Las conexiones existentes en esa carpeta se incorporan al equipo. El inicio de una terminal por sí solo no activa el canal ni asigna liderazgo.
- El líder puede cerrar el canal por pedido de la persona: se detienen las entregas y la participación, se conserva el historial y la carpeta queda libre para un nuevo canal.
- Nueva vista **Memoria → Colaboración sin proyecto**, con búsqueda, lectura de conversaciones y expulsión de participantes.
- Herramientas nuevas: `memory_chat_create_channel` y `memory_chat_close_channel`.

Los canales por worktree Git y espacio de Orca conservan su comportamiento. Para editar código en paralelo, seguí usando worktrees separados.

## Recuperación de Antigravity

El Hub reconoce una entrada `mcpServers.hub` copiada exactamente de un Gemini CLI registrado en la misma máquina y puede reemplazarla por la conexión propia de Antigravity. Conserva los demás servidores, genera un respaldo y registra la huella en el manifiesto.

Una conexión que ya es correcta puede registrarse sin editar hashes manualmente ni reescribir el archivo. La adopción verifica contenido, identidad y permisos; una modificación concurrente se informa como deriva. Las configuraciones desconocidas o personalizadas siguen protegidas.

## Actualización e historial

La migración conserva los canales, participantes y mensajes existentes. Los respaldos incluyen los canales virtuales; al restaurarlos, los canales activos se convierten en históricos para evitar reutilizar conexiones o líderes anteriores.

Después de actualizar, sincronizá los clientes y volvé a abrir las conexiones MCP para cargar las herramientas e instrucciones nuevas.

## Validación y límites

La integración pasó 636 pruebas de backend, daemon y desktop, más 126 del frontend, con 14 pruebas omitidas. También pasó build, tipos, lint y un recorrido de navegador con servidor HTTP y gateways MCP reales. La revisión independiente aprobó los tres cambios.

El workflow de publicación vuelve a comprobar la versión y las pruebas en Linux y Windows, instala y abre el Hub en Windows y construye los instaladores de macOS, Windows y Linux antes de publicar.

Las pruebas automatizadas de Antigravity no equivalen a una sesión interactiva del cliente real en Windows. El despertar de las TUI reales de Gemini/Antigravity y los selectores de continuación sin ID nativo mantienen los límites documentados en la [guía de colaboración](https://github.com/aguara-guazu/agent-hub/blob/v0.10.0/docs/local-agent-collaboration.md).
