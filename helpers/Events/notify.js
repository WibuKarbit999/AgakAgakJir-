/*!-======[ Default Export Function ]======-!*/
export default async function on({ cht, Exp, ev, is }) {
    
    // Helper delay mandiri tanpa perlu import dari baileys
    const delay = ms => new Promise(res => setTimeout(res, ms));

    ev.on(
        {
            cmd: ['notify'],
            listmenu: ['notify'],
            tag: 'owner', // Menandakan bahwa ini fitur khusus owner
            energy: 0
        },
        async ({ args }) => {
            // Validasi khusus Owner
            const isOwner = !!is?.owner;
            if (!isOwner) {
                return cht.reply('🔒 Perintah ini khusus untuk Owner.');
            }

            // Memisahkan argumen dari input text
            const parts = (args || '').trim().split(/\s+/);
            const jump = parts[0];
            const target = parts[1];
            const dely = parts[2];

            // Validasi input
            if (!jump || isNaN(parseInt(jump))) {
                return cht.reply(`Contoh penggunaan: *${cht.prefix + cht.cmd} <jumlah> <?target> <?delay>*`);
            }

            const much = parseInt(jump);
            const sendto = (target === 'here' ? cht.id : target) || cht.id;
            const sabar = parseInt(dely) || 500;

            const notif = {
                sessionTransparencyMetadata: {
                    disclaimerText: '~ let me know',
                    hcaId: `hca_${Date.now()}`,
                    sessionTransparencyType: 1
                },
              verificationMetadata: {} 
            };

            const mContextInfo = {
                messageContextInfo: {
                    botMetadata: {
                        ...notif
                    }
                }
            };

            const reaction = {
                ...mContextInfo,
                reactionMessage: {
                    key: {
                        remoteJid: sendto,
                        id: cht.key.id, // Menggunakan ID pesan masuk (cht)
                        fromMe: false
                    },
                    text: ''
                }
            };

            // React loading ⏳ 
            try {
                await Exp.sendMessage(cht.id, { react: { text: '⏳', key: cht.key } });
            } catch (e) {
                console.log('Gagal react:', e);
            }

            // Looping relayMessage
            for (let i = 0; i < much; i++) {
                await Exp.relayMessage(
                    sendto,
                    reaction,
                    {
                        additionalAttributes: {
                            type: 'reaction'
                        }
                    }
                );

                await delay(sabar);
            }

            // React selesai ✅
            try {
                await Exp.sendMessage(cht.id, { react: { text: '✅', key: cht.key } });
            } catch (e) {
                console.log('Gagal react selesai:', e);
            }
        }
    );
}
