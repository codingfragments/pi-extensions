// The shortcuts the panel has, as data (no browser code), so the "?" sheet and a test read the same list.
/** The shortcuts that exist. Keep this list true: a test reads it against the places that handle the keys. */
export const SHORTCUTS = [
  ["?", "Show this list"],
  ["Tab · Shift+Tab", "Move between controls (a list is one stop)"],
  ["↑ ↓ · Home · End", "Move between the items of a list; Enter opens the one in focus"],
  [
    "[ · ]",
    "Previous / next chapter in the recording review, previous / next annotation in Annotations",
  ],
  ["< · >", "Previous / next finding of the take in the recording review"],
  ["← · →", "Back / forward 10 seconds in the recording (Shift: 1 second)"],
  ["N · +", "Add a note at the current moment of the recording"],
  ["Esc", "Close the top layer: a dialog, the Versions list, the Map, or clear a search"],
  ["/ · Ctrl/Cmd+K", "Search the settings (in Config)"],
  ["Arrow keys in the Map", "Walk the graph from node to node; Enter selects"],
  ["+ · − · 0 in the Map", "Zoom in, zoom out, fit the whole graph in the window"],
  [
    "Mouse in the Map",
    "Wheel zooms at the pointer (Shift + wheel scrolls); drag the background to pan",
  ],
  [
    "Trackpad in the Map",
    "Pinch zooms at the pointer; two fingers pan (Wheel: Auto / Zooms / Scrolls at the bottom)",
  ],
];
