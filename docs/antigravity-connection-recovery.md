# Recuperación de la conexión de Antigravity

Antigravity usa `~/.gemini/config/mcp_config.json`; Gemini CLI usa
`~/.gemini/settings.json`. Cada cliente tiene su propia instancia de agente.
Copiar la entrada `mcpServers.hub` de Gemini a Antigravity también copia el
argumento `--agent`, y conecta el cliente con una identidad equivocada.

El daemon recupera ese caso durante la sincronización cuando la entrada de
Antigravity todavía no está registrada en el manifiesto y coincide **exactamente**
con la conexión stdio que el propio daemon genera para un Gemini registrado en
esta máquina. No basta con que se llame `hub` o que el comando se parezca.

La recuperación:

1. Calcula los endpoints desde el registro local de agentes, sin confiar en
   comandos encontrados en otros archivos de configuración.
2. Planifica el reemplazo de `mcpServers.hub` con la identidad de Antigravity.
3. Verifica que el archivo no haya cambiado desde la planificación.
4. Conserva un respaldo y todas las claves ajenas, incluidos otros MCP servers.
5. Registra la huella del valor escrito en `~/.agenthub/managed.json`.

Una entrada que ya coincide con la conexión correcta se registra sin reescribir
el archivo. Así, una corrección manual correcta no requiere editar hashes ni
claves del manifiesto para permitir futuras actualizaciones.
La adopción asegura los permisos del archivo y vuelve a verificar contenido,
identidad y permisos antes de registrar la huella esperada. Si otro proceso
reemplaza el archivo durante esa operación, se informa deriva y no se lo registra.

Las entradas con un agente desconocido, comandos, opciones o variables personales
siguen produciendo deriva. Una modificación de una entrada previamente gestionada
tampoco se acepta como copia recuperable. El modo HTTP no usa esta migración.
En esos casos se conserva el archivo para que la persona decida cómo resolverlo.

Las pruebas de `packages/daemon/src/adapters/antigravity.test.ts` cubren la
planificación real del daemon, argumentos Windows con espacios y barras inversas,
preservación de Blender, respaldo, registro del manifiesto, idempotencia y cambios
concurrentes. Ejecutarlas en macOS no equivale a probar la aplicación Antigravity
nativa de Windows.
