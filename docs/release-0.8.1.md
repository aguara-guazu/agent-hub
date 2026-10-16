# Agent Hub 0.8.1

Los participantes de proyectos compartidos ahora muestran una barra de recepción debajo del nombre. La barra avanza cuando el otro Hub confirma los cambios recibidos y permite distinguir conexión, transferencia y recepción completa. Es compatible con participantes que siguen usando 0.8.0; no mide el análisis posterior de los agentes.

La red P2P permanece activa mientras Hub está abierto, incluso si una instalación anterior la había desactivado. Compartir proyecto queda centrado en miembros, roles e invitaciones. En Ajustes están el nombre y el botón Copiar identidad, los parámetros avanzados de red, los respaldos y las palabras de recuperación, que siguen reservadas a los owners. Se conservan los proyectos, identidades y datos existentes.

Las actualizaciones se descargan, instalan y reinician en segundo plano, sin confirmaciones, avisos ni ventanas al terminar. Las descargas interrumpidas se reanudan cuando la release proporciona SHA-256, con verificación de tamaño e integridad. Los errores se reintentan automáticamente; la limpieza de archivos ya no compite con la descarga y el reinicio de macOS evita borrar el bundle anterior antes de volver a arrancar.

El flujo automático funciona en macOS, Windows con instalador y Linux AppImage. En Windows espera y reintenta mientras existan puentes MCP activos que el instalador cerraría. Windows portable, Linux `.deb` y las instalaciones sin permisos de escritura requieren instalación externa. La primera instalación de 0.8.1 usa el actualizador que ya tenga cada Hub; a partir de esta versión, las siguientes actualizaciones serán silenciosas.

Validación local: 548 pruebas de backend/escritorio y 116 de interfaz; 11 etapas de punta a punta con Hubs independientes; intercambio real con un peer 0.8.0; actualización nativa aislada en macOS con descarga, instalación, reinicio oculto, servicio saludable y cero ventanas/notificaciones. El recorrido P2P usa descubrimiento local; no sustituye una prueba entre redes y firewalls externos.
