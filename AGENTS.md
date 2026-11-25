# Trabajar en Agent Hub

Cada función de producto pertenece a un módulo. Antes de modificarla, identificá su declaración en `packages/shared/src/modules` y abrí su carpeta en `frontend/src/modules`. El punto de entrada para quienes mantienen la app es [Desarrollo por módulos](docs/modulos.md).

Implementá la funcionalidad, sus ajustes y sus pruebas en el módulo responsable. Cuando intervengan dos módulos, declarales la dependencia a las operaciones que usan ambos. El arranque del Hub, la sesión local y el acceso a Ajustes deben funcionar con todos los módulos apagados.

Al verificar una modificación, probá la función encendida, apagada y nuevamente encendida. Incluí las entradas que realmente la ejecutan y al menos una operación de otro módulo que deba seguir disponible.
