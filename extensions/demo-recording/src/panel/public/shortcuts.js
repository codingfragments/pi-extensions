// The shortcuts the panel has, as data (no browser code), so the "?" sheet and a test read the same list.
/** The shortcuts that exist. Keep this list true: a test reads it against the places that handle the keys. */
export const SHORTCUTS = [
  ["?", "Show this list"],
  ["Tab · Shift+Tab", "Move between controls (a list is one stop)"],
  ["↑ ↓ · Home · End", "Move between the items of a list; Enter opens the one in focus"],
  ["Esc", "Close the top layer: a dialog, the Versions list, the Map, or clear a search"],
  ["/ · Ctrl/Cmd+K", "Search the settings (in Config)"],
  ["Arrow keys in the Map", "Walk the graph from node to node; Enter selects"],
  ["+ · − · 0 in the Map", "Zoom in, zoom out, fit the whole graph in the window"],
];
