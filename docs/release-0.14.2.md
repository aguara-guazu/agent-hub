# Agent Hub 0.14.2 — Corrección de la verificación de publicación

Versión de correcciones sobre 0.14.1. No cambia el comportamiento de la aplicación.

## Publicación

- La prueba de sincronización de proyectos compartidos sobre sockets reales ya no
  depende de que los ciclos automáticos de sincronización caigan fuera de la
  ventana en la que se lee el progreso. La verificación previa a la publicación
  de 0.14.1 fallaba de forma intermitente por esa carrera, de modo que 0.14.1 no
  llegó a publicarse.
- Los cambios de 0.14.1 y 0.14.0 se publican en esta versión.
