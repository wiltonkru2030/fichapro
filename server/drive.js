import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const scope = 'https://www.googleapis.com/auth/drive.file';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const filesUrl = 'https://www.googleapis.com/drive/v3/files';
const folderType = 'application/vnd.google-apps.folder';
const error = (message, status = 502) => Object.assign(new Error(message), { status });

// A credencial do salão é criptografada no servidor. A chave fica fora do banco.
export function createDrive({ origin, env = process.env, request = fetch }) {
  const client = env.GOOGLE_CLIENT_ID;
  const secret = env.GOOGLE_CLIENT_SECRET;
  const key = Buffer.from(env.DRIVE_ENCRYPTION_KEY || '', 'base64');
  const redirect = new URL('/api/drive/callback', origin).href;
  const configured = Boolean(client && secret && key.length === 32);

  async function call(url, options = {}) {
    let response;
    try {
      response = await request(url, { ...options, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw error('O Google Drive não respondeu. Tente novamente.');
    }
    if (!response.ok) throw error('O Google recusou a operação. Confira a conexão e o espaço disponível no Drive.');
    return response;
  }

  async function token(fields) {
    const response = await call(tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: client, client_secret: secret })
    });
    return response.json();
  }

  function seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  function unseal(value) {
    const data = Buffer.from(value, typeof value === 'string' ? 'hex' : undefined);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }

  async function access(connection) {
    if (!configured) throw error('A integração com o Google Drive está indisponível.', 503);
    let refresh;
    try { refresh = unseal(connection.refresh); }
    catch { throw error('A credencial do Drive não pôde ser aberta. Confira a chave de criptografia.'); }
    const result = await token({ grant_type: 'refresh_token', refresh_token: refresh });
    if (!result.access_token) throw error('Reconecte a conta do Google Drive.');
    return result.access_token;
  }

  async function folder(bearer, name, parent) {
    const response = await call(filesUrl + '?fields=id', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: folderType, ...(parent ? { parents: [parent] } : {}) })
    });
    return (await response.json()).id;
  }

  async function upload(bearer, parent, file) {
    const boundary = randomBytes(24).toString('hex');
    const metadata = JSON.stringify({ name: file.name, parents: [parent], mimeType: file.type });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`),
      file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'multipart/related; boundary=' + boundary }, body
    });
    return (await response.json()).id;
  }

  async function trash(bearer, id) {
    await call(filesUrl + '/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  }

  return {
    configured,
    authorization(state, challenge) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code',
        scope, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: challenge, code_challenge_method: 'S256' });
      return url.href;
    },
    async connect(code, verifier, findExisting) {
      const result = await token({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
      if (!result.access_token || !result.refresh_token) throw error('O Google não concedeu acesso permanente. Inicie a conexão novamente.');
      const response = await call('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)', {
        headers: { Authorization: 'Bearer ' + result.access_token }
      });
      const account = (await response.json()).user?.permissionId;
      if (!account) throw error('Não foi possível identificar a conta do Drive.');
      return { account, root: (await findExisting(account))?.root || await folder(result.access_token, 'FichaPro'), refresh: seal(result.refresh_token) };
    },
    async store(connection, name, files) {
      const bearer = await access(connection);
      const parent = await folder(bearer, name, connection.root);
      const ids = [];
      try {
        for (const file of files) ids.push(await upload(bearer, parent, file));
      } catch (failure) {
        await trash(bearer, parent).catch(() => {});
        throw failure;
      }
      return { ids, discard: () => trash(bearer, parent) };
    },
    async download(connection, id) {
      const bearer = await access(connection);
      const response = await call(filesUrl + '/' + encodeURIComponent(id) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + bearer }
      });
      return Buffer.from(await response.arrayBuffer());
    }
  };
}
