// Salesforce reads for the command center (same client-credentials flow as ../../donations.mjs on the main site).
// SF_DOMAIN, SF_CLIENT_ID and SF_CLIENT_SECRET are Worker secrets, never stored in files.
export async function salesforceToken(env) {
  const response = await fetch(env.SF_DOMAIN.replace(/\/$/, '') + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SF_CLIENT_ID, client_secret: env.SF_CLIENT_SECRET })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('sf_auth_' + (data.error || response.status));
  return data;
}

async function sf(auth, method, path, body) {
  const response = await fetch(auth.instance_url + '/services/data/v62.0' + path, {
    method, headers: { Authorization: 'Bearer ' + auth.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error('sf_' + response.status + ' ' + JSON.stringify(data).slice(0, 300));
  return data;
}
export const soql = (auth, q) => sf(auth, 'GET', '/query?q=' + encodeURIComponent(q));
export const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
