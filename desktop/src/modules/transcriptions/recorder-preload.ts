import { contextBridge, ipcRenderer } from "electron"
import { RECORDER_IPC, type RecorderBridge, type RecorderCommand } from "./recorder-ipc.js"

const bridge: RecorderBridge = {
  regionDone: () => ipcRenderer.send(RECORDER_IPC.regionDone),
  tabLevel: level => ipcRenderer.send(RECORDER_IPC.tabLevel, level),
  visualFailed: () => ipcRenderer.send(RECORDER_IPC.visualFailed),
  linuxMonitor: process.platform === "linux",
  startMonitor: () => ipcRenderer.send(RECORDER_IPC.startMonitor),
  stopMonitor: () => ipcRenderer.send(RECORDER_IPC.stopMonitor),
  onMonitor: listener => {
    const receive = (_event: Electron.IpcRendererEvent, bytes: Uint8Array | null) => listener(bytes)
    ipcRenderer.on(RECORDER_IPC.monitor, receive)
    return () => { ipcRenderer.removeListener(RECORDER_IPC.monitor, receive) }
  },
  speakerFrame: (at, tile, image) => ipcRenderer.invoke(RECORDER_IPC.speakerFrame, at, tile, image),
  speakerStill: () => ipcRenderer.invoke(RECORDER_IPC.speakerStill),
  ready: () => ipcRenderer.send(RECORDER_IPC.ready),
  onCommand: listener => {
    ipcRenderer.on(RECORDER_IPC.command, (_event, command: unknown) => {
      if (command === "start" || command === "stop" || command === "stop-window" || command === "start-tab") listener(command as RecorderCommand)
    })
  },
  trackStarted: (track, epochMs) => ipcRenderer.send(RECORDER_IPC.trackStarted, track, epochMs),
  trackFailed: (track, message) => ipcRenderer.send(RECORDER_IPC.trackFailed, track, message),
  chunk: (track, data) => ipcRenderer.send(RECORDER_IPC.chunk, track, data),
  levels: levels => ipcRenderer.send(RECORDER_IPC.levels, levels),
  stopped: () => ipcRenderer.send(RECORDER_IPC.stopped),
}

contextBridge.exposeInMainWorld("recorderBridge", bridge)
