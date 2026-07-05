const WORKER_URL = 'https://bahamas-chat-worker.117shadowwalker117.workers.dev';

export async function onRequest(context) {
  const { request } = context;
  const proxyUrl = WORKER_URL + '/dashboard';
  return fetch(new Request(proxyUrl, {
    method: request.method,
    headers: request.headers
  }));
}
