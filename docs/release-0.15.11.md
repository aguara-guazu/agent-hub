# Agent Hub 0.15.11

Esta versión corrige los tres problemas de Windows del [reporte #23](https://github.com/aguara-guazu/agent-hub/issues/23).

- Cuando una actualización espera conexiones MCP, el Hub conserva el instalador y comprueba los procesos conocidos sin abrir PowerShell en cada reintento. Los reintentos se espacian desde 15 segundos hasta 15 minutos. Si una versión anterior sigue esperando, cerrá por completo Claude Desktop, Claude Code y los demás clientes conectados. Podés volver a abrirlos cuando el Hub termine de actualizarse.
- Los hooks de Claude Code esperan a que termine el proceso de Agent Hub y devuelven su código de salida. El hook de avisos deja de consultar al Hub cuando se cierra la sesión que lo inició.
- El diagnóstico y el selector de proveedores de extracción reconocen Claude Code instalado con npm cuando el paquete incluye el ejecutable de Windows.
