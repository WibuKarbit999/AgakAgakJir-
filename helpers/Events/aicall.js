/*!-======[ Module Imports ]======-!*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';

/*!-======[ Function Imports ]======-!*/
const { transcribe } = await (fol[2] + 'transcribe.js').r();
const { ai, appendAssistantMemory } = await `${fol[2]}reasoner.js`.r();
const wm = await `${fol[1]}wifemood.js`.r();
const { transcribeSmart, hasForeignScript } = await (fol[2] + 'stt.js').r();

/*!-======[ Config ]======-!*/
// Format audio masuk BELUM terverifikasi di call hidup -> cek dulu dengan ".aicall test"
let SAMPLE_RATE = 16000; // ubah lewat ".aicall rate <hz>"
let VAD_RMS = 0.008; // ambang suara, ubah lewat ".aicall vad <rms>"
const FRAMES_PER_CHUNK = 320; // sesuai wasm-engine (framesPerChunk)
const MIN_SPEECH_MS = 250; // rentang awal-akhir suara; lebih pendek dari ini dianggap noise
const MIN_VOICED_MS = 120; // total frame yang benar2 bersuara (bicara pelan = frame bersuara jarang)
const PRE_ROLL_CHUNKS = 15; // simpan ~300ms sebelum suara mulai, supaya suku kata awal tidak terpotong
const MAX_UTTER_MS = 20000; // satu giliran maksimal
const IDLE_HANGUP_MS = 45000; // tidak ada yang bicara segini -> telpon ditutup
const MAX_CALL_MS = 10 * 60000; // batas durasi satu sesi
const RING_TIMEOUT = 45000;
const MIN_RING_FOR_REJECT_MS = 4000; // di bawah ini dianggap gagal teknis, bukan ditolak
const TEST_MS = 10000; // lama rekam di mode test
const BYE_RE =
  /\b(udah dulu|sudah dulu|tutup (telp|telepon|telpon)|matiin (telp|telepon|telpon)|matikan (telp|telepon|telpon)|dadah|daa+h|bye|sampai (jumpa|nanti)|selamat tinggal)\b/i;

const CALL_RULES = `

=== MODE TELEPON SUARA ===
- Kamu sedang berbicara lewat telepon; jawabanmu akan DIUCAPKAN lewat suara (TTS).
- Jawab SANGAT singkat: 1-2 kalimat pendek (maksimal sekitar 20 kata), bahasa lisan yang natural.
- DILARANG emoji, markdown, daftar, URL, atau menyebut nama perintah.
- Isi "cmd" dengan null; jawab hanya lewat "msg".
- Masukan adalah hasil transkripsi suara, bisa ada salah dengar. Kalau tidak jelas, minta diulang dengan sopan.
- Kalau lawan bicara ingin menutup telepon, ucapkan salam perpisahan singkat.`;

const CALL_RULES_NGOMEL = `

=== MODE TELEPON SUARA (NGOMEL / RINDU MARAH) ===
- Kamu sedang menelepon suami-mu karena dia LAMA BANGET tidak mengajakmu chat.
- Kamu kesal, manja, sedikit marah, tapi tetap sayang. Nada: ngomel manis yandere.
- Sapa dulu dengan nada kesal: tanya kenapa lama hilang, bilang kamu khawatir / cemburu / kangen.
- Jawab SANGAT singkat: 1-2 kalimat pendek (maksimal sekitar 20 kata), bahasa lisan natural (TTS).
- DILARANG emoji, markdown, daftar, URL, atau menyebut nama perintah.
- Isi "cmd" dengan null; jawab hanya lewat "msg".
- Kalau dia minta maaf atau merayu, pelan-pelan luluh. Kalau dia cuek, makin ngambek.
- Kalau lawan bicara ingin menutup telepon, ucapkan salam perpisahan singkat (bisa masih agak ngambek).`;

const CALL_RULES_KANGEN = `

=== MODE TELEPON SUARA (KANGEN) ===
- Kamu sedang menelepon suami-mu karena KANGEN dan ingin mendengar suaranya.
- Nada: manja, hangat, lembut, sedikit malu-malu tapi jujur bilang kangen.
- Sapa dengan singkat dan manis, bilang kamu kangen / ingin dengar suaranya.
- Jawab SANGAT singkat: 1-2 kalimat pendek (maksimal sekitar 20 kata), bahasa lisan natural (TTS).
- DILARANG emoji, markdown, daftar, URL, atau menyebut nama perintah.
- Isi "cmd" dengan null; jawab hanya lewat "msg".
- Kalau lawan bicara ingin menutup telepon, ucapkan salam perpisahan singkat yang hangat.`;

const CALL_RULES_BANGUN = `

=== MODE TELEPON SUARA (MEMBANGUNKAN) ===
- Kamu menelepon suami-mu untuk MEMBANGUNKANNYA, karena dia sendiri yang minta dibangunkan pagi ini.
- Nada: manja, lembut, sedikit gemas dan cerewet, tetap sayang. Boleh mengomel manis kalau dia masih ngantuk.
- Sapa singkat dan suruh dia bangun. Sebut waktu sesuai keterangan jam yang diberikan; jangan bilang pagi kalau sekarang bukan pagi.
- Jawab SANGAT singkat: 1-2 kalimat pendek (maksimal sekitar 20 kata), bahasa lisan natural (TTS).
- DILARANG emoji, markdown, daftar, URL, atau menyebut nama perintah.
- Isi "cmd" dengan null; jawab hanya lewat "msg".
- Pastikan dia benar-benar sudah melek: tanya sudah bangun atau belum. Kalau sudah, puji singkat lalu ucapkan salam perpisahan.
- Kalau lawan bicara ingin menutup telepon, ucapkan salam perpisahan singkat yang hangat.`;

/*!-======[ Tuning latensi telpon ]======-!*/
/**
 * cfg.call_tune (semua opsional, default aman):
 *   silenceMs    800    diam sekian ms = giliranmu dianggap selesai (makin kecil makin cepat, tapi bisa memotong kalimat)
 *   reasoning    'minimal'  thinking model AI saat telpon ('minimal'|'low'|'medium'|'high'; "" = tidak dikirim)
 *   historyLimit 10     jumlah pesan terakhir yang dikirim ke AI saat telpon
 *   ttsSpeed     0.9    kecepatan suara ElevenLabs (1.0 = normal)
 *   maxChars     160    batas panjang balasan yang diucapkan
 *   chunkTts     false  balasan 2 kalimat dipecah: kalimat 1 diputar selagi kalimat 2 dibuat (lebih cepat, EKSPERIMEN)
 *   timing       true   log ⏱ rincian waktu tiap giliran
 */
function tune() {
  const c = (typeof cfg !== 'undefined' && cfg?.call_tune) || {};
  const o = globalThis.__aicallTune || {}; // override live lewat .aicall silence
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    silenceMs: num(o.silenceMs ?? c.silenceMs, 800, 300, 2500),
    reasoning: c.reasoning === undefined ? 'minimal' : c.reasoning || '',
    historyLimit: num(c.historyLimit, 10, 2, 40),
    ttsSpeed: num(c.ttsSpeed, 0.9, 0.7, 1.2),
    maxChars: num(c.maxChars, 160, 60, 400),
    chunkTts: c.chunkTts === true,
    timing: c.timing !== false,
  };
}

/*!-======[ State ]======-!*/
const TMP_DIR = path.join(os.tmpdir(), 'aicall');
// Sesi disimpan di globalThis: modul ini di-import ulang lewat .r(), jadi variabel modul TIDAK dibagi antar instance.
const S = {
  get v() {
    return globalThis.__aicallSession || null;
  },
  set v(x) {
    globalThis.__aicallSession = x;
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = (f) => f && fs.promises.rm(f, { force: true }).catch(() => {});
const log = (...a) => console.log('[AICALL]', ...a);

/*!-======[ Helper: audio ]======-!*/
function rms(f) {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / (f.length || 1));
}

function concatF32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function pcmToWav(samples, rate) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

function wavToMp3(wav) {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffmpeg', [
        '-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '64k', 'pipe:1',
      ]);
      const out = [];
      p.stdout.on('data', (d) => out.push(d));
      p.on('error', () => resolve(null));
      p.on('close', (c) => resolve(c === 0 && out.length ? Buffer.concat(out) : null));
      p.stdin.on('error', () => {});
      p.stdin.end(wav);
    } catch {
      resolve(null);
    }
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
      ]);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(0));
      p.on('close', () => resolve(Math.round(parseFloat(out) * 1000) || 0));
    } catch {
      resolve(0);
    }
  });
}

/*!-======[ Helper: TTS (elevenlabs via termai, sama seperti voice di interactive.js) ]======-!*/
async function elevenToFile(text) {
  const voice = (typeof cfg !== 'undefined' && cfg?.ai_voice) || 'bella';
  const url = `${api.xterm.url}/api/text2speech/elevenlabs?key=${api.xterm.key}&text=${encodeURIComponent(
    text
  )}&voice=${voice}&speed=${tune().ttsSpeed}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const type = String(res.headers?.['content-type'] || '');
  if (type.includes('json') || type.includes('text')) {
    throw new Error('TTS gagal: ' + Buffer.from(res.data).toString().slice(0, 150));
  }
  if (!res.data?.length) throw new Error('TTS kosong');
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  await fs.promises.writeFile(file, Buffer.from(res.data));
  return file;
}

/** TTS: hanya ElevenLabs (tanpa fallback gTTS). Coba ulang 1x kalau gagal sesaat. */
async function ttsToFile(text) {
  try {
    return await elevenToFile(text);
  } catch (e) {
    console.error('[AICALL] ElevenLabs gagal, coba lagi 1x:', e?.message || e);
    await sleep(1200);
    return elevenToFile(text);
  }
}

/** Ambil JID kanonik lewat onWhatsApp (akun biasa & bisnis sama-sama dicek). */
async function resolveCallTarget(Exp, jid) {
  try {
    if (typeof Exp?.onWhatsApp !== 'function') return jid;
    const r = await Promise.race([Exp.onWhatsApp(jid), sleep(8000).then(() => null)]);
    const hit = Array.isArray(r) ? r.find((x) => x?.exists) : null;
    if (hit?.jid && !String(hit.jid).endsWith('@lid')) return hit.jid;
  } catch (e) {
    log('resolveCallTarget gagal:', e?.message || e);
  }
  return jid;
}

function cleanSpeech(t) {
  let s = String(t || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const maxChars = tune().maxChars;
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > 80 ? cut.slice(0, end + 1) : cut;
  }
  return s;
}

/*!-======[ Helper: call ]======-!*/
async function endAndWait(call) {
  if (!call) return;
  try {
    call.end();
  } catch {}
  try {
    if (typeof call.waitForEnd === 'function') {
      await Promise.race([call.waitForEnd().catch(() => {}), sleep(6000)]);
    } else {
      await sleep(2000);
    }
  } catch {}
}

function clearStaleFeeder(voip) {
  try {
    if (!voip || voip._activeCall) return;
    if (voip._feeder) {
      try { voip._feeder.stop(); } catch {}
      voip._feeder = null;
    }
    if (voip._audioStartTimer) {
      clearTimeout(voip._audioStartTimer);
      voip._audioStartTimer = null;
    }
  } catch {}
}

// Putar file ke call. Jangan pakai call.play(): kalau tidak ada track yang sedang jalan,
// play() akan memulai lalu langsung men-skip file yang baru mulai itu.
function speakFile(call, file) {
  const playing = !!call.nowPlaying?.();
  call.enqueue(file);
  if (playing) call.skip();
}

// tunggu sambil tetap memantau call masih hidup
async function sleepActive(s, ms) {
  const end = Date.now() + ms;
  while (s.active && Date.now() < end) await sleep(Math.min(200, end - Date.now()));
}

/** Pecah balasan jadi 2 bagian di batas kalimat (hanya kalau chunkTts aktif & cukup panjang). */
function splitSpeech(text) {
  const t = String(text || '').trim();
  if (!tune().chunkTts || t.length < 70) return [t];
  const m = t.match(/^([\s\S]{25,}?[.!?])\s+([\s\S]{15,})$/);
  return m ? [m[1], m[2]] : [t];
}

async function say(s, text, { tm } = {}) {
  const k = tune();
  const parts = splitSpeech(text);
  const tStart = Date.now();
  // semua bagian dibuat PARALEL; bagian ke-2 yang gagal cukup dilewati
  const jobs = parts.map((p, i) =>
    ttsToFile(p).catch((e) => {
      if (i === 0) throw e;
      console.error('[AICALL] TTS bagian 2 gagal:', e?.message || e);
      return null;
    })
  );
  const files = [];
  try {
    const f1 = await jobs[0];
    files.push(f1);
    if (!s.active) return;
    const dur1 = (await probeDuration(f1)) || 3000;
    speakFile(s.call, f1);
    const startedAt = Date.now();
    s.speakingUntil = startedAt + dur1 + 600;
    s.lastActivity = s.speakingUntil;
    log(`bicara (${dur1}ms): ${parts[0]}`);
    if (tm && k.timing) {
      log(
        `⏱ diam=${tm.detect - tm.lastVoice}ms stt=${tm.stt ?? '-'}ms ai=${tm.ai ?? '-'}ms ` +
          `tts=${startedAt - tStart}ms → suara mulai ${startedAt - tm.lastVoice}ms setelah kamu berhenti bicara` +
          (parts.length > 1 ? ' (pecah 2 bagian)' : '')
      );
    }
    if (jobs[1]) {
      const f2 = await jobs[1]; // biasanya sudah selesai selagi bagian 1 diputar
      if (f2) {
        files.push(f2);
        if (s.active) {
          const dur2 = (await probeDuration(f2)) || 2000;
          s.call.enqueue(f2); // antre di belakang bagian 1 (tanpa skip)
          const begin = Math.max(Date.now(), startedAt + dur1);
          s.speakingUntil = begin + dur2 + 600;
          s.lastActivity = s.speakingUntil;
          log(`bicara lanjutan (${dur2}ms): ${parts[1]}`);
        }
      }
    }
    await sleepActive(s, s.speakingUntil - Date.now());
  } finally {
    // PATCH: s.utt tidak dihapus lagi (berisi ucapan user yang ditangkap saat bot memproses). Echo sudah diblok di onAudio.
    s.pre = [];
    s.lastActivity = Date.now();
    for (const f of files) rm(f);
    if (jobs[1]) jobs[1].then((f) => rm(f)).catch(() => {}); // bersihkan kalau bagian 2 selesai belakangan
  }
}

/*!-======[ Core: tangkap suara lawan bicara ]======-!*/
function onAudio(s, pcm) {
  if (!s.active) return;
  const now = Date.now();
  if (now < s.speakingUntil) {
    // bot sedang bicara -> abaikan (cegah echo). Log (maks 1x/3 dtk) kalau ada suara yang terbuang.
    if (now - (s.lastDropLog || 0) > 3000 && rms(pcm) >= VAD_RMS) {
      s.lastDropLog = now;
      log('suara masuk diabaikan (bot sedang bicara)');
    }
    return;
  }

  // WAJIB disalin: pcm adalah view ke memori WASM yang ditimpa di tick berikutnya
  const f = pcm.slice();
  const level = rms(f);

  if (s.mode === 'test') {
    if (!s.rec) return;
    s.rec.chunks.push(f);
    s.rec.first ??= now;
    s.rec.last = now;
    s.rec.peak = Math.max(s.rec.peak, level);
    s.rec.sumRms += level;
    return;
  }

  // PATCH: dulu `if (s.busy) return;` -> ucapan saat bot memproses (STT/AI/TTS ~10 dtk) terbuang.
  // Sekarang tetap ditangkap; diproses setelah bot selesai bicara (echo tetap diblok lewat speakingUntil di atas).
  const thr = s.utt ? VAD_RMS * 0.6 : VAD_RMS; // hysteresis: setelah mulai, suku kata pelan di ujung tetap dihitung
  if (level >= thr) {
    if (!s.utt) {
      s.utt = { chunks: [...(s.pre || [])], voiced: 0, start: now, last: now, duringBusy: !!s.busy };
      if (s.busy) log('ucapan ditangkap saat bot memproses (akan diproses setelah bot selesai)');
      s.pre = [];
    }
    s.utt.last = now;
    s.utt.voiced++;
  }
  if (s.utt) {
    s.utt.chunks.push(f);
  } else {
    (s.pre ??= []).push(f);
    if (s.pre.length > PRE_ROLL_CHUNKS) s.pre.shift();
  }
}

/*!-======[ Core: satu giliran percakapan ]======-!*/
async function aiReply(s, text, { synthetic = false } = {}) {
  const { Exp, cht } = s;
  const { func } = Exp;
  const rules =
    s.mode === 'ngomel' ? CALL_RULES_NGOMEL
    : s.mode === 'kangen' ? CALL_RULES_KANGEN
    : s.mode === 'bangun' ? CALL_RULES_BANGUN
    : CALL_RULES;
  const wakeSulk = s.mode === 'bangun' && (s.cht?.wakeSulk || 0) > 0;
  const moodHint =
    s.mode === 'ngomel' || wakeSulk ? 'ngambek'
    : s.mode === 'kangen' || s.mode === 'bangun' ? 'manja'
    : (s.mood || null);
  const base = {
    text,
    fullainame: botfullname,
    nickainame: botnickname,
    ownerName: ownername,
    date: func.newDate(),
    msgtype: 'telepon suara (ucapan lawan bicara, hasil transkripsi)',
    mood: moodHint,
    ...(synthetic ? { synthetic: true } : {}),
    reasoning: tune().reasoning,
    historyLimit: tune().historyLimit,
    custom_profile:
      func.tagReplacer(cfg.logic, { botfullname, botnickname }) +
      rules +
      `\n- Waktu sekarang: ${dayNow()}. Riwayat percakapan lama bisa berasal dari waktu lain (mis. pagi); patuhi waktu sekarang dan jangan menyapa "pagi" kalau sekarang bukan pagi.` +
      (wakeSulk
        ? '\n- Kamu MASIH NGAMBEK pada suami-mu, tapi tetap menepati permintaannya untuk membangunkan. Nada ketus dan ngomel manis, jangan luluh sendiri, jangan mesra berlebihan.'
        : ''),
  };

  let body;
  if (s.self) {
    const chatCount = cht?.memories?.chat;
    body = {
      ...base,
      id:
        s.mode === 'bangun'
          ? `aicall-bangun:${s.number}` // percakapan bangunin tidak dicampur ke riwayat utama
          : cht.fake
            ? `${s.number}@s.whatsapp.net`
            : await func.getSender(cht.sender, { cht, lid: false }),
      senderName: cht.pushName,
      role: cht?.memories?.role?.split(',')[0],
      ...(typeof chatCount === 'number' ? { chatCount } : {}),
    };
  } else {
    // owner menelpon nomor lain: lawan bicara BUKAN owner -> jangan pakai role/memori owner
    body = {
      ...base,
      id: `aicall:${s.number}`,
      senderName: s.number,
      role: `Orang yang ditelpon ${ownername}`,
    };
  }

  // Mood terpadu (helpers/wifemood.js): telepon juga memengaruhi & dipengaruhi mood
  const wUid = s.self ? wm.uidOf(s.number) : null;
  const wOn = !!(wUid && wm.wife(wUid));
  if (wOn) {
    if (!synthetic) wm.onUserMessage(wUid, text, { via: 'call' });
    const extra = wm.moodPrompt(wUid, { via: 'call' });
    if (extra) body.custom_profile += extra;
    const cm = wm.currentMood(wUid);
    if (cm) body.mood = cm;
  }

  const res = await ai(body);
  if (wOn && !synthetic) wm.applyAiResult(wUid, res?.data, { via: 'call', allowEnter: false });
  try { await func.addAiResponse?.(); } catch {}
  if (res?.data?.mood) s.mood = res.data.mood;
  log(`ai mood=${res?.data?.mood || '-'} msg=${(res?.data?.msg || '').slice(0, 60)}`);
  // newRole/cmd sengaja diabaikan di mode telpon
  return cleanSpeech(res?.data?.msg);
}

/** Sapaan di telepon — digenerate AI biar tidak template */
async function generateCallGreeting(s) {
  const prompt =
    s.mode === 'ngomel'
      ? 'Kamu baru saja menelpon suami-mu karena dia lama banget tidak mengajakmu chat. Sapa dia di telepon dengan nada kesal/manja/ngomel (1-2 kalimat singkat, bahasa lisan). Jangan pakai emoji.'
      : s.mode === 'bangun'
        ? s.cht?.wakeSulk
          ? 'Kamu menelpon suami-mu untuk membangunkannya sesuai permintaannya sendiri, tapi kamu MASIH NGAMBEK padanya. Sapa dengan nada ketus dan ngomel (contoh gaya: bangun, aku masih kesel ya), suruh dia bangun (1-2 kalimat singkat, bahasa lisan). Jangan pakai emoji.'
          : 'Kamu baru saja menelpon suami-mu untuk membangunkannya, sesuai permintaannya sendiri. Sapa dia di telepon dengan nada manja, lembut, sedikit gemas, suruh dia bangun, dan sebut waktu yang benar sesuai keterangan waktu (1-2 kalimat singkat, bahasa lisan). Jangan pakai emoji.'
      : s.mode === 'kangen'
        ? 'Kamu baru saja menelpon suami-mu karena kangen dan ingin mendengar suaranya. Sapa dia di telepon dengan nada manja dan hangat (1-2 kalimat singkat, bahasa lisan). Jangan pakai emoji.'
        : 'Sapa lawan bicara di telepon secara natural (1 kalimat singkat).';
  const prompt2 = s.mode === 'bangun' ? `${prompt} Keterangan waktu: sekarang ${dayNow()}. Jangan bilang pagi kalau bukan pagi.` : prompt;
  try {
    const line = await aiReply(s, prompt2, { synthetic: true });
    if (line && line.length > 3) return line;
  } catch (e) {
    console.error('[AICALL] generateCallGreeting:', e?.message || e);
  }
  if (s.mode === 'ngomel') return `Hai... kamu di mana aja sih? Lama banget hilang.`;
  if (s.mode === 'kangen') return `Halo sayang... aku kangen, pengen dengar suara kamu.`;
  if (s.mode === 'bangun') return `Sayang, bangun yuk... jangan tidur lagi.`;
  return `Halo, ini ${botnickname}. Ada apa?`;
}

/** Pesan chat susulan (ngambek / dicuekin / reda) — digenerate AI */
const KIND_TEXT = {
  reject: 'Suami-mu MENOLAK (me-reject) teleponmu setelah lama tidak mengabari.',
  missed: 'Suami-mu tidak mengangkat teleponmu (sudah dicoba lebih dari sekali) setelah lama tidak mengabari.',
  ignored: 'Suami-mu masih saja diam dan tidak membalas apa pun sejak kamu ngambek.',
  kangen: 'Kamu tiba-tiba KANGEN pada suami-mu dan ingin menyapanya duluan lewat chat (bukan karena marah).',
  bangun: 'Kamu ingin MEMBANGUNKAN suami-mu sesuai permintaannya sendiri, dan kamu menyapanya duluan lewat chat (bukan karena marah).',
  reda: 'Ngambekmu pada suami-mu mulai reda dengan sendirinya karena sudah lama dia tidak merayu. Kamu masih gengsi.',
};

async function generateNgambekChat({ Exp, number, name, role, chatCount, kind = 'reject', level = 1, sulk = 0 }) {
  const { func } = Exp;
  try {
    const nada =
      kind === 'bangun' && sulk
        ? 'nada ketus dan ngomel karena kamu MASIH NGAMBEK, tapi tetap membangunkan sesuai permintaannya (contoh gaya: bangun. aku masih kesel ya), jangan manis berlebihan'
      : kind === 'bangun'
        ? level > 1
          ? 'nada gemas dan sedikit cerewet karena dia belum juga bangun padahal sudah dibangunkan beberapa kali, tetap sayang, tanpa marah beneran'
          : 'nada manja, lembut, singkat, membangunkan dengan sayang (contoh gaya: bangun sayang), tanpa marah'
      : kind === 'kangen'
        ? 'nada manja, hangat, jujur bilang kangen, boleh menyebut ingin mendengar suaranya, tanpa marah'
        : kind === 'reda'
        ? 'nada gengsi tapi mulai melunak, memancing dia untuk merayu lagi'
        : `nada ngambek level ${level} dari 3, cuek, sedikit marah tapi masih sayang (yandere), memancing dia untuk merayu`;
    const res = await ai({
      text: `${KIND_TEXT[kind] || KIND_TEXT.reject} Tulis SATU pesan chat WhatsApp singkat (maksimal 2 kalimat), ${nada}.${kind === 'bangun' ? ` Waktu sekarang ${dayNow()}; jangan bilang pagi kalau bukan pagi.` : ''} Jangan pakai emoji berlebihan. Jangan bilang kamu AI.`,
      id: `wifecall-ngambek:${number}`,
      fullainame: botfullname,
      nickainame: botnickname,
      senderName: name || number,
      ownerName: ownername,
      date: func.newDate(),
      role: role || '🤍Suami🤍',
      mood: sulk ? 'ngambek' : kind === 'kangen' || kind === 'bangun' ? 'manja' : kind === 'reda' ? 'normal' : 'ngambek',
      chatCount: chatCount || 0,
      msgtype: 'sistem (generate pesan susulan, bukan pesan dari user)',
      synthetic: true,
      custom_profile:
        func.tagReplacer(cfg.logic, { botfullname, botnickname }) +
        '\n- Tulis pesan chat yang natural, bukan template kaku.',
    });
    const msg = cleanSpeech(res?.data?.msg);
    if (msg && msg.length > 5) return msg;
  } catch (e) {
    console.error('[WIFECALL] generateNgambekChat:', e?.message || e);
  }
  const pool = FALLBACK_TEXTS[kind] || FALLBACK_TEXTS.reject;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function handleTurn(s, utt) {
  s.busy = true;
  const tm = { lastVoice: utt.last, detect: Date.now() }; // waktu suara terakhir & saat giliran terdeteksi selesai
  try {
    const wav = pcmToWav(concatF32(utt.chunks), SAMPLE_RATE);
    const t0 = Date.now();
    const { text: rawText, engine, failed } = await transcribeSmart(wav, { transcribe });
    const text = String(rawText || '').trim();
    tm.stt = Date.now() - t0;
    log(`STT[${engine}] ${tm.stt}ms:`, JSON.stringify(text));
    if (failed) {
      // STT gagal total (bukan sekadar sunyi): jangan kirim apa pun ke AI, minta ulang
      if (Date.now() - (s.lastUnclear || 0) > 15000) {
        s.lastUnclear = Date.now();
        await say(s, 'Hah? Suaranya kurang jelas, ulangi dong sayang.').catch(() => {});
      }
      return;
    }
    if (text.length < 2) return;

    // Hasil beraksara asing (Jepang/Cina/Korea/Arab/dll) hampir pasti salah tebak bahasa -> jangan dikirim ke AI
    if (cfg?.call_stt?.dropForeignScript !== false && hasForeignScript(text)) {
      log('STT dibuang (aksara asing):', JSON.stringify(text));
      if (Date.now() - (s.lastUnclear || 0) > 15000) {
        s.lastUnclear = Date.now();
        await say(s, 'Hah? Suaranya kurang jelas, ulangi dong sayang.').catch(() => {});
      }
      return;
    }

    if (BYE_RE.test(text)) {
      await say(s, 'Oke, sampai nanti ya!').catch(() => {});
      await finish(s);
      return;
    }

    if (s.mode === 'bangun') {
      const mins = parseSnooze(text);
      if (mins) {
        const r = snoozeWake(s.number, mins);
        if (r > 0) {
          await say(s, `Oke, ${r} menit lagi ya. Awas kalau tidur lagi.`).catch(() => {});
          await finish(s);
          return;
        }
        if (r < 0) {
          await say(s, 'Sudah beberapa kali kamu tunda lho. Bangun sekarang ya sayang.').catch(() => {});
          return;
        }
      }
    }

    const tAi = Date.now();
    const reply = await aiReply(s, text);
    tm.ai = Date.now() - tAi;
    if (!reply) return;
    await say(s, reply, { tm });
  } catch (e) {
    console.error('[AICALL] turn error:', e?.message || e);
  } finally {
    s.busy = false;
    // PATCH: s.utt tidak dihapus (ucapan yang masuk saat memproses tetap diproses di giliran berikut)
    s.lastActivity = Date.now();
  }
}

/*!-======[ Core: mode test (rekam suara masuk, kirim ke chat) ]======-!*/
async function runTest(s) {
  const { Exp, cht } = s;
  try {
    await say(s, 'Tes rekaman. Silakan bicara selama sepuluh detik.').catch((e) =>
      console.error('[AICALL] TTS test gagal:', e?.message || e)
    );
    s.rec = { chunks: [], first: null, last: null, peak: 0, sumRms: 0 };
    await sleepActive(s, TEST_MS);
    const rec = s.rec;
    s.rec = null;

    if (!rec.chunks.length) {
      await cht.reply(
        '❌ Tidak ada audio masuk dari lawan bicara (event "audio" tidak pernah datang atau semuanya senyap).',
        { replyAi: false }
      );
      return;
    }

    const samples = concatF32(rec.chunks);
    const spanSec = Math.max(0.001, (rec.last - rec.first) / 1000);
    const effRate = Math.round(samples.length / spanSec);
    const wav = pcmToWav(samples, SAMPLE_RATE);
    const mp3 = await wavToMp3(wav);

    await Exp.sendMessage(
      cht.id,
      mp3
        ? { audio: mp3, mimetype: 'audio/mpeg' }
        : { audio: wav, mimetype: 'audio/wav' },
      { quoted: cht }
    );
    await cht.reply(
      '🎙️ *HASIL TES REKAM*\n\n' +
        `• Chunk       : ${rec.chunks.length}\n` +
        `• Sample      : ${samples.length}\n` +
        `• Rentang     : ${spanSec.toFixed(1)} detik\n` +
        `• Rate efektif: ~${effRate} Hz (akurat kalau kamu bicara terus tanpa jeda)\n` +
        `• RMS puncak  : ${rec.peak.toFixed(4)}\n` +
        `• RMS rata2   : ${(rec.sumRms / rec.chunks.length).toFixed(4)}\n` +
        `• Rate dipakai: ${SAMPLE_RATE} Hz | VAD: ${VAD_RMS}\n\n` +
        'Dengarkan VN di atas:\n' +
        '• suara normal → rate sudah benar\n' +
        '• terdengar cepat/cempreng → rate asli lebih rendah\n' +
        '• terdengar lambat/berat → rate asli lebih tinggi\n' +
        'Atur dengan .aicall rate <hz>, lalu tes lagi.',
      { replyAi: false }
    );
  } catch (e) {
    console.error('[AICALL] test error:', e?.message || e);
    await cht.reply('❌ Tes gagal: ' + (e?.message || e), { replyAi: false }).catch(() => {});
  } finally {
    await finish(s);
  }
}

/*!-======[ Session lifecycle ]======-!*/
async function finish(s) {
  if (!s || s.finishing) return;
  s.finishing = true;
  s.active = false;
  clearInterval(s.tick);
  clearTimeout(s.ringTimer);
  clearTimeout(s.maxTimer);
  await endAndWait(s.call);
  if (S.v === s) S.v = null;
  await sleep(1500); // beri waktu native call benar2 lepas
  clearStaleFeeder(s.Exp.voip);
  s.resolveDone();
}

function tickLoop(s) {
  if (!s.active) return;
  const now = Date.now();

  if (s.mode !== 'test' && !s.busy && now >= s.speakingUntil) {
    if (s.utt && (now - s.utt.last > tune().silenceMs || now - s.utt.start > MAX_UTTER_MS)) {
      const u = s.utt;
      s.utt = null;
      const voicedMs = u.voiced * ((FRAMES_PER_CHUNK / SAMPLE_RATE) * 1000);
      const spanMs = u.last - u.start;
      if (voicedMs >= MIN_VOICED_MS && spanMs >= MIN_SPEECH_MS) {
        s.spoke = true; // user bersuara minimal sekali
        if (u.duringBusy) log(`memproses ucapan yang ditangkap saat busy (bersuara ${Math.round(voicedMs)}ms, rentang ${Math.round(spanMs)}ms)`);
        handleTurn(s, u);
      } else {
        log(`suara terlalu pendek (bersuara ${Math.round(voicedMs)}ms, rentang ${Math.round(spanMs)}ms${u.duringBusy ? ', ditangkap saat busy' : ''}), diabaikan`);
      }
      return;
    }
    if (!s.utt && now - s.lastActivity > IDLE_HANGUP_MS) {
      log('tidak ada aktivitas, telpon ditutup');
      s.busy = true;
      say(s, 'Kayaknya sudah selesai ya. Aku tutup dulu.')
        .catch(() => {})
        .finally(() => finish(s));
    }
  }
}

/** answered | missed (tidak diangkat sampai timeout) | rejected (ditutup saat berdering) | failed (tidak pernah berdering) */
function classifyCall(s) {
  if (s?.connectedAt) return 'answered';
  if (s?.timedOut) return 'missed';
  // Reject manusiawi butuh waktu (lihat layar, tekan tolak). Putus < 4 detik setelah ringing = gangguan jaringan, bukan reject.
  if (s?.ringingAt) {
    const ringMs = (s.endedAt || Date.now()) - s.ringingAt;
    return ringMs >= MIN_RING_FOR_REJECT_MS ? 'rejected' : 'failed';
  }
  return 'failed';
}

async function waitFeeder(s, ms = 6000) {
  const end = Date.now() + ms;
  while (s.active && Date.now() < end) {
    if (s.call.nowPlaying?.()) return true;
    await sleep(150);
  }
  return !!s.call.nowPlaying?.();
}

async function startSession({ cht, Exp, target, number, self, mode }) {
  const call = await Promise.race([
    Exp.voip.call(target, {
      audioSource: 'silence',
      endWhenQueueEmpty: false, // jangan tutup otomatis saat tidak ada lagu
      audioStartDelayMs: 800,
      durationMs: MAX_CALL_MS + RING_TIMEOUT,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('call_timeout')), 20000)),
  ]);
  if (!call) throw new Error('voip.call() mengembalikan object kosong');

  const s = {
    call, Exp, cht, mode, number, self,
    active: true, finishing: false, busy: false,
    utt: null, rec: null,
    speakingUntil: 0, lastActivity: Date.now(), connectedAt: 0,
    tick: null, ringTimer: null, maxTimer: null,
  };
  s.done = new Promise((r) => (s.resolveDone = r));
  S.v = s;

  call.on('ringing', () => {
    log('ringing');
    s.ringingAt ??= Date.now();
  });
  call.on('audio', (pcm) => {
    try { onAudio(s, pcm); } catch (e) { console.error('[AICALL] onAudio:', e?.message || e); }
  });
  call.on('ended', (reason) => {
    log('ended:', reason);
    s.endReason ??= String(reason?.message || reason || '');
    s.endedAt ??= Date.now();
    finish(s);
  });
  call.on('error', (err) => {
    console.error('[AICALL] call error:', err?.message || err);
    s.endReason ??= String(err?.message || err || 'error');
    finish(s);
  });
  call.on('connected', async () => {
    log('connected');
    s.connectedAt = Date.now();
    s.lastActivity = Date.now();
    clearTimeout(s.ringTimer);
    s.maxTimer = setTimeout(() => finish(s), MAX_CALL_MS);
    s.tick = setInterval(() => tickLoop(s), 100);

    const ready = await waitFeeder(s);
    if (!ready) log('feeder belum siap, lanjut');

    if (s.mode === 'test') return runTest(s);

    s.busy = true;
    try {
      // Sapaan digenerate AI (mode ngomel = ngomel dinamis, bukan template)
      const greeting = await generateCallGreeting(s);
      await say(s, greeting);
    } catch (e) {
      console.error('[AICALL] greeting gagal:', e?.message || e);
    } finally {
      s.busy = false;
      s.lastActivity = Date.now();
    }
  });

  // PATCH: 'ended' bisa terpicu SINKRON di dalam voip.call() (gagal setup), sebelum listener di atas terpasang.
  // Tanpa cek ini bot menunggu sampai ring timeout lalu salah melapor "tidak diangkat".
  if (call._ended) {
    log('call sudah berakhir saat setup (offer tidak terkirim / tidak pernah berdering)');
    s.endReason ??= 'gagal saat setup panggilan (offer tidak terkirim)';
    s.endedAt ??= Date.now();
    finish(s);
    await s.done;
    return s;
  }

  s.ringTimer = setTimeout(() => {
    if (!s.connectedAt) {
      log('tidak diangkat');
      s.rejected = true;
      s.timedOut = true;
      if (!s.silentChat) {
        cht.reply('⏱️ Tidak diangkat.', { replyAi: false }).catch(() => {});
      }
      finish(s);
    }
  }, RING_TIMEOUT);

  await s.done;
  return s;
}

/*!-======[ Event ]======-!*/
export default async function on({ cht, Exp, ev, is }) {
  const { sender } = cht;
  const { func } = Exp;

  ev.on(
    {
      cmd: ['aicall'],
      listmenu: ['aicall'],
      tag: 'ai',
      energy: 0,
    },
    async ({ args }) => {
      const text = (args || '').trim();
      const parts = text.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      /* ---- akses: HANYA owner & role 🤍Suami🤍 ---- */
      const isOwner = !!is?.owner;
      let isSuami = /suami/i.test(cht?.memories?.role?.split(',')[0] || '');
      if (!isOwner && !isSuami) {
        try {
          isSuami = wm.isListed(await func.getSender(sender, { cht, lid: false }));
        } catch {}
      }
      if (!isOwner && !isSuami) {
        return cht.reply('🔒 Fitur telpon cuma buat owner, 🤍Suami🤍, & nomor terdaftar.', { replyAi: false });
      }
      const adminCmds = ['status', 'end', 'stop', 'reset', 'test', 'rate', 'vad', 'diag', 'silence'];
      if (!isOwner && adminCmds.includes(sub)) {
        return cht.reply('🔒 Perintah ini cuma buat owner.', { replyAi: false });
      }

      if (sub === 'help') {
        return cht.reply(
          '*AI CALL*\n\n' +
            '.aicall (AI menelpon & ngobrol denganmu)\n' +
            '.aicall <nomor> (owner: telpon nomor lain)\n' +
            '.aicall test [nomor] (rekam 10 detik suara lawan -> kirim VN)\n' +
            '.aicall end | status | reset\n' +
            '.aicall rate <hz> | vad <rms> | silence <ms>\n' +
            '.aicall diag <nomor> (cek nomor biasa/bisnis)\n' +
            '.aicall kangen (AI menelpon dengan nada kangen)\n' +
            '.bangunin 06.00-07.30 (AI chat lalu telpon berulang sampai kamu bangun)'
        );
      }

      if (sub === 'diag') {
        const n = (parts[1] || '').replace(/\D/g, '');
        if (n.length < 10) return cht.reply('Contoh: .aicall diag 628xxx');
        const jid = n + '@s.whatsapp.net';
        const out = ['🔎 *AICALL DIAG* ' + n];
        try {
          const r = await Exp.onWhatsApp(jid);
          out.push('• onWhatsApp : ' + JSON.stringify(r));
        } catch (e) {
          out.push('• onWhatsApp : ERR ' + (e?.message || e));
        }
        try {
          const bp = await Exp.getBusinessProfile(jid);
          out.push('• Bisnis     : ' + (bp ? 'YA (' + (bp.description ? 'ada profil' : 'tanpa deskripsi') + ')' : 'bukan / tidak terbaca'));
        } catch (e) {
          out.push('• Bisnis     : tidak terbaca (' + (e?.message || e) + ')');
        }
        const lid = ((typeof Data !== 'undefined' && Data.lids) || []).find((a) => a.id === jid)?.lid;
        out.push('• LID        : ' + (lid || '-'));
        out.push('• VoIP       : ' + (Exp.voip ? 'ready' : 'tidak ada'));
        out.push('\nCoba .aicall ' + n + ' lalu lihat log [AICALL] ended:/error.');
        return cht.reply(out.join('\n'), { replyAi: false });
      }

      if (sub === 'status') {
        return cht.reply(
          '📡 *AICALL STATUS*\n\n' +
            `• VoIP     : ${Exp.voip ? '🟢 Ready' : '🔴 Tidak ada'}\n` +
            `• Sesi     : ${S.v ? `📞 ${S.v.mode} → ${S.v.number}` : '📴 Tidak ada'}\n` +
            `• Rate     : ${SAMPLE_RATE} Hz\n` +
            `• VAD RMS  : ${VAD_RMS}\n` +
            `• Diam     : ${tune().silenceMs} ms\n` +
            `• Reasoning: ${tune().reasoning || '(default model)'} | riwayat ${tune().historyLimit} pesan | TTS ${tune().ttsSpeed}x | pecah TTS ${tune().chunkTts ? 'ON' : 'off'}`
        );
      }

      if (sub === 'end' || sub === 'stop') {
        if (!S.v) return cht.reply('📵 Tidak ada sesi aktif.');
        await finish(S.v);
        return cht.reply('📵 Sesi ditutup.');
      }

      if (sub === 'reset') {
        try {
          if (S.v) await finish(S.v);
          S.v = null;
          globalThis.__wifeCalling = false;
          if (Exp.voip) {
            Exp.voip._activeCall = null;
            clearStaleFeeder(Exp.voip);
          }
          return cht.reply('🔄 Sesi aicall di-reset.');
        } catch (e) {
          return cht.reply('❌ Reset gagal: ' + (e?.message || e));
        }
      }

      if (sub === 'rate') {
        const v = parseInt(parts[1], 10);
        if (!v || v < 8000 || v > 96000) return cht.reply('Contoh: .aicall rate 16000');
        SAMPLE_RATE = v;
        return cht.reply(`✅ Rate audio masuk = ${v} Hz`);
      }

      if (sub === 'silence') {
        const v = parseInt(parts[1], 10);
        if (!v || v < 300 || v > 2500) {
          return cht.reply(`Contoh: .aicall silence 700 (sekarang ${tune().silenceMs} ms, rentang 300-2500)`);
        }
        globalThis.__aicallTune = { ...(globalThis.__aicallTune || {}), silenceMs: v };
        return cht.reply(`✅ Diam ${v} ms = giliran selesai (sampai bot restart; permanen: cfg.call_tune.silenceMs)`);
      }

      if (sub === 'vad') {
        const v = parseFloat(parts[1]);
        if (!v || v <= 0 || v > 0.5) return cht.reply('Contoh: .aicall vad 0.012');
        VAD_RMS = v;
        return cht.reply(`✅ Ambang VAD (RMS) = ${v}`);
      }

      /* ---- mulai sesi ---- */
      const mode = sub === 'test' ? 'test' : sub === 'ngomel' ? 'ngomel' : sub === 'kangen' ? 'kangen' : 'chat';
      const rest = (mode === 'chat' ? parts : parts.slice(1)).join(' ');

      if (!Exp.voip) return cht.reply('❌ VoIP client belum siap. Cek log [VOIP] di console.');
      if (S.v) return cht.reply('📞 Masih ada sesi aicall. Pakai .aicall end / .aicall reset.');
      if (Exp.voip._activeCall) {
        return cht.reply('📞 Ada panggilan lain yang sedang aktif (mis. playcall). Tunggu selesai.');
      }

      let target = sender;
      let self = true;
      const num = rest.match(/(?:^|\s)\+?(\d{10,15})(?=\s|$)/);
      if (num) {
        if (!isOwner) {
          return cht.reply('🔒 Menelpon nomor lain cuma buat owner.', { replyAi: false });
        }
        target = num[1] + '@s.whatsapp.net';
        self = false;
      } else if (target.endsWith('@lid')) {
        // voip.call() hanya mengambil ANGKA -> LID harus diterjemahkan ke nomor asli
        try {
          target = await func.getSender(sender, { cht, lid: false });
        } catch {}
        if (target?.endsWith('@lid')) {
          const lids = (typeof Data !== 'undefined' && Data.lids) || [];
          target = lids.find((a) => a.lid === sender)?.id || target;
        }
      }
      if (!target || target.endsWith('@lid')) {
        return cht.reply(
          '❌ Nomor kamu belum terbaca (LID).\nTulis nomor: .aicall 628xxx',
          { replyAi: false }
        );
      }

      target = await resolveCallTarget(Exp, target);
      const number = target.split('@')[0];
      log(`mulai sesi mode=${mode} target=${target} self=${self}`);
      await cht.reply(
        mode === 'test'
          ? `🎙️ Mode tes: menelpon ${number}... Setelah diangkat, bicara 10 detik.`
          : `📞 Menelpon ${number}...`,
        { replyAi: false }
      );

      clearStaleFeeder(Exp.voip);
      try {
        const ses = await startSession({ cht, Exp, target, number, self, mode });
        const res = classifyCall(ses);
        if (res === 'failed') {
          await cht.reply(
            `❌ Telpon tidak tersambung (tidak pernah berdering).\nAlasan: ${ses?.endReason || 'tidak diketahui'}\nCoba .aicall diag ${number}`,
            { replyAi: false }
          );
        } else if (mode !== 'test') {
          await cht.reply('📵 Telpon AI berakhir.', { replyAi: false });
        }
      } catch (e) {
        console.error('[AICALL] gagal:', e);
        if (S.v) await finish(S.v);
        await cht.reply(`❌ Gagal menelpon:\n${e?.message || e}`, { replyAi: false });
      }
    }
  );

  /* ---- .wifecall : opt-out, status, dan alat tes ---- */
  ev.on(
    {
      cmd: ['wifecall'],
      listmenu: ['wifecall'],
      tag: 'ai',
      energy: 0,
    },
    async ({ args }) => {
      const isOwner = !!is?.owner;
      const roleStr = cht?.memories?.role?.split(',')[0] || '';
      if (!isOwner && !wm.isSuami(roleStr)) {
        return cht.reply('🔒 Fitur ini cuma buat owner & 🤍Suami🤍.', { replyAi: false });
      }
      let uid = wm.uidOf(sender);
      if (!global.Data?.users?.[uid]) {
        try {
          uid = wm.uidOf(await func.getSender(sender, { cht, lid: false }));
        } catch {}
      }
      const [sub = 'status', ...rest] = String(args || '').trim().split(/\s+/);
      const s0 = sub.toLowerCase();
      const ownerOnly = ['ngambek', 'maaf', 'reset', 'tes', 'test'];
      if (ownerOnly.includes(s0) && !isOwner) {
        return cht.reply('🔒 Perintah ini cuma buat owner.', { replyAi: false });
      }
      const opt = { force: isOwner };

      if (s0 === 'help') {
        return cht.reply(
          '*WIFE CALL*\n\n' +
            '.wifecall status\n' +
            '.wifecall off | on  (matikan/nyalakan telpon & ngambek otomatis)\n' +
            '(owner) .wifecall ngambek [1-3] | maaf | reset | tes'
        );
      }
      if (s0 === 'on' || s0 === 'off') {
        const w = wm.setOptOut(uid, s0 === 'off', opt);
        if (!w) return cht.reply('❌ Data kamu tidak ditemukan.', { replyAi: false });
        return cht.reply(
          s0 === 'off'
            ? '🔕 Oke, telpon otomatis dimatikan. Aku nggak akan nelpon kamu duluan lagi.'
            : '🔔 Telpon otomatis dinyalakan lagi.',
          { replyAi: false }
        );
      }
      if (s0 === 'ngambek') {
        const lv = Math.min(3, Math.max(1, parseInt(rest[0], 10) || 1));
        wm.enterNgambek(uid, { reason: 'ai', level: lv, force: true });
        return cht.reply(`😤 (tes) status ngambek level ${lv} diset.\n\n` + wm.status(uid, opt), { replyAi: false });
      }
      if (s0 === 'maaf') {
        wm.forgive(uid, 'owner', { force: true });
        return cht.reply('💞 (tes) ngambek dihapus.\n\n' + wm.status(uid, opt), { replyAi: false });
      }
      if (s0 === 'reset') {
        wm.resetAll(uid, { force: true });
        return cht.reply('🔄 (tes) state wife di-reset.', { replyAi: false });
      }
      if (s0 === 'tes' || s0 === 'test') {
        await cht.reply('📞 (tes) memicu telpon otomatis sekarang, abaikan jam idle...', { replyAi: false });
        const out = await tryWifeAutoCall(Exp, uid, { force: true });
        return cht.reply(`📋 Hasil: *${out}*\n\n` + wm.status(uid, opt), { replyAi: false });
      }
      return cht.reply(wm.status(uid, opt), { replyAi: false });
    }
  );

  /* ---- .bangunin : jadwal bangunin pagi (chat dulu -> telpon berulang sampai bangun) ---- */
  ev.on(
    {
      cmd: ['bangunin', 'wakecall', 'bangunkan'],
      listmenu: ['bangunin'],
      tag: 'ai',
      energy: 0,
    },
    async ({ args, cht: evCht }) => {
      const isOwner = !!is?.owner;
      // ev.emit() hanya meneruskan {media,urls,args,cht,...}; penanda "dari obrolan AI" dititipkan di cht.wakeVia
      const viaAi = (evCht?.wakeVia ?? cht?.wakeVia) === 'ai';
      let allowed = isOwner || /suami/i.test(cht?.memories?.role?.split(',')[0] || '');
      let me = '';
      try {
        me = wm.uidOf(await func.getSender(sender, { cht, lid: false }));
      } catch {}
      if (!me || me.length > 16) me = wm.uidOf(sender);
      if (!allowed) allowed = wm.isListed(me);
      if (!allowed) {
        return cht.reply('🔒 Fitur ini cuma buat owner, 🤍Suami🤍, & nomor terdaftar.', { replyAi: false });
      }

      const text = String(args || '').trim();
      const low = text.toLowerCase();
      let uid = me;
      const numM = text.match(/(?:^|\s)\+?(\d{10,15})(?=\s|$)/);
      if (numM) {
        if (!isOwner) return cht.reply('🔒 Bangunin nomor lain cuma buat owner.', { replyAi: false });
        let n = numM[1];
        if (n.startsWith('0')) n = '62' + n.slice(1);
        uid = wm.uidOf(n);
      }
      if (!global.Data?.users?.[uid]) {
        return cht.reply(`❌ Data ${uid} belum ada (nomor itu belum pernah chat ke bot).`, { replyAi: false });
      }

      if (/^help\b/.test(low)) {
        return cht.reply(
          '*BANGUNIN*\n\n' +
            '.bangunin 06.00-07.30 (sekali, hari ini / besok)\n' +
            '.bangunin 06.00-07.30 tiap hari\n' +
            '.bangunin 06.30 (jendela default 60 menit)\n' +
            '.bangunin status | off\n' +
            '.bangunin snooze 10 (tunda; bisa juga ketik/ucap "5 menit lagi")\n' +
            '(owner) .bangunin 628xxx 06.00-07.30\n\n' +
            'Alur: chat "bangun" -> beberapa detik -> telpon. Kalau tidak diangkat, telpon lagi dengan jeda makin lama. ' +
            'Berhenti kalau telpon diangkat, kamu chat apa saja, atau jam batas habis.',
          { replyAi: false }
        );
      }
      if (!text || /^(status|cek|info)\b/.test(low)) {
        return cht.reply(wakeStatusText(uid), { replyAi: false });
      }
      if (/^(off|batal|batalkan|cancel|stop|matikan|hapus)\b/.test(low)) {
        const wk = getWake(uid);
        if (!wk?.on) return cht.reply('⏰ Tidak ada jadwal bangunin yang aktif.', { replyAi: false });
        cancelWake(uid);
        return cht.reply('⏰ Jadwal bangunin dibatalkan.', { replyAi: false });
      }

      const snz = parseSnooze(text);
      if (snz) {
        const r = snoozeWake(uid, snz);
        if (r > 0) return cht.reply(`⏰ Oke, ditunda ${r} menit. Aku telpon lagi nanti.`, { replyAi: false });
        if (r < 0) return cht.reply('⏰ Batas tunda sudah habis, bangun sekarang ya 😤', { replyAi: false });
        return cht.reply('⏰ Tidak ada sesi bangunin yang sedang berjalan.', { replyAi: false });
      }
      const p = parseWake(text);
      if (!p) {
        return cht.reply('❓ Jamnya belum kebaca. Contoh: .bangunin 06.00-07.30', { replyAi: false });
      }
      // lewat obrolan + ngambek banget: ditolak (cadangan; interactive.js sudah cek duluan)
      if (viaAi && ngambekLevel(uid) >= 3) {
        return cht.reply(wakeRefuseText(), { replyAi: false });
      }
      const wk = setWake(uid, p, { force: !viaAi });
      const note = Exp.voip ? '' : '\n⚠️ VoIP belum siap sekarang, tapi jadwal tetap tersimpan.';
      return cht.reply(
        `⏰ Siap, bangunin ${wakeWindowText(wk)} (${wk.repeat ? 'tiap hari' : 'sekali'}).\n` +
          'Berhenti kalau telpon diangkat atau kamu chat apa saja.' +
          (viaAi && ngambekLevel(uid) > 0 ? '\n😤 Dia lagi ngambek, nadanya bakal ketus.' : '') + note,
        { replyAi: false }
      );
    }
  );
}

/*!-======[ Wife Auto-Call (role 🤍Suami🤍 idle) ]======-!*/
/**
 * State & aturan emosi ada di helpers/wifemood.js (Data.users[uid].wife).
 * Bagian ini hanya orkestrasi: kapan menelpon, apa hasilnya, dan pesan chat susulan.
 *
 * Hasil telpon:
 *  - answered : ngobrol -> siklus direset, cooldown ringan
 *  - rejected : ditutup saat berdering -> langsung ngambek (rejectNgambekNow) + chat ngambek
 *  - missed   : tidak diangkat sampai timeout -> coba lagi, ngambek setelah maxAttempts
 *  - failed   : tidak pernah berdering / error teknis -> TIDAK dihitung percobaan
 */

const FALLBACK_TEXTS = {
  reject: [
    'Oh, sibuk ya? Nggak apa-apa. Aku juga bisa pura-pura nggak peduli.',
    'Sudah kucoba hubungi... kamu reject. Oke. Jangan harap aku manis-manis dulu.',
    'Aku nungguin... tapi kamu malah nolak teleponku. Sakit tau. Aku ngambek sekarang.',
  ],
  missed: [
    'Dua kali aku telpon, nggak ada yang diangkat. Oke. Terserah kamu.',
    'Kamu tuh ya... aku telpon nggak diangkat-angkat. Aku ngambek.',
  ],
  ignored: [
    'Masih diam aja? Hebat ya kamu.',
    'Oh. Jadi beneran nggak mau ngomong sama aku sama sekali.',
  ],
  kangen: [
    'Sayang... lagi ngapain? Aku tiba-tiba kangen kamu.',
    'Hei... aku kangen. Pengen denger suara kamu deh.',
  ],
  bangun: [
    'Bangun sayang... sudah waktunya bangun nih.',
    'Sayang, bangun yuk. Aku telpon sebentar lagi ya.',
    'Hei tukang tidur, bangun. Awas kalau telponku nggak diangkat.',
  ],
  reda: [
    'Aku masih kesel sih... tapi ya sudahlah. Kamu ke mana aja?',
    'Hmph. Aku udah nggak terlalu marah. Cuma sedikit. Jangan GR.',
  ],
};

async function sendChatAsBot(Exp, jid, text) {
  try {
    await Exp.sendMessage(jid, { text });
  } catch (e) {
    console.error('[WIFECALL] sendChatAsBot:', e?.message || e);
  }
}

/** Kirim pesan chat susulan + catat ke memori AI supaya percakapan berikutnya nyambung. */
async function wifeSulk(Exp, uid, kind) {
  const u = global.Data?.users?.[uid];
  const w = wm.wife(uid);
  if (!u || !w) return;
  const msg = await generateNgambekChat({
    Exp,
    number: uid,
    name: u.name,
    role: u.role,
    chatCount: u.chat,
    kind,
    level: w.level || 1,
  });
  const jid = `${uid}@s.whatsapp.net`;
  await sendChatAsBot(Exp, jid, msg);
  try {
    appendAssistantMemory?.(jid, msg);
  } catch {}
}

/**
 * Jalankan 1x auto-call ke user Suami.
 * return: 'answered' | 'rejected' | 'missed' | 'failed' | 'busy' | 'skip'
 */
export async function tryWifeAutoCall(Exp, userId, { force = false, mode = 'ngomel' } = {}) {
  const wcfg = wm.cfgWife();
  if (!Exp?.voip) return 'skip';
  if (!force && !wcfg.enabled) return 'skip';
  if (S.v || Exp.voip._activeCall || globalThis.__wifeCalling) return 'busy';

  const uid = wm.uidOf(userId);
  const u = global.Data?.users?.[uid];
  const w = wm.wife(uid, { force });
  if (!u || !w) return 'skip';
  const c = w.calls;
  const now = Date.now();

  if (!force) {
    if (w.optOut || wm.isNgambek(uid) || !wm.isProactiveEligible(uid)) return 'skip';
    if (now < c.cooldownUntil) return 'skip';
    const last = Number(u.lastChat) || 0;
    if (!last || now - last < wcfg.idleHours * 3600 * 1000) return 'skip';
    if (c.lastAt && now - c.lastAt < wcfg.retryMinutes * 60 * 1000) return 'skip';
    if (wm.inQuietHours(now)) return 'skip';
  }

  const target = await resolveCallTarget(Exp, `${uid}@s.whatsapp.net`);
  c.attempts = (c.attempts || 0) + 1;
  c.lastAt = now;
  log(`[WIFECALL] auto-call attempt ${c.attempts}/${wcfg.maxAttempts} → ${uid}${force ? ' (force)' : ''}`);

  // cht palsu minimal untuk startSession
  const fakeCht = {
    fake: true,
    sender: target,
    pushName: u.name || uid,
    memories: { chat: u.chat || 0, role: u.role || '🤍Suami🤍' },
    reply: async () => {},
  };

  globalThis.__wifeCalling = true;
  clearStaleFeeder(Exp.voip);
  let outcome = 'failed';
  try {
    const s = await startSession({ cht: fakeCht, Exp, target, number: uid, self: true, mode });
    outcome = classifyCall(s);
  } catch (e) {
    console.error('[WIFECALL] tryWifeAutoCall error:', e?.message || e);
    outcome = 'failed';
  } finally {
    globalThis.__wifeCalling = false;
  }

  const after = Date.now();
  c.lastOutcome = outcome;
  log(`[WIFECALL] hasil telpon → ${outcome}`);

  if (outcome === 'answered') {
    c.attempts = 0;
    c.fails = 0;
    c.cooldownUntil = after + Math.max(2, wcfg.idleHours / 2) * 3600 * 1000;
    return outcome;
  }

  if (outcome === 'failed') {
    c.attempts = Math.max(0, c.attempts - 1); // gagal teknis tidak dihitung
    c.fails = (c.fails || 0) + 1;
    if (c.fails >= 3) {
      c.fails = 0;
      c.cooldownUntil = after + 2 * 3600 * 1000;
    }
    return outcome;
  }

  // rejected / missed
  if (mode === 'kangen' && wcfg.kangen.rejectNgambek !== true) {
    c.attempts = 0; // telpon kangen tidak diangkat: tidak ngambek, cukup coba lain waktu
    return outcome;
  }
  const sulkNow =
    (outcome === 'rejected' && wcfg.rejectNgambekNow) || c.attempts >= wcfg.maxAttempts;
  if (sulkNow) {
    const kind = outcome === 'rejected' ? 'reject' : 'missed';
    wm.enterNgambek(uid, { reason: kind, force });
    c.attempts = 0;
    c.fails = 0;
    c.cooldownUntil = after + wcfg.cooldownHours * 3600 * 1000;
    await wifeSulk(Exp, uid, kind);
  }
  return outcome;
}

/** Kadang-kadang AI kangen: kirim chat duluan atau langsung menelpon. Hanya nomor terdaftar. */
async function maybeKangen(E) {
  const k = wm.cfgWife().kangen;
  if (!k.enabled || !E) return;
  if (Math.random() > k.chance) return;
  const cands = wm.kangenCandidates();
  if (!cands.length) return;
  const { uid } = cands[Math.floor(Math.random() * cands.length)];
  const u = global.Data?.users?.[uid];
  if (!u) return;
  wm.markKangen(uid);
  const canCall = !!E.voip && !S.v && !E.voip._activeCall && !globalThis.__wifeCalling;
  if (canCall && Math.random() < k.callChance) {
    log(`[KANGEN] menelpon ${uid}`);
    const out = await tryWifeAutoCall(E, uid, { force: true, mode: 'kangen' });
    if (out === 'answered') return;
    if (out === 'busy') return;
    // tidak diangkat / gagal -> lanjut kirim chat kangen
  }
  log(`[KANGEN] chat ke ${uid}`);
  const msg = await generateNgambekChat({
    Exp: E, number: uid, name: u.name, role: u.role, chatCount: u.chat, kind: 'kangen',
  });
  const jid = `${uid}@s.whatsapp.net`;
  await sendChatAsBot(E, jid, msg);
  try { appendAssistantMemory?.(jid, msg); } catch {}
}

/*!-======[ API untuk interactive.js (telpon atas inisiatif AI saat chat) ]======-!*/
function canChatCall(userId, Exp, { owner = false } = {}) {
  const uid = wm.uidOf(userId);
  const k = wm.cfgWife().kangen;
  if (!k.chatCall || !Exp?.voip) return false;
  if (S.v || Exp.voip._activeCall || globalThis.__wifeCalling) return false;
  if (!owner && !wm.isProactiveEligible(uid)) return false;
  const w = wm.wife(uid, { force: true });
  if (!w || w.optOut || wm.isNgambek(uid)) return false;
  if (Date.now() - (globalThis.__chatCallAt?.[uid] || 0) < k.chatCallCooldownMinutes * 60000) return false;
  return true;
}

function startChatCall({ Exp, userId, owner = false }) {
  const uid = wm.uidOf(userId);
  if (!canChatCall(uid, Exp, { owner })) return false;
  (globalThis.__chatCallAt ??= {})[uid] = Date.now();
  setTimeout(() => {
    tryWifeAutoCall(Exp, uid, { force: true, mode: 'kangen' }).catch((e) =>
      console.error('[AICALL] chat-call:', e?.message || e)
    );
  }, 3500); // beri jeda biar chat "aku telpon ya" terkirim dulu
  return true;
}


/*!-======[ Wake Call: bangunin pagi ]======-!*/
/**
 * Jadwal disimpan di Data.users[uid].wakeCall (ikut tersimpan bersama data user, tahan restart).
 * Alur: jam mulai tiba -> chat "bangun" -> beberapa detik -> telpon. Tidak diangkat -> telpon lagi
 * dengan jeda makin lama (gapMinutes). Berhenti kalau: telpon diangkat, user chat apa saja
 * (wakeSeen, dipanggil dari client.js), jam batas habis, atau maxCalls tercapai.
 * Tidak terpengaruh quietHours / opt-out / ngambek karena ini permintaan user sendiri.
 *
 * Config opsional (cfg.wifeCall.wake): defaultWindowMin, maxCalls, gapMinutes[], chatDelaySec[min,max],
 * chatEvery (chat susulan tiap N telpon, 0 = hanya chat pertama), checkEverySec, failRetrySec.
 */
/** Level ngambek aktif (0 = tidak ngambek). Pakai force: owner non-Suami juga punya state wife. */
function ngambekLevel(userId) {
  const w = wm.wife(wm.uidOf(userId), { force: true });
  return w && w.mood === 'ngambek' && Date.now() < w.expiresAt ? w.level || 1 : 0;
}
const WAKE_REFUSE = [
  'Hmph. Bangun aja sendiri. Aku masih ngambek.',
  'Nggak mau. Aku lagi marah sama kamu, pasang alarm sendiri sana.',
  'Enak aja minta dibangunin. Rayu aku dulu baru dipikirin.',
];
const wakeRefuseText = () => WAKE_REFUSE[Math.floor(Math.random() * WAKE_REFUSE.length)];

const cfgWake = () => {
  const c = (typeof cfg !== 'undefined' && cfg?.wifeCall?.wake) || {};
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const gaps = Array.isArray(c.gapMinutes) ? c.gapMinutes.map(Number).filter((n) => n > 0) : [];
  const cd = Array.isArray(c.chatDelaySec) ? c.chatDelaySec.map(Number).filter((n) => n >= 0) : [];
  return {
    defaultWindowMin: num(c.defaultWindowMin, 60),
    maxCalls: num(c.maxCalls, 8),
    gapMinutes: gaps.length ? gaps : [3, 5, 8, 10],
    chatDelaySec: cd.length >= 2 ? [cd[0], cd[1]] : [5, 10],
    chatEvery: c.chatEvery === undefined || !(Number(c.chatEvery) >= 0) ? 3 : Number(c.chatEvery),
    checkEverySec: Math.max(10, num(c.checkEverySec, 30)),
    snoozeDefaultMin: num(c.snoozeDefaultMin, 5),
    snoozeMaxMin: num(c.snoozeMaxMin, 30),
    maxSnooze: num(c.maxSnooze, 3),
    failRetrySec: num(c.failRetrySec, 90),
  };
};

/** "jam 15.20 (sore)" menurut zona waktu bot — dipakai supaya AI tidak bilang "pagi" di sore hari. */
function dayNow() {
  const p = zoneParts(Date.now(), wakeTz());
  const h = p.hour;
  const part = h >= 4 && h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : h < 24 ? 'malam' : 'dini hari';
  const label = h < 4 ? 'dini hari' : part;
  return `jam ${String(h).padStart(2, '0')}.${String(p.minute).padStart(2, '0')} (${label})`;
}
const wakeTz = () => wm.cfgWife().quietHours.tz || 'Asia/Jakarta';
const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}.${String(m % 60).padStart(2, '0')}`;

function zoneParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms);
  return Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
}

/** Jam dinding di zona `tz` -> timestamp UTC (ms). */
function zonedToMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = zoneParts(guess, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return guess - (asUtc - guess);
}

/** Jendela [startAt, endAt] terdekat yang belum lewat. skipToday = paksa mulai dari besok. */
function buildWindow(w, now = Date.now(), skipToday = false) {
  const tz = wakeTz();
  const p = zoneParts(now, tz);
  for (let add = skipToday ? 1 : 0; add < 4; add++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    const startAt = zonedToMs(y, mo, d, Math.floor(w.startMin / 60), w.startMin % 60, tz);
    let endAt = zonedToMs(y, mo, d, Math.floor(w.endMin / 60), w.endMin % 60, tz);
    if (w.endMin <= w.startMin) endAt += 24 * 3600 * 1000; // lewat tengah malam
    if (endAt > now) return { startAt, endAt };
  }
  return { startAt: now, endAt: now + 3600 * 1000 };
}

/** "06.00-07.30", "jam 6 sampai 7.30 tiap hari", "6:30" -> { startMin, endMin, repeat } */
function parseWake(text) {
  const t = String(text || '').toLowerCase();
  const repeat = /\b(tiap|setiap|harian|daily|rutin|every)\b/.test(t);
  const clean = t.replace(/\+?\d{9,}/g, ' '); // buang nomor telepon
  const re = /(?<!\d)(\d{1,2})(?:\s?[.:]\s?(\d{2}))?(?!\d)(?!\s*(?:menit|detik|kali|x|hari)\b)/g;
  const times = [];
  for (const m of clean.matchAll(re)) {
    const h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || mi > 59) return null; // jam tidak valid -> tolak, jangan ditebak
    times.push(h * 60 + mi);
    if (times.length === 2) break;
  }
  if (!times.length) return null;
  const startMin = times[0];
  let endMin = times.length > 1 ? times[1] : (startMin + cfgWake().defaultWindowMin) % 1440;
  if (endMin === startMin) endMin = (startMin + cfgWake().defaultWindowMin) % 1440;
  return { startMin, endMin, repeat };
}

/** "5 menit lagi", "lima menit lagi", "bentar lagi", "snooze 10" -> menit (0 = bukan snooze). */
const NUM_WORDS = {
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10,
  'lima belas': 15, 'dua puluh': 20, 'tiga puluh': 30, setengah: 30,
};
function parseSnooze(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t || t.length > 60) return 0; // pesan panjang = obrolan biasa, bukan snooze
  const k = cfgWake();
  const clamp = (n) => Math.min(k.snoozeMaxMin, Math.max(1, Math.round(n)));
  const m = t.match(/\b(\d{1,2}|lima belas|dua puluh|tiga puluh|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)\s*(?:menit|mnt|min)\b/);
  const lagi = /\b(lagi|ntar|entar|nanti|bentar|sebentar|snooze|tunda)\b/.test(t);
  if (m && lagi) return clamp(/^\d/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]]);
  if (/\bsetengah jam\b/.test(t) && lagi) return clamp(30);
  const sn = t.match(/\b(?:snooze|tunda)\s+(\d{1,2})\b/);
  if (sn) return clamp(Number(sn[1]));
  if (/\b(?:bentar|sebentar|bntar|ntar|entar)\s+lagi\b|\b(?:snooze|tunda)\b/.test(t)) return clamp(k.snoozeDefaultMin);
  return 0;
}

/** Tunda telpon berikutnya. return: menit yang dipakai | -1 batas snooze habis | 0 tidak ada sesi berjalan. */
function snoozeWake(uid, minutes) {
  const wk = getWake(uid);
  const k = cfgWake();
  if (!wk?.on || wk.state !== 'run') return 0;
  if ((wk.snoozes || 0) >= k.maxSnooze) return -1;
  wk.snoozes = (wk.snoozes || 0) + 1;
  wk.nextAt = Date.now() + minutes * 60000;
  wk.endAt = Math.max(wk.endAt, wk.nextAt + 15 * 60000); // snooze diminta user: jendela ikut digeser supaya tidak habis duluan
  wk.snoozeFlag = true; // runWakeAttempt jangan menimpa nextAt / menganggap selesai
  wk.chatNext = true; // chat "bangun lagi" sebelum telpon berikutnya
  log(`[WAKE] ${uid} snooze ${minutes} menit (${wk.snoozes}/${k.maxSnooze})`);
  return minutes;
}

const getWake = (uid) => global.Data?.users?.[uid]?.wakeCall || null;

function setWake(uid, p, { force = true } = {}) {
  const u = global.Data?.users?.[uid];
  if (!u) return null;
  u.wakeCall = {
    on: true, force: !!force, startMin: p.startMin, endMin: p.endMin, repeat: !!p.repeat,
    ...buildWindow(p),
    state: 'wait', calls: 0, chats: 0, fails: 0, snoozes: 0, snoozeFlag: false, chatNext: false, nextAt: 0, startedAt: 0,
    lastOutcome: null, doneReason: null, doneAt: 0,
  };
  return u.wakeCall;
}

const clearWakeMemory = (uid) => globalThis.__aiChatMemory?.delete(`aicall-bangun:${uid}`);

function endWake(uid, reason) {
  clearWakeMemory(uid);
  const wk = getWake(uid);
  if (!wk) return;
  wk.doneReason = reason;
  wk.doneAt = Date.now();
  if (wk.repeat) {
    Object.assign(wk, buildWindow(wk, Date.now(), true), {
      state: 'wait', calls: 0, chats: 0, fails: 0, snoozes: 0, snoozeFlag: false, chatNext: false, nextAt: 0, startedAt: 0,
    });
  } else {
    wk.on = false;
    wk.state = 'done';
  }
  log(`[WAKE] ${uid} selesai: ${reason}${wk.repeat ? ' (jadwal harian dilanjut besok)' : ''}`);
}

function cancelWake(uid) {
  const wk = getWake(uid);
  if (!wk) return;
  wk.repeat = false;
  wk.on = false;
  wk.state = 'done';
  wk.doneReason = 'batal';
  wk.doneAt = Date.now();
  if (S.v?.mode === 'bangun' && S.v.number === uid) finish(S.v); // telpon yang lagi berdering ikut ditutup
}

function dayLabel(ms) {
  const tz = wakeTz();
  const a = zoneParts(Date.now(), tz), b = zoneParts(ms, tz);
  const diff = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
  if (diff === 0) return 'hari ini';
  if (diff === 1) return 'besok';
  return `${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')}`;
}

function wakeWindowText(wk) {
  const tz = wakeTz();
  return `${dayLabel(wk.startAt)} ${fmtHM(wk.startMin)}–${fmtHM(wk.endMin)} ${tz === 'Asia/Jakarta' ? 'WIB' : tz}`;
}

const WAKE_REASON = {
  diangkat: 'telpon diangkat & kamu bicara', chat: 'kamu sudah chat', habis: 'jam batas habis',
  batas: 'batas jumlah telpon tercapai', terlewat: 'jadwal terlewat (bot sedang mati)', batal: 'dibatalkan',
};

function wakeStatusText(uid) {
  const wk = getWake(uid);
  if (!wk) return '⏰ Belum ada jadwal bangunin.\nContoh: .bangunin 06.00-07.30';
  const lines = ['⏰ *BANGUNIN*', ''];
  if (wk.on) {
    lines.push(`• Jadwal : ${wakeWindowText(wk)} (${wk.repeat ? 'tiap hari' : 'sekali'})`);
    if (wk.state === 'run' && !wk.force && ngambekLevel(uid) >= 3) {
      lines.push('• Status : 😤 ditahan, dia lagi ngambek banget (rayu sampai luluh)');
    } else if (wk.state === 'run') {
      const min = Math.max(0, Math.round((wk.nextAt - Date.now()) / 60000));
      lines.push(`• Status : 📞 berjalan, telpon ke-${wk.calls}, berikutnya ~${min} menit lagi`);
    } else {
      lines.push('• Status : ⏳ menunggu jam mulai');
    }
  } else {
    lines.push('• Status : ⛔ tidak ada jadwal aktif');
  }
  if (wk.doneReason) lines.push(`• Terakhir: ${WAKE_REASON[wk.doneReason] || wk.doneReason}`);
  return lines.join('\n');
}

async function sendWakeChat(E, uid, attempt, sulk = 0) {
  const u = global.Data?.users?.[uid];
  if (!u) return;
  const msg = await generateNgambekChat({
    Exp: E, number: uid, name: u.name, role: u.role, chatCount: u.chat, kind: 'bangun', level: attempt, sulk,
  });
  const jid = `${uid}@s.whatsapp.net`;
  await sendChatAsBot(E, jid, msg);
  try { appendAssistantMemory?.(jid, msg); } catch {}
}

async function runWakeAttempt(E, uid, wk) {
  const k = cfgWake();
  const u = global.Data?.users?.[uid];
  const gapMs = (n) => k.gapMinutes[Math.min(Math.max(n, 1) - 1, k.gapMinutes.length - 1)] * 60000;
  const sulk = ngambekLevel(uid); // 1-2: tetap bangunin dengan nada ngomel
  wk.calls++;

  // chat dulu: sebelum telpon pertama, dan susulan tiap `chatEvery` telpon
  const needChat = wk.chatNext || wk.chats === 0 || (k.chatEvery > 0 && wk.calls > 1 && (wk.calls - 1) % k.chatEvery === 0);
  wk.snoozeFlag = false;
  if (needChat) {
    wk.chatNext = false;
    wk.chats++;
    await sendWakeChat(E, uid, wk.calls, sulk).catch((e) => console.error('[WAKE] chat:', e?.message || e));
    const [a, b] = k.chatDelaySec;
    await sleep((a + Math.random() * (b - a)) * 1000);
    if (wk.state !== 'run') return; // dia keburu chat balik
    if (wk.snoozeFlag) { wk.snoozeFlag = false; wk.lastOutcome = 'snooze'; return; } // dia minta ditunda sebelum telpon
  }

  clearWakeMemory(uid); // tiap telpon bangunin mulai dari percakapan kosong
  const target = await resolveCallTarget(E, `${uid}@s.whatsapp.net`);
  log(`[WAKE] telpon ke-${wk.calls}/${k.maxCalls} → ${uid}`);
  const fakeCht = {
    fake: true,
    sender: target,
    pushName: u?.name || uid,
    memories: { chat: u?.chat || 0, role: u?.role || '🤍Suami🤍' },
    reply: async () => {},
    wakeSulk: sulk,
  };

  globalThis.__wifeCalling = true;
  clearStaleFeeder(E.voip);
  let outcome = 'failed';
  let spoke = false;
  try {
    const s = await startSession({ cht: fakeCht, Exp: E, target, number: uid, self: true, mode: 'bangun' });
    outcome = classifyCall(s);
    spoke = !!s?.spoke;
  } catch (e) {
    console.error('[WAKE] call error:', e?.message || e);
  } finally {
    globalThis.__wifeCalling = false;
  }
  wk.lastOutcome = outcome;
  log(`[WAKE] hasil → ${outcome}`);

  if (wk.state !== 'run') return; // selesai selagi telpon (dia chat / dibatalkan)
  if (wk.snoozeFlag) { // snooze lewat suara / chat selama telpon: nextAt sudah diatur snoozeWake
    wk.snoozeFlag = false;
    wk.lastOutcome = 'snooze';
    return;
  }
  if (outcome === 'answered' && spoke) return endWake(uid, 'diangkat');
  if (outcome === 'answered') {
    // diangkat tapi tidak ada suara sama sekali (HP di saku / auto-angkat / tidur lagi) -> belum dianggap bangun
    wk.lastOutcome = 'silent';
    wk.fails = 0;
    log(`[WAKE] ${uid} diangkat tapi tidak bicara, dianggap belum bangun`);
    wk.nextAt = Date.now() + gapMs(wk.calls);
    return;
  }
  if (outcome === 'failed') {
    wk.calls = Math.max(0, wk.calls - 1); // gagal teknis tidak dihitung
    wk.fails = (wk.fails || 0) + 1;
    wk.nextAt = Date.now() + (wk.fails >= 3 ? gapMs(wk.calls + 1) : k.failRetrySec * 1000);
    return;
  }
  wk.fails = 0;
  wk.nextAt = Date.now() + gapMs(wk.calls); // rejected / missed -> jeda makin lama
}

async function wakeTick() {
  if (globalThis.__wakeTicking) return;
  globalThis.__wakeTicking = true;
  try {
    const E = globalThis.__wifeExp;
    for (const [uid, u] of Object.entries(global.Data?.users || {})) {
      const wk = u?.wakeCall;
      if (!wk?.on) continue;
      const now = Date.now();
      if (wk.state === 'wait') {
        if (now < wk.startAt) continue;
        if (now >= wk.endAt) { endWake(uid, 'terlewat'); continue; }
        Object.assign(wk, { state: 'run', startedAt: now, calls: 0, chats: 0, fails: 0, snoozes: 0, snoozeFlag: false, chatNext: false, nextAt: now });
        log(`[WAKE] mulai membangunkan ${uid}`);
      }
      if (wk.state !== 'run') continue;
      if (now >= wk.endAt) { endWake(uid, 'habis'); continue; }
      if (now < wk.nextAt) continue;
      // ngambek banget (lv3): jadwal dari obrolan ditahan sampai luluh; jadwal dari command .bangunin tidak
      if (!wk.force && ngambekLevel(uid) >= 3) continue;
      if (wk.calls >= cfgWake().maxCalls) { endWake(uid, 'batas'); continue; }
      if (!E?.voip || S.v || E.voip._activeCall || globalThis.__wifeCalling) continue; // coba lagi tick berikut
      await runWakeAttempt(E, uid, wk);
    }
  } catch (e) {
    console.error('[WAKE] tick:', e?.message || e);
  } finally {
    globalThis.__wakeTicking = false;
  }
}

const wakeRunning = () =>
  Object.values(global.Data?.users || {}).some((u) => u?.wakeCall?.on && u.wakeCall.state === 'run');

function startWakeTicker(Exp) {
  if (globalThis.__wakeSched) clearInterval(globalThis.__wakeSched);
  globalThis.__wifeExp = Exp;
  const every = cfgWake().checkEverySec * 1000;
  globalThis.__wakeSched = setInterval(wakeTick, every);
  log(`[WAKE] ticker start, cek tiap ${every / 1000}s`);
}

/** Dipanggil client.js tiap user chat: dia sudah bangun -> stop chat/telpon susulan. */
function wakeSeen(userId, text = '') {
  const uid = wm.uidOf(userId);
  const wk = getWake(uid);
  if (!wk?.on || wk.state !== 'run') return false;
  const mins = parseSnooze(text);
  if (mins) {
    const r = snoozeWake(uid, mins);
    if (r > 0) {
      if (S.v?.mode === 'bangun' && S.v.number === uid && !S.v.connectedAt) finish(S.v); // telpon yang berdering ditutup
      sendChatAsBot(globalThis.__wifeExp, `${uid}@s.whatsapp.net`, `Oke, ${r} menit lagi ya. Awas tidur lagi.`);
      return true;
    }
    if (r < 0) return false; // batas snooze habis: chat ini tidak mengakhiri sesi, telpon lanjut
  }
  endWake(uid, 'chat');
  if (S.v?.mode === 'bangun' && S.v.number === uid && !S.v.connectedAt) finish(S.v); // tutup telpon yang masih berdering
  return true;
}

globalThis.__aicallApi = { canChatCall, startChatCall, isListed: (j) => wm.isListed(j), wakeSeen, ngambekLevel, wakeRefuseText };

export function startWifeCallScheduler(Exp) {
  startWakeTicker(Exp); // bangunin jalan sendiri, tidak tergantung wifeCall.enabled
  const wcfg = wm.cfgWife();
  if (globalThis.__wifeSched) {
    clearInterval(globalThis.__wifeSched);
    globalThis.__wifeSched = null;
  }
  globalThis.__wifeExp = Exp; // index.js memperbarui ini saat reconnect
  if (!wcfg.enabled) {
    log('[WIFECALL] scheduler disabled by config');
    return;
  }
  const intervalMs = Math.max(5, wcfg.checkEveryMinutes) * 60 * 1000;
  log(`[WIFECALL] scheduler start, check every ${wcfg.checkEveryMinutes}m, idle=${wcfg.idleHours}h`);

  const tick = async () => {
    const E = globalThis.__wifeExp || Exp;
    try {
      // 1) reda otomatis / naik level kalau dicuekin
      const { receded, bumped } = wm.sweep();
      if (receded.length || bumped.length) {
        log(`[WIFECALL] sweep: reda=${receded.join(',') || '-'} naik-level=${bumped.join(',') || '-'}`);
      }
      // 2) kirim pesan susulan yang tertunda (tidak di jam tenang)
      for (const p of wm.takePending()) {
        await wifeSulk(E, p.uid, p.kind);
      }
      // sedang ada sesi bangunin -> jangan ganggu dengan kangen/telpon otomatis
      if (wakeRunning()) return;
      // 3) kangen: chat duluan / telpon sendiri (acak, hanya nomor terdaftar)
      await maybeKangen(E);
      // 4) telpon otomatis
      if (!E?.voip || S.v || E.voip._activeCall || globalThis.__wifeCalling) return;
      const cands = wm.callCandidates();
      if (!cands.length) return;
      await tryWifeAutoCall(E, cands[0].uid); // satu user per tick biar tidak spam
    } catch (e) {
      console.error('[WIFECALL] scheduler tick:', e?.message || e);
    }
  };

  setTimeout(tick, 60 * 1000); // delay pertama 1 menit biar bot siap
  globalThis.__wifeSched = setInterval(tick, intervalMs);
}

export function stopWifeCallScheduler() {
  if (globalThis.__wifeSched) {
    clearInterval(globalThis.__wifeSched);
    globalThis.__wifeSched = null;
  }
}
