import type es from "../es/common"
import type { Messages } from "../../types"

const common = {
  app: {
    name: "Agent Hub",
  },
  actions: {
    add: "Add",
    back: "Back",
    cancel: "Cancel",
    close: "Close",
    confirm: "Confirm",
    copy: "Copy",
    create: "Create",
    createNamed: "Create “{{name}}”",
    delete: "Delete",
    discard: "Discard",
    edit: "Edit",
    pause: "Pause",
    resume: "Resume",
    retry: "Try again",
    runNow: "Run now",
    saveChanges: "Save changes",
    search: "Search",
    undo: "Undo",
    clearFilters: "Clear filters",
    showMore: "Show more",
    viewAll_one: "View {{count}}",
    viewAll_other: "View all {{count, number}}",
  },
  a11y: {
    moreActions: "More actions",
    closePanel: "Close panel",
    removeFilter: "Remove filter {{name}}",
    openMenu: "Open menu",
  },
  states: {
    loading: "Loading…",
    saving: "Saving…",
    saved: "Changes saved",
    autosave: "Changes save automatically",
    unsaved: "Unsaved changes",
    on: "On",
    off: "Off",
  },
  empty: {
    noResults: "No results",
    noResultsHint: "Try another search or clear the filters.",
  },
  error: {
    title: "Couldn’t load",
    hint: "Check that Agent Hub is still open and try again.",
  },
  confirm: {
    deleteTitle: "Delete “{{name}}”?",
    irreversible: "This can’t be undone.",
  },
  toast: {
    deleted: "Deleted “{{name}}”",
    paused: "Paused “{{name}}”",
    resumed: "Resumed “{{name}}”",
    copied: "Copied",
    saveFailed: "Change not saved",
  },
  count: {
    items_one: "{{count, number}} item",
    items_other: "{{count, number}} items",
  },
  language: {
    label: "Language",
    auto: "Automatic",
    es: "Español",
    en: "English",
  },
} satisfies Messages<typeof es>

export default common
