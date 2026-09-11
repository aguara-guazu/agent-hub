# Agent Hub: correcciones y verificación local

Se reemplazó la interfaz anterior por una biblioteca local con MCP servers, skills, clientes, actividad y ajustes. No hay flujos de cuentas, equipos ni otras computadoras. Excalidraw · Escalidrau quedó configurado en el catálogo real, con 21 herramientas y sincronización confirmada en Claude Code, Codex CLI y Kiro.

## Correcciones

- **ON/OFF durante una sesión:** el gateway verifica la política local antes de listar o ejecutar herramientas. Observa el directorio de snapshots, soporta sucesivos reemplazos atómicos y rechaza llamadas a servidores, herramientas o clientes apagados. La salida normal de Electron sincroniza el último estado antes de detener el servicio.
- **Skills:** apagar una skill para un cliente conserva el archivo utilizado por los demás. Codex usa `.codex/skills` y Gemini `.gemini/skills`; las pruebas verifican ambas direcciones. Se migran sólo los enlaces antiguos registrados en el manifiesto del hub, conservando archivos personales.
- **Clientes:** detección continua, incluida la instalación posterior al arranque; snapshots concurrentes y aplicación secuencial de archivos compartidos. La interfaz muestra confirmaciones del daemon y desajustes concretos.
- **Electron:** preload CommonJS empaquetado para funcionar con sandbox y aislamiento; sesión local y renovación automática, sincronización manual, reinicio serializado, cierre de procesos y vaciado final de snapshots. Icono de aplicación y bandeja incluido.
- **MCP:** alta y edición con sondeo automático, importación JSON, controles globales que eliminan excepciones previas y controles individuales. El sondeo resuelve las mismas credenciales locales que el gateway. Corregir la conexión invalida la espera de un intento fallido anterior.
- **CLI local:** encuentra el estado de la app de escritorio; el comando generado desde TypeScript apunta al archivo compilado correcto. El diagnóstico informa ejecución local, sin anunciar aislamiento inexistente.

## Verificación

| Recorrido | Resultado |
|---|---|
| Electron real, servicios reales y estado descartable | Preload, sesión, alta MCP, 21 tools, OFF/ON por UI, alta y distribución de skill, nuevo cliente, ajustes, reinicio y salida: correctos |
| Codex 0.154.0, configuración real del bundle | Descubre 21 herramientas y ejecuta `escalidrau_get_canvas_style` |
| Claude Code 2.1.267, configuración real del bundle | `mcp get hub`: conectado; llamada real a la misma herramienta: `MCP_OK` |
| Kiro 2.21.2, configuración real del bundle | Inicio MCP requerido y llamada real a la misma herramienta: `MCP_OK` |
| Sesiones persistentes y cambios OFF → ON → OFF | Deniega, permite y vuelve a denegar; también en el mismo thread de Codex |
| Skill apagada sólo en Codex | Claude y Gemini conservan su archivo; el almacén común permanece |
| Último OFF seguido inmediatamente de Salir | Snapshots en disco apagados antes de cerrar los servicios |
| Regresiones automatizadas | Unitarias, React, integración con procesos, TypeScript estricto y ESLint |

Las llamadas a Excalidraw fueron de lectura; no modificaron el lienzo. Gemini no está instalado en esta computadora: se verificó su adaptador y materialización con configuraciones descartables, sin afirmar una sesión real de Gemini. La ruta nativa de skills de Codex también fue detectada por `skills/list` del Codex instalado.

Se guardó un respaldo anterior a la actualización en:
`~/Library/Application Support/Agent Hub Backups/2026-09-10T19-34-55-453Z/`.

## Reproducir

```sh
npm run build
npm test
npm run test:e2e
npm run typecheck
npm run lint
# Necesitan Escalidrau abierto en http://127.0.0.1:3580/mcp:
node docs/review-2026-09-10/reproduce.mjs
node_modules/.bin/electron docs/review-2026-09-10/desktop-verification.cjs
```

Evidencias: [gateway y Codex](verification.json), [Electron](desktop-verification.json), [bundle real](live-app.json), [Codex con el bundle](codex-live.json), [catálogo](live-app.png).

Las sesiones que ya habían cargado skills necesitan abrirse nuevamente para retirar instrucciones de su contexto. Los MCP conectados directamente por proyectos u otras aplicaciones conservan su configuración propia; el hub administra su entrada `hub` y los archivos que registra en su manifiesto.
