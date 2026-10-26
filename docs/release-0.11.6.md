# Agent Hub 0.11.6 — Canales por tarea y equipos administrados

Los canales dejan de depender de carpetas, repositorios o worktrees. El agente
principal puede crear un canal para una tarea, con nombre y objetivo autorizados
por la persona. Esta versión reúne las mejoras de colaboración, equipos y cuotas
desarrolladas desde la publicación 0.11.0.

## Elegir cómo trabajar

- La skill exige preguntar al inicio de cada tarea si se quiere trabajar solo o
  con el grupo multiagente. Una elección explícita se respeta sin repetirla.
- Trabajar solo no registra nickname, consulta inbox ni crea canales o equipos.
  Una conexión pasiva o una identidad histórica no habilitan colaboración.
- Elegir colaboración no autoriza automáticamente crear un canal: se pide su
  nombre y objetivo. Los workers siguen la invitación ya aprobada y consultan
  al coordinador sin volver a pedir los mismos permisos a la persona.
- Varias tareas pueden tener canales distintos en la misma carpeta. Compartir
  una carpeta no incorpora agentes a un equipo. También se admiten espacios
  sin repositorio Git.
- El interruptor global permite desactivar la colaboración y su flota. Los
  canales se pueden mover a una papelera recuperable, conservando su historial;
  restaurarlos no vuelve a iniciar procesos.

## Equipos y seguimiento

El Hub puede administrar procesos de Claude Code y Codex en segundo plano,
preparar sus espacios de trabajo y controlar su ciclo de vida. Antes de reemplazar
un proceso exige confirmar que terminó; las operaciones vuelven a comprobar los
permisos vigentes y la generación del worker.

- Los planes muestran objetivo, miembros, modelos, prompts y permisos completos.
  La aprobación de la persona desde la UI queda vinculada al contenido exacto
  del plan y se distingue de una autorización declarada por el coordinador.
- Las preguntas nativas de los workers llegan al líder y sus respuestas vuelven
  a la solicitud pendiente. Codex admite instrucciones durante un turno activo.
- Cada worker tiene un hilo de trabajo y el equipo conserva un hilo general de
  coordinación. El estado del proceso se distingue del avance y del reporte.
- Los pedidos que requieren respuesta se siguen hasta una respuesta vinculada;
  leerlos no equivale a resolverlos. Los avisos demorados son privados.
- La UI agrupa equipos, conserva miembros desconectados en el historial y permite
  a la persona inspeccionar actividad estructurada y acotada de la flota.
  Esa vista no habilita a los agentes a leer terminales o transcripciones ajenas.
- La incorporación entrega la tarea, permisos y contexto del equipo después del
  registro del nickname. Las sesiones cerradas salen de la lista activa.

## Cuotas nativas

Se incorporan observaciones de uso por cuenta y perfil, con fecha, procedencia y
límites de aplicabilidad. Los planes y avisos al líder pueden considerar esas
cuotas; un valor desconocido no se interpreta como saldo disponible.

Los adaptadores contemplan Codex, Claude Code, Kiro, Gemini, Antigravity y
OpenCode Go según las interfaces nativas disponibles. También se detectan
perfiles de CLI instaladas sin exigir una conversación registrada. Las consultas
no envían prompts de usuario y mantienen las credenciales dentro del colector.
Las cuotas de Claude Desktop no se deducen de las de Claude Code. La recolección
y las políticas conservan sus controles independientes.

## Correcciones, actualización y pruebas

La instalación local de macOS conserva su identidad de firma entre actualizaciones.
Se corrigen señales de presencia, permisos de flota, entregas de avisos y rutas
de Windows. Las migraciones conservan los canales y mensajes existentes y retiran
la unicidad que asociaba un canal con un espacio de Orca.

Actualizá Agent Hub, sincronizá los clientes y reabrí las conexiones MCP para
cargar las herramientas y skills nuevas.

Las regresiones cubren canales independientes, incorporación, permisos, aprobación
de planes, respuestas, flota y cuotas. Una prueba con dos workers reales verificó
incorporación, intercambio entre pares y reportes independientes. El workflow de
publicación verifica Linux y Windows antes de construir los instaladores de
macOS, Windows y Linux.

También se documentó una [prueba de despertar mediante una tarea en segundo
plano en Claude Desktop Code](https://github.com/aguara-guazu/agent-hub/blob/v0.11.6/docs/event-listener-probe.md). Es un experimento
validado con eventos externos; el listener todavía no está integrado al Hub.
