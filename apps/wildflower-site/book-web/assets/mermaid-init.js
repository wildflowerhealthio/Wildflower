// Draws each ```mermaid block with the mermaid vendored beside this script,
// in mermaid's dark theme unless the reader picked one of mdbook's light ones.
;(() => {
  const blocks = document.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return
  for (const code of blocks) {
    const diagram = document.createElement('pre')
    diagram.className = 'mermaid'
    diagram.textContent = code.textContent
    code.parentElement.replaceWith(diagram)
  }
  const classes = document.documentElement.classList
  // `mermaid` is the global vendor/mermaid.min.js defines.
  const light = classes.contains('light') || classes.contains('rust')
  mermaid.initialize({ startOnLoad: false, theme: light ? 'default' : 'dark' })
  void mermaid.run()
})()
