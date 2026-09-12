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
| `src/updater.ts` | Actualización automática desde las releases de GitHub: consulta, descarga e instalación por plataforma (dmg, NSIS silencioso, AppImage) | No (red, procesos y disco inyectables) |

La lógica que no importa Electron está cubierta por pruebas unitarias (`*.test.ts`).
`main.ts` y `preload.ts` son deliberadamente delgados y delegan en esos módulos.

## Ciclo de vida en macOS

- El bundle declara `LSUIElement` (`electron-builder.yml`, `mac.extendInfo`): la app es de barra de menú, sin ícono en el Dock ni en Cmd+Tab. `main.ts` además llama a `app.dock.hide()` para `npm run dev`.
- Al mostrar la ventana se fuerza la activación (`app.focus({ steal: true })`); al ocultarla se devuelve el foco a la app anterior (`app.hide()`), porque una app accesoria sin ventanas seguiría quedándose con el teclado.
- El gateway headless que lanza cada CLI corre con `ELECTRON_RUN_AS_NODE=1` (`@agenthub/daemon`, `daemonCommand`). Como app gráfica quedaba registrado en LaunchServices como «Agent Hub» en primer plano: ocupaba el Dock y, al abrir la app, macOS activaba ese proceso sin ventana en vez de lanzar la app real.
- Core y daemon reciben stdin abierto y `AGENTHUB_STDIN_LIFELINE=1`: si el proceso principal muere sin poder detenerlos, el EOF los apaga y liberan el puerto.
- `quit()` tiene un tope de 20 s; si el apagado ordenado se cuelga, la app sale igual. Un fallo de arranque muestra un cuadro de error en vez de desaparecer en silencio.

## Actualización automática

Sin Squirrel ni electron-updater: los binarios no van firmados y Squirrel.Mac rechaza actualizar una app sin firma, así que se hace como en escalidrau. `main.ts` consulta al arrancar y cada seis horas (`CHECK_INTERVAL_MS`); si hay versión nueva y esta instalación puede autoinstalar, la baja con el `fetch` de Node (sin `com.apple.quarantine`) y la aplica:

- macOS: `installDmg` monta el dmg, verifica el bundle id, copia el bundle nuevo a `Agent Hub.app.incoming`, aparta el actual a `.previous` y los intercambia; luego `app.relaunch()`. `cleanupLeftovers` borra los restos al próximo arranque.
- Windows con instalador NSIS: lanza `AgentHub-Setup-<arch>.exe --updated /S --force-run` (los mismos argumentos que electron-updater) y sale; el instalador reabre la app. Se detecta por el desinstalador junto al ejecutable; el zip portable sólo avisa.
- Linux AppImage: reemplaza el archivo `APPIMAGE` con un `rename` en el mismo directorio y lo vuelve a lanzar; el `.deb` sólo avisa.

Con la ventana visible la actualización queda pendiente (aviso del sistema y opción en el menú) y se aplica al cerrarla. `AGENTHUB_NO_AUTO_UPDATE=1` desactiva todo; `AGENTHUB_UPDATE_API` y `AGENTHUB_UPDATE_REPO` permiten probar contra un servidor propio sin publicar una release, que es como se verificó el flujo completo en macOS.

## Seguridad del renderer

`contextIsolation`, `sandbox` y `webSecurity` activos; `nodeIntegration` desactivado.
El renderer no ve `ipcRenderer` ni Node: sólo la superficie declarada en `ipc.ts`.
La navegación fuera del origen propio se abre en el navegador del sistema.

## Scripts

```bash
npm run build --workspace @agenthub/desktop      # tsc -b
npm run typecheck --workspace @agenthub/desktop  # tsc -b --pretty false
npm run test --workspace @agenthub/desktop       # vitest run
npm run dev --workspace @agenthub/desktop        # electron dist/entry.js
```

El empaquetado vive en la raíz del monorepo (`electron-builder.yml`): `npm run package`
deja el bundle sin instalador en `release/`, `npm run dist` genera los instaladores de la
plataforma actual y `make install-app` instala en `/Applications` (macOS).
