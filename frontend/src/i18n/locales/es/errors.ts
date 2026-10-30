/** Mensajes de error para la persona: qué pasó y qué hacer (R6). */
const errors = {
  network: "No se pudo conectar con Agent Hub. Revisá que la app siga abierta.",
  timeout: "Agent Hub tardó demasiado en responder. Volvé a intentar.",
  unauthorized: "Tu sesión venció. Cerrá y volvé a abrir Agent Hub.",
  forbidden: "No tenés permiso para hacer esto. Pedile acceso a quien administra el proyecto.",
  notFound: "Ya no existe. Puede que se haya eliminado desde otro cliente.",
  conflict: "Cambió mientras lo editabas. Recargá y volvé a aplicar el cambio.",
  tooLarge: "El archivo supera el tamaño permitido. Probá con uno más chico.",
  server: "Algo falló en Agent Hub. Volvé a intentar; si sigue, revisá Actividad.",
  invalid: "Algún dato no es válido. Revisá los campos y volvé a intentar.",
  rateLimited: "Hubo demasiados intentos seguidos. Esperá un momento y volvé a intentar.",
  unknown: "Algo salió mal. Volvé a intentar.",
  memoryUnavailable: "La memoria no responde. Agent Hub vuelve a intentar abrirla; si sigue, revisá Actividad.",
  desktopOnly: "Esta acción solo está disponible en la app de escritorio.",
  actionFailed: "No se pudo completar la acción. Volvé a intentar.",
  loadFailed: "No se pudo cargar. Volvé a intentar.",
  saveFailed: "No se guardó el cambio. Volvé a intentar.",
  field: {
    required: "Completá este campo.",
    invalidUrl: "Ingresá una URL que empiece con http:// o https://.",
    invalidEmail: "Ingresá un correo válido.",
    tooLong: "Usá {{max}} caracteres como máximo.",
    duplicate: "Ya existe uno con ese nombre. Elegí otro.",
  },
}

export default errors
