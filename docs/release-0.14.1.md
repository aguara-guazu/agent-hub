# Agent Hub 0.14.1 — Correcciones de colaboración y de Brief y cierre

Versión de correcciones sobre 0.14.0.

## Colaboración

- Los workers de la flota del Hub cuya sesión no tiene identificador nativo ya
  reciben los mensajes pendientes.
- La entrega a los workers de la flota se reconcilia con el proceso que los
  posee, y quien envía recibe un aviso cuando una entrega queda detenida.
- La salida de un worker del Hub cuenta como actividad: un worker ocupado ya no
  figura con estado desconocido.
- La sección Archivados conserva su estado en la URL, de modo que sobrevive a una
  recarga o a un enlace.
- El panel Agentes del canal cuenta y lista todos los agentes del canal, también
  con más de 40.
- El registro de autoridad rotula todos los tipos de evento; `leadership_kick`
  pasa a «Liderazgo retirado».

## Brief y cierre

- Al guardar, el panel valida en el cliente las acciones, la clave de Jira, los
  repositorios, el cliente del equipo y el modelo, y marca el campo exacto que
  falla en lugar de un error genérico.
- Los errores del servidor se asocian a su campo, incluido el formulario de
  repositorios; el primero recibe el foco y un aviso resume los campos.
- El equipo se muestra siempre porque el backend lo exige, las opciones de cliente
  coinciden con las del backend y las acciones de Jira marcadas se pueden
  desmarcar sin una clave de Jira.
- Los avisos de guardado sobreviven al remontaje del panel.
