# Agent Hub 0.5.0

Esta versión reduce el trabajo manual al asociar fuentes y configurar proyectos.

- **Proyectos sugeridos:** el selector de reuniones y documentos combina nombres de proyectos y empresas con búsqueda semántica local. Preselecciona coincidencias claras y permite buscar entre todos los proyectos. Las elecciones manuales se conservan.
- **Empresas con contexto:** «Asociar empresa → Crear empresa» prepara un nombre y una descripción editables usando el modelo configurado. Prioriza las reuniones iniciales de assessment y venta, muestra la evidencia y guarda sólo al confirmar.
- **Descripción de proyectos:** el editor permite generar y revisar un borrador basado en las fuentes actuales del proyecto, con citas y cobertura del análisis.
- **Jira predeterminado:** en Ajustes se puede guardar el sitio Jira Cloud común. Cada proyecto hereda ese sitio y sólo necesita su clave, o puede configurar otro sitio propio. La sincronización y el espejo de tickets respetan esa elección.

Los borradores respetan las restricciones de procesamiento remoto. Si la búsqueda semántica no está disponible, el selector conserva las coincidencias por nombre. Se validan conflictos entre claves y sitios de Jira para evitar asociaciones ambiguas.

Verificado con pruebas de backend, interfaz, PostgreSQL y procesos completos, además de una prueba del modelo real con datos sintéticos y comprobaciones en la app instalada.
