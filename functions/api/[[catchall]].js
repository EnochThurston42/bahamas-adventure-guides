const WORKER_URL = 'https://bahamas-chat-worker.117shadowwalker117.workers.dev';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const proxyUrl = WORKER_URL + url.pathname + url.search;

  const proxyRequest = new Request(proxyUrl, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer(),
  });

  return fetch(proxyRequest);
}
