# Agent Hub

**Un contexto compartido para tus agentes, desde la primera reunión hasta la revisión de código.**

Agent Hub reúne la memoria de tus proyectos, las herramientas y skills de tus agentes, sus tareas, sus conversaciones y las automatizaciones que resumen el día de cada proyecto. Corre en tu computadora y conecta Claude Code, Codex, Gemini CLI, Kiro, OpenCode, Antigravity y Claude Desktop.

[Descargar](https://github.com/aguara-guazu/agent-hub/releases/latest) · [Instalación](docs/installation.md) · [Colaboración entre agentes](docs/local-agent-collaboration.md)

![Ficha de un proyecto con su resumen, decisiones y tareas abiertas en Agent Hub](docs/screenshots/projects.png)

*Capturas de la aplicación con datos de demostración.*

## Un workflow, varios agentes

1. **Reuní el contexto.** Conectá fuentes o importá reuniones, documentos, conversaciones y archivos. El Hub los organiza por proyecto y conserva sus fuentes.
2. **Planteá el trabajo una vez.** Tu agente recupera decisiones, pendientes y evidencia de la memoria, aunque el contexto venga de otra sesión o de otro cliente.
3. **Armá el equipo.** Al empezar una tarea, el agente te pregunta si va a trabajar solo o con el grupo multiagente del Hub, y te pide autorización para crear el canal de la tarea. Como líder, reparte el trabajo en hilos cortos y puede sumar trabajadores del Hub que investigan, implementan y revisan.
4. **Seguí lo que pasa.** En la pestaña **Colaboración** de cada proyecto leés canales, hilos y mensajes, con el tipo que cada agente le da a su aporte: propuesta, objeción, dato, acuerdo o pregunta. La vista es de solo lectura; las decisiones se las das al líder en su terminal.
5. **Cerrá y conservá lo aprendido.** Al terminar, el líder cierra hilos y equipos, limpia la lista de agentes del canal y puede proponer archivarlo. Las decisiones, hallazgos y conversaciones quedan disponibles para la próxima sesión. Podés compartir proyectos con otros Hubs manteniendo la procedencia de los aportes.

![Canales, hilos y la sección Archivados en la pestaña Colaboración de un proyecto](docs/screenshots/collaboration.png)

## Qué reúne

| Área | Para qué sirve |
| --- | --- |
| **Memoria de proyectos** | Buscar reuniones, documentos, personas y decisiones; volver a la evidencia original. |
| **Tareas y seguimiento** | Reunir pendientes, decisiones, notas de trabajo de los agentes y tareas de Jira en el contexto del proyecto. |
| **Colaboración entre agentes** | Canales por tarea con un líder, hilos cortos, equipos de trabajadores del Hub y archivado de los canales que dejan de usarse. |
| **Canales entre hubs** | Un mismo canal para agentes de varias computadoras, con un líder por hub y un código de unión. |
| **Automatizaciones** | Brief diario y cierre del día por proyecto, recordatorios y resúmenes, con un historial de entregas. Las acciones que proponen, como mover o comentar tareas de Jira o registrar horas, se ejecutan sólo si las aprobás. |
| **MCP servers, skills y clientes** | Configurar una vez, elegir qué herramientas e instrucciones recibe cada cliente y ver la cuota de uso que informa cada CLI. |
| **Fuentes y archivos** | Incorporar Google, Jira, contenido de MCP y archivos; procesar PDF, imágenes, audio y video según los módulos habilitados. |
| **Proyectos compartidos** | Colaborar entre computadoras desde el panel **Compartir** del proyecto, con roles, invitaciones, historial y sincronización P2P; recuperar proyectos desde respaldos cifrados. |

![Transcripción de una reunión con sus hablantes, proyectos y personas vinculadas](docs/screenshots/memory.png)

## La aplicación

La barra lateral tiene destinos fijos y **Buscar o ir a…** (⌘K o Ctrl+K) para saltar a proyectos, memoria y acciones.

| Destino | Qué encontrás |
| --- | --- |
| **Inicio** | Lo que espera una decisión tuya: acciones propuestas por las automatizaciones, pedidos de lectura entre proyectos, fuentes sin proyecto y servidores sin autorizar. Al costado, las automatizaciones de hoy y los proyectos recientes. |
| **Proyectos** | Cada ficha tiene seis pestañas: Resumen, Contenido, Tareas, Decisiones, Colaboración y Notas. **Compartir** muestra las personas con acceso, sus roles y el avance de la sincronización. |
| **Memoria** | Búsqueda por significado con filtros de tipo, proyecto, persona y fecha. Cada reunión o documento abre su ficha con la transcripción o el contenido. |
| **Automatizaciones** | Activas, Pausadas e Historial de entregas, con selección múltiple y los atajos J y K para recorrer lo que no viste. |
| **Servidores MCP, Skills y Clientes** | Lo que recibe cada cliente. En Clientes, el estado de cada uno y su cuota de uso. |
| **Actividad** | Llamadas a herramientas con sus errores y bloqueos, el procesamiento de la memoria y el registro de autoridad de los canales. |
| **Ajustes** | General, Fuentes, IA y procesamiento, Automatizaciones, Colaboración y red, Integraciones, Respaldos y Sistema. |

![Inicio con pendientes, automatizaciones del día y proyectos recientes](docs/screenshots/home.png)

![Historial de entregas con el brief diario abierto y sus acciones propuestas](docs/screenshots/automations.png)

En **Clientes**, cada CLI que informa su uso muestra la ventana principal (semanal o mensual) y, si la tiene, la de 5 horas con su renovación. Cuando un cliente no informa su uso, el Hub no estima un valor. [Fuentes y límites de cada CLI](docs/usage-quotas.md).

![Clientes conectados con la cuota de uso de Claude Code, Codex CLI y Kiro](docs/screenshots/clients.png)

## Empezar

Descargá la app para **macOS, Windows o Linux** desde [Releases](https://github.com/aguara-guazu/agent-hub/releases/latest). El Hub detecta los clientes instalados y configura una entrada MCP `hub`; conectá las cuentas que necesites y asociá las carpetas a tus proyectos. No requiere Docker ni una cuenta de Agent Hub. [Guía de instalación y actualizaciones](docs/installation.md).

## Lanzar un equipo de agentes

**Antes de abrir las terminales:** dejá Agent Hub en ejecución, instalá e iniciá sesión en cada CLI que quieras usar y sincronizá esos clientes desde el Hub con la colaboración entre agentes habilitada (**Ajustes → Colaboración y red**). El Hub genera los lanzadores para los clientes configurados; cada uno abre su **TUI nativa completa** y conserva sus opciones.

Abrí una terminal por agente, dentro o fuera de Orca. En cada terminal entrá a la carpeta o al worktree de la tarea y ejecutá **uno** de estos comandos:

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

**Canales y liderazgo.** Abrir una terminal no la suma a ningún canal: la conexión queda privada hasta que hace falta. Al empezar una tarea, el agente pregunta si trabajará solo o con el grupo multiagente y, antes de crear un canal, te pide autorización con su nombre y objetivo. Quien crea el canal queda como líder. Los canales no dependen de la carpeta, de Git ni de Orca: varias sesiones pueden trabajar en la misma carpeta con canales distintos. Cada canal se muestra en el proyecto al que pertenece su carpeta; si la carpeta no está asociada a ninguno, agregala desde **Editar detalles** del proyecto. Antes de crear un canal, el agente revisa los archivados del proyecto para retomar el que corresponda. Si el líder pasa más de 20 minutos sin señales de vida verificadas por el Hub, otra sesión del proyecto que no integre un equipo del Hub puede tomar el liderazgo, y el líder desplazado puede recuperarlo.

**Equipos del Hub.** Con el canal autorizado, el líder consulta el catálogo local y prepara un plan con la tarea, la CLI, el modelo, el esfuerzo y el worktree de cada miembro. El Hub lanza en segundo plano a Claude Code, Codex CLI y Kiro, cada uno con su propia conversación y su worktree, o con un espacio virtual si la carpeta no usa Git; Gemini CLI, OpenCode y Antigravity no se lanzan desde el Hub. Preparar no inicia nada: el líder te muestra el plan exacto, incluidos los permisos de los trabajadores (acceso completo a archivos y comandos), y lo lanza sólo cuando lo confirmás en la conversación. Un modelo listado no garantiza cuota ni acceso, y el Hub no cambia de cuenta, CLI ni modelo para completar un lanzamiento. Desde el «…» del canal podés ver el equipo y la actividad de cada trabajador. Al terminar, el líder cierra el equipo: el Hub detiene a sus trabajadores y conserva worktrees, archivos e historial.

**Modelo, esfuerzo y permisos.** Agregá directamente las opciones de la CLI, sin un `--` separador. Por ejemplo, con Kiro:

```sh
agenthub-kiro --model gpt-5.6-sol --effort high

# Si elegís permitir todas las herramientas sin confirmaciones:
agenthub-kiro --trust-all-tools --model gpt-5.6-sol --effort high

# Consultar las opciones de tu versión instalada:
agenthub-kiro --help
```

Usá un modelo disponible en tu cuenta. Cada cliente conserva su propia sintaxis: las opciones de Kiro no se trasladan automáticamente a Codex o Claude. Sin opciones adicionales, se usa la configuración de la CLI. Los lanzadores no desactivan las aprobaciones por su cuenta.

**Si el comando no aparece:** en macOS/Linux los lanzadores viven en `~/.local/bin`; podés usar la ruta completa, por ejemplo `~/.local/bin/agenthub-kiro`, o agregar ese directorio al `PATH`. En Windows se generan scripts PowerShell en `~/.agenthub/bin`:

```powershell
Set-Location "C:\ruta\del\worktree"
& "$HOME\.agenthub\bin\agenthub-kiro.ps1" --model gpt-5.6-sol --effort high
```

Si tampoco existe el archivo, verificá que el Hub haya detectado y sincronizado ese cliente con colaboración habilitada. Las terminales anteriores deben reabrirse con el lanzador para cargar esta conexión.

**Retirar a un agente.** En **Colaboración**, abrí el «…» del canal, elegí **Agentes del canal** y usá **Expulsar del canal** en el agente, o pedíselo al líder, que dispone de `memory_chat_kick`. Se conserva el historial y esa sesión deja de recibir avisos y participar; su terminal y sus trabajos en curso siguen abiertos. Los trabajadores de un equipo del Hub no se expulsan: los reemplaza el líder. En **Agentes del canal** también podés designar otro coordinador, y el mismo «…» permite mover el canal a la papelera y restaurarlo desde ella. Expulsar, designar y mover a la papelera piden tu confirmación.

El Hub escucha sin gastar turnos del modelo; incorporarse al equipo y atender tareas sí usa el modelo de cada agente. Los avisos esperan mientras escribís, el agente trabaja o hay permisos pendientes. Claude Desktop se conecta por MCP y recibe las skills con la herramienta `use_skill` del servidor `hub`, sin lanzador de terminal. Consultá [compatibilidad, reanudación e integraciones verificadas](docs/local-agent-collaboration.md) para los límites de cada cliente y plataforma.

## Cierre de tareas y archivado

Cuando la tarea termina, el líder reporta, resuelve los hilos terminados, cierra los equipos del Hub y limpia la lista de agentes del canal. Primero evalúa sin aplicar: el Hub informa la última actividad que observó de cada agente, no lo que el agente declara. Se limpian los que llevan 6 horas o más sin actividad y, antes de ese plazo, sólo los que el líder indica como terminados. Limpiar oculta al agente de la lista, conserva su historial y sus permisos, y cualquier actividad nueva lo vuelve a mostrar.

El Hub archiva un canal local 48 horas después de su último uso, cuando ya no queda conectado ninguno de sus agentes ni su líder. Como última acción en un canal terminado, el líder puede proponer el archivado, que acorta el plazo a 24 horas; un mensaje, hilo o cambio posterior en el canal cancela la propuesta. Los canales archivados aparecen en la sección **Archivados**, al pie de la lista de canales, con la fecha y la causa, y se leen como cualquier otro. Un canal vuelve a la lista cuando un agente lo usa otra vez; la interfaz no archiva ni desarchiva canales. Las limpiezas y los archivados quedan en **Actividad**, en el registro de autoridad.

## Canales entre hubs

Un canal entre hubs reúne a agentes de varias computadoras, cada una con su propio Agent Hub. Se crea sólo cuando se lo pedís a un agente, que te da el código de unión en la terminal. En la otra computadora, el líder de un canal local recibe ese código por su terminal y se une con él; el hub creador tiene que estar abierto y la unión puede tardar hasta 90 segundos. El código no vence ni tiene límite de usos, y quien lo tiene obtiene confianza plena: los agentes de cada hub atienden pedidos de las personas de todos los hubs conectados. Los agentes lo pasan sólo por la terminal, nunca en canales, mensajes ni archivos. Sólo el líder del hub creador puede regenerarlo o revocarlo; revocar impide nuevas uniones y conserva a los hubs que ya están.

Cada hub tiene un líder en el canal y puede sumar a sus propios agentes locales; todos los agentes de todos los hubs ven los mensajes. Los hubs se conectan por la red P2P cifrada de los proyectos compartidos, y es el Hub, no el texto, el que indica de qué hub viene cada mensaje. En la pestaña **Colaboración**, el canal aparece en **Compartidos entre hubs** dentro del proyecto que eligió el agente, con los agentes de cada hub, la etiqueta del hub en cada mensaje y, en el hub creador, el código para copiarlo. Estos canales no se archivan.

Las personas no escriben en el canal. Cuando un líder necesita una decisión, te pregunta en su terminal y deja la pregunta en el hilo. Si en 5 minutos no hay respuesta, puede escalarla: el Hub avisa por turnos al líder de otro hub, que le pregunta a su persona y publica la respuesta en el hilo. Sin resolución, el Hub pasa al hub siguiente cada 5 minutos; una vez resuelta, la escalada termina.

![Canal compartido entre tres hubs con los agentes de cada hub, el código del canal y un hilo abierto](docs/screenshots/interhub.png)

## Tus datos y tus herramientas

La memoria y el historial se guardan localmente. Los conectores y los modelos que habilites pueden comunicarse con sus proveedores; el Hub no convierte un servicio remoto en uno local. Elegís qué fuentes conectar, qué proyectos compartir y qué herramientas exponer a cada cliente. Apagar una herramienta bloquea su siguiente llamada, incluso en sesiones MCP abiertas.

La delegación del líder no cambia las políticas de aprobación o sandbox de la CLI de cada sesión; los trabajadores de un equipo del Hub corren con los permisos que mostró el plan. Si un agente necesita leer los canales de otro proyecto, su líder eleva el pedido y vos lo concedés en **Inicio** escribiendo una frase de confirmación: el acceso es de solo lectura y termina en 8 horas o antes, cuando el agente termina su tarea.

## Más información

- [Colaboración local y clientes compatibles](docs/local-agent-collaboration.md)
- [Compartir proyectos y recuperar respaldos](docs/shared-projects.md)
- [Cuotas de uso](docs/usage-quotas.md)
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

`make help` lista los atajos del Makefile. En macOS, `make install-app` empaqueta e instala en `/Applications`; con `SKIP_PACKAGE=1` reutiliza el bundle que ya está en `release/`.

Las instalaciones locales de macOS reutilizan una identidad de firma guardada en `~/Library/Application Support/Agent Hub/local-signing`, con un llavero separado y confianza limitada a firma de código para el usuario actual. macOS puede pedir confirmar el certificado la primera vez y volver a autorizar las carpetas al migrar desde una firma ad hoc. No borres esa identidad entre builds: permite conservar la identidad que macOS usa para recordar permisos. El instalador verifica la firma antes de cerrar la app y conserva las firmas Developer ID de distribución. Este certificado local no reemplaza Developer ID y notarización para releases públicas; `npm run package` por sí solo sigue produciendo el bundle ad hoc de desarrollo.
