// Every request from the installed CLI stays inside this fixture.
globalThis.fetch = async (request, options = {}) => {
  const url = new URL(String(request))
  if (url.hostname !== 'searchconsole.googleapis.com')
    throw new Error(`Unexpected request host: ${url.hostname}`)
  if (url.pathname.endsWith('/sites')) {
    return Response.json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
  }
  if (url.pathname.endsWith('/searchAnalytics/query')) {
    const body = JSON.parse(options.body)
    const keys = body.dimensions.map(dimension => dimension === 'page' ? 'https://example.com/guide' : body.startDate)
    return Response.json({ rows: body.startRow > 0 ? [] : [{ keys, clicks: 5, impressions: 50, position: 3, ctr: 0.1 }] })
  }
  throw new Error(`Unexpected Google request: ${url.pathname}`)
}
