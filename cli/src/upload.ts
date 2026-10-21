import { basename, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import type { Api } from "./http.js";
import { errorFromResponse, send, userAgent } from "./http.js";
import { isLoopbackHost } from "./config.js";
import { CliError, EXIT, usageError } from "./exit-codes.js";
import type { Runtime } from "./runtime.js";

/**
 * Files for Swaps, Remakes and references. A local file: POST /uploads (where to put it) →
 * stream it with PUT (no token: the upload URL itself is the credential) → POST
 * /uploads/complete → a file id. The server may answer the PUT with a 307 to storage: followed
 * by hand, https only. A link: POST /uploads/import. A file id (u1.…) is used as it is.
 */

export type FileOutput = { file_id: string; kind: "image" | "video"; name: string | null; size_bytes: number; duration_seconds: number | null; expires_at: string };
type PrepareOutput = { upload_id: string; upload_url: string; method: "PUT"; headers: Record<string, string>; max_bytes: number; expires_at: string };

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
};

const MAX_HOPS = 3;

export function contentTypeFor(path: string): string | null {
  return TYPES[extname(path).toLowerCase()] ?? null;
}

export const isUrl = (s: string) => /^https?:\/\//i.test(s);
export const isFileId = (s: string) => s.startsWith("u1.");

/** Where a redirect may lead: https only (resolved against the URL that redirected). */
export function followHttps(current: string, location: string | null): string {
  if (!location) throw new CliError("Redirected without a destination.", EXIT.error, "bad_redirect");
  let u: URL;
  try {
    u = new URL(location, current);
  } catch {
    throw new CliError("Redirected to something that isn't a URL.", EXIT.error, "bad_redirect");
  }
  if (u.protocol !== "https:") throw new CliError("Refusing to follow a redirect to a non-https address.", EXIT.error, "unsafe_redirect");
  return u.toString();
}

/** The first upload URL: https, or plain http only on the API's own loopback origin (local development). */
function checkUploadUrl(raw: string, apiOrigin: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError("The server's upload address isn't a URL.", EXIT.error, "bad_response");
  }
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && isLoopbackHost(u.hostname) && u.origin === apiOrigin) return u.toString();
  throw new CliError("Refusing to send the file over an unencrypted connection.", EXIT.error, "unsafe_redirect");
}

function progressStream(rt: Runtime, label: string, total: number): Transform {
  let sent = 0;
  let lastAt = 0;
  let lastStep = -1;
  const tty = !!rt.ctx.stderr.isTTY;
  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      const pct = total ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
      if (tty) {
        const now = rt.ctx.now();
        if (now - lastAt > 200 || sent === total) {
          lastAt = now;
          rt.out.progress(`Uploading ${label}  ${pct}%  (${mb(sent)} / ${mb(total)} MB)`);
        }
      } else if (Math.floor(pct / 25) > lastStep) {
        lastStep = Math.floor(pct / 25);
        rt.out.progress(`Uploading ${label}: ${pct}%`);
      }
      cb(null, chunk);
    },
  });
}

/** Streams the file to `url`, following up to 3 redirects (307/308, https only). */
export async function putFile(rt: Runtime, url: string, headers: Record<string, string>, path: string, size: number): Promise<void> {
  let target = checkUploadUrl(url, rt.settings.apiUrl);
  const label = basename(path);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const source = rt.ctx.fs.createReadStream(path).pipe(progressStream(rt, label, size));
    const init = {
      method: "PUT",
      headers: { ...headers, "Content-Length": String(size), "User-Agent": userAgent(rt.ctx) },
      body: Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>,
      duplex: "half",
      redirect: "manual",
    } as RequestInit;
    const res = await send(rt.ctx, rt.out, target, init);
    rt.out.progressDone();
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      source.destroy();
      if (res.status !== 307 && res.status !== 308) throw new CliError(`The upload was redirected with ${res.status}; only 307/308 keep the file.`, EXIT.error, "bad_redirect");
      target = followHttps(target, res.headers.get("location"));
      rt.out.debug("upload redirected to storage");
      continue;
    }
    if (!res.ok) throw await errorFromResponse(res);
    await res.body?.cancel().catch(() => {});
    return;
  }
  throw new CliError("The upload was redirected too many times.", EXIT.error, "bad_redirect");
}

export async function uploadFile(rt: Runtime, api: Api, path: string): Promise<FileOutput> {
  let size: number;
  try {
    const st = rt.ctx.fs.statSync(path);
    if (!st.isFile()) throw usageError(`${path} is not a file.`);
    size = st.size;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw usageError(`Can't read ${path}.`);
  }
  if (!size) throw usageError(`${path} is empty.`);
  const contentType = contentTypeFor(path);
  if (!contentType) throw usageError(`${basename(path)}: we take JPG, PNG and WEBP pictures, and MP4, MOV, M4V and WEBM videos.`);
  const prep = await api.post<PrepareOutput>("/uploads", { file_name: basename(path).slice(0, 255), content_type: contentType, size_bytes: size });
  if (size > prep.max_bytes) throw usageError(`${basename(path)} is over the ${Math.floor(prep.max_bytes / 1_048_576)} MB limit.`);
  await putFile(rt, prep.upload_url, prep.headers ?? {}, path, size);
  return api.post<FileOutput>("/uploads/complete", { upload_id: prep.upload_id });
}

export function importUrl(api: Api, url: string, o: { kind?: "image" | "video"; name?: string } = {}): Promise<FileOutput> {
  return api.post<FileOutput>("/uploads/import", { url, ...(o.kind ? { kind: o.kind } : {}), ...(o.name ? { name: o.name } : {}) });
}

/** A file argument as a file id: a u1.… id as is, a link imported, a local path uploaded. */
export async function fileIdOf(rt: Runtime, api: Api, ref: string): Promise<string> {
  if (isFileId(ref)) return ref;
  const f = isUrl(ref) ? await importUrl(api, ref) : await uploadFile(rt, api, ref);
  rt.out.info(isUrl(ref) ? `Imported ${new URL(ref).host}${new URL(ref).pathname}` : `Uploaded ${basename(ref)}`);
  return f.file_id;
}
