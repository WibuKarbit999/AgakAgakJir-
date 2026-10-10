export default async function on({ cht, Exp, ev }) {
  ev.on(
    {
      cmd: ['reloadevents', 'reload'],
      listmenu: ['reloadevents'],
      isOwner: true,
      tag: 'owner',
    },
    async ({ args }) => {
      await ev.reloadEventHandlers();
      cht.reply('Sukses✅, Semua Events Berhasil dimuat ulang!');
    }
  );
}
