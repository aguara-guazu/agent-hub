import { ipcRenderer } from "electron"

window.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll<HTMLButtonElement>("button[data-decision]").forEach(button => {
    button.addEventListener("click", () => ipcRenderer.send("agenthub:calendar-end-choice", button.dataset.decision))
  })
})
