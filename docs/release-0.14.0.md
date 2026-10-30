# Agent Hub 0.14.0 — Rediseño, canales entre hubs y cierre de canales

Esta versión reúne el rediseño de la interfaz, la colaboración entre hubs y el
cierre ordenado de los canales de colaboración.

## Interfaz rediseñada

- Nueva navegación (Inicio, Proyectos, Memoria, Automatizaciones, Servidores MCP,
  Skills, Clientes, Actividad y Ajustes) y un sistema de diseño común con
  temas oscuro y claro.
- La colaboración vive dentro de cada proyecto y es de solo lectura: la persona
  ve canales, hilos y mensajes; las decisiones se piden a los agentes por la
  terminal. Se quitaron el Foro compartido y la propuesta de resolución.
- Pestaña Notas por proyecto y panel Compartir con las personas del proyecto.
- Automatizaciones con Activas, Pausadas e Historial.
- Clientes muestra la cuota de uso de cada agente.
- El tablero de Colaboración se ajusta a la ventana, cada columna scrollea por
  separado y el hilo abre en el último mensaje.
- Los checkboxes de Brief y cierre ya no se dibujan con borde de campo.

## Canales entre hubs

- Un canal compartido entre varios hubs sobre la capa P2P de proyectos
  compartidos. Se une con un código único del canal, sin vencimiento ni límite de
  usos; el hub creador puede revocarlo o regenerarlo. Quien tiene el código tiene
  confianza plena en el canal.
- Cada hub aporta su líder y sus agentes locales. El panel Agentes del canal
  agrupa por hub y los mensajes llevan la etiqueta del hub de origen.
- Si un líder le pregunta a su persona y pasan 5 minutos sin respuesta, escala a
  los líderes de los otros hubs por turnos, sin avisos en la interfaz.
- Los canales entre hubs no se archivan ni se limpian automáticamente.

## Cierre de canales

- Los líderes limpian del canal a los agentes que ya no colaborarán: cerrados,
  con la tarea completada, o con 6 horas o más sin actividad. Cualquier
  actividad reinicia la cuenta y el agente vuelve a figurar.
- Un canal sin agentes conectados ni líder se archiva a las 48 horas. Si el líder
  propone archivarlo, se archiva a las 24 horas. Se muestra en una sección
  Archivados, plegada por defecto.
- Los líderes pueden consultar los canales archivados al crear uno, leer su
  historial o revivirlo tomando el liderazgo. Un canal revivido vuelve a la lista
  normal y se archiva de nuevo con las mismas reglas.
- La skill local-collaboration incluye una sección de cierre (wrap up) y hay dos
  herramientas nuevas para el líder: `memory_chat_clean_agents` y
  `memory_chat_propose_archive`.

## Migración

- Versión 41 del esquema, aditiva: columnas de actividad y descarte en
  `chat_sessions` y de archivado en `chat_channels`, más el índice
  `chat_channels_archived`. El rollback quita esas columnas y el índice y borra
  la versión 41 de `schema_versions`.

## Versionado

- Se define la regla de versionado en `docs/versionado.md`.
