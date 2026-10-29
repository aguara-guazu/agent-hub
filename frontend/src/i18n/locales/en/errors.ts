import type es from "../es/errors"
import type { Messages } from "../../types"

const errors = {
  network: "Couldn’t connect to Agent Hub. Check that the app is still open.",
  timeout: "Agent Hub took too long to respond. Try again.",
  unauthorized: "Your session expired. Close and reopen Agent Hub.",
  forbidden: "You don’t have permission to do this. Ask the project admin for access.",
  notFound: "It no longer exists. It may have been deleted from another client.",
  conflict: "It changed while you were editing. Reload and apply your change again.",
  tooLarge: "The file is over the size limit. Try a smaller one.",
  server: "Something failed in Agent Hub. Try again; if it keeps failing, check Activity.",
  unknown: "Something went wrong. Try again.",
  loadFailed: "Couldn’t load. Try again.",
  saveFailed: "Change not saved. Try again.",
  field: {
    required: "Fill in this field.",
    invalidUrl: "Enter a URL that starts with http:// or https://.",
    invalidEmail: "Enter a valid email.",
    tooLong: "Use {{max}} characters at most.",
    duplicate: "One with that name already exists. Choose another.",
  },
} satisfies Messages<typeof es>

export default errors
