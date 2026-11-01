// Verifies the Cloudflare Access JWT (same method as ../admin.mjs requireAccess) and returns the signed-in email.
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const b64json = s => JSON.parse(new TextDecoder().decode(b64url(s)));
let cache = { team: '', at: 0, keys: new Map() };

async function signingKey(team, kid) {
  const fresh = cache.team === team && Date.now() - cache.at < 3600e3;
  if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
  if (fresh && Date.now() - cache.at < 30e3) return null;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error('access_certs_' + response.status);
  const keys = new Map();
  for (const jwk of (await response.json()).keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cache = { team, at: Date.now(), keys };
  return keys.get(kid) || null;
}

// Returns { email } or null. HUB_DEV=1 on localhost trusts the x-dev-email header (never set in Cloudflare).
export async function signedInEmail(request, env, url) {
  if (env.HUB_DEV === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return (request.headers.get('x-dev-email') || '').toLowerCase() || null;
  }
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const [head, payload, signature] = token.split('.');
    if (!signature) return null;
    const header = b64json(head), claims = b64json(payload);
    if (header.alg !== 'RS256') return null;
    const key = await signingKey(team, header.kid);
    if (!key) return null;
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(signature), new TextEncoder().encode(head + '.' + payload))) return null;
    const now = Date.now() / 1000;
    if (!(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return null;
    return claims.email ? String(claims.email).toLowerCase() : null;
  } catch (error) {
    console.error('hub_access_error', error.message);
    return null;
  }
}
