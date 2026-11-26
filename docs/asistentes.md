# Asistentes residentes

Al habilitar el módulo, el asistente del Hub sigue automáticamente todos los proyectos vigentes de Memoria. Incorpora los nuevos durante su ciclo de 45 segundos. Abrí **Asistentes** para ver los asuntos de todos tus proyectos agrupados por urgencia, con el chat de tu asistente siempre a la vista. **Pendientes**, **Atendidos** y **Microtareas** cambian la lista. La búsqueda y el filtro de proyecto la acotan. Al elegir un asunto, su detalle aparece sobre el chat y lo que escribas se refiere a él. Hay una sola conversación para todos los proyectos. Podés descartar un asunto o varios seleccionados: quedan en Atendidos, se pueden restaurar y vuelven a Pendientes si cambian en el origen. Con J y K pasás al asunto siguiente o al anterior. Un aviso individual abre su asunto. Un aviso agrupado muestra los asuntos que lo originaron.

En **Ajustes → Asistentes** hay una sola configuración para el horario, la espera, la urgencia mínima, el presupuesto diario de IA, el trabajo nocturno, el estilo y la energía. Las preferencias se aplican a los proyectos actuales y futuros. El core mantiene el seguimiento al cerrar la ventana y recupera los chats al reiniciar.

Un proyecto marcado con **Este proyecto es homebrew** en su ficha queda fuera del seguimiento: no genera asuntos, avisos ni microtareas. Al desmarcarlo, el asistente lo retoma en el ciclo siguiente. Un proyecto que ya estaba pausado a mano sigue pausado.

## Proyectos archivados

En **Proyectos**, elegí **Archivar proyecto** en la fila o en la ficha. El archivo se aplica a este Hub. Reuniones, notas, sincronizaciones y aportes de otros equipos siguen llegando a la misma ficha. En **Proyectos → Archivados** podés leerlos, agregar contenido y elegir **Desarchivar**. El siguiente ciclo revisa los asuntos que siguen vigentes. La etapa comercial se puede filtrar por separado.

## Cuándo te interrumpe

En **Ajustes → Asistentes → Entrega de avisos** elegí cómo querés recibir los avisos de todos tus proyectos. El escritorio y los clientes headless comparten una cola. Dentro de tu horario laboral, el Hub reúne los pendientes en un aviso y deja pasar 15 minutos entre grupos por defecto. Con el espaciado adaptable activado, considera cuántos asuntos se acumularon y cuántos avisos recibiste en la última hora. Una tanda de ocho asuntos duplica la pausa habitual a 30 minutos. Una de dieciséis la lleva a una hora. Si aparece un asunto nuevo que alcanza el umbral de interrupción, puede adelantar el siguiente aviso a los cinco minutos, o al intervalo que elegiste si es menor.

Mientras tu calendario marca que estás en una reunión, el Hub retiene los asuntos con severidad inferior a **9/10**. Podés cambiar ese umbral, elegir **Nunca interrumpir** o desactivar el silencio. Se consultan los calendarios conectados y los eventos guardados en Memoria. Si una conexión de Calendar deja de responder y la última lectura tiene más de 15 minutos, el Hub sigue reteniendo los avisos ordinarios hasta verificar tu disponibilidad.

El orden tiene en cuenta la próxima reunión del proyecto, las preguntas de Slack pendientes, los vencimientos de Jira y las tareas que bloquean otras. En el detalle de cada aviso podés ver el proyecto, la fuente, la severidad, el motivo y el enlace al origen. Los asuntos que se resuelven durante la espera salen de la cola.

El primer recordatorio espera **30 minutos** por defecto y cada intervalo siguiente se duplica. Con el máximo inicial de **tres presentaciones por asunto y día**, un primer aviso a las 9:00 puede repetirse a las 9:30 y a las 10:30. Podés elegir hasta cuatro presentaciones. Al llegar al límite, los asuntos que siguen abiertos se incluyen en el próximo correo del brief diario si tenés esa entrega habilitada. El contador se reinicia al cambiar de día en la zona horaria de Asistentes y se conserva al reiniciar el Hub.

## Atención a clientes

El asistente reutiliza las cuentas y los canales autorizados en Conexiones. Reconoce la identidad de usuario de Slack y asocia canales por asignación existente, por enlace en memoria o por coincidencia inequívoca entre el nombre del canal y el del proyecto o cliente. Una cuenta puede servir a varios proyectos. Si un nombre coincide con dos clientes, podés precisar el destino en las excepciones. Una cuenta bot requiere identificar a la persona cuyas respuestas atienden el hilo. Slack muestra como remitente al usuario o bot autenticado por esa conexión.

El valor inicial de espera es diez minutos. Durante el horario elegido, la notificación muestra la urgencia del 1 al 10, el canal, el motivo y, cuando hay evidencia suficiente, un texto sugerido. El clic abre el asunto junto al chat. Ahí se puede consultar la evidencia, pedir otra redacción y aceptar la revisión que se ve en pantalla. Ignorar el aviso deja la sugerencia pendiente. Una respuesta propia o de un colega registrado en el hilo retira la sugerencia. Una respuesta en el canal también cuenta si enlaza explícitamente al hilo.

Antes de redactar, la secretaría recupera los mensajes del hilo y busca en las fuentes vigentes, los hechos, las notas, los tickets y las revisiones del mismo proyecto. El mensaje que disparó el aviso se excluye de la evidencia corroborante. Los mensajes propios del canal sirven como ejemplos de escritura. Si falta una fuente o hay información contradictoria, el chat explica qué falta. Las preferencias de procesamiento remoto del Hub y de las fuentes se aplican a los turnos del modelo.

Al aceptar, el core vuelve a consultar la memoria y Slack y reclama la revisión para un solo envío. Si cambió el hilo o la evidencia, la sugerencia requiere otra revisión. Una entrega cuyo acuse se perdió queda por confirmar. El core busca su identificador en Slack y recupera el recibo cuando aparece. La API de Slack separa leer el hilo y publicar en dos operaciones. Una intervención humana entre ambas puede coincidir con el envío.

## Proyectos y desarrollo

- **Secretaría** sigue los canales vinculados y las preguntas relacionadas con el proyecto. Reconoce compromisos propios de seguimiento al responder en el hilo.
- **PM** relaciona tickets atrasados, bloqueos dirigidos hacia tareas propias, revisiones de PR y reuniones del próximo día. Reconoce la identidad de la cuenta de Jira conectada y reconoce los repositorios GitHub en el remoto `origin` de las carpetas Git registradas, en los remotos registrados y en los datos del proyecto. Jira y Calendar usan la sincronización de Conexiones. El core lee los PR con la cuenta de `gh` del usuario del servicio.
- **Desarrollo** refina el objetivo y los criterios de aceptación. Con una carpeta Git registrada y un conjunto explícito de archivos, prepara la revisión en un worktree privado, registra base y commit, y ejecuta la verificación. El resultado identifica la rama, los archivos y la revisión evaluada. El checkout principal sigue disponible para trabajar. La publicación de cambios pasa por el flujo de revisión del equipo.

Antes de avisar por una tarea, PM confirma su estado en Jira. Trae lo que cambió desde la última consulta y actualiza la copia local, incluidas las tareas cerradas. Lo hace como mucho cada cinco minutos por proyecto, con el conector de Jira con token o con la cuenta de Atlassian conectada en Servidores MCP. Si no puede consultar Jira, la bandeja lo avisa y deja de alertar por tiempo sin actualización hasta volver a confirmarlo.

Podés delegar desde el chat o con **Delegar microtarea**. El coordinador también genera tareas ante asuntos prioritarios. Si ningún modelo puede leer las fuentes de un proyecto, porque no hay uno configurado o porque es externo y las fuentes no admiten IA remota, el asistente no encola microtareas automáticas para ese proyecto. La bandeja lo avisa con **Configurar modelo**, que lleva a Ajustes. El aviso desaparece cuando hay un modelo local. Cada trabajo conserva su estado, los pasos completados y el resultado. El trabajo nocturno se puede desactivar una vez para todo el Hub. Los avisos nocturnos esperan al horario laboral. El límite diario de turnos de IA se comparte entre los proyectos. Para cada rol y modelo se muestra la mediana de tokens de hasta diez turnos medidos cuando hay al menos tres muestras.

La verificación predeterminada de Desarrollo es `git diff --check`. Para probar el comportamiento del código, configurá el ejecutable y cada argumento en una línea. La verificación personalizada usa el sandbox del sistema en macOS y `bwrap` en Linux. Se ejecuta en el worktree con un directorio temporal propio. Las microtareas bloqueadas muestran el motivo y se pueden reintentar. Los respaldos conservan el historial. La restauración mantiene los perfiles respaldados en pausa y conserva la conversación general. Las excepciones permiten reactivar un perfil pausado.

## Ejecutar sin escritorio

Después de `npm ci` y `npm run build`, arrancá el core con la configuración del dueño local. El ejemplo usa un directorio propio. Guardá ambos secretos en el gestor de secretos del servicio para reutilizarlos al reiniciar. El host predeterminado es loopback.

```sh
export AGENTHUB_LOCAL_MODE=1
export AGENTHUB_DATABASE_PATH="$HOME/.agent-hub-residente/hub.db"
export AGENTHUB_CONSOLE_DIST="$PWD/frontend/dist"
umask 077
mkdir -p "$(dirname "$AGENTHUB_DATABASE_PATH")"
: "${AGENTHUB_JWT_SECRET:?Configurá el secreto JWT de esta instalación}"
: "${AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN:?Configurá el bootstrap privado del dueño}"
node packages/core/dist/server.js
```

El proceso puede administrarse con el supervisor habitual de la máquina. Cada directorio de datos debe tener un solo core propietario. Desde otro terminal con el bootstrap o un `AGENTHUB_ACCESS_TOKEN` del dueño, el cliente usa la misma API autenticada que la ventana. `AGENTHUB_URL` permite elegir otro core.

```sh
npm run --silent assistants -- projects
npm run --silent assistants -- inbox
npm run --silent assistants -- overview "¿Qué necesita mi atención hoy?"
npm run --silent assistants -- settings
npm run --silent assistants -- scan
npm run --silent assistants -- watch
npm run --silent assistants -- chat "$PROJECT_ID" "¿Qué está bloqueando mi entrega?"
npm run --silent assistants -- delegate "$PROJECT_ID" pm "Preparar el seguimiento de la demo"
npm run --silent assistants -- approve "$CASE_ID" "$REVISION"
```

`watch` muestra el próximo aviso en JSON con su enlace al Hub. `watch --ack` reserva el aviso y registra su presentación en la bandeja compartida con el escritorio. Se puede consumir el mismo contrato desde otro cliente. En macOS la opción de energía mantiene un `caffeinate -i` ligado al core mientras haya un proyecto activo que lo pida. El cierre de la tapa puede provocar reposo forzado. Para continuidad durante ese reposo, ejecutá el core en un equipo que permanezca encendido. [Documentación de energía de Apple](https://developer.apple.com/library/archive/qa/qa1340/_index.html)

## API del dueño

Las rutas llevan el prefijo `/api/assistants` y usan `Authorization: Bearer` con la sesión local del dueño.

| Método y ruta | Operación |
| --- | --- |
| `GET /settings`, `PUT /settings` | Preferencias comunes con control de versión |
| `POST /scan` | Revisar todos los proyectos vigentes |
| `GET /chat`, `POST /chat` | Conversación única y persistente. El mensaje lleva `{text, case_id?, mode?, revision?}`. Con `case_id` el asunto es el contexto del turno y `rewrite` pide otra redacción de su borrador |
| `GET /work` | Microtareas de todos los proyectos, con `total` y `blocked` |
| `GET /projects`, `GET /projects/{proyecto}` | Proyectos, perfil, canales, último escaneo, error y consumos |
| `PUT /projects/{proyecto}` | Guardar `{version, config}` con control de concurrencia |
| `POST /projects/{proyecto}/scan` | Revisar ahora el proyecto activo |
| `GET /inbox?project={proyecto}`, `GET /cases/{id}` | Bandeja global o filtrada, asunto, evidencia y conversación. La bandeja admite `state`, `q`, `limit` y `offset`, y devuelve `total`, `urgent` e `important` |
| `POST /cases/dismiss`, `POST /cases/restore` | Descartar o restaurar asuntos con `{ids}`. Devuelve los que cambiaron |
| `GET /projects/{proyecto}/chat`, `POST /projects/{proyecto}/chat` | Leer o conversar con `{text, case_id?, mode?, revision?, request_id?}`. `rewrite` pide otra redacción |
| `POST /slack/{id}/approve` | Aceptar exactamente `{revision}` para el canal e hilo visibles |
| `GET /notices`, `POST /notices/claim` | Consultar el próximo aviso o reservarlo con `{consumer}` (UUID del cliente) |
| `GET /notices/{delivery_id}` | Abrir el detalle del aviso con los asuntos que siguen vigentes |
| `POST /notices/{id}/seen` | Confirmar la presentación con `{revision, delivery_id}`. Si se pierde el acuse, el cliente puede repetirlo |
| `GET /work/{proyecto}`, `POST /work/{proyecto}` | Consultar o delegar con `{role, objective, request_id}`. La clave de petición es un UUID |
| `POST /work/{proyecto}/{id}/retry` | Reintentar una tarea bloqueada conservando los pasos confirmados |
| `POST /projects/{proyecto}/shadow` | Comparar los avisos del perfil actual y un perfil candidato sobre los mismos asuntos |
| `POST /automations/{proyecto}/close/compare` | Ensayar el cierre diario con una captura de sus entradas. Acepta `current` y `proposed` con las estimaciones tipadas del cierre y una lista opcional `delivery`. Devuelve ambos textos, propuestas, destinos y digest de la captura sin despachar efectos |
