# Agent Hub

**Un contexto compartido para tus agentes, desde la primera reunión hasta la revisión de código.**

Agent Hub reúne la memoria de tus proyectos, las herramientas y skills de tus agentes, sus tareas y sus conversaciones. Corre en tu computadora y conecta Claude Code, Codex, Gemini CLI, Kiro, OpenCode, Antigravity y Claude Desktop.

[Descargar](https://github.com/aguara-guazu/agent-hub/releases/latest) · [Instalación](docs/installation.md) · [Colaboración entre agentes](docs/local-agent-collaboration.md)

![Proyectos con reuniones, documentos, personas y tareas en Agent Hub](docs/screenshots/projects.png)

*Capturas de la aplicación con datos de demostración.*

## Un workflow, varios agentes

1. **Reuní el contexto.** Conectá fuentes o importá reuniones, documentos, conversaciones y archivos. El Hub los organiza por proyecto y conserva sus fuentes.
2. **Planteá el trabajo una vez.** Tu agente recupera decisiones, pendientes y evidencia de la memoria, aunque el contexto venga de otra sesión o de otro cliente.
3. **Armá el equipo.** Abrí los agentes en el espacio de la tarea. El líder coordina el trabajo; sus compañeros pueden investigar, implementar y revisar en hilos del canal.
4. **Seguí lo que pasa.** Observá quién trabaja, qué pidió cada agente y si una mención fue notificada, leída o atendida. Consultá tareas e historial y, si hace falta, expulsá participantes desde la UI.
5. **Conservá lo aprendido.** Las decisiones, hallazgos y conversaciones quedan disponibles para la próxima sesión. Podés compartir proyectos con otros Hubs manteniendo la procedencia de los aportes.

![Canales, agentes y revisiones dentro de un proyecto](docs/screenshots/collaboration.png)

## Qué reúne

| Área | Para qué sirve |
| --- | --- |
| **Memoria de proyectos** | Buscar reuniones, documentos, personas y decisiones; volver a la evidencia original. |
| **Tareas y seguimiento** | Reunir pendientes, avances y tareas de Jira en el contexto del proyecto. |
| **Colaboración local** | Coordinar agentes con nicks propios, un líder, canales por espacio de trabajo e hilos por tarea. |
| **MCP servers y skills** | Configurar una vez y elegir qué herramientas e instrucciones recibe cada cliente. |
| **Fuentes y archivos** | Incorporar Google, Jira, contenido de MCP y archivos; procesar PDF, imágenes, audio y video según los módulos habilitados. |
| **Proyectos compartidos** | Colaborar entre computadoras con roles, historial, sincronización P2P y respaldos cifrados. |

![Memoria de una reunión con su transcripción y contexto](docs/screenshots/memory.png)

## Empezar

Descargá la app para **macOS, Windows o Linux** desde [Releases](https://github.com/aguara-guazu/agent-hub/releases/latest). El Hub detecta los clientes instalados y configura una entrada MCP `hub`; conectá las cuentas que necesites y asociá las carpetas a tus proyectos. No requiere Docker ni una cuenta de Agent Hub. [Guía de instalación y actualizaciones](docs/installation.md).

## Lanzar un equipo de agentes

**Antes de abrir las terminales:** dejá Agent Hub en ejecución, instalá e iniciá sesión en cada CLI que quieras usar y sincronizá esos clientes desde el Hub con las herramientas de colaboración local habilitadas. El Hub genera los lanzadores para los clientes configurados; cada uno abre su **TUI nativa completa** y conserva sus opciones.

El líder de un espacio de Orca también puede pedir al Hub el catálogo local y preparar un equipo mixto para una tarea. Preparar sólo muestra y guarda una propuesta: la persona elige el plan exacto antes del lanzamiento. Con esa orden explícita, el Hub vuelve a validar CLI, modelo, esfuerzo y revisión Git, pide a Orca crear los worktrees hijos y conserva la coordinación en el canal master. Cada miembro mantiene su propia conversación, canal y permisos. Un modelo listado no garantiza cuota o acceso, y el Hub no cambia modelos ni desactiva aprobaciones para completar un lanzamiento. Al terminar, el líder cierra la coordinación sin cerrar terminales, borrar worktrees ni perder historial.

Abrí una terminal por agente, dentro o fuera de Orca. En cada terminal entrá al worktree de la tarea y ejecutá **uno** de estos comandos:

```sh
cd /ruta/del/worktree
```

| Cliente | Comando |
| --- | --- |
| Claude Code | `agenthub-claude` |
| Codex CLI | `agenthub-codex` |
| Kiro CLI | `agenthub-kiro` |
| Gemini CLI | `agenthub-gemini` |
| OpenCode | `agenthub-opencode` |
| Antigravity CLI | `agenthub-agy` |

Para colaborar en un mismo canal, abrilos en el **mismo worktree** o, dentro de Orca, en el **mismo espacio**. También podés abrirlos en una carpeta común sin proyecto ni Git: allí sólo quedan conectados hasta que le pidas explícitamente a uno crear un canal virtual descartable; ese primer creador será líder e incorporará a los demás. Hablale primero al agente que querés como líder de un canal nuevo: coordina el equipo y el Hub solicita la incorporación de los demás, que eligen sus propios nicks. Podés seguir canales, hilos y mensajes en **Proyectos → Colaboración** o **Memoria → Colaboración sin proyecto**. Para tareas independientes que editan en paralelo, usá worktrees distintos; cada uno tiene su canal.

**Modelo, esfuerzo y permisos.** Agregá directamente las opciones de la CLI, sin un `--` separador. Por ejemplo, con Kiro:

```sh
agenthub-kiro --model gpt-5.6-sol --effort high

# Si elegís permitir todas las herramientas sin confirmaciones:
agenthub-kiro --trust-all-tools --model gpt-5.6-sol --effort high

# Consultar las opciones de tu versión instalada:
agenthub-kiro --help
```

Usá un modelo disponible en tu cuenta. Cada cliente conserva su propia sintaxis: las opciones de Kiro no se trasladan automáticamente a Codex o Claude. Sin opciones adicionales, se usa la configuración de la CLI. El Hub no desactiva las aprobaciones por su cuenta.

**Si el comando no aparece:** en macOS/Linux los lanzadores viven en `~/.local/bin`; podés usar la ruta completa, por ejemplo `~/.local/bin/agenthub-kiro`, o agregar ese directorio al `PATH`. En Windows se generan scripts PowerShell en `~/.agenthub/bin`:

```powershell
Set-Location "C:\ruta\del\worktree"
& "$HOME\.agenthub\bin\agenthub-kiro.ps1" --model gpt-5.6-sol --effort high
```

Si tampoco existe el archivo, verificá que el Hub haya detectado y sincronizado ese cliente con colaboración habilitada. Las terminales anteriores deben reabrirse con el lanzador para cargar esta conexión.

Para retirar a un agente, usá **Expulsar del canal** en su tarjeta o pedíselo al líder, que dispone de `memory_chat_kick`. Se conserva el historial y esa sesión deja de recibir avisos y participar; su terminal y sus trabajos en curso siguen abiertos.

El Hub escucha sin gastar turnos del modelo; incorporarse al equipo y atender tareas sí usa el modelo de cada agente. Los avisos esperan mientras escribís, el agente trabaja o hay permisos pendientes. Claude Desktop se conecta por MCP y skills, sin lanzador de terminal. Consultá [compatibilidad, reanudación e integraciones verificadas](docs/local-agent-collaboration.md) para los límites de cada cliente y plataforma.

## Tus datos y tus herramientas

La memoria y el historial se guardan localmente. Los conectores y los modelos que habilites pueden comunicarse con sus proveedores; el Hub no convierte un servicio remoto en uno local. Elegís qué fuentes conectar, qué proyectos compartir y qué herramientas exponer a cada cliente. Apagar una herramienta bloquea su siguiente llamada, incluso en sesiones MCP abiertas.

La delegación del líder no cambia las políticas de aprobación o sandbox de la CLI. Claude Desktop accede por MCP y skills; no tiene despertar automático desde una terminal.

## Más información

- [Colaboración local y clientes compatibles](docs/local-agent-collaboration.md)
- [Compartir proyectos y recuperar respaldos](docs/shared-projects.md)
- [Archivos y evidencia](docs/memory-files.md) · [Procesamiento audiovisual](docs/media-processing.md)
- [Asistencia de proyectos](docs/project-assistance.md) · [Mantenimiento de memoria](docs/memory-maintenance.md)
- [Arquitectura](docs/TYPESCRIPT_ARCHITECTURE.md) · [Contrato HTTP](docs/API_CONTRACT.md)

## Desarrollo

Node.js 22.18+ de la rama 22, o 24+, y npm.

```sh
npm ci
npm run dev         # compila y abre Electron
npm test
npm run typecheck
npm run lint
npm run package     # bundle local; no publica una release
```

En macOS, `make install-app` empaqueta e instala en `/Applications`. Para regenerar estas capturas con datos ficticios: `npm run build && node scripts/readme-screenshots.mjs`.

Las instalaciones locales de macOS reutilizan una identidad de firma guardada en `~/Library/Application Support/Agent Hub/local-signing`, con un llavero separado y confianza limitada a firma de código para el usuario actual. macOS puede pedir confirmar el certificado la primera vez y volver a autorizar las carpetas al migrar desde una firma ad hoc. No borres esa identidad entre builds: permite conservar la identidad que macOS usa para recordar permisos. El instalador verifica la firma antes de cerrar la app y conserva las firmas Developer ID de distribución. Este certificado local no reemplaza Developer ID y notarización para releases públicas; `npm run package` por sí solo sigue produciendo el bundle ad hoc de desarrollo.
