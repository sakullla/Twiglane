export const BRAND = {
  name: "Twiglane",
  zh: "枝序",
  full: "Twiglane（枝序）",
  tagline: "让每次改动，都清晰有序。",
} as const;

const platform = typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
export const MODIFIER_LABEL = /Mac|iPhone|iPad/.test(platform) ? "⌘" : "Ctrl";
