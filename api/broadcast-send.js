const BASE = 'https://api.channel.io/open/v5';

function ctHeaders(key, secret) {
  return { 'x-access-key': key, 'x-access-secret': secret, 'content-type': 'application/json' };
}

async function fetchAllUserChats(key, secret) {
  const chats = [];
  let since = null;
  do {
    const url = new URL(`${BASE}/user-chats`);
    url.searchParams.set('state', 'opened');
    url.searchParams.set('limit', '500');
    if (since) url.searchParams.set('since', since);

    const res = await fetch(url.toString(), { headers: ctHeaders(key, secret) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `채널톡 API 오류 (${res.status})`);
    }
    const data = await res.json();
    chats.push(...(data.userChats || []));
    since = data.next || null;
    if (since) await new Promise(r => setTimeout(r, 150));
  } while (since);
  return chats;
}

async function sendToChat(key, secret, chatId, message) {
  const res = await fetch(`${BASE}/user-chats/${chatId}/messages`, {
    method: 'POST',
    headers: ctHeaders(key, secret),
    body: JSON.stringify({
      blocks: [{ type: 'text', value: message }],
      options: ['actAsManager']
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `발송 실패 (${res.status})`);
  }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, tags } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '메시지가 없습니다.' });
  if (!tags?.length) return res.status(400).json({ error: '태그가 없습니다.' });

  const key = process.env.CHANNELTALK_ACCESS_KEY;
  const secret = process.env.CHANNELTALK_ACCESS_SECRET;
  if (!key || !secret) return res.status(500).json({ error: '채널톡 API 키가 설정되지 않았습니다.' });

  try {
    const allChats = await fetchAllUserChats(key, secret);

    const matched = allChats.filter(chat =>
      (chat.tags || []).some(t => tags.includes(t))
    );

    if (!matched.length) {
      return res.status(200).json({ sent: 0, failed: 0, total: 0, skipped: allChats.length });
    }

    let sent = 0, failed = 0;
    for (const chat of matched) {
      try {
        await sendToChat(key, secret, chat.id, message);
        sent++;
        await new Promise(r => setTimeout(r, 120));
      } catch {
        failed++;
      }
    }

    return res.status(200).json({ sent, failed, total: matched.length, scanned: allChats.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
