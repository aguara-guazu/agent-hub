/** Pedidos de lectura entre proyectos que la persona confirma con una frase. */
const access = {
  list: "Pedidos de lectura",
  row: {
    title: "{{agent}} pide ver «{{target}}»",
    elevated: "Elevado por {{leader}}",
  },
  pending: "Espera tu confirmación",
  field: {
    label: "Frase de confirmación",
    hint: "Escribila vos. El acceso es de solo lectura y termina en 8 h o cuando el agente termine su tarea.",
  },
  example: {
    withProject: "confirmo que el agente {{agent}} del proyecto {{source}} puede ver los canales del proyecto {{target}}",
    withoutProject: "confirmo que el agente {{agent}} puede ver los canales del proyecto {{target}}",
  },
  actions: {
    grant: "Otorgar acceso",
    reject: "Rechazar pedido",
  },
  toast: {
    granted: "Acceso otorgado a {{agent}}",
    rejected: "Pedido rechazado",
  },
  empty: "No hay pedidos de lectura",
  errors: {
    phrase_structure: "Escribí la frase con la forma del ejemplo.",
    phrase_target: "La frase tiene que nombrar el proyecto «{{target}}» tal como figura.",
    phrase_requester: "La frase tiene que nombrar al agente {{agent}} o a su proyecto.",
    request_not_pending: "Este pedido ya se resolvió. Actualizá la lista.",
    requester_inactive: "El agente ya no está conectado; el pedido no se puede otorgar.",
  },
}

export default access
