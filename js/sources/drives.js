import { MAX_BYTES } from '../parser/formats.js';

async function api(url, init, signal) {
  const res = await fetch(url, { ...init, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (res.status === 401) throw Object.assign(new Error('session expired, sign in again'), { auth: true });
  if (res.status === 404) throw new Error('file not found at that path');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
async function boundedText(res) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('remote file larger than 8 MB');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('remote file larger than 8 MB');
  return text;
}
const bearer = (t) => ({ Authorization: `Bearer ${t.access}` });
export const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const encodePath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

/** Reader contract: (path, validators, signal, token) -> {notModified:true} | {text, etag}. Revision ids are the validators. */
export const READERS = {
  async dropbox(path, v, signal, token) {
    const meta = await (await api('https://api.dropboxapi.com/2/files/get_metadata', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }, signal)).json();
    if (meta.rev && meta.rev === v?.etag) return { notModified: true };
    const res = await api('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { ...bearer(token), 'Dropbox-API-Arg': asciiJson({ path }) } }, signal);
    return { text: await boundedText(res), etag: meta.rev };
  },
  async onedrive(path, v, signal, token) {
    const base = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodePath(path)}`;
    const meta = await (await api(`${base}?select=eTag`, { headers: bearer(token) }, signal)).json();
    if (meta.eTag && meta.eTag === v?.etag) return { notModified: true };
    return { text: await boundedText(await api(`${base}:/content`, { headers: bearer(token) }, signal)), etag: meta.eTag };
  },
  /** path is a file name, or "id:<fileId>". Native Google Docs are exported as text/plain. */
  async google(path, v, signal, token) {
    const fields = encodeURIComponent('id,md5Checksum,modifiedTime,mimeType');
    let meta;
    if (path.startsWith('id:')) meta = await (await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(path.slice(3))}?fields=${fields}`, { headers: bearer(token) }, signal)).json();
    else {
      const q = encodeURIComponent(`name='${path.replace(/['\\]/g, '\\$&')}' and trashed=false`);
      const list = await (await api(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1&orderBy=${encodeURIComponent('modifiedTime desc')}&fields=${encodeURIComponent('files(id,md5Checksum,modifiedTime,mimeType)')}`, { headers: bearer(token) }, signal)).json();
      meta = list.files?.[0];
      if (!meta) throw new Error(`no file named "${path}" in Drive`);
    }
    const etag = meta.md5Checksum ?? meta.modifiedTime;
    if (etag === v?.etag) return { notModified: true };
    const native = meta.mimeType?.startsWith('application/vnd.google-apps');
    const url = native ? `https://www.googleapis.com/drive/v3/files/${meta.id}/export?mimeType=text%2Fplain` : `https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media`;
    return { text: await boundedText(await api(url, { headers: bearer(token) }, signal)), etag };
  },
  /**
   * Box has no simple path-based lookup like Dropbox/OneDrive (you'd otherwise have to walk folders by
   * id), so this only accepts "id:<fileId>" — find the id from the file's "Copy link" / API in the Box
   * web UI. UNTESTED: whether api.box.com and the file content host (dl.boxcloud.com, reached via the
   * redirect from /content) send CORS headers for a browser-only app has not been confirmed here.
   */
  async box(path, v, signal, token) {
    if (!path.startsWith('id:')) throw new Error('Box needs a file id: use "id:<fileId>" (from the file\'s Box API info)');
    const fileId = encodeURIComponent(path.slice(3));
    const meta = await (await api(`https://api.box.com/2.0/files/${fileId}?fields=etag,name,size`, { headers: bearer(token) }, signal)).json();
    if (meta.etag && meta.etag === v?.etag) return { notModified: true };
    const res = await api(`https://api.box.com/2.0/files/${fileId}/content`, { headers: bearer(token) }, signal);
    return { text: await boundedText(res), etag: meta.etag };
  },
  async pcloud(path, v, signal, token) {
    const host = token.locationid === 2 ? 'eapi.pcloud.com' : 'api.pcloud.com', q = encodeURIComponent(path);
    const call = async (method) => {
      const data = await (await api(`https://${host}/${method}?path=${q}`, { headers: bearer(token) }, signal)).json();
      if (data.result !== 0) throw new Error(data.error || `pCloud error ${data.result}`);
      return data;
    };
    const etag = String((await call('stat')).metadata.hash);
    if (etag === v?.etag) return { notModified: true };
    const link = await call('getfilelink');
    return { text: await boundedText(await api(`https://${link.hosts[0]}${link.path}`, {}, signal)), etag };
  },
};
