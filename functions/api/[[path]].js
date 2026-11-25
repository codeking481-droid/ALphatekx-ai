const API_ORIGIN = 'https://129.213.161.206.sslip.io'

export async function onRequest({ request }) {
  const incomingUrl = new URL(request.url)
  const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, API_ORIGIN)
  const proxyRequest = new Request(upstreamUrl, request)
  const headers = new Headers(proxyRequest.headers)
  headers.delete('host')

  return fetch(new Request(proxyRequest, {
    headers,
    redirect: 'manual',
  }))
}
