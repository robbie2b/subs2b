// Cloudflare Worker: relays requests from the addon to api.subs.ro
// (Render's IP is challenged by Cloudflare; Worker traffic normally is not).
// Secrets to set on the Worker: RELAY_TOKEN (any long random string).
export default {
  async fetch(request, env) {
    if (!env.RELAY_TOKEN || request.headers.get('X-Relay-Token') !== env.RELAY_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1.0/')) {
      return new Response('Not found', { status: 404 });
    }

    const upstream = await fetch('https://api.subs.ro' + url.pathname + url.search, {
      headers: {
        'X-Subs-Api-Key': request.headers.get('X-Subs-Api-Key') || '',
        'User-Agent': request.headers.get('User-Agent') || 'Subs.ro API Test Script',
        'Accept': request.headers.get('Accept') || '*/*',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8'
      }
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'X-Upstream-Status': String(upstream.status),
        'X-Upstream-Mitigated': upstream.headers.get('cf-mitigated') || ''
      }
    });
  }
};
