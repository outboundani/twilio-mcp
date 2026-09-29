// Twilio REST client - zero dependencies, plain fetch + HTTP Basic auth with
// an API Key SID/secret. Three hosts, all pinned (see rules.js HOSTS):
//   api.twilio.com         2010-04-01 core API (account, phone numbers)
//   studio.twilio.com      Studio v2 (flows, validate)
//   taskrouter.twilio.com  TaskRouter v1 (workspaces, queues, workflows)
//
// Every non-GET request passes the WRITE allowlist in rules.js, typed tools
// included, and DELETE is refused outright. This client cannot place a call,
// send a message, change a phone number, or start a Studio Execution.

import { HOSTS, isAllowedWrite } from './rules.js';

export class TwilioError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'TwilioError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function formBody(params) {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => f.append(k, String(x)));
    else f.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return f;
}

export class TwilioClient {
  constructor({ accountSid, apiKeySid, apiKeySecret }) {
    this.accountSid = accountSid;
    this.auth = `Basic ${btoa(`${apiKeySid}:${apiKeySecret}`)}`;
  }

  // Core request. `hostKey` is api|studio|taskrouter; `path` is relative
  // ("v2/Flows", "2010-04-01/Accounts/AC.../IncomingPhoneNumbers.json").
  // Retries twice on 429 (Twilio sends Retry-After on some products only).
  async request(hostKey, method, path, { form, query, _attempt = 0, _url } = {}) {
    const m = String(method).toUpperCase();
    if (!HOSTS[hostKey]) throw new TwilioError(`Refused: unknown host "${hostKey}".`, 400);
    if (m === 'DELETE') throw new TwilioError('Refused: this server ships no deletes.', 403);
    if (m !== 'GET' && m !== 'POST') throw new TwilioError(`Refused: method ${m} is not used by this server.`, 403);
    const rel = String(path).replace(/^\/+/, '');
    if (m === 'POST' && !isAllowedWrite(hostKey, m, rel)) {
      throw new TwilioError(`Refused: POST ${HOSTS[hostKey]}/${rel} is outside this server's write allowlist.`, 403);
    }
    let url;
    if (_url) {
      url = _url;
    } else {
      const expected = `/${rel}`;
      url = new URL(`https://${HOSTS[hostKey]}${expected}`);
      // Defense in depth: if URL parsing rewrote the path (dot segments, a
      // stray ? or #), the request would land somewhere other than what
      // the caller checked. Refuse instead of sending it.
      if (url.pathname !== expected || url.search || url.hash || url.host !== HOSTS[hostKey]) {
        throw new TwilioError(`Refused: the path "${rel}" does not survive URL parsing unchanged.`, 400);
      }
      for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = { Authorization: this.auth, Accept: 'application/json' };
    let body;
    if (m === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody(form).toString();
    }
    const res = await fetch(url, { method: m, headers, body });
    if (res.status === 429 && _attempt < 2) {
      const ra = Number(res.headers.get('Retry-After'));
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : (_attempt === 0 ? 1500 : 5000)));
      return this.request(hostKey, m, path, { form, query, _attempt: _attempt + 1, _url });
    }
    if (res.status === 204) return { ok: true };
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : { ok: true }; } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = data.message || data.detail || `HTTP ${res.status}`;
      const more = data.more_info ? ` (${data.more_info})` : '';
      const code = data.code ? ` [${data.code}]` : '';
      throw new TwilioError(`${m} ${HOSTS[hostKey]}/${rel} failed${code}: ${msg}${more}`, res.status, data.code, data.details);
    }
    return data;
  }

  get(hostKey, path, query) { return this.request(hostKey, 'GET', path, { query }); }
  post(hostKey, path, form) { return this.request(hostKey, 'POST', path, { form }); }

  // Core API path under this account.
  acct(sub = '') { return `2010-04-01/Accounts/${this.accountSid}${sub}`; }

  // Collect paged results. v1/v2 APIs page via meta.next_page_url (absolute);
  // the 2010 API via next_page_uri (relative). Next-page links are followed
  // only when they stay on the same pinned host. Caps at `max`.
  async listAll(hostKey, path, key, query = {}, { max = 500 } = {}) {
    const out = [];
    let page = await this.get(hostKey, path, { PageSize: Math.min(max, 200), ...query });
    for (;;) {
      out.push(...(page[key] || []));
      const next = page.meta?.next_page_url || (page.next_page_uri ? `https://${HOSTS[hostKey]}${page.next_page_uri}` : null);
      if (!next || out.length >= max) break;
      const u = new URL(next);
      if (u.host !== HOSTS[hostKey] || u.protocol !== 'https:') break;
      page = await this.request(hostKey, 'GET', u.pathname, { _url: u });
    }
    return { entities: out.slice(0, max), truncated: out.length > max };
  }
}
