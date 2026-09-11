# @agenthub/desktop

Proceso principal Electron de Agent Hub. Arranca el core HTTP local en loopback,
queda en la bandeja (tray) al cerrar la ventana, respeta una sola instancia, ofrece
inicio al ingresar (autostart) y expone un puente IPC mínimo y seguro al renderer.

## Módulos

| Archivo | Qué hace | ¿Importa Electron? |
|---|---|---|
| `src/main.ts` | Pegamento con Electron: ventana, tray, single-instance, close-to-tray, quit ordenado con tope de tiempo, IPC, supervisor | Sí |
| `src/entry.ts` | Punto de entrada del bundle: `--agenthub-headless` delega en el CLI del daemon; si no, carga `main.ts` | Sólo en el fallback headless |
| `src/preload.ts` | Puente seguro por `contextBridge`; expone sólo `window.agentHub` | Sí |
| `src/supervisor.ts` | Supervisor del core: arranque, reinicio con backoff, parada SIGTERM→SIGKILL, stdin como línea de vida | No (spawn inyectable) |
| `src/paths.ts` | Rutas dev/prod del core, preload, renderer e íconos | No |
| `src/window.ts` | Opciones seguras del BrowserWindow y política de navegación | No |
| `src/tray.ts` | Plantilla del menú de tray como datos puros | No |
| `src/autostart.ts` | Autostart darwin/win32 (login item) y linux (`.desktop`) | No (efectos inyectables) |
| `src/ipc.ts` | Contrato IPC: canales y tipos compartidos | No |
| `src/packager.ts` | Configuración de `@electron/packager` para darwin/win32/linux | Sólo al ejecutar como script |

La lógica que no importa Electron está cubierta por pruebas unitarias (`*.test.ts`).
`main.ts` y `preload.ts` son deliberadamente delgados y delegan en esos módulos.

## Ciclo de vida en macOS

- El bundle declara `LSUIElement` (`packager.ts`): la app es de barra de menú, sin ícono en el Dock ni en Cmd+Tab. `main.ts` además llama a `app.dock.hide()` para `npm run dev`.
- Al mostrar la ventana se fuerza la activación (`app.focus({ steal: true })`); al ocultarla se devuelve el foco a la app anterior (`app.hide()`), porque una app accesoria sin ventanas seguiría quedándose con el teclado.
- El gateway headless que lanza cada CLI corre con `ELECTRON_RUN_AS_NODE=1` (`@agenthub/daemon`, `daemonCommand`). Como app gráfica quedaba registrado en LaunchServices como «Agent Hub» en primer plano: ocupaba el Dock y, al abrir la app, macOS activaba ese proceso sin ventana en vez de lanzar la app real.
- Core y daemon reciben stdin abierto y `AGENTHUB_STDIN_LIFELINE=1`: si el proceso principal muere sin poder detenerlos, el EOF los apaga y liberan el puerto.
- `quit()` tiene un tope de 20 s; si el apagado ordenado se cuelga, la app sale igual. Un fallo de arranque muestra un cuadro de error en vez de desaparecer en silencio.

## Seguridad del renderer

`contextIsolation`, `sandbox` y `webSecurity` activos; `nodeIntegration` desactivado.
El renderer no ve `ipcRenderer` ni Node: sólo la superficie declarada en `ipc.ts`.
La navegación fuera del origen propio se abre en el navegador del sistema.

## Scripts

```bash
npm run build --workspace @agenthub/desktop      # tsc -b
npm run typecheck --workspace @agenthub/desktop  # tsc -b --pretty false
npm run test --workspace @agenthub/desktop       # vitest run
npm run dev --workspace @agenthub/desktop        # build + electron dist/main.js
npm run package --workspace @agenthub/desktop    # build + node dist/packager.js (las 3 plataformas)
```

Empaquetar una sola plataforma: `dist/packager.js darwin|win32|linux`.
