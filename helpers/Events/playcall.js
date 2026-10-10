/*!-======[ Module Imports ]======-!*/
import { spawn } from 'child_process';
const fs = 'fs'.import();
const axios = 'axios'.import();

/*!-======[ Function Imports ]======-!*/
const { default: pino } = await 'pino'.import();

/*!-======[ Playcall State ]======-!*/
let playCallBusy = false;
let activeCall = null;
let last = { target: '-', title: '-', at: 0, result: '-' };

/*!-======[ Config ]======-!*/
const RING_TIMEOUT = 45000; // maks nunggu diangkat (berhenti begitu tersambung)
const END_GRACE = 1500; // jeda setelah audio habis sebelum telpon ditutup
const IGNORE_IDLE_MS = 5000; // abaikan 'idle'/'trackend' di awal call
const FALLBACK_MAX_MS = 5 * 60000; // kalau durasi audio tidak terbaca
const MAX_RETRY = 2; // retry HANYA kalau call() error, bukan kalau ditolak/ditutup

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*!-======[ Helper: durasi audio (ms) via ffprobe ]======-!*/
function probeDuration(file) {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        file,
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

/*!-======[ Helper: tutup call & tunggu benar2 mati ]======-!*/
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

/*!-======[ Helper: buang feeder sisa call sebelumnya ]======-!
 * VoipClient tidak men-stop _feeder sendiri kalau call berakhir tanpa stopCapture,
 * dan _startAudioFeeder() batal jalan kalau _feeder masih ada (call berikutnya jadi tanpa audio).
 * Hanya menyentuh feeder, TIDAK menyentuh engine native.
 */
function clearStaleFeeder(voip) {
  try {
    if (!voip || voip._activeCall) return;
    if (voip._feeder) {
      console.log('[PLAYCALL] stale feeder dibuang');
      try { voip._feeder.stop(); } catch {}
      voip._feeder = null;
    }
    if (voip._audioStartTimer) {
      clearTimeout(voip._audioStartTimer);
      voip._audioStartTimer = null;
    }
  } catch {}
}

/*!-======[ Helper: pantau call (listener dipasang SEKALI) ]======-!
 * Hasil:
 *  finished -> audio habis (bot / library yang menutup telpon)
 *  hangup   -> sudah tersambung lalu ditutup sebelum audio habis (mis. kamu matikan) = BUKAN gagal
 *  rejected / noanswer / ended / error -> gagal sebelum tersambung
 */
function watchCall(call, { attempt, onRing, onConnect, maxMs }) {
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    let audioEnded = false;
    let connectedAt = 0;
    let ringTimer, maxTimer, graceTimer;
    let endReason = null;

    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(ringTimer);
      clearTimeout(maxTimer);
      clearTimeout(graceTimer);
      console.log(`[PLAYCALL] attempt ${attempt} result=${v} reason=${endReason} connected=${connected} audioEnded=${audioEnded}`);
      resolve({ result: v, reason: endReason });
    };

    const audioDone = () => {
      if (done || graceTimer) return;
      graceTimer = setTimeout(() => finish('finished'), END_GRACE);
    };

    call.on('ringing', () => {
      console.log(`[PLAYCALL] 📳 RINGING — attempt ${attempt}`);
      onRing?.();
    });

    call.on('connected', () => {
      connected = true;
      connectedAt = Date.now();
      clearTimeout(ringTimer); // timeout berdering TIDAK boleh memutus call yang sudah tersambung
      console.log(`[PLAYCALL] 📞 CONNECTED — attempt ${attempt}`);
      onConnect?.();
      // pengaman terakhir: pasti ditutup walau event audio-habis tidak datang
      maxTimer = setTimeout(audioDone, maxMs);
    });

    call.on('track', (t) => console.log('[PLAYCALL] 🎵 TRACK:', t));

    const onTrackEnd = (name) => () => {
      console.log(`[PLAYCALL] 🎵 ${name}`);
      if (!connected) return;
      if (Date.now() - connectedAt < IGNORE_IDLE_MS) return;
      audioEnded = true;
      audioDone();
    };
    call.on('trackend', onTrackEnd('TRACK END'));
    call.on('idle', onTrackEnd('IDLE'));

    call.on('ended', (reason) => {
      endReason = reason;
      console.log(`[PLAYCALL] ❌ ENDED — attempt ${attempt}:`, reason);
      // library sendiri juga menutup call saat playlist habis (endWhenQueueEmpty)
      if (connected) return finish(audioEnded ? 'finished' : 'hangup');
      finish(reason === 'rejected' ? 'rejected' : 'ended');
    });

    call.on('error', (err) => {
      console.error(`[PLAYCALL] 💥 CALL ERROR — attempt ${attempt}:`, err?.message || err);
      endReason = endReason || err?.message || 'error';
      finish(connected ? (audioEnded ? 'finished' : 'hangup') : 'error');
    });

    ringTimer = setTimeout(() => finish('noanswer'), RING_TIMEOUT);
  });
}

/*!-======[ Default Export Function ]======-!*/
export default async function on({ cht, Exp, store, ev, is }) {
  const { sender, id } = cht;
  const { func } = Exp;

  ev.on(
    {
      cmd: ['playcall'],
      listmenu: ['playcall'],
      tag: 'downloader',
      //args: 'Harap sertakan judul atau URL YouTube!',
      energy: 10,
    },

    async ({ args, urls }) => {
      const text = (args || '').trim();
      const cmdWord = text.toLowerCase();

      /* ---- sub command (cocok persis, supaya judul lagu "reset" dll tidak bentrok) ---- */
      if (cmdWord === '--help') {
        return cht.reply(
          '*CALL MUSIK*\n\n' +
            '.playcall <judul/url>\n' +
            '.playcall <nomor> <judul/url>\n' +
            '.playcall end (tutup call)\n' +
            '.playcall reset (bersihkan sesi call yang nyangkut)\n' +
            '.playcall status'
        );
      }

      if (cmdWord === '--status') {
        return cht.reply(
          '📡 *CALL STATUS*\n\n' +
            `• VoIP client : ${Exp.voip ? '🟢 Ready' : '🔴 Tidak ada'}\n` +
            `• Sibuk       : ${playCallBusy ? '📞 Ya' : '📴 Tidak'}\n` +
            `• Call aktif  : ${activeCall ? 'Ya' : 'Tidak'}\n` +
            `• Last target : ${last.target}\n` +
            `• Last lagu   : ${last.title}\n` +
            `• Last hasil  : ${last.result}\n` +
            `• Last call   : ${last.at ? new Date(last.at).toLocaleString('id-ID') : '-'}`
        );
      }

      if (cmdWord === 'end' || cmdWord === 'stop') {
        if (!activeCall) return cht.reply('📵 Tidak ada panggilan aktif.');
        await endAndWait(activeCall);
        return cht.reply('📵 Panggilan ditutup.');
      }

      /* reset: tutup call sisa + buang feeder sisa + bebaskan flag sibuk (TIDAK menyentuh session/engine) */
      if (cmdWord === 'reset') {
        try {
          if (activeCall) await endAndWait(activeCall);
          activeCall = null;
          playCallBusy = false;
          if (Exp.voip) {
            Exp.voip._activeCall = null;
            clearStaleFeeder(Exp.voip);
          }
          return cht.reply('🔄 Sesi call di-reset. Coba .playcall lagi.');
        } catch (e) {
          return cht.reply('❌ Reset gagal: ' + (e?.message || e));
        }
      }

      if (playCallBusy) {
        return cht.reply(
          '📞 Masih ada sesi call yang aktif.\n' +
          '⏳ Tunggu sampai selesai, atau pakai .playcall end / .playcall reset'
        );
      }

      /* ---- tentukan target ----
       * voip.call() hanya mengambil ANGKA dari target. Di grup sender biasanya @lid,
       * angkanya bukan nomor asli -> harus diterjemahkan dulu ke nomor (@s.whatsapp.net).
       */
      let target = sender;
      let query = text;

      const num = text.match(/(?:^|\s)\+?(\d{10,15})(?=\s|$)/);
      if (num) {
        target = num[1] + '@s.whatsapp.net';
        query = text.replace(num[0], ' ').replace(/\s+/g, ' ').trim();
      } else if (target.endsWith('@lid')) {
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
          '❌ Nomor kamu belum terbaca (LID).\n' +
          'Tulis nomor tujuan: .playcall 628xxx <judul/url>'
        );
      }

      console.log('[PLAYCALL] sender:', sender, '-> target:', target);

      playCallBusy = true;

      const _key = keys[sender];
      const q = urls?.[0] || query;

      let saved = null;

      try {
        if (!q) {
          throw new Error('Harap sertakan judul atau URL YouTube!');
        }

        await cht.edit('🔎 Searching...', _key);

        let item;

        if (/youtu\.be|youtube\.com/.test(q)) {
          const idMatch =
            q.match(/[?&]v=([^&]+)/)?.[1] ||
            q.match(/youtu\.be\/([^?]+)/)?.[1];

          if (!idMatch) {
            throw new Error('URL YouTube tidak valid!');
          }

          item = {
            id: idMatch,
            title: 'YouTube Audio',
          };
        } else {
          const response = await fetch(
            `${api.xterm.url}/api/search/youtube?query=${encodeURIComponent(q)}&key=${api.xterm.key}`
          );

          if (!response.ok) {
            throw new Error(
              `YouTube search HTTP ${response.status}`
            );
          }

          const result = await response.json();

          item = result?.data?.items?.[0];

          if (!item) {
            throw new Error(
              'Hasil pencarian tidak ditemukan!'
            );
          }
        }

        await cht.edit(
          `⬇️ Downloading...\n${item.title || 'YouTube'}`,
          _key
        );

        const downloadUrl =
          api.xterm.url +
          '/api/downloader/youtube?key=' +
          api.xterm.key +
          '&url=' +
          encodeURIComponent(
            `https://www.youtube.com/watch?v=${item.id}`
          ) +
          '&type=mp3';

        const response = await fetch(downloadUrl);

        if (!response.ok) {
          throw new Error(
            `Downloader HTTP ${response.status}`
          );
        }

        const result = await response.json();
        const data = result?.data;

        if (!data?.dlink) {
          throw new Error(
            'Download URL tidak ditemukan'
          );
        }

        const playCallDir =
          `${process.cwd()}/container/toolkit/db/playcall`;

        await fs.promises.mkdir(
          playCallDir,
          {
            recursive: true,
          }
        );

        const filename =
          `playcall-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.mp3`;

        saved =
          `${playCallDir}/${filename}`;

        const audioUrl =
          data.dlink +
          (data.dlink.includes('?')
            ? '&'
            : '?') +
          'isBaileys=true';

        console.log(
          '[PLAYCALL] Downloading audio:',
          audioUrl
        );

        const audioResponse =
          await axios.get(
            audioUrl,
            {
              responseType: 'arraybuffer',
              timeout: 120000,
              maxContentLength:
                100 * 1024 * 1024,
              maxBodyLength:
                100 * 1024 * 1024,
            }
          );

        if (
          !audioResponse?.data ||
          !audioResponse.data.length
        ) {
          throw new Error(
            'Audio hasil download kosong'
          );
        }

        await fs.promises.writeFile(
          saved,
          Buffer.from(audioResponse.data)
        );

        console.log(
          '[PLAYCALL] Audio saved:',
          saved
        );

        const stat =
          await fs.promises.stat(saved);

        if (
          !stat.isFile() ||
          stat.size <= 0
        ) {
          throw new Error(
            'File audio tidak valid'
          );
        }

        console.log(
          `[PLAYCALL] Audio size: ${stat.size} bytes`
        );

        await cht.edit(
          `📞 Preparing call...\n${item.title || 'YouTube'}`,
          _key
        );

        const title = item.title || 'YouTube';
        const audioMs = await probeDuration(saved);
        const maxPlayMs = audioMs ? audioMs + 3000 + END_GRACE : FALLBACK_MAX_MS;
        console.log('[PLAYCALL] Audio duration(ms):', audioMs);

        let success = false;
        let finalMsg = '❌ Gagal menghubungi.';
        last = { target: target.split('@')[0], title, at: Date.now(), result: 'calling' };

        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
          await cht.edit(`📞 Calling... (${attempt}/${MAX_RETRY})\n${title}`, _key);

          clearStaleFeeder(Exp.voip);

          let call = null;
          let outcome = { result: 'error', reason: null };

          try {
            console.log('[PLAYCALL] ATTEMPT', attempt, '| target:', target, '| audio:', saved);

            call = await Promise.race([
              Exp.voip.call(target, {
                audioSource: saved,
                // timer library mulai saat call dibuat (termasuk waktu berdering) -> hanya jaring pengaman
                durationMs: audioMs ? audioMs + RING_TIMEOUT + 15000 : 15 * 60000,
                audioStartDelayMs: 1800,
                endWhenQueueEmpty: true,
              }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('call_timeout')), 20000)),
            ]);

            if (!call) throw new Error('VoIP call() returned empty object');
            activeCall = call;

            outcome = await watchCall(call, {
              attempt,
              maxMs: maxPlayMs,
              onRing: () =>
                cht.edit(`📞 Ringing... (${attempt}/${MAX_RETRY})\n${title}`, _key).catch(() => {}),
              onConnect: () =>
                cht.edit(`📞 Connected!\n▶️ ${title}`, _key).catch(() => {}),
            });
          } catch (err) {
            console.error('[PLAYCALL] ❌ VOIP CALL ERROR:', err?.message, err?.stack);
            outcome = { result: 'error', reason: err?.message };
          }

          // SELALU tutup & tunggu call benar2 mati, apapun hasilnya
          await endAndWait(call);
          activeCall = null;
          await sleep(1500); // beri waktu native call lepas sebelum call berikutnya

          const { result, reason } = outcome;
          last.result = result + (reason ? ` (${reason})` : '');

          if (result === 'finished') {
            success = true;
            finalMsg = '✅ Audio selesai dimainkan.\n📞 Call selesai.';
            break;
          }
          if (result === 'hangup') {
            success = true;
            finalMsg = '📵 Panggilan berakhir.';
            break;
          }
          if (result === 'rejected') {
            finalMsg = '❌ Panggilan ditolak.';
            break;
          }
          if (result === 'noanswer') {
            finalMsg = '⏱️ Tidak diangkat.';
            break;
          }
          if (result === 'ended') {
            // berakhir sebelum tersambung: JANGAN auto-retry (reason dicatat di console)
            finalMsg = `📵 Panggilan berakhir sebelum tersambung${reason ? ` (${reason})` : ''}.`;
            break;
          }

          // 'error' -> satu-satunya yang di-retry
          finalMsg = `❌ Gagal memulai call${reason ? `: ${reason}` : ''}.`;
          if (attempt < MAX_RETRY) {
            await cht.edit(
              `❌ Call gagal.\n🔄 Mencoba lagi dalam 5 detik... (${attempt + 1}/${MAX_RETRY})`,
              _key
            );
            await sleep(5000);
          }
        }

        await cht.edit(finalMsg, _key);

      } catch (err) {
        console.error(
          '[PLAYCALL ERROR]',
          err
        );

        console.error(
          '[PLAYCALL ERROR STACK]',
          err?.stack
        );

        try {
          await cht.reply(
            `❌ Playcall error:\n${err?.message || err}`
          );
        } catch {}
      } finally {
        playCallBusy = false;

        if (saved) {
          try {
            await fs.promises.rm(
              saved,
              {
                force: true,
              }
            );

            console.log(
              '[PLAYCALL] Temporary audio deleted:',
              saved
            );
          } catch (err) {
            console.error(
              '[PLAYCALL] Failed to delete audio:',
              err
            );
          }
        }
      }
    }
  );
}
