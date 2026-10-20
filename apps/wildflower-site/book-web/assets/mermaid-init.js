// Draws each ```mermaid block with the mermaid vendored into the book's
// `vendor/`, in mermaid's dark theme unless the reader picked one of mdbook's
// light ones. Mermaid is loaded only on a page that has a diagram: it is
// megabytes, and most pages have none.
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
  const light = classes.contains('light') || classes.contains('rust')
  const script = document.createElement('script')
  // `path_to_root` is the page's own, which mdbook defines on every page.
  script.src = `${path_to_root}vendor/mermaid.min.js`
  script.addEventListener('load', () => {
    // `mermaid` is the global vendor/mermaid.min.js defines.
    mermaid.initialize({ startOnLoad: false, theme: light ? 'default' : 'dark' })
    void mermaid.run()
  })
  document.head.append(script)
})()
