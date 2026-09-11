const {app,BrowserWindow}=require('electron')
const fs=require('node:fs')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1024,height:1024,show:false,frame:false,transparent:true,webPreferences:{sandbox:true}})
 await win.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;background:transparent}</style>'+fs.readFileSync('desktop/assets/icon.svg','utf8')))
 fs.writeFileSync('desktop/assets/icon.png',(await win.webContents.capturePage()).toPNG())
 win.destroy();app.quit()
})
