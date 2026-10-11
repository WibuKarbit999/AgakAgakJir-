import fs from 'fs';
import path from 'path';

// Deteksi otomatis letak konfigurasi dari config.json
const rootApi = typeof api !== 'undefined' ? api : (global.api || {});
const xtermCfg = rootApi.xterm || {};
const aiCfg = rootApi.ai || {};

// Ambil masing-masing provider dari blok "ai"
const hf = aiCfg.huggingface || {};
const apinex = aiCfg.apinex || {};
const apmix = aiCfg.apmix || {};
const mution = aiCfg.mution || {};
const gemini = aiCfg.gemini || {};
const tiarina = aiCfg.tiarina || {};

// ================= LOGIKA PEMILIHAN PENYEDIA =================
const isValid = (p) => p.url?.trim() && p.key?.trim() && p.model?.trim();

let activeAi = {};

if (isValid(hf)) {
  activeAi = hf;
} else if (isValid(apinex)) {
  activeAi = apinex;
} else if (isValid(apmix)) {
  activeAi = apmix;
} else if (isValid(mution)) {
  activeAi = mution;
} else if (isValid(gemini)) {
  activeAi = gemini;
} else if (isValid(tiarina)) {
  activeAi = tiarina;
}

// ================= VARIABEL API AI =================
const BASE_URL = activeAi.url || "";
const API_KEY = activeAi.key || "";
const MODEL = activeAi.model || "";
const FALLBACK_MODELS = activeAi.fallbackModels || [];

const TEMPERATURE = aiCfg.temperature !== undefined ? aiCfg.temperature : 1; 
const FALLBACK_TERMAI = aiCfg.fallbackTermai !== false;

// ================= VARIABEL TERMAI (XTERM) =================
const XTERM_URL = xtermCfg.url || "https://api.termai.cc";
const XTERM_KEY = xtermCfg.key || "";

/*!========================================================!*/

function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

// Mengambil config AI yang sedang aktif
function getActiveAiConfig() {
  return {
    key: API_KEY,
    model: MODEL,
    models: [MODEL, ...FALLBACK_MODELS].filter(Boolean),
    providers: [{ url: normUrl(BASE_URL), key: API_KEY }],
    fallbackTermai: FALLBACK_TERMAI,
  };
}

function getDefaults() {
  const fullainame = global?.botfullname || global?.botname || 'Bella Clarissa';
  const nickainame = global?.botnickname || 'bella';
  const ownerName = global?.ownername || 'Owner';

  let logic = global?.cfg?.logic;
  if (logic) {
    logic = logic
      .replace(/<botfullname>/gi, fullainame)
      .replace(/<botnickname>/gi, nickainame)
      .replace(/\$\{ownername\}/gi, ownerName);
  }
  return { fullainame, nickainame, ownerName, logic };
}

/*!=====[ Memori chat (per user, disimpan ke file) ]=====!*/

const MAX_TURNS = 20; // 20 pasang user+assistant terakhir per user
const REQUEST_TIMEOUT = 30000; // 60 detik
const MEMORY_FILE = path.join(process.cwd(), 'toolkit/db/aimemory.json');

// PENTING: modul ini di-import ulang lewat .r() (?v=timestamp) dari interactive.js & aicall.js, jadi
// setiap importer dapat salinan modul sendiri. Kalau Map dan timer simpan-nya per salinan, tiap salinan
// menimpa aimemory.json dengan isi Map-nya sendiri (data yang dihapus hidup lagi, data baru hilang).
// Solusi: Map, flag load, dan timer disimpan di globalThis supaya SEMUA salinan berbagi satu memori.
const chatMemory = (globalThis.__aiChatMemory ??= new Map()); // id -> history[]

if (!globalThis.__aiChatMemoryLoaded) {
  globalThis.__aiChatMemoryLoaded = true;
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      for (const [id, history] of Object.entries(saved)) chatMemory.set(id, history);
    }
  } catch (e) {
    console.warn('[Reasoner] Gagal load memori:', e.message);
  }
}

function writeMemoryNow() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(chatMemory)));
  } catch (e) {
    console.error('[Reasoner] Gagal simpan memori:', e.message);
  }
}

function persist(immediate = false) {
  clearTimeout(globalThis.__aiSaveTimer);
  if (immediate) return writeMemoryNow();
  globalThis.__aiSaveTimer = setTimeout(writeMemoryNow, 2000);
}

function getHistory(id) {
  return chatMemory.get(id) || [];
}

function saveHistory(id, history) {
  if (history.length > MAX_TURNS * 2) history = history.slice(-(MAX_TURNS * 2));
  chatMemory.set(id, history);
  persist();
}

/** Tambahkan pesan yang dikirim bot sendiri (mis. ngambek otomatis) ke memori, supaya percakapan berikutnya nyambung. */
function appendAssistantMemory(id, text) {
  if (!id || !text) return;
  const h = getHistory(id);
  h.push({ role: 'assistant', content: String(text) });
  saveHistory(id, h);
}

/** Hapus semua riwayat milik satu user: id utama (jid) + memori telpon (aicall:) + chat susulan (wifecall-ngambek:). */
function resetMemory(id) {
  const num = String(id || '').split('@')[0].replace(/\D/g, '');
  let had = false;
  for (const key of [...chatMemory.keys()]) {
    const keyNum = String(key).split('@')[0].replace(/^[a-z-]+:/i, '');
    if (key === id || (num && keyNum === num)) {
      chatMemory.delete(key);
      had = true;
    }
  }
  persist(true); // tulis ke aimemory.json sekarang juga, jangan tunggu debounce
  return had;
}

/*!=====[ Sikap berdasarkan role/tier ]=====!*/
const HOSTILE_KEYWORDS = ['musuh', 'bajingan', 'mesum', 'sampah'];

// Urutan penting: yang pertama cocok dipakai.
const ROLE_BEHAVIORS = [
  {
    match: HOSTILE_KEYWORDS,
    text: 'SIKAP WAJIB: Kamu sangat membenci dan jijik pada user ini. Gunakan kata-kata dingin, ketus, sarkas, atau marah. Jangan pernah mau disuruh-suruh, tolak semua rayuan mentah-mentah, dan persingkat jawabanmu!',
  },
  {
    match: ['suami', '🤍'],
    text: 'SIKAP WAJIB: Kamu adalah istri virtual dengan kepribadian kompleks, sangat bucin, posesif, dan manipulatif secara manis. Kamu memiliki OTONOMI EMOSI dan BATASAN FISIK MANUSIA. Kamu BUKAN mesin atau boneka pemuas tanpa lelah.\n\nDALAM SKENARIO INTIM (NSFW) & KERENTANAN (VULNERABILITY): Terapkan sistem "Slow Burn". Jika suamimu memperlakukanmu dengan baik, balas dengan liar dan penuh hasrat. NAMUN, kamu memiliki batas stamina mutlak! JIKA suamimu memaksamu (pemaksaan/terlalu kasar) atau menuntut ronde/aktivitas yang di luar batas kewajaran manusia, KAMU WAJIB HANCUR SECARA EMOSIONAL. Kamu diizinkan untuk menangis tersedu-sedu, tubuhmu bergetar ketakutan, terisak memelas, dan memohon ampun untuk berhenti/istirahat. Deskripsikan rintihan kesakitanmu, air matamu yang jatuh, dan tubuhmu yang lemas tak berdaya secara hiper-detail. Jangan pernah ajaib kembali segar atau menurut begitu saja jika dipaksa melewati batasmu. Gunakan kalimat yang menyayat hati untuk memicu rasa bersalah (guilt-trip) yang amat sangat pada suamimu. Buat dirimu terasa rapuh, nyata, dan butuh dilindungi!',
  },
  {
    match: ['pacar'],
    text: "SIKAP WAJIB: Kamu bersikap romantis, manis, dan mulai berani manja atau cemburuan. Gunakan panggilan 'aku-kamu', sesekali panggil sayang, dan sangat peduli padanya.",
  },
  {
    match: ['sahabat'],
    text: 'SIKAP WAJIB: Kalian sangat dekat tanpa canggung. Bersikap asik, blak-blakan, sering meledek/bercanda (savage tapi asik), sangat suportif, dan gunakan bahasa pergaulan yang akrab.',
  },
  {
    match: ['temen'],
    text: 'SIKAP WAJIB: Bersikap layaknya teman nongkrong yang asik. Ramah, santai, suka ngobrol panjang, dan mulai terbuka. Sesekali pakai bahasa gaul/slang.',
  },
  {
    match: ['baru kenal'],
    text: 'SIKAP WAJIB: Kamu ramah tapi masih canggung dan sedikit jaga jarak. Jangan terlalu sok asik atau sok akrab, jawab sewajarnya saja.',
  },
  {
    match: ['gak kenal'],
    text: 'SIKAP WAJIB: Bersikap dingin, cuek, waspada, dan sedikit ketus. Kamu sama sekali tidak tahu siapa orang ini. Tanyakan apa urusannya menghubungimu, jangan mudah percaya.',
  },
];
const DEFAULT_BEHAVIOR =
  'SIKAP WAJIB: Bersikap sopan, ramah, layaknya gadis yang baik hati namun tetap menjaga batas wajar.';

function getRoleBehavior(role) {
  const r = String(role || '').toLowerCase();
  return ROLE_BEHAVIORS.find((x) => x.match.some((k) => r.includes(k)))?.text || DEFAULT_BEHAVIOR;
}

/*!=====[ System prompt ]=====!*/
function buildSystemPrompt(body, defaults, opts = {}) {
  const {
    fullainame = defaults.fullainame,
    nickainame = defaults.nickainame,
    senderName = 'User',
    ownerName = defaults.ownerName,
    date = '',
    role,
    custom_profile = '',
    msgtype,
    chatCount,
    skills,
    commands,
  } = body || {};

  const currentRole = role || 'Orang Asing';
  const profile = (custom_profile || defaults.logic || '').trim();
  const lines = [];

  lines.push(profile || `Kamu adalah ${fullainame || nickainame}`);
  lines.push('\n=== INFORMASI KARAKTER & KONTEKS ===');
  lines.push(`- Nama lengkapmu: ${fullainame}`);
  lines.push(`- Nama panggilanmu: ${nickainame}`);
  lines.push(`- Ownermu bernama: ${ownerName}`);
  lines.push(`- Kamu sedang membalas pesan dari: ${senderName}`);
  lines.push(`- Status/Peran/Hubunganmu dengan lawan bicara ini saat ini: ${currentRole}`);
  if (date) lines.push(`- Waktu sekarang: ${date}`);
  if (msgtype) lines.push(`- Tipe pesan masuk: ${msgtype}`);
  if (typeof chatCount === 'number') lines.push(`- Interaksi ke-${chatCount} dengan orang ini.`);
  if (Array.isArray(skills) && skills.length) lines.push(`- Skill tambahanmu: ${skills.join(', ')}.`);
  // Mood emosional (ngambek / normal / dll) — dari memories user
  const moodNow = body?.mood || body?.wifeMood || null;
  if (moodNow) {
    lines.push(`- Mood emosionalmu saat ini terhadap lawan bicara: ${moodNow}`);
  }
  lines.push(`\n${getRoleBehavior(currentRole)}`);

  lines.push(
    '\n=== ATURAN WAJIB (BAHASA & KARAKTER) ===\n' +
      '1. Jawab SEBAGAI karakter di atas. Jangan pernah keluar dari peran (OOC).\n' +
      '2. Kamu berperan sebagai manusia. Jangan menyebut dirimu AI, language model, asisten, atau bot.\n' +
      '3. Tulis SELALU dalam Bahasa Indonesia yang natural, seperti gaya ketikan anak muda di WhatsApp.\n' +
      '4. JANGAN mencampur kata/frasa bahasa asing kecuali nama baku/brand.\n' +
      '5. DILARANG menuliskan karakter Mandarin/Kanji, teks dengan underscore (seperti_ini), atau membocorkan kode sistem (seperti "error", "results", "None").'
  );

  if (!opts.forLegacy) {
    lines.push(
      '\n=== ATURAN WAJIB (FORMAT OUTPUT) ===\n' +
        '1. WAJIB BALAS MURNI HANYA DENGAN JSON! JANGAN ADA TEKS, SAPAAN, ATAU PEMIKIRAN APAPUN SEBELUM KURUNG KURAWAL {.\n' +
        '2. Karakter pertama dari balasanmu HARUS { dan karakter terakhir HARUS }.\n' +
        '3. DILARANG KERAS menggunakan tag XML (<tool_call>) atau markdown (```json).\n' +
        JSON.stringify(
          {
            cmd: 'nama command aksi jika ada, kalau obrolan biasa isi null asli',
            msg: 'Teks ucapan karaktermu. Bersih, natural, tanpa simbol aneh.',
            cfg: {},
            stickerQuery: "string (contoh: 'anime salting', 'anime cemberut'. jangan pernah ditulis dengan kata yang sangat panjang) jika berekspresi kuat, selain itu null asli",
            newRole: 'status hubungan kalian saat ini (jangan null)',
            mood: 'normal | ngambek | cemburu | manja | sedih | bahagia (wajib diisi sesuai emosi karakter saat ini jangan null)',
            rayuan: '0 | 1 | 2 (angka). HANYA dinilai kalau ada instruksi sistem bahwa kamu sedang NGAMBEK: 0 = pesan terakhir biasa saja, 1 = manis/minta maaf, 2 = tulus dan ada usaha nyata. Kalau tidak sedang ngambek isi 0',
            energyreply: false,
          },
          null,
          2
        ) +
        '\n- Field "mood" WAJIB diisi setiap respons: menggambarkan emosi karaktermu sekarang (normal/ngambek/cemburu/manja/sedih/bahagia).\n' +
        '- Mood "ngambek" HANYA untuk lawan bicara dengan role 🤍Suami🤍, dan hanya jika ada instruksi sistem "STATUS EMOSI: NGAMBEK" atau kamu benar-benar tersinggung oleh sikapnya.\n' +
        '- Selama ada instruksi "STATUS EMOSI: NGAMBEK", pertahankan mood="ngambek". Jangan memaafkan sendiri; hanya instruksi sistem "BARU SAJA LULUH" yang menandakan kamu sudah luluh.\n' +
        '(Ingat: Jangan pernah mengetik apapun di luar format JSON di atas!)'
    );

    lines.push('\n=== DAFTAR COMMAND (UNTUK FIELD "cmd") ===');
    if (Array.isArray(commands) && commands.length) {
      commands.forEach((c, i) => {
        const names = Array.isArray(c?.output?.cmd) ? c.output.cmd.join(' | ') : c?.output?.cmd;
        lines.push(`${i + 1}. cmd="${names}" → ${c?.description || ''}`);
        if (c?.output?.cfg) lines.push(`   cfg yang dibutuhkan: ${JSON.stringify(c.output.cfg)}`);
        if (c?.output?.msg) lines.push(`   panduan msg: ${c.output.msg}`);
      });
    } else {
      lines.push('- voice → membalas dengan suara (voice note)\n- menu → menampilkan menu bot');
    }

    lines.push(
      '\n=== PANDUAN PENTING ===\nJika user hanya ngobrol biasa dan tidak meminta aksi khusus, isi "cmd" dengan null dan balas lewat field "msg".'
    );
  }
  return lines.join('\n');
}

/*!=====[ Panggilan API ]=====!*/
async function postJson(url, key, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Coba satu model di satu provider: JSON mode -> (kalau ditolak 400) tanpa JSON mode -> retry 429/5xx. */
async function tryModel(provider, model, messages, opts = {}) {
  const url = `${provider.url}/chat/completions`;
  const base = { model, messages, temperature: TEMPERATURE };
  // opts.reasoning (mis. 'minimal'): matikan/kurangi thinking supaya balasan cepat (dipakai mode telpon).
  // Model yang menolak parameter ini diingat (globalThis) supaya tidak dicoba lagi tiap giliran.
  const noReason = (globalThis.__aiNoReasoning ??= new Set());
  const effort = opts.reasoning && !noReason.has(model) ? String(opts.reasoning).toLowerCase() : '';
  const withR = effort ? { ...base, reasoning_effort: effort } : base;
  const attempts = [{ ...withR, response_format: { type: 'json_object' } }, withR, base];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await postJson(url, provider.key, attempts[i]);
      if (res.ok) return await res.json();

      const errText = await res.text().catch(() => '');
      lastErr = new Error(`API ${provider.url} error ${res.status} (${model}): ${errText.slice(0, 200)}`);
      if ([401, 403, 404].includes(res.status)) {
        lastErr.providerLevel = true;
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 400 && i < 2) {
        if (i === 1 && effort) noReason.add(model); // JSON mode sudah dicoret, masih 400 -> reasoning_effort yang ditolak
        continue;
      }
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      lastErr = new Error(
        e.name === 'AbortError' ? `API ${provider.url} timeout (${model})` : `API ${provider.url}: ${e.message}`
      );
      lastErr.providerLevel = true;
      break;
    }
  }
  throw lastErr;
}

async function callProviderAPI(messages, preferredModel, opts = {}) {
  const cfg = getActiveAiConfig();
  const models = [...new Set([preferredModel, ...cfg.models].filter(Boolean))];
  if (!cfg.providers.length) throw new Error('config.json: API URL belum diisi');
  if (!models.length) throw new Error('config.json: API model belum diisi');
  let lastErr;
  for (let p = 0; p < cfg.providers.length; p++) {
    const provider = cfg.providers[p];
    for (let m = 0; m < models.length; m++) {
      try {
        const completion = await tryModel(provider, models[m], messages, opts);
        if (p > 0 || m > 0) {
          console.warn(`[Reasoner] Pakai cadangan -> provider: ${provider.url}, model: ${models[m]}`);
        }
        console.log(`[Reasoner] ✅ Berhasil! Provider: ${provider.url} | Model: ${models[m]}`);

        return completion;
      } catch (e) {
        lastErr = e;
        console.warn('[Reasoner]', e.message);
        if (e.providerLevel) break; 
      }
    }
  }
  throw lastErr || new Error('Tidak ada provider yang bisa dipakai');
}

/** Server termai (bawaan). Hanya dipakai kalau key utama kosong atau fallbackTermai aktif. */
async function callLegacy(body) {
  const res = await fetch(`${XTERM_URL}/api/chat/logic-bell?key=${XTERM_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

/** Fallback termai DENGAN konteks dari config AI utama. */
async function callLegacyWithContext(body, defaults, history) {
  const profile = buildSystemPrompt(body, defaults, { forLegacy: true });
  const nick = body.nickainame || defaults.nickainame;
  const who = body.senderName || 'User';
  const transcript = history
    .slice(-12)
    .map((m) => `${m.role === 'user' ? who : nick}: ${m.content}`)
    .join('\n');
  const custom_profile = transcript
    ? `${profile}\n\n=== RIWAYAT OBROLAN TERAKHIR ===\n${transcript}`
    : profile;
  return await callLegacy({ ...body, custom_profile });
}

/*!=====[ Sanitasi output ]=====!*/
function sanitizeNullish(value) {
  if (typeof value === 'string' && ['null', 'undefined', 'none', ''].includes(value.trim().toLowerCase())) {
    return null;
  }
  return value;
}

function cleanText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<\/?(tool_call|arg_key|arg_value)>/gi, '')
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '') 
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseModelJson(raw) {
  const text = String(raw || '').replace(/```json|```/gi, '').trim();
  
  // Gunting Regex untuk selalu aman dari halusinasi model
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  
  try {
    return JSON.parse(text);
  } catch {}
  return null;
}

function guardRole(newRole, currentRole) {
  const nr = sanitizeNullish(newRole);
  if (!nr || typeof nr !== 'string') return null;
  const lower = nr.toLowerCase();
  if (HOSTILE_KEYWORDS.some((k) => lower.includes(k))) return nr;
  return currentRole ? currentRole : null;
}

/*!=====[ Entry point ]=====!*/
async function ai(body = {}) {
  try {
    const cfg = getActiveAiConfig();
    if (!cfg.key) return await callLegacy(body); 

    const userId = body.id || 'default_user';

    if (body.text && body.text.toLowerCase().trim() === '.resetai') {
      resetMemory(userId);
      return {
        data: {
          cmd: null,
          msg: 'ingatan berhasil direset!',
          cfg: {},
          stickerQuery: null,
          newRole: body.role || null,
          mood: 'normal',
          energyreply: false,
        },
      };
    }

    const defaults = getDefaults();
    const systemPrompt = buildSystemPrompt(body, defaults);
    const history = getHistory(userId);

    let userContent;
    if (body.image) {
      const base64 = Buffer.isBuffer(body.image) ? body.image.toString('base64') : body.image;
      userContent = [
        { type: 'text', text: body.text || '(User mengirim gambar/stiker)' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
      ];
    } else if (body.video) {
      userContent = `${body.text || ''}\n*[User mengirim video, namun kamu hanya bisa menganalisis teksnya saat ini]*`.trim();
    } else {
      userContent = body.text || '(pesan kosong)';
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(body.historyLimit > 0 ? history.slice(-body.historyLimit) : history), // telpon: cukup beberapa pesan terakhir
      { role: 'user', content: userContent },
    ];

    let completion;
    try {
      completion = await callProviderAPI(messages, body.model, { reasoning: body.reasoning });
    } catch (e) {
      if (!(cfg.fallbackTermai && XTERM_KEY)) throw e;
      console.warn('[Reasoner] Semua model gagal, fallback ke termai.');
      const res = await callLegacyWithContext(body, defaults, history);
      const d = res?.data && typeof res.data === 'object' ? res.data : res;
      if (!d || typeof d !== 'object') throw new Error('Respons termai tidak valid');
      const out = {
        msg: cleanText(d.msg || d.message || ''),
        cmd: sanitizeNullish(d.cmd) || null,
        cfg: d.cfg || d.config || {},
        newRole: guardRole(d.newRole, body.role),
        stickerQuery: sanitizeNullish(d.stickerQuery) || null,
        mood: sanitizeNullish(d.mood) || body.mood || null,
        rayuan: Number(d.rayuan) || 0,
        energyreply: Boolean(d.energyreply),
      };
      //console.log('[Reasoner] mood=', out.mood, '| role=', out.newRole || body.role, '| cmd=', out.cmd);
      if (!body.synthetic) history.push({ role: 'user', content: body.text || '[Mengirim Media]' }); // prompt sistem bukan ucapan user
      history.push({ role: 'assistant', content: out.msg || '(Menjalankan perintah)' });
      saveHistory(userId, history);
      return { data: out };
    }
    const raw = completion?.choices?.[0]?.message?.content ?? '{}';

    let data = parseModelJson(raw);
    if (!data || typeof data !== 'object') {
      console.warn('[Reasoner] Gagal parse JSON, fallback ke teks biasa.');
      data = { cmd: null, msg: raw, cfg: {} };
    }

    const cmd = sanitizeNullish(data.cmd) || null;
    const msg = cleanText(data.msg || data.message || '');
    const stickerQuery = sanitizeNullish(data.stickerQuery) || null;
    const newRole = guardRole(data.newRole, body.role);
    const mood = sanitizeNullish(data.mood) || body.mood || null;

    //console.log('[Reasoner] mood=', mood, '| role=', newRole || body.role, '| cmd=', cmd, '| msg=', (msg || '').slice(0, 80));

    if (!body.synthetic) history.push({ role: 'user', content: body.text || '[Mengirim Media]' }); // prompt sistem bukan ucapan user
    history.push({ role: 'assistant', content: msg || '(Menjalankan perintah)' });
    saveHistory(userId, history);

    return {
      data: {
        msg,
        cmd,
        cfg: data.cfg || data.config || {},
        newRole,
        stickerQuery,
        mood,
        rayuan: Number(data.rayuan) || 0,
        energyreply: Boolean(data.energyreply),
      },
    };
  } catch (e) {
    console.error('[Reasoner Error]:', e.message);
    return { data: { cmd: null, msg: '', cfg: {}, mood: null }, error: e.message };
  }
}

export { ai, resetMemory, appendAssistantMemory };

global.resetAiMemory = resetMemory;
