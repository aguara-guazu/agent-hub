# Asistencia para proyectos y empresas

Al revisar una reunión o documento sin proyecto, el selector busca coincidencias en todos los proyectos, incluidas sus empresas. Combina nombres con embeddings locales vigentes y preselecciona sólo cuando hay una coincidencia suficientemente clara. Si falta el modelo de embeddings, conserva la búsqueda por nombres. Una elección manual no se reemplaza por respuestas tardías y el vínculo sólo se guarda al confirmar.

En un proyecto, «Asociar empresa» permite elegir una empresa existente o «Crear empresa». Esta última opción genera una vista previa de nombre y descripción con el modelo configurado en Procesamiento y búsqueda. En «Editar», el mismo asistente propone una descripción del proyecto. Ambos borradores se pueden editar y aplicar al formulario antes de guardar.

La generación utiliza una muestra acotada de las fuentes actuales del proyecto: prioriza assessment, venta y reuniones iniciales, incorpora material reciente y conocimiento extraído respaldado por los fragmentos consultados. La vista previa informa la cobertura y enlaza la evidencia. No incluye fuentes ni fragmentos que prohíban el procesamiento remoto cuando el modelo es remoto. No crea empresas ni modifica descripciones automáticamente.

Las operaciones de memoria son `suggest_projects`, `draft_profile` y `save_project_company`. Esta última crea y asocia en una transacción y verifica que el proyecto no haya cambiado mientras se editaba el formulario.

## Sitio de Jira predeterminado

En Ajustes y en Fuentes y ajustes se puede guardar un sitio Jira Cloud predeterminado. Los proyectos sin sitio propio lo heredan dinámicamente: basta configurar su clave de Jira. En Tareas, un sitio propio tiene prioridad; «Usar sitio predeterminado» vuelve a la herencia al guardar. Borrar el valor global elimina el predeterminado sin cambiar las excepciones. La sincronización por token, la cuenta MCP y el espejo de tickets usan el mismo sitio efectivo. Se rechazan cambios que asignarían la misma clave y sitio a dos proyectos.
