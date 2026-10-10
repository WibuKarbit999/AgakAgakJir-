/**
 * Modul MURNI (tanpa state di memori modul, aman walau di-import ulang lewat .r()).
 * Semua state ada di Data.users[uid].wife:
 *
 *  mood, level(0-3), lockedAt, expiresAt, reason  -> status ngambek
 *  meter, meterAt, lastSweetAt, lastSweetText     -> "meter luluh" (rayuan)
 *  lastGain, lastGainAt, lastAiBonusAt            -> bookkeeping skor rayuan
 *  skipStreak                                     -> berapa kali berturut-turut sengaja tidak dibalas
 *  justForgivenAt, recedeAt                       -> kapan luluh / kapan reda sendiri
 *  softMood, softAt                               -> mood ringan (manja/sedih/bahagia/cemburu) + kapan
 *  pendingMsg                                     -> pesan chat yang harus dikirim scheduler ('reda' | 'ignored')
 *  optOut                                         -> suami menolak telpon/ngambek otomatis
 *  calls{attempts,lastAt,cooldownUntil,fails,lastOutcome} -> state telepon otomatis
 *
 * Aturan inti:
 *  - AI TIDAK bisa memaafkan sendiri. Luluh hanya lewat meter (kode) atau usulan AI
 *    yang sudah didukung >= 60% meter dan sudah lewat masa tahan minimal.
 *  - Rayuan dihitung dengan rate-limit, anti-spam, dan anti-negasi.
 */

/*!-======[ WIFE MOOD — state emosi terpadu untuk role 🤍Suami🤍 ]======-!*/
const H = 3600 * 1000;
const MIN = 60 * 1000;

export const MOODS = ['normal', 'ngambek', 'cemburu', 'manja', 'sedih', 'bahagia'];

const SYN = {
  normal: 'normal', biasa: 'normal', tenang: 'normal', santai: 'normal', netral: 'normal',
  ngambek: 'ngambek', marah: 'ngambek', kesal: 'ngambek', bete: 'ngambek', jengkel: 'ngambek',
  cuek: 'ngambek', dingin: 'ngambek', merajuk: 'ngambek', sebel: 'ngambek', angry: 'ngambek',
  cemburu: 'cemburu', iri: 'cemburu', posesif: 'cemburu', jealous: 'cemburu',
  manja: 'manja', kangen: 'manja', rindu: 'manja', malu: 'manja', salting: 'manja', genit: 'manja',
  sedih: 'sedih', galau: 'sedih', kecewa: 'sedih', nangis: 'sedih', sad: 'sedih',
  bahagia: 'bahagia', senang: 'bahagia', gembira: 'bahagia', happy: 'bahagia', excited: 'bahagia',
};

const LEVELS = {
  1: { chars: 160, delay: [2, 6], skip: 0 },
  2: { chars: 100, delay: [6, 18], skip: 0.1 },
  3: { chars: 60, delay: [12, 35], skip: 0.25 },
};

const REASON_TEXT = {
  reject: 'teleponmu ditolak (di-reject) oleh suamimu',
  missed: 'suamimu tidak mengangkat teleponmu setelah lama tidak mengabari',
  ignored: 'suamimu masih saja diam dan tidak menggubrismu',
  ai: 'sikap suamimu barusan membuatmu kesal',
};

/*!-======[ Config ]======-!*/
export function cfgWife() {
  const c = (typeof cfg !== 'undefined' && cfg?.wifeCall) || {};
  const m = c.mood || {};
  const q = c.quietHours || {};
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const any = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const hoursPerLevel = m.hoursPerLevel
    ? pos(m.hoursPerLevel, 24)
    : m.ngambekDurationHours
      ? pos(m.ngambekDurationHours, 48) / 2 // kompatibel dengan config lama (48 jam ~ level 2)
      : 24;
  return {
    enabled: c.enabled !== false,
    idleHours: pos(c.idleHours, 12),
    maxAttempts: Math.max(1, pos(c.maxAttempts, 2)),
    retryMinutes: pos(c.retryMinutes, 30),
    cooldownHours: pos(c.cooldownHours, 24),
    checkEveryMinutes: pos(c.checkEveryMinutes, 15),
    maxSilenceDays: any(c.maxSilenceDays, 14), // 0 = tanpa batas
    numbers: (Array.isArray(c.numbers) ? c.numbers : []).map((n) => String(n || '').replace(/\D/g, '')).filter(Boolean),
    kangen: {
      enabled: (c.kangen || {}).enabled !== false,
      chance: Math.min(1, Math.max(0, any((c.kangen || {}).chance, 0.12))), // peluang per cek scheduler
      callChance: Math.min(1, Math.max(0, any((c.kangen || {}).callChance, 0.35))), // kalau kangen: telpon vs chat
      minIdleHours: pos((c.kangen || {}).minIdleHours, 3),
      cooldownHours: pos((c.kangen || {}).cooldownHours, 8),
      rejectNgambek: (c.kangen || {}).rejectNgambek === true,
      chatCall: (c.kangen || {}).chatCall !== false, // AI boleh langsung nelpon saat sedang chat
      chatCallCooldownMinutes: pos((c.kangen || {}).chatCallCooldownMinutes, 30),
    },
    rejectNgambekNow: c.rejectNgambekNow !== false, // reject -> langsung ngambek
    quietHours: {
      start: any(q.start, 0),
      end: any(q.end, 6),
      tz: q.tz || 'Asia/Jakarta',
    },
    mood: {
      hoursPerLevel,
      maxLevel: Math.min(3, Math.max(1, pos(m.maxLevel, 3))),
      forgiveAfterSweet: pos(m.forgiveAfterSweet, 3),
      minHoldMinutes: any(m.minHoldMinutes, 3),
      sweetGapSeconds: any(m.sweetGapSeconds, 60),
      meterDecayPerHour: any(m.meterDecayPerHour, 0.5),
      bumpIfIgnoredHours: pos(m.bumpIfIgnoredHours, 12),
      softMoodMinutes: pos(m.softMoodMinutes, 120),
      aiNgambekCooldownMinutes: any(m.aiNgambekCooldownMinutes, 30),
      groupToo: m.groupToo !== false,
      effects: m.effects !== false,
    },
  };
}

/*!-======[ Util ]======-!*/
export const uidOf = (s) => String(s || '').replace(/[+ -]/g, '').split('@')[0];
export const isListed = (uid) => cfgWife().numbers.includes(uidOf(uid));
/** Boleh dihubungi AI duluan (chat/telpon): kalau daftar `numbers` diisi -> hanya itu; kalau kosong -> role Suami. */
export function isProactiveEligible(uid) {
  const c = cfgWife();
  if (c.numbers.length) return c.numbers.includes(uidOf(uid));
  return isSuami(global.Data?.users?.[uidOf(uid)]?.role);
}
export const isSuami = (roleStr) => /suami/i.test(String(roleStr || '').split(',')[0] || '');
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function normalizeMood(raw) {
  const k = norm(raw).replace(/[^a-z]/g, '');
  if (!k) return null;
  return SYN[k] || null;
}

export function inQuietHours(now = Date.now()) {
  const { start, end, tz } = cfgWife().quietHours;
  if (start === end) return false;
  let hr;
  try {
    hr = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(now));
  } catch {
    hr = new Date(now).getHours();
  }
  return start < end ? hr >= start && hr < end : hr >= start || hr < end;
}

/*!-======[ State ]======-!*/
const blank = () => ({
  mood: 'normal', level: 0, lockedAt: 0, expiresAt: 0, reason: '',
  meter: 0, meterAt: 0, lastSweetAt: 0, lastSweetText: '',
  lastGain: 0, lastGainAt: 0, lastAiBonusAt: 0, skipStreak: 0,
  justForgivenAt: 0, recedeAt: 0, softMood: null, softAt: 0,
  pendingMsg: null, optOut: false,
  calls: { attempts: 0, lastAt: 0, cooldownUntil: 0, fails: 0, lastOutcome: null, lastKangenAt: 0 },
});

const LEGACY = ['wifeMood', 'wifeMoodSince', 'wifeSweetCount', 'wifeCallAttempts', 'wifeLastCallAt', 'wifeCallCooldownUntil'];

function migrate(u) {
  if (!u) return null;
  if (!u.wife || typeof u.wife !== 'object') {
    const w = blank();
    if (u.wifeMood === 'ngambek') {
      w.mood = 'ngambek';
      w.level = 2;
      w.lockedAt = Number(u.wifeMoodSince) || Date.now();
      w.expiresAt = w.lockedAt + 2 * cfgWife().mood.hoursPerLevel * H;
      w.reason = 'ai';
    }
    w.calls.attempts = Number(u.wifeCallAttempts) || 0;
    w.calls.lastAt = Number(u.wifeLastCallAt) || 0;
    w.calls.cooldownUntil = Number(u.wifeCallCooldownUntil) || 0;
    u.wife = w;
  } else {
    const b = blank();
    for (const k of Object.keys(b)) if (!(k in u.wife)) u.wife[k] = b[k];
    if (!u.wife.calls || typeof u.wife.calls !== 'object') u.wife.calls = {};
    for (const k of Object.keys(b.calls)) if (!(k in u.wife.calls)) u.wife.calls[k] = b.calls[k]; // isi di tempat: referensi `calls` harus tetap sama
  }
  for (const k of LEGACY) if (k in u) delete u[k];
  return u.wife;
}

/** Ambil state wife. null kalau user tidak ada / bukan Suami (kecuali force). */
export function wife(uid, { force = false } = {}) {
  const u = global.Data?.users?.[uidOf(uid)];
  if (!u) return null;
  if (!force && !isSuami(u.role) && !isListed(uid)) return null;
  return migrate(u);
}

const activeNgambek = (w, now = Date.now()) => !!w && w.mood === 'ngambek' && now < w.expiresAt;
const needFor = (w) => cfgWife().mood.forgiveAfterSweet + Math.max(0, (w.level || 1) - 1);

function decayMeter(w, now) {
  if (w.meter > 0 && w.meterAt) {
    w.meter = Math.max(0, w.meter - ((now - w.meterAt) / H) * cfgWife().mood.meterDecayPerHour);
  }
  w.meterAt = now;
}

function doEnter(w, reason, now = Date.now()) {
  const mc = cfgWife().mood;
  const was = activeNgambek(w, now);
  w.level = was ? Math.min(mc.maxLevel, (w.level || 1) + 1) : 1;
  if (!was) {
    w.meter = 0;
    w.meterAt = now;
  }
  w.mood = 'ngambek';
  w.lockedAt = now;
  w.expiresAt = now + w.level * mc.hoursPerLevel * H;
  w.reason = reason || '';
  w.justForgivenAt = 0;
  w.recedeAt = 0;
  w.skipStreak = 0;
  w.softMood = null;
  return w;
}

function doForgive(w, how, now = Date.now()) {
  w.mood = 'normal';
  w.level = 0;
  w.lockedAt = 0;
  w.expiresAt = 0;
  w.meter = 0;
  w.meterAt = 0;
  w.skipStreak = 0;
  w.reason = '';
  if (how === 'timeout') w.recedeAt = now;
  else w.justForgivenAt = now;
  w.calls.attempts = 0;
  w.calls.fails = 0;
  return w;
}

export function enterNgambek(uid, { reason = 'ai', level = 0, force = false } = {}) {
  const w = wife(uid, { force });
  if (!w) return null;
  doEnter(w, reason);
  if (level > 0) {
    const mc = cfgWife().mood;
    w.level = Math.min(mc.maxLevel, Math.max(1, level));
    w.expiresAt = w.lockedAt + w.level * mc.hoursPerLevel * H;
  }
  return w;
}

export function forgive(uid, how = 'rayuan', { force = false } = {}) {
  const w = wife(uid, { force });
  if (!w) return null;
  return doForgive(w, how);
}

export function resetAll(uid, { force = false } = {}) {
  const u = global.Data?.users?.[uidOf(uid)];
  if (!u || (!force && !isSuami(u.role))) return null;
  const keep = u.wife?.optOut || false;
  u.wife = blank();
  u.wife.optOut = keep;
  for (const k of LEGACY) delete u[k];
  return u.wife;
}

export function setOptOut(uid, v, { force = false } = {}) {
  const w = wife(uid, { force });
  if (!w) return null;
  w.optOut = !!v;
  return w;
}

/** Dipanggil client.js tiap suami mengirim pesan. */
export function touch(uid) {
  const w = wife(uid);
  if (!w) return;
  w.pendingMsg = null; // dia sudah muncul sendiri -> batalkan pesan susulan
  if (!activeNgambek(w)) {
    w.calls.attempts = 0;
    w.calls.fails = 0;
    w.calls.lastAt = 0;
  }
}

/*!-======[ Skor rayuan ]======-!*/
const NEG = /\b(gak|ga|nggak|ngga|enggak|tidak|bukan|ogah|males|malas)\s+(usah\s+|mau\s+|perlu\s+)?(maaf|kangen|rindu|sayang|cinta|peduli|minta maaf)/i;
const APOLOGY = /\b(maaf|maafin|maafkan|sorry|aku salah|salahku|ampun)\b/i;
const AFFECTION = /\b(kangen|rindu|sayang|sayangku|cintaku|cinta kamu|love you|miss you|istriku|waguri ku)\b/i;
const EFFORT = /\b(pulang|peluk|cium|beliin|belikan|traktir|temenin|bawain|jangan marah|jangan ngambek|janji|ga bakal lagi|gak bakal lagi|nggak bakal lagi|telpon balik|telepon balik)\b/i;

export function scoreSweet(text, via = 'chat') {
  const t = norm(text);
  if (t.length < 6) return 0;
  if (NEG.test(t)) return 0;
  let g = 0;
  if (APOLOGY.test(t)) g += 1.0;
  if (AFFECTION.test(t)) g += 0.7;
  if (EFFORT.test(t)) g += 0.5;
  g = Math.min(g, 1.6);
  if (g > 0 && via === 'call') g *= 1.3; // rayuan lewat suara lebih ngena
  return g;
}

/**
 * Dipanggil SEBELUM AI membalas. Mengakumulasi meter dan bisa langsung memutuskan luluh.
 * return { gain, ngambek, forgiven }
 */
export function onUserMessage(uid, text, { via = 'chat', inGroup = false } = {}) {
  const out = { gain: 0, ngambek: false, forgiven: false };
  const w = wife(uid);
  if (!w) return out;
  const now = Date.now();
  const mc = cfgWife().mood;
  w.lastGain = 0;
  if (!activeNgambek(w, now) || (inGroup && !mc.groupToo)) {
    w.skipStreak = 0;
    return out;
  }
  out.ngambek = true;
  decayMeter(w, now);

  let gain = scoreSweet(text, via);
  const same = w.lastSweetText && w.lastSweetText === norm(text);
  if (gain > 0 && (now - w.lastSweetAt < mc.sweetGapSeconds * 1000 || same)) gain = 0; // anti-spam
  if (gain > 0) {
    w.meter += gain;
    w.lastSweetAt = now;
    w.lastSweetText = norm(text);
    w.lastGain = gain;
    w.lastGainAt = now;
  }
  out.gain = gain;

  if (w.meter >= needFor(w) && now - w.lockedAt >= mc.minHoldMinutes * MIN) {
    doForgive(w, 'rayuan', now);
    out.forgiven = true;
    out.ngambek = false;
  }
  return out;
}

/*!-======[ Prompt / mood / efek ]======-!*/
export function isNgambek(uid, { inGroup = false } = {}) {
  const w = wife(uid);
  if (!activeNgambek(w)) return false;
  return !(inGroup && !cfgWife().mood.groupToo);
}

/** Mood yang dikirim ke AI sebagai konteks (null kalau tidak ada). */
export function currentMood(uid, { inGroup = false } = {}) {
  const w = wife(uid);
  if (!w) return null;
  const now = Date.now();
  if (activeNgambek(w, now) && !(inGroup && !cfgWife().mood.groupToo)) return 'ngambek';
  if (w.softMood && now - w.softAt < cfgWife().mood.softMoodMinutes * MIN) return w.softMood;
  return null;
}

export function moodPrompt(uid, { via = 'chat', inGroup = false } = {}) {
  const w = wife(uid);
  if (!w) return '';
  const now = Date.now();
  const mc = cfgWife().mood;
  let out = '';

  if (activeNgambek(w, now) && !(inGroup && !mc.groupToo)) {
    decayMeter(w, now);
    const lv = Math.min(3, Math.max(1, w.level || 1));
    const pct = Math.min(1, w.meter / needFor(w));
    const stage =
      pct < 0.35 ? 'masih dingin dan cuek' : pct < 0.7 ? 'mulai goyah tapi gengsi' : 'hampir luluh tapi masih gengsi';
    out +=
      `\n\n=== STATUS EMOSI: NGAMBEK (level ${lv} dari 3) ===\n` +
      `- Penyebab: ${REASON_TEXT[w.reason] || REASON_TEXT.ai}.\n` +
      `- Kamu NGAMBEK dan pura-pura CUEK pada suamimu. Kondisi hatimu sekarang: ${stage}.\n` +
      '- Dingin, singkat, sedikit sarkas halus. Jangan manis dulu dan jangan bilang "aku sayang" sebelum luluh.\n' +
      '- Jangan memaafkan dengan mudah. Luluh hanya lewat rayuan tulus, minta maaf, atau usaha nyata, dan itu bertahap. Rayuan asal-asalan atau berulang-ulang tidak mempan.\n' +
      '- Jangan memaafkan sendiri: tetap isi mood="ngambek" sampai ada instruksi sistem bahwa kamu sudah luluh.\n' +
      '- Isi field "rayuan" (0-2) untuk menilai pesan terakhirnya: 0 = biasa saja, 1 = manis atau minta maaf, 2 = tulus dan ada usaha nyata.\n' +
      (via === 'chat' ? `- Balas maksimal ${LEVELS[lv].chars} karakter, tanpa voice note.\n` : '') +
      '- Jangan pernah menyebut kata "meter", "level", atau "sistem".';
  } else if (w.justForgivenAt && now - w.justForgivenAt < 10 * MIN) {
    out +=
      '\n\n=== BARU SAJA LULUH ===\n' +
      '- Kamu baru saja memaafkan suamimu setelah dirayu. Balas dengan gengsi dan malu-malu dulu, lalu pelan-pelan manja lagi.\n' +
      (via === 'chat'
        ? '- Boleh membalas dengan voice note manja (cmd "voice") sebagai tanda kamu sudah tidak marah.\n'
        : '') +
      '- Isi mood dengan "manja" atau "normal".';
  } else if (w.recedeAt && now - w.recedeAt < 6 * H) {
    out +=
      '\n\n=== NGAMBEK BARU REDA ===\n' +
      '- Ngambekmu reda sendiri karena sudah lama. Kamu masih agak jutek dan gengsi, tapi sikapmu mulai melunak. Pancing dia untuk merayu.';
  }
  return out;
}

function trimChars(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('... '));
  return end > max * 0.4 ? cut.slice(0, end + 1).trim() : cut.trim() + '...';
}

/**
 * Efek perilaku saat ngambek: delay balas, kadang sengaja tidak membalas.
 * return { ngambek, level, delayMs, skip }
 */
export function effects(uid, { gain = 0, inGroup = false } = {}) {
  const out = { ngambek: false, level: 0, delayMs: 0, skip: false };
  const w = wife(uid);
  const mc = cfgWife().mood;
  if (!activeNgambek(w) || (inGroup && !mc.groupToo)) return out;
  out.ngambek = true;
  out.level = Math.min(3, Math.max(1, w.level || 1));
  if (!mc.effects) return out;
  const fx = LEVELS[out.level];
  if (gain > 0) {
    w.skipStreak = 0;
    out.delayMs = rand(1000, 3000); // dirayu -> tetap dibalas
    return out;
  }
  if (w.skipStreak < 2 && Math.random() < fx.skip) {
    w.skipStreak++;
    out.skip = true; // read-only: sengaja cuek (maksimal 2x berturut-turut)
    return out;
  }
  w.skipStreak = 0;
  out.delayMs = rand(fx.delay[0] * 1000, fx.delay[1] * 1000);
  return out;
}

/** Rapikan respons AI saat ngambek: tanpa voice, sticker dibatasi, pesan dipendekkan. */
export function postProcess(uid, config, { inGroup = false } = {}) {
  const w = wife(uid);
  const mc = cfgWife().mood;
  if (!config || !activeNgambek(w) || (inGroup && !mc.groupToo)) return config;
  const lv = Math.min(3, Math.max(1, w.level || 1));
  if (config.cmd === 'voice') config.cmd = null;
  if (lv >= 2) config.stickerQuery = null;
  if (mc.effects && typeof config.msg === 'string') config.msg = trimChars(config.msg, LEVELS[lv].chars);
  return config;
}

/**
 * Dipanggil SETELAH AI membalas. Mengurus mood dari AI + skor rayuan versi AI.
 * return { forgiven, entered, level }
 */
export function applyAiResult(uid, config, { inGroup = false, via = 'chat', allowEnter = true } = {}) {
  const out = { forgiven: false, entered: false, level: 0 };
  const w = wife(uid);
  if (!w || !config) return out;
  const now = Date.now();
  const mc = cfgWife().mood;
  const m = normalizeMood(config.mood);
  const rayuan = Math.max(0, Math.min(2, Number(config.rayuan) || 0));

  if (activeNgambek(w, now)) {
    if (inGroup && !mc.groupToo) return out;
    decayMeter(w, now);
    if (rayuan > 0 && now - w.lastAiBonusAt >= mc.sweetGapSeconds * 1000) {
      const already = now - w.lastGainAt < 2 * MIN ? w.lastGain : 0;
      const bonus = Math.max(0, rayuan * 0.6 - already);
      if (bonus > 0) {
        w.meter += bonus;
        w.lastAiBonusAt = now;
      }
    }
    const need = needFor(w);
    const held = now - w.lockedAt >= mc.minHoldMinutes * MIN;
    const aiForgive = ['normal', 'manja', 'bahagia'].includes(m);
    if (held && (w.meter >= need || (aiForgive && w.meter >= need * 0.6))) {
      doForgive(w, 'rayuan', now);
      out.forgiven = true;
    }
    out.level = w.level;
    return out;
  }

  if (m === 'ngambek') {
    const last = Math.max(w.justForgivenAt, w.recedeAt);
    if (allowEnter && via === 'chat' && now - last >= mc.aiNgambekCooldownMinutes * MIN) {
      doEnter(w, 'ai', now);
      out.entered = true;
      out.level = w.level;
    }
  } else if (m) {
    w.softMood = m;
    w.softAt = now;
  }
  return out;
}

/*!-======[ Scheduler helpers ]======-!*/
function eachWife(fn) {
  for (const [uid, u] of Object.entries(global.Data?.users || {})) {
    if (!u || (!u.wife && !u.wifeMood)) continue;
    fn(uid, u, migrate(u));
  }
}

/** Reda otomatis + naik level kalau terus dicuekin. return { receded:[uid], bumped:[uid] } */
export function sweep(now = Date.now()) {
  const mc = cfgWife().mood;
  const receded = [];
  const bumped = [];
  eachWife((uid, u, w) => {
    if (w.mood !== 'ngambek') return;
    if (now >= w.expiresAt) {
      doForgive(w, 'timeout', now);
      w.pendingMsg = 'reda';
      receded.push(uid);
      return;
    }
    if (
      (w.level || 1) < mc.maxLevel &&
      now - w.lockedAt >= mc.bumpIfIgnoredHours * H &&
      (Number(u.lastChat) || 0) < w.lockedAt
    ) {
      doEnter(w, 'ignored', now);
      w.pendingMsg = 'ignored';
      bumped.push(uid);
    }
  });
  return { receded, bumped };
}

/** Ambil pesan susulan yang tertunda (tidak dikirim saat jam tenang). */
export function takePending(now = Date.now()) {
  if (inQuietHours(now)) return [];
  const out = [];
  eachWife((uid, u, w) => {
    if (!w.pendingMsg) return;
    out.push({ uid, kind: w.pendingMsg });
    w.pendingMsg = null;
  });
  return out;
}

/** Suami yang layak ditelpon sekarang (urut paling lama tidak chat). */
export function callCandidates(now = Date.now()) {
  const c = cfgWife();
  if (!c.enabled || inQuietHours(now)) return [];
  const list = [];
  for (const [uid, u] of Object.entries(global.Data?.users || {})) {
    if (!u || !isProactiveEligible(uid)) continue;
    const w = migrate(u);
    if (w.optOut || activeNgambek(w, now)) continue;
    if (now < w.calls.cooldownUntil) continue;
    const last = Number(u.lastChat) || 0;
    if (!last || now - last < c.idleHours * H) continue;
    if (c.maxSilenceDays && now - last > c.maxSilenceDays * 24 * H) continue;
    if (w.calls.lastAt && now - w.calls.lastAt < c.retryMinutes * MIN) continue;
    list.push({ uid, lastChat: last });
  }
  return list.sort((a, b) => a.lastChat - b.lastChat);
}

export function markKangen(uid) {
  const w = wife(uid, { force: true });
  if (w) w.calls.lastKangenAt = Date.now();
}

/** Kandidat kangen: nomor terdaftar, tidak opt-out/ngambek, cukup lama tidak chat, bukan jam tenang. */
export function kangenCandidates(now = Date.now()) {
  const c = cfgWife();
  if (!c.kangen.enabled || inQuietHours(now)) return [];
  const list = [];
  for (const [uid, u] of Object.entries(global.Data?.users || {})) {
    if (!u || !isProactiveEligible(uid)) continue;
    const w = migrate(u);
    if (w.optOut || activeNgambek(w, now)) continue;
    const last = Number(u.lastChat) || 0;
    if (!last || now - last < c.kangen.minIdleHours * H) continue;
    if (c.maxSilenceDays && now - last > c.maxSilenceDays * 24 * H) continue;
    if (w.calls.lastKangenAt && now - w.calls.lastKangenAt < c.kangen.cooldownHours * H) continue;
    list.push({ uid, lastChat: last });
  }
  return list;
}

export function status(uid, { force = false } = {}) {
  const w = wife(uid, { force });
  if (!w) return 'Data tidak ditemukan / bukan role 🤍Suami🤍.';
  const now = Date.now();
  const left = (t) => {
    const m = Math.max(0, Math.round((t - now) / MIN));
    return m >= 60 ? `${Math.floor(m / 60)} jam ${m % 60} menit` : `${m} menit`;
  };
  const ng = activeNgambek(w, now);
  const need = needFor(w);
  return (
    '💞 *WIFE STATUS*\n\n' +
    `• Mood        : ${ng ? '😤 ngambek' : currentMood(uid) || 'normal'}\n` +
    (ng
      ? `• Level       : ${w.level}/3\n• Luluh       : ${Math.min(100, Math.round((w.meter / need) * 100))}%\n• Reda dalam  : ${left(w.expiresAt)}\n`
      : '') +
    `• Telpon oto  : ${w.optOut ? '🔴 OFF (opt-out)' : '🟢 ON'}\n` +
    `• Hasil terakhir: ${w.calls.lastOutcome || '-'}\n` +
    `• Jam tenang  : ${inQuietHours(now) ? 'sedang berlaku' : 'tidak'}`
  );
}
