import { contextBridge, ipcRenderer } from "electron"
import { RECORDER_IPC, type RecorderBridge, type RecorderCommand } from "./recorder-ipc.js"

const bridge: RecorderBridge = {
  ready: () => ipcRenderer.send(RECORDER_IPC.ready),
  onCommand: listener => {
    ipcRenderer.on(RECORDER_IPC.command, (_event, command: unknown) => {
      if (command === "start" || command === "stop") listener(command as RecorderCommand)
    })
  },
  trackStarted: (track, epochMs) => ipcRenderer.send(RECORDER_IPC.trackStarted, track, epochMs),
  trackFailed: (track, message) => ipcRenderer.send(RECORDER_IPC.trackFailed, track, message),
  chunk: (track, data) => ipcRenderer.send(RECORDER_IPC.chunk, track, data),
  levels: levels => ipcRenderer.send(RECORDER_IPC.levels, levels),
  stopped: () => ipcRenderer.send(RECORDER_IPC.stopped),
}

contextBridge.exposeInMainWorld("recorderBridge", bridge)
