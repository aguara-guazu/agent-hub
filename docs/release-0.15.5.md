# Agent Hub 0.15.5 — Flota supervisada y parada coordinada

Versión menor sobre 0.15.0.

## Agentes de la flota

- Si un agente de un equipo pierde su proceso, o el Hub ya no lo controla después de
  un reinicio, el coordinador recibe un aviso de liveness. Antes el agente quedaba en
  `unknown` durante horas sin que nadie se enterara.
- Un agente relanzado con `team_control start` o `clear` conserva su canal y recibe las
  menciones que la conversación anterior dejó sin atender: las de las últimas 24 horas,
  hasta 30 mensajes y solo de canales que la sesión nueva puede leer. Ya no se crea un
  canal virtual nuevo en cada arranque.
- El reintento de incorporación de un agente que terminó su primer turno sin unirse al
  equipo valida la invitación y el estado del proceso antes de rotar el token. El envío
  solo cuenta como entregado si el recibo no informa el proceso como `failed`, `unknown`
  o `stopped`.
- Si una parada no pudo confirmar la salida del proceso, el agente pasa a `stopped` en
  cuanto la salida llega. Así se lo puede volver a lanzar.
- El ciclo de entrega de menciones ya no se traba si una consulta o un aviso a una CLI
  no responde.
- Al proponer un equipo, el coordinador le muestra a la persona la composición, los
  permisos, el canal y el commit base, y nunca el plan_id, el digest ni URLs internas.
  La persona confirma en la conversación.
- Los reportes de los miembros de un equipo llegan a su coordinador.

## Parada coordinada para actualizar y cerrar

- Antes de una actualización silenciosa o de un cierre de la app, el Hub avisa a los
  líderes de los equipos activos. Cada líder pide a sus agentes que lleguen a un punto
  seguro (puede usar `memory_team_control` con `interrupt` o `stop`) y después confirma
  con `memory_hub_stop_confirm`. El MCP sigue disponible hasta que todos paran.
- Actualización: si a los 30 minutos la parada no se completó, la actualización se
  pospone y no se vuelve a intentar antes de 30 minutos. Nunca se corta a nadie.
- Cierre: durante los primeros 30 minutos se espera la parada coordinada. Después hay
  15 minutos de gracia con un segundo aviso a los líderes. A los 45 minutos el cierre se
  fuerza de forma ordenada: SIGTERM, SIGKILL solo como último recurso y hasta tres
  reintentos. Un segundo pedido de cierre no fuerza nada. El tray muestra la cuenta
  regresiva y permite cancelar el cierre en cualquier momento antes del commit.
- Si la app o el core se reinician a mitad de un cierre, esa parada se cancela y la app
  queda lista para usar.
- Al volver a arrancar después de una parada, los líderes reciben un aviso para
  relanzar sus agentes.
- Al cerrarse, el core detiene primero la flota y corta las esperas de chat antes de
  drenar las conexiones. Cada paso del cierre se ejecuta aunque falle uno anterior, y
  una salida de proceso que no se pudo confirmar se informa como error.
- El core termina si el proceso que lo lanzó ya no existe.
- En Windows, si el instalador no llega a instalar la versión nueva después de la parada,
  la versión anterior vuelve a abrir el Hub y la parada se da por terminada.

## Diagnóstico

- `hub.log` guarda la actividad estructurada del Hub (entregas, avisos, procesos de la
  flota, paradas) en segmentos rotativos. La rotación apunta a un presupuesto de 50 MB
  para toda la carpeta de logs; es un objetivo, no un tope exacto, y prioriza no perder
  líneas.
- La skill `report-hub-issue` arma un issue redactado con versiones, sistema, eventos de
  `hub.log` en una lista cerrada de campos, incidentes de procesos y causas de avisos.
  Solo lo publica después de que la persona aprueba el texto exacto. El cuerpo se guarda
  en un borrador privado del Hub que se borra a la hora, también si el Hub se reinició
  antes.
- `memory_context` informa la hora local de la persona.

## Límites conocidos

- En macOS, una actualización silenciosa espera a que terminen los procesos de agentes
  iniciados con una versión anterior del bundle (gateways heredados). Mientras quede
  alguno, la actualización se pospone sin avisar a los líderes ni parar la flota, y la
  consola muestra cuántos procesos heredados quedan. Cerrar la app no los espera. La
  cantidad depende de cada máquina: en la verificación previa de esta release, en la Mac
  de prueba se detectaron 36.
- La vuelta automática a la versión anterior (rollback) existe solo en macOS. En Windows
  y Linux el instalador reemplaza la app sin rollback.
- El rollback sigue usando las rutas `/update-drain/*` anteriores, no la parada
  coordinada.
- Si la persona cierra la app mientras una actualización está en espera, se pierde el
  tiempo de espera entre intentos de esa actualización.
- Si el commit de una actualización no se confirma por errores de red o del servidor, la
  app deja de reintentar al cabo de unos 30 ciclos: cerca de un minuto con la red caída,
  y hasta unos 5 minutos si el servidor responde con errores 5xx. La parada queda en
  estado incierto: la app conserva la intención y la pospone, y un intento posterior la
  reconcilia o la reintenta. Si eso no alcanza, la parada se resuelve al reiniciar el Hub.
- Al arrancar, el core espera hasta unos 3 segundos para leer el estado de la parada. Si
  no puede leerlo y no tiene la transacción del lanzador, no empieza a escuchar y el
  escritorio lo reinicia.
- En una carrera rara de rotación entre procesos, `hub.log` todavía puede perder o
  cortar alguna línea.

## Verificación

- Pasaron todas las suites corridas sobre la rama de la release: memory y core, gateway,
  daemon y shared, desktop, frontend y sharing, más el build, el typecheck y el lint.
- Los timeouts de 5 s de los tests ya existían antes de esta release y no se cambiaron.
- El test de fleet-process que cruza un arranque con el cierre del manager fallaba de
  forma intermitente con la máquina muy cargada. Se le subió el margen de parada de
  50 ms a 500 ms. El cambio es solo del test y no toca el comportamiento del Hub.
- El test de update-lease que aceptaba un core ya admitido sin repetir la admisión se
  reemplazó por uno que exige repetirla y recibir su confirmación, porque la app ahora
  hace eso.
- Los tests de recuperación del bundle de macOS corren solo en macOS, porque leen la
  versión del bundle con `/usr/bin/plutil`.
- El test de local-chat «pagina sin perder menciones y separa leído/atendido» falla de
  forma intermitente. La bandeja ordena por fecha de creación y desempata por un id
  aleatorio, así que dos mensajes del mismo milisegundo pueden salir en otro orden. Ya
  pasaba antes de esta release: no se pierden mensajes, solo cambia el orden.
