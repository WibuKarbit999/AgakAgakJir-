/*
 * Fitur : Add Meta AI ke Grup
 * Type  : Plugin ESM (SC Bell Structure)
 */

export default async function on({ cht, Exp, ev }) {
  ev.on(
    {
      cmd: ['addai', 'addmeta'],
      listmenu: ['addai'],
      tag: 'owner',
      isOwner: true, // Cukup owner bot yang bisa manggil
      isGroup: true  // Otomatis menolak kalau dipakai di chat pribadi
    },
    async () => {
      try {
        await cht.reply("⏳ Sedang mencoba mengundang Meta AI ke dalam grup...");

        // Mengeksekusi penambahan member menggunakan JID khusus bot Meta AI
        const res = await Exp.groupParticipantsUpdate(
          cht.id, 
          ["867051314767696@bot"], // Catatan: Baileys kadang butuh format @s.whatsapp.net, tapi bisa coba @bot jika gagal
          "add"
        );

        // Cek status balasan dari server (seperti fitur culik sebelumnya)
        let status = res && res[0] ? res[0].status : null;

        if (status == 200 || status == '200') {
            await cht.reply("✅ Sukses menambahkan Meta AI ke grup!");
        } else if (status == 409 || status == '409') {
            await cht.reply("⚠️ Meta AI sudah ada di dalam grup ini.");
        } else {
            await cht.reply(`❓ Proses selesai, tapi dapet kode status: ${status}. Coba cek apakah Meta AI sudah masuk.`);
        }

      } catch (e) {
        console.error('[ADDAI ERROR]', e);
        await cht.reply(`❌ Gagal menambahkan Meta AI:\n\n${String(e?.stack || e)}`);
      }
    }
  );
}