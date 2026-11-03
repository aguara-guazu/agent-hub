# Agent Hub 0.15.0 — Agentes Kiro en el motor v3

Versión menor sobre 0.14.4.

## Agentes Kiro de la flota

- Los agentes Kiro que lanza el Hub en un equipo corren en el motor v3 de Kiro
  CLI (`kiro-cli acp --agent-engine=v3`). Así se pueden elegir los modelos que
  sólo ofrece ese motor, como `claude-opus-5.5`, `claude-sonnet-5.5` y la
  familia `gpt-5.6`. Antes `memory_team_prepare` rechazaba esos modelos con
  «Kiro CLI no ofrece el modelo elegido», y el motor anterior fallaba en el
  primer prompt.
- El catálogo de equipos (`memory_team_catalog`) lee los modelos de Kiro del
  mismo motor v3, con los niveles de esfuerzo que Kiro informa para cada
  modelo. El catálogo de la extracción de memoria no cambia: sigue usando
  `chat --list-models`.
- El motor v3 no acepta `--model`, `--effort` ni `--trust-all-tools`. Al abrir
  la sesión, el Hub fija el modelo y el esfuerzo con
  `session/set_config_option`, sólo con valores que la sesión ofrece, y
  confirma que quedaron aplicados. Si el modelo o el esfuerzo no existen, el
  agente falla antes del primer prompt con `fleet_model_unavailable`,
  `fleet_effort_unavailable` o `fleet_config_rejected`; Kiro, en cambio,
  acepta un valor desconocido sin avisar.
- En el motor v3 los pedidos de permiso de herramientas llegan al cliente
  aunque Kiro se haya lanzado con `--trust-all-tools`. El Hub los concede de a
  uno (`allow_once`) y sólo para la sesión del propio agente, igual que el
  cliente de Kiro con `--trust-all-tools`. Nunca elige «permitir siempre», así
  que no escribe reglas permanentes en la configuración de Kiro.
- Un agente que empezó en el motor anterior (ID de sesión sin el prefijo
  `sess_`) se reanuda en ese mismo motor, con los mismos flags de antes, para
  no perder su conversación.

## Límites conocidos

- Los agentes Kiro de la flota necesitan una versión de Kiro CLI con
  `--agent-engine` en `kiro-cli acp --help`; si falta, el preflight pide
  actualizar la CLI.
- Cada consulta del catálogo de equipos abre una sesión nueva del motor v3
  para leer sus modelos; esa sesión no envía prompts ni consume créditos.
- Un modelo del motor v3 que no aparece en `chat --list-models` todavía no se
  puede usar para la extracción de memoria.
- El acceso de la cuenta a cada modelo sigue sin verificarse hasta lanzar el
  agente.
