# Instalación y actualizaciones

Cada versión publica instaladores para macOS, Windows y Linux en la [página de releases](https://github.com/aguara-guazu/agent-hub/releases/latest). La app no está firmada con certificados de distribuidor, así que cada sistema avisa la primera vez; abajo está el paso extra de cada uno.

**macOS** (Apple Silicon o Intel), en una terminal:

```bash
curl -fL "https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-$(uname -m | sed s/x86_64/x64/).dmg" -o /tmp/AgentHub.dmg && open /tmp/AgentHub.dmg
```

Arrastrá **Agent Hub** a Aplicaciones. Al abrirla por primera vez macOS la bloquea por no estar notarizada: en **Ajustes del Sistema → Privacidad y seguridad**, bajá hasta el aviso y elegí **Abrir de todos modos** ([instrucciones de Apple](https://support.apple.com/es-es/102445)). La app vive en la barra de menú, no en el Dock.

**Windows**, en PowerShell:

```powershell
irm https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-Setup-x64.exe -OutFile "$env:TEMP\AgentHub-Setup.exe"; & "$env:TEMP\AgentHub-Setup.exe"
```

El instalador no pide permisos de administrador y deja la app en el menú Inicio. En equipos ARM reemplazá `x64` por `arm64`. Si Windows muestra el aviso de SmartScreen por tratarse de un ejecutable sin firma, elegí **Más información → Ejecutar de todas formas**.

**Linux**, en una terminal:

```bash
curl -fL "https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-$(uname -m | sed 's/aarch64/arm64/').AppImage" -o ~/AgentHub.AppImage && chmod +x ~/AgentHub.AppImage && ~/AgentHub.AppImage
```

Es la versión portable, sin instalar nada. Para Debian y Ubuntu hay `.deb` (`AgentHub-amd64.deb` y `AgentHub-arm64.deb`) que se instalan con `sudo apt install ./AgentHub-amd64.deb`. El ícono queda en la bandeja del sistema.

**Primer arranque.** La app deja un catálogo inicial de MCP servers públicos listos para «Conectar cuenta», detecta los clientes instalados (Claude Code, Codex CLI, Gemini CLI, Kiro, OpenCode, Antigravity y Claude Desktop) y escribe en cada uno una única entrada `hub`. No hace falta cuenta ni otro equipo.

**Actualizaciones automáticas y silenciosas.** La app revisa las releases de GitHub al arrancar y cada seis horas. En macOS, Windows con instalador y Linux AppImage descarga, instala y reinicia en segundo plano, sin avisos, confirmaciones ni ventanas al terminar. En Windows espera automáticamente mientras haya conexiones MCP activas que NSIS cerraría y vuelve a intentar cada 30 segundos. Las descargas interrumpidas con SHA-256 publicado se reanudan con HTTP Range; los errores se registran y reintentan con backoff. El zip portable de Windows, el `.deb` y las instalaciones sin permisos de escritura siguen requiriendo instalación externa; no generan avisos. `AGENTHUB_NO_AUTO_UPDATE=1` desactiva el proceso.

**Actualizar a mano y desinstalar.** Instalá la versión nueva encima; los datos quedan. Para desinstalar, borrá la app y su directorio de estado: `~/Library/Application Support/Agent Hub` en macOS, `%APPDATA%\Agent Hub` en Windows y `~/.config/Agent Hub` en Linux. La entrada `hub` de cada cliente se puede quitar a mano de su configuración.
