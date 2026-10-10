export default async function on({ cht, Exp, ev }) {
  ev.on(
    {
      cmd: ['resetchat'],
      tag: 'ai',
      listmenu: ['resetchat'],
    },
    async ({ cht }) => {
      try {
        if (typeof global.resetAiMemory !== 'function') {
          return await cht.reply(
            '❌ Fungsi reset belum aktif. Pastikan reasoner.js versi lokal dan bot sudah direstart.'
          );
        }
        let userId = cht?.sender;
        try {
          userId = await Exp.func.getSender(cht?.sender, { cht, lid: false });
        } catch {}
        const had = await global.resetAiMemory(userId);
        await cht.reply('✅ Riwayat percakapan AI berhasil dibersihkan!',
          { ai: false }
        );
      } catch (e) {
        console.error('[resetchat]', e.stack || e.message);
        try {
          await cht.reply('❌ Gagal mereset riwayat: ' + e.message);
        } catch {}
      }
    }
  );
}
