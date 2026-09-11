const {app,nativeImage}=require('electron')
const {resolve}=require('node:path')
app.whenReady().then(()=>{for(const ext of ['icns','png']){const icon=nativeImage.createFromPath(resolve('desktop/assets/icon.'+ext));console.log(ext,icon.isEmpty(),icon.getSize())}app.quit()})
