const bootstrap = new URLSearchParams(location.hash.slice(1)).get('connect');
if (bootstrap) history.replaceState(null, '', location.pathname + location.search);
export const connected = bootstrap
  ? fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: bootstrap }),
    }).then((r) => {
      if (!r.ok) throw new Error('Ouvre Menki depuis le lanceur de ton PC.');
    })
  : Promise.resolve();

export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<T> {
  await connected;
  const response = await fetch('/api' + path, {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error ?? 'La demande n’a pas abouti.');
  }
  return response.json();
}
export async function recordWave(stream: MediaStream) {
  const context = new AudioContext({ sampleRate: 16000 });
  const input = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const samples: Float32Array[] = [];
  processor.onaudioprocess = (e) => samples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  input.connect(processor);
  processor.connect(context.destination);
  return async () => {
    processor.disconnect();
    input.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await context.close();
    const length = samples.reduce((n, x) => n + x.length, 0),
      buffer = new ArrayBuffer(44 + length * 2),
      view = new DataView(buffer);
    const tag = (n: number, text: string) =>
      [...text].forEach((c, i) => view.setUint8(n + i, c.charCodeAt(0)));
    tag(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, length * 2, true);
    let offset = 44;
    for (const block of samples)
      for (const value of block) {
        view.setInt16(offset, Math.max(-1, Math.min(1, value)) * 32767, true);
        offset += 2;
      }
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
}
