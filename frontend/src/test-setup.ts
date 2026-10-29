// jsdom informa navigator.languages = ["en-US", "en"]; las pruebas existentes esperan los textos en español.
// Debe correr antes de que i18n/index.ts lea la preferencia guardada.
localStorage.setItem("agenthub.language", "es")
