/*!-======[ STT untuk telepon — paksa bahasa Indonesia ]======-!*/
/**
 * Masalah: endpoint termai /transcribe menebak bahasa otomatis, jadi ucapan pendek
 * bahasa Indonesia sering terbaca "enfeite" (Portugis) atau aksara Jepang.
 *
 * Solusi: kirim audio ke Gemini (provider yang sudah ada di config api.ai.gemini)
 * lewat endpoint OpenAI-compatible dengan instruksi eksplisit "bahasa Indonesia".
 * Kalau Gemini tidak dikonfigurasi / error / timeout -> jatuh ke transcribe termai.
 *
 * Config opsional (cfg.call_stt):
 *   engine: 'auto' | 'gemini' | 'termai'   (default 'auto')
 *   language: 'Indonesia'                  (nama bahasa untuk instruksi)
 *   model: 'gemini-...'                    (default: model gemini di api.ai.gemini)
 *   timeoutMs: 15000
 *   dropForeignScript: true                (buang hasil beraksara Jepang/China/Korea/Arab/Cyrilic/Thai)
 */

const FOREIGN_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/;

export const hasForeignScript = (t) => FOREIGN_SCRIPT.test(String(t || ''));

function geminiCfg() {
  const g = (global.api || {}).ai?.gemini || {};
  const ok = g.url?.trim() && g.key?.trim();
  return ok ? { url: g.url.trim().replace(/\/+$/, ''), key: g.key.trim(), model: g.model?.trim() } : null;
}

async function viaGemini(wav, { language, model, timeoutMs, effort }) {
  const g = geminiCfg();
  if (!g) throw new Error('gemini belum dikonfigurasi');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const post = (withEffort) => fetch(`${g.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${g.key}` },
      body: JSON.stringify({
        model: model || g.model,
        temperature: 0,
        // matikan thinking: STT cuma menyalin suara, thinking bikin lambat belasan detik
        ...(withEffort ? { reasoning_effort: effort } : {}),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Transkripsikan audio ini apa adanya. Bahasa yang diucapkan adalah bahasa ${language} ` +
                  '(boleh bercampur kata Inggris atau Jepang dalam huruf latin). ' +
                  'Tulis hasilnya dengan huruf latin saja. Jawab HANYA teks transkripnya tanpa tanda kutip atau penjelasan. ' +
                  'Jika tidak ada ucapan yang jelas (hanya noise, napas, atau senyap), jawab persis: [kosong]',
              },
              { type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    // model yang pernah menolak reasoning_effort diingat, supaya tidak kirim 2x tiap giliran
    const noEffort = (globalThis.__sttNoEffort ??= new Set());
    const key = model || g.model;
    const useEffort = !!effort && !noEffort.has(key);
    let res = await post(useEffort);
    if (res.status === 400 && useEffort) {
      noEffort.add(key);
      res = await post(false);
    }
    if (!res.ok) throw new Error(`gemini STT ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const j = await res.json();
    const out = j?.choices?.[0]?.message?.content;
    return typeof out === 'string' ? out : '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Buffer} wav
 * @param {{ transcribe?: (b:Buffer)=>Promise<any> }} deps  fungsi termai sebagai cadangan
 * @returns {Promise<{ text: string, engine: string }>}
 */
export async function transcribeSmart(wav, { transcribe } = {}) {
  const c = (global.cfg || {}).call_stt || {};
  const engine = c.engine || 'auto';
  const language = c.language || 'Indonesia';
  const timeoutMs = Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 8000;
  // cfg.call_stt.reasoning: 'minimal' (default) | 'low' | ... ; isi "" / false untuk tidak mengirim parameter
  let effort = c.reasoning === undefined ? 'minimal' : c.reasoning || '';
  if (effort && !['none', 'minimal', 'low', 'medium', 'high'].includes(String(effort).toLowerCase())) {
    console.warn(`[STT] call_stt.reasoning "${effort}" tidak dikenal (pakai: minimal/low/medium/high), dipakai "minimal"`);
    effort = 'minimal';
  }
  effort = String(effort).toLowerCase();
  const audioSec = wav.length > 44 && wav.readUInt32LE(24) ? ((wav.length - 44) / 2 / wav.readUInt32LE(24)).toFixed(1) : '?';

  const g = geminiCfg();
  if (engine !== 'termai' && g) {
    // model khusus STT (call_stt.model) dulu; kalau gagal, coba model default gemini sebelum jatuh ke termai
    const models = [...new Set([c.model?.trim(), g.model].filter(Boolean))];
    for (const m of models.length ? models : [undefined]) {
      try {
        const t0 = Date.now();
        let t = (await viaGemini(wav, { language, model: m, timeoutMs, effort })).trim();
        console.log(`[STT] gemini ${m || 'default'} ${Date.now() - t0}ms (audio ${audioSec}s)`);
        t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
        if (/^\[?\s*kosong\s*\]?\.?$/i.test(t)) t = '';
        return { text: t, engine: 'gemini' };
      } catch (e) {
        console.error(`[STT] gemini (${m || 'default'}) gagal:`, e?.message || e);
      }
    }
    if (engine === 'gemini') return { text: '', engine: 'gemini-error', failed: true };
  }

  // termai hanya dipakai kalau diminta (call_stt.fallbackTermai = true) atau engine = 'termai'.
  // Default mati: hasilnya sering ngawur & lambat (~19 dtk), lebih baik minta user mengulang.
  const allowTermai = engine === 'termai' || c.fallbackTermai === true || !g;
  if (!allowTermai) return { text: '', engine: 'gemini-error', failed: true };

  if (typeof transcribe === 'function') {
    const r = await transcribe(wav);
    const t = typeof r === 'string' ? '' : (r?.text || '').trim();
    return { text: t, engine: 'termai' };
  }
  return { text: '', engine: 'none' };
}
