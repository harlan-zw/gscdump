// A client-side router: links change the History API, as an SPA framework does.
const app = document.querySelector('#app')!

function render(): void {
  document.title = location.pathname === '/' ? 'Home' : location.pathname
  app.textContent = `Page: ${location.pathname}`
}

document.addEventListener('click', (event) => {
  const link = (event.target as Element).closest('a')
  if (!link || link.origin !== location.origin)
    return
  event.preventDefault()
  history.pushState(null, '', link.pathname)
  render()
})
addEventListener('popstate', render)
render()
