// antiDelete.js
const fs = require('fs');
const path = require('path');
const { generateWAMessageFromContent, proto, downloadContentFromMessage, prepareWAMessageMedia } = require('@whiskeysockets/baileys');

module.exports = function initAntiDelete(trashcore, opts = {}) {
  const DB_PATH = opts.dbPath || path.join(__dirname, './library/antidelete.json');
  const MAX_CACHE = opts.maxCache || 500;
  const enabled = typeof opts.enabled === 'boolean' ? opts.enabled : true;

  // REQUIRED: bot number in international format without @s.whatsapp.net
  const botNumber = opts.botNumber?.endsWith('@s.whatsapp.net') ? opts.botNumber : `${opts.botNumber}@s.whatsapp.net`;

  const cache = new Map();

  // Ensure database file exists
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}), 'utf8');
  } catch (e) {
    console.error('antiDelete: failed to create db path', e);
  }

  // Load persisted cache metadata
  let persisted = {};
  try {
    persisted = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
    for (const k of Object.keys(persisted)) cache.set(k, persisted[k]);
  } catch (e) {
    console.warn('antiDelete: no persisted db or parse failed', e);
  }

  function persist() {
    try {
      const obj = {};
      for (const [k, v] of cache.entries()) {
        const toStore = Object.assign({}, v);
        delete toStore.contentBuffer;
        obj[k] = toStore;
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('antiDelete persist error', e);
    }
  }

  function addToCache(key, messageObj) {
    cache.set(key, messageObj);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    persist();
  }

  async function handleIncomingMessage(m) {
    try {
      if (!enabled || !m?.message) return;

      const chat = m.key.remoteJid;
      const id = m.key.id || `${chat}-${Date.now()}`;
      const cacheKey = `${chat}:${id}`;

      // Text message
      if (m.message.conversation || m.message.extendedTextMessage) {
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
        addToCache(cacheKey, {
          id,
          chat,
          type: 'text',
          text,
          sender: m.key.participant || m.key.remoteJid,
          timestamp: Date.now()
        });
        return;
      }

      // Media messages
      const mediaNode =
        m.message.imageMessage ||
        m.message.videoMessage ||
        m.message.audioMessage ||
        m.message.stickerMessage ||
        m.message.documentMessage ||
        null;

      if (mediaNode) {
        const mediaType =
          m.message.imageMessage ? 'image' :
          m.message.videoMessage ? 'video' :
          m.message.audioMessage ? 'audio' :
          m.message.stickerMessage ? 'sticker' :
          m.message.documentMessage ? 'document' : 'unknown';

        const stream = await downloadContentFromMessage(
          mediaNode,
          mediaType === 'document' ? (mediaNode.mimetype?.split('/')[0] || 'document') : mediaType
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        addToCache(cacheKey, {
          id,
          chat,
          type: mediaType,
          sender: m.key.participant || m.key.remoteJid,
          timestamp: Date.now(),
          fileName: mediaNode.fileName || null,
          mimetype: mediaNode.mimetype || null,
          size: buffer.length || null,
          contentBuffer: buffer,
          caption: mediaNode.caption || null
        });
        return;
      }

      // Other nodes
      addToCache(cacheKey, {
        id,
        chat,
        type: 'raw',
        raw: m.message,
        sender: m.key.participant || m.key.remoteJid,
        timestamp: Date.now()
      });

    } catch (err) {
      console.error('antiDelete.handleIncomingMessage error', err);
    }
  }

  async function handleProtocolMessage(m) {
    try {
      if (!enabled || !m?.message?.protocolMessage) return;

      const proto = m.message.protocolMessage;
      const revokedKey = proto.key;
      if (!revokedKey) return;

      const chat = revokedKey.remoteJid || m.key.remoteJid;
      const revokedId = revokedKey.id;
      const cacheKey = `${chat}:${revokedId}`;
      const saved = cache.get(cacheKey);

      // Get group name if group
      let groupName = chat;
      if (chat.endsWith('@g.us')) {
        const metadata = await trashcore.groupMetadata(chat).catch(() => ({}));
        groupName = metadata?.subject || chat;
      }

      if (!saved) {
        await trashcore.sendMessage(botNumber, { text: `⚠️ A deleted message was not found in cache in group: ${groupName}` });
        return;
      }

      const senderJid = saved.sender || 'unknown@s.whatsapp.net';
      const userTag = `@${senderJid.split('@')[0]}`;
      const mention = [senderJid];
      const header = `🛡️ *Anti-Delete*\nGroup: ${groupName}\nUser: ${userTag}`;

      // Text messages
      if (saved.type === 'text') {
        await trashcore.sendMessage(botNumber, { text: `${header}\n\nDeleted message:\n${saved.text}`, mentions: mention });
        return;
      }

      // Media messages with downloadable support
      if (['image','video','audio','sticker','document'].includes(saved.type)) {
        let msgOptions = {};

        switch(saved.type) {
          case 'image': msgOptions.image = saved.contentBuffer; break;
          case 'video': msgOptions.video = saved.contentBuffer; break;
          case 'audio': msgOptions.audio = saved.contentBuffer; msgOptions.mimetype = saved.mimetype || 'audio/mpeg'; break;
          case 'sticker': msgOptions.sticker = saved.contentBuffer; break;
          case 'document': msgOptions.document = saved.contentBuffer; msgOptions.fileName = saved.fileName || 'file'; break;
        }

        if (['image','video','document'].includes(saved.type)) {
          msgOptions.caption = `${header}\nOriginal caption: ${saved.caption || '—'}`;
          msgOptions.contextInfo = { mentionedJid: mention };
        }

        await trashcore.sendMessage(botNumber, msgOptions);
        return;
      }

      // fallback
      await trashcore.sendMessage(botNumber, { text: `${header}\n(Content type not supported)`, mentions: mention });

    } catch (err) {
      console.error('antiDelete.handleProtocolMessage error:', err);
    }
  }

  // Wire up event listener
  trashcore.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (m?.message?.protocolMessage) await handleProtocolMessage(m);
        else if (m?.message) await handleIncomingMessage(m);
      } catch (e) {
        console.error('antiDelete messages.upsert loop error', e);
      }
    }
  });

  return {
    clearCache: () => { cache.clear(); persist(); },
    getCacheSize: () => cache.size
  };
};