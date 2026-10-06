// The toolbar button opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('[gscdump] could not set the side panel behavior', error)
})
