# Versionado

El número de versión sigue `MAYOR.MEDIO.MENOR` y se sube en todos los paquetes a la vez (`package.json` de la raíz, `desktop`, `frontend`, `testdata` y `packages/*`, más `package-lock.json`).

| Nivel | Formato | Cuándo |
|---|---|---|
| Mayor | `1.xx.xx` | Cambios extremadamente grandes o reescrituras completas. |
| Medio | `x.14.xx` | Features nuevas, gran cantidad de cambios consolidados o cambios visuales muy grandes, como rediseños. |
| Menor | `x.xx.1` | Fixes de features, fixes gráficos, correcciones de secciones o de localización, y correcciones o actualizaciones de skills o features. |

Ante la duda entre dos niveles se elige el menor. Subir un nivel medio o mayor lo decide la persona, no el agente.
