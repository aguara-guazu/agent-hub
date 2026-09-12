# Iconos de Agent Hub

`icon.svg` es la fuente vectorial. `icon.ico` (Windows) se generó a partir del PNG con entradas PNG de 256, 64, 32 y 16 px. `icon.png` se usa en la bandeja y en Linux; `icon.icns` es el icono del bundle de macOS. La bandeja carga el PNG y lo reduce a 22 px porque Electron no decodifica ICNS mediante `nativeImage.createFromPath`.
