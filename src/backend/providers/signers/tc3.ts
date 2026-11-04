// 官方签名规范：https://cloud.tencent.com/document/api/213/30654（2026-11-03 核实）。
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
async function hmac(key: Uint8Array<ArrayBuffer>, text: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(text)));
}

export async function signTc3(options: {
  secretId: string; secretKey: string; host: string; service: string; action: string; body: string; timestamp: number;
}): Promise<string> {
  const { secretId, secretKey, host, service, action, body, timestamp } = options;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\n${signedHeaders}\n${await sha256(body)}`;
  const scope = `${date}/${service}/tc3_request`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonical)}`;
  const dateKey = await hmac(encoder.encode(`TC3${secretKey}`), date);
  const serviceKey = await hmac(dateKey, service);
  const signingKey = await hmac(serviceKey, 'tc3_request');
  const signature = hex((await hmac(signingKey, toSign)).buffer);
  return `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
