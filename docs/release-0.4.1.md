# Agent Hub 0.4.1

El botón «Sincronizar con Jira» ahora reutiliza la cuenta de Atlassian Rovo conectada en MCP servers cuando no hay un conector Jira con token. Antes, un proyecto podía tener la clave y el sitio correctos y aun así fallar al sincronizar.

- Resuelve el sitio autorizado y consulta todos los tickets del proyecto, incluyendo las páginas siguientes.
- Mantiene el estado de Jira y actualiza las tareas existentes sin duplicarlas.
- Respeta las herramientas deshabilitadas, la cuarentena y los permisos del agente que solicita la sincronización.
- Pide especificar el sitio cuando la cuenta tiene varios y muestra errores claros ante problemas de conexión o respuestas incompletas.

Validación: pruebas de paginación, permisos y persistencia con PostgreSQL; sincronización real de Escala (`EGA`) mediante la cuenta conectada, con 109 tickets.
