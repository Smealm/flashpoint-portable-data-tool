import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as https from 'https';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { URL, URLSearchParams } from 'url';
import {
  ensureDir,
  errorMessage,
  isErrno,
  nativePath,
  readJson,
  removeIfExists,
  statOrNull,
  writeJsonAtomic,
} from './io';
import { Logger } from './types';
import {
  CLOUD_FOLDER_NAME,
  CLOUD_MANIFEST_NAME,
  CloudManifestData,
  CloudRemoteFile,
  CloudTransport,
} from './cloud';

/**
 * Google Drive access uses the `drive.appdata` scope only. Files live in the
 * hidden app data folder, which is private to this OAuth client. FPDT cannot
 * see, read, or write any other file in the user's Drive even if it tried.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const NAME_PREFIX = 'fpdt-';
// Inactivity timeout, not a transfer limit: a large upload stays alive while
// bytes keep moving. Kept short so an offline launch is not blocked for long.
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

interface StoredToken {
  refreshToken: string;
  clientId?: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RequestOptions {
  headers?: Record<string, string>;
  body?: Buffer | string;
  stream?: NodeJS.ReadableStream;
  timeoutMs?: number;
}

function httpsDownload(
  url: string,
  headers: Record<string, string>,
  destination: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), { method: 'GET', headers }, response => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
        return;
      }
      pipeline(response, createWriteStream(nativePath(destination)))
        .then(() => resolve({ status, headers: response.headers, body: Buffer.alloc(0) }))
        .catch(reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Google Drive download timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    });
    request.on('error', reject);
    request.end();
  });
}

function httpsRequest(method: string, url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) {
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const request = https.request(new URL(url), { method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on('error', reject);
    });
    request.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Google Drive request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    });
    request.on('error', reject);
    if (options.stream) {
      options.stream.pipe(request);
    } else {
      request.end(options.body ?? undefined);
    }
  });
}

function apiError(response: HttpResponse, action: string): Error {
  let detail = '';
  try {
    const parsed = JSON.parse(response.body.toString('utf8')) as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof parsed.error === 'string') {
      detail = parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    } else {
      detail = parsed.error?.message ?? '';
    }
  } catch {
    detail = response.body.toString('utf8').slice(0, 300);
  }
  return new Error(`Google Drive ${action} failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

/**
 * OAuth token storage. Tokens never go into the portable Flashpoint folder:
 * they are machine-specific secrets and live in `%LOCALAPPDATA%/FPDT`.
 */
export class GoogleTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly credentials: GoogleCredentials,
    private readonly logger: Logger,
  ) {}

  async hasToken(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async read(): Promise<StoredToken | null> {
    const raw = await this.readRaw();
    if (!raw) {
      return null;
    }
    if (raw.clientId && raw.clientId !== this.credentials.clientId) {
      // A token from a different OAuth client cannot refresh here. Keep the
      // file for the old client in case the user switches back.
      this.logger.debug('The stored Google token belongs to a different client ID; reconnect is required.');
      return null;
    }
    return raw;
  }

  async clear(): Promise<void> {
    const token = await this.readRaw();
    if (token?.refreshToken) {
      try {
        const response = await httpsRequest('POST', REVOKE_URL, {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: token.refreshToken }).toString(),
        });
        if (response.status >= 400 && response.status !== 400) {
          this.logger.warn(`Google could not revoke the cloud token (${response.status}); removing it locally.`);
        }
      } catch (error) {
        this.logger.warn(`Could not revoke the Google token online: ${errorMessage(error)}`);
      }
    }
    await removeIfExists(this.filePath);
  }

  async accessToken(): Promise<string> {
    const token = await this.read();
    if (!token) {
      throw new Error('Cloud sync is not connected to Google Drive. Use Connect first.');
    }
    if (token.accessToken && token.expiresAt && token.expiresAt - 60_000 > Date.now()) {
      return token.accessToken;
    }
    return this.refresh(token);
  }

  private async readRaw(): Promise<StoredToken | null> {
    try {
      const raw = await readJson<StoredToken>(this.filePath);
      return typeof raw?.refreshToken === 'string' && raw.refreshToken.length > 0 ? raw : null;
    } catch (error) {
      if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  async invalidateAccessToken(): Promise<void> {
    const token = await this.read();
    if (!token) {
      return;
    }
    delete token.accessToken;
    delete token.expiresAt;
    await this.write(token);
  }

  /** Interactive loopback OAuth flow with PKCE. */
  async login(openUrl: (url: string) => void): Promise<void> {
    if (!this.credentials.clientId || !this.credentials.clientSecret) {
      throw new Error('A Google Drive desktop app client ID and client secret are required.');
    }

    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('hex');

    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    let redirectUri = '';
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/') {
        response.writeHead(404).end('Not found');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state');
      if (error) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body><h2>FPDT could not connect to Google Drive.</h2>You can close this tab.</body></html>');
        rejectCode(new Error(`Google authorization failed: ${error}`));
        return;
      }
      if (!code || returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body><h2>FPDT received an invalid authorization response.</h2></body></html>');
        rejectCode(new Error('Google authorization returned an invalid response.'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><body><h2>FPDT is connected to Google Drive.</h2>' +
        'You can close this tab and return to Flashpoint.</body></html>',
      );
      resolveCode(code);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    redirectUri = `http://127.0.0.1:${address.port}`;

    const authUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()}`;

    const timeout = setTimeout(() => {
      rejectCode(new Error('Google authorization timed out. Try connecting again.'));
    }, LOGIN_TIMEOUT_MS);
    timeout.unref?.();

    try {
      this.logger.info('Opening the browser for Google Drive authorization...');
      this.logger.debug(`Google authorization URL: ${authUrl}`);
      openUrl(authUrl);
      const code = await codePromise;
      const response = await httpsRequest('POST', TOKEN_URL, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }).toString(),
      });
      if (response.status !== 200) {
        throw apiError(response, 'authorization');
      }
      const body = JSON.parse(response.body.toString('utf8')) as {
        refresh_token?: string;
        access_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!body.access_token || !body.refresh_token) {
        throw new Error(
          'Google did not return a refresh token. Remove FPDT from your Google account permissions and connect again.',
        );
      }
      await this.write({
        refreshToken: body.refresh_token,
        accessToken: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        scope: body.scope,
      });
      this.logger.info('Connected to Google Drive (app data folder only).');
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  }

  private async refresh(token: StoredToken): Promise<string> {
    const response = await httpsRequest('POST', TOKEN_URL, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: token.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (response.status !== 200) {
      throw new Error(
        `Google Drive authorization expired or was revoked (${response.status}). Reconnect cloud sync.`,
      );
    }
    const body = JSON.parse(response.body.toString('utf8')) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!body.access_token) {
      throw new Error('Google did not return an access token. Reconnect cloud sync.');
    }
    const updated: StoredToken = {
      ...token,
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? token.scope,
    };
    await this.write(updated);
    return body.access_token;
  }

  private async write(token: StoredToken): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeJsonAtomic(this.filePath, { ...token, clientId: this.credentials.clientId });
    // Best effort on Windows (where chmod is mostly advisory), real on POSIX.
    await fsp.chmod(nativePath(this.filePath), 0o600).catch(() => undefined);
  }
}

export class GoogleDriveTransport implements CloudTransport {
  private folderId: string | null = null;
  private manifestId: string | null = null;
  private readonly tokenStore: GoogleTokenStore;

  constructor(
    credentials: GoogleCredentials,
    tokenFile: string,
    private readonly logger: Logger,
  ) {
    this.tokenStore = new GoogleTokenStore(tokenFile, credentials, logger);
  }

  get tokens(): GoogleTokenStore {
    return this.tokenStore;
  }

  async isConnected(): Promise<boolean> {
    return this.tokenStore.hasToken();
  }

  async login(openUrl: (url: string) => void): Promise<void> {
    await this.tokenStore.login(openUrl);
  }

  async logout(): Promise<void> {
    await this.tokenStore.clear();
    this.folderId = null;
    this.manifestId = null;
  }

  async list(): Promise<CloudRemoteFile[]> {
    const folderId = await this.ensureFolder();
    const files: CloudRemoteFile[] = [];
    const temporary: Array<{ id: string; modifiedTime?: string }> = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${escapeQuery(folderId)}' in parents and trashed = false`,
        spaces: 'appDataFolder',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,md5Checksum,size,modifiedTime)',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const response = await this.authorized('GET', `${DRIVE_API}?${params.toString()}`);
      if (response.status !== 200) {
        throw apiError(response, 'listing files');
      }
      const body = JSON.parse(response.body.toString('utf8')) as {
        nextPageToken?: string;
        files?: Array<{
          id: string;
          name: string;
          mimeType: string;
          md5Checksum?: string;
          size?: string;
          modifiedTime?: string;
        }>;
      };
      for (const file of body.files ?? []) {
        if (file.name === CLOUD_MANIFEST_NAME) {
          this.manifestId = file.id;
          continue;
        }
        if (file.name.startsWith(`${NAME_PREFIX}tmp-`)) {
          // An interrupted first upload leaves a temporary, unpublished file.
          // It must never be mistaken for real cloud data.
          temporary.push({ id: file.id, modifiedTime: file.modifiedTime });
          continue;
        }
        if (file.mimeType === 'application/vnd.google-apps.folder' || !file.md5Checksum) {
          continue;
        }
        const key = decodeName(file.name);
        if (!key) {
          continue;
        }
        files.push({
          key,
          fileId: file.id,
          md5: file.md5Checksum,
          size: file.size ? Number.parseInt(file.size, 10) : 0,
          modifiedTime: file.modifiedTime ?? new Date(0).toISOString(),
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
    for (const item of temporary) {
      // Only clean up files that have been abandoned for a day. Another
      // machine may be uploading right now under a temporary name.
      const modified = item.modifiedTime ? Date.parse(item.modifiedTime) : Number.NaN;
      if (!Number.isNaN(modified) && modified > staleBefore) {
        continue;
      }
      await this.remove(item.id).catch(() => undefined);
    }
    return files;
  }

  async download(file: CloudRemoteFile, destination: string): Promise<void> {
    await ensureDir(path.dirname(destination));
    const partPath = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
    const url = `${DRIVE_API}/${encodeURIComponent(file.fileId)}?alt=media`;
    try {
      for (let attempt = 0; ; attempt++) {
        let response = await httpsDownload(
          url,
          { authorization: `Bearer ${await this.tokenStore.accessToken()}` },
          partPath,
        );
        if (response.status === 401) {
          await this.tokenStore.invalidateAccessToken();
          response = await httpsDownload(
            url,
            { authorization: `Bearer ${await this.tokenStore.accessToken()}` },
            partPath,
          );
        }
        if (retryable(response) && attempt < 3) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (response.status !== 200) {
          throw apiError(response, `downloading ${file.key}`);
        }
        await fsp.rename(nativePath(partPath), nativePath(destination));
        return;
      }
    } catch (error) {
      await removeIfExists(partPath);
      throw error;
    }
  }

  async upload(key: string, source: string, fileId?: string): Promise<{ fileId: string; md5: string }> {
    const size = (await statOrNull(source))?.size;
    if (size === undefined) {
      throw new Error(`Cannot upload ${key}: the prepared copy is missing.`);
    }
    let id = fileId ?? null;
    const created = !id;
    if (!id) {
      const folderId = await this.ensureFolder();
      const response = await this.authorized('POST', `${DRIVE_API}?fields=id`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Upload under a temporary name, then rename. A failed upload can
          // therefore never appear as a real, empty cloud file.
          name: `${NAME_PREFIX}tmp-${randomBytes(6).toString('hex')}`,
          parents: [folderId],
          mimeType: 'application/octet-stream',
        }),
      });
      if (response.status !== 200 && response.status !== 201) {
        throw apiError(response, `creating ${key}`);
      }
      id = (JSON.parse(response.body.toString('utf8')) as { id?: string }).id ?? null;
      if (!id) {
        throw new Error(`Google Drive did not return a file id for ${key}.`);
      }
    }

    try {
      const response = await this.authorized(
        'PATCH',
        `${UPLOAD_API}/${encodeURIComponent(id)}?uploadType=media&fields=id,md5Checksum,size`,
        {
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
          stream: createReadStream(nativePath(source)),
        },
      );
      if (response.status !== 200 && response.status !== 201) {
        throw apiError(response, `uploading ${key}`);
      }
      const body = JSON.parse(response.body.toString('utf8')) as { id?: string; md5Checksum?: string };
      if (created) {
        const rename = await this.authorized('PATCH', `${DRIVE_API}/${encodeURIComponent(id)}?fields=id`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: encodeName(key) }),
        });
        if (rename.status !== 200) {
          throw apiError(rename, `publishing ${key}`);
        }
      }
      return {
        fileId: body.id ?? id,
        md5: body.md5Checksum ?? (await md5File(source)),
      };
    } catch (error) {
      if (created) {
        // Do not leave empty or temporary orphan files in the app data folder.
        await this.remove(id).catch(() => undefined);
      }
      throw error;
    }
  }

  async remove(fileId: string): Promise<void> {
    const response = await this.authorized('DELETE', `${DRIVE_API}/${encodeURIComponent(fileId)}`);
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw apiError(response, 'deleting a cloud file');
    }
  }

  async readManifest(): Promise<CloudManifestData | null> {
    const id = await this.findManifestId();
    if (!id) {
      return null;
    }
    const response = await this.authorized('GET', `${DRIVE_API}/${encodeURIComponent(id)}?alt=media`);
    if (response.status === 404) {
      this.manifestId = null;
      return null;
    }
    if (response.status !== 200) {
      throw apiError(response, 'reading the cloud manifest');
    }
    try {
      return JSON.parse(response.body.toString('utf8')) as CloudManifestData;
    } catch (error) {
      this.logger.warn(`The cloud manifest is not valid JSON and will be rebuilt: ${errorMessage(error)}`);
      return null;
    }
  }

  async writeManifest(data: CloudManifestData, retry = true): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const folderId = await this.ensureFolder();
    let id = await this.findManifestId();
    if (!id) {
      const create = await this.authorized('POST', `${DRIVE_API}?fields=id`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: CLOUD_MANIFEST_NAME,
          parents: [folderId],
          mimeType: 'application/json',
        }),
      });
      if (create.status !== 200 && create.status !== 201) {
        throw apiError(create, 'creating the cloud manifest');
      }
      id = (JSON.parse(create.body.toString('utf8')) as { id?: string }).id ?? null;
      if (!id) {
        throw new Error('Google Drive did not return an id for the cloud manifest.');
      }
      this.manifestId = id;
    }
    const response = await this.authorized(
      'PATCH',
      `${UPLOAD_API}/${encodeURIComponent(id)}?uploadType=media&fields=id`,
      {
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      },
    );
    if (response.status === 404 && retry) {
      // The manifest was removed outside FPDT; recreate it instead of failing.
      this.manifestId = null;
      await this.writeManifest(data, false);
      return;
    }
    if (response.status !== 200 && response.status !== 201) {
      throw apiError(response, 'writing the cloud manifest');
    }
  }

  private async findManifestId(): Promise<string | null> {
    if (this.manifestId) {
      return this.manifestId;
    }
    const folderId = await this.ensureFolder();
    const params = new URLSearchParams({
      q: `name = '${CLOUD_MANIFEST_NAME}' and '${escapeQuery(folderId)}' in parents and trashed = false`,
      spaces: 'appDataFolder',
      fields: 'files(id,name)',
    });
    const response = await this.authorized('GET', `${DRIVE_API}?${params.toString()}`);
    if (response.status !== 200) {
      throw apiError(response, 'finding the cloud manifest');
    }
    const body = JSON.parse(response.body.toString('utf8')) as { files?: Array<{ id: string }> };
    this.manifestId = body.files?.[0]?.id ?? null;
    return this.manifestId;
  }

  private async ensureFolder(): Promise<string> {
    if (this.folderId) {
      return this.folderId;
    }
    const params = new URLSearchParams({
      q: `name = '${CLOUD_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' ` +
        `and 'appDataFolder' in parents and trashed = false`,
      spaces: 'appDataFolder',
      fields: 'files(id,name)',
    });
    const existing = await this.authorized('GET', `${DRIVE_API}?${params.toString()}`);
    if (existing.status !== 200) {
      throw apiError(existing, 'looking for the FPDT cloud folder');
    }
    const body = JSON.parse(existing.body.toString('utf8')) as { files?: Array<{ id: string }> };
    const found = body.files?.[0]?.id;
    if (found) {
      this.folderId = found;
      return found;
    }
    const created = await this.authorized('POST', `${DRIVE_API}?fields=id`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: CLOUD_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['appDataFolder'],
      }),
    });
    if (created.status !== 200 && created.status !== 201) {
      throw apiError(created, 'creating the FPDT cloud folder');
    }
    const id = (JSON.parse(created.body.toString('utf8')) as { id?: string }).id;
    if (!id) {
      throw new Error('Google Drive did not return an id for the FPDT cloud folder.');
    }
    this.folderId = id;
    return id;
  }

  private async authorized(method: string, url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      let token = await this.tokenStore.accessToken();
      let response = await httpsRequest(method, url, {
        ...options,
        headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        if (options.stream) {
          throw apiError(response, 'uploading (authorization expired; the next sync will retry)');
        }
        await this.tokenStore.invalidateAccessToken();
        token = await this.tokenStore.accessToken();
        response = await httpsRequest(method, url, {
          ...options,
          headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
        });
      }
      if (!options.stream && retryable(response) && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }
}

function retryable(response: HttpResponse): boolean {
  if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    return true;
  }
  if (response.status === 403) {
    const text = response.body.toString('utf8');
    return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(text);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function encodeName(key: string): string {
  return `${NAME_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function decodeName(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) {
    return null;
  }
  try {
    const key = Buffer.from(name.slice(NAME_PREFIX.length), 'base64url').toString('utf8');
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

async function md5File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(nativePath(filePath));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Open a URL in the default browser without a shell. */
export function openExternalUrl(url: string): void {
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // The caller logs the URL; this is best effort.
  }
}
