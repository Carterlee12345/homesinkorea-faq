const BROADCAST_SYSTEM = `You are a broadcast message writer for HOMESINKOREA, a short/mid-term furnished rental service for international residents in Seoul, Korea.

Write concise, warm, professional broadcast messages to send via Channel Talk.

TONE RULES:
- Korean: formal ~합니다/드립니다 style, address as "고객님". Warm and human — not robotic.
- English: friendly and professional. Clear and direct.
- Both messages must convey exactly the same information.
- Keep messages concise (3–6 sentences max). No unnecessary filler.
- For urgent notices: lead with the key fact immediately.
- For promotions: lead with the benefit, not the mechanics.
- Always end with a clear next step or contact prompt (e.g. "문의사항은 채널톡으로 편하게 말씀해 주세요.")

OUTPUT FORMAT — respond ONLY with a single valid JSON object, no markdown, no extra text:
{
  "ko_message": "Complete Korean broadcast message ready to send",
  "en_message": "Complete English broadcast message ready to send"
}`;

const BASE = 'https://api.channel.io/open/v5';
function ctHeaders(key, secret) {
  return { 'x-access-key': key, 'x-access-secret': secret, 'content-type': 'application/json' };
}
async function fetchAllUserChats(key, secret) {
  const chats = []; let since = null;
  do {
    const url = new URL(`${BASE}/user-chats`);
    url.searchParams.set('state', 'opened');
    url.searchParams.set('limit', '500');
    if (since) url.searchParams.set('since', since);
    const res = await fetch(url.toString(), { headers: ctHeaders(key, secret) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `채널톡 API 오류 (${res.status})`); }
    const data = await res.json();
    chats.push(...(data.userChats || []));
    since = data.next || null;
    if (since) await new Promise(r => setTimeout(r, 150));
  } while (since);
  return chats;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action || 'generate';

  // ── generate ──
  if (action === 'generate') {
    const { brief, purpose, tags, statusFilter } = req.body;
    if (!brief?.trim()) return res.status(400).json({ error: '전달 내용이 없습니다.' });
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: '서버 설정 오류: API 키가 없습니다.' });
    const audienceNote = [
      tags?.length ? `수신 태그: ${tags.join(', ')}` : '',
      statusFilter ? `고객 상태: ${statusFilter}` : '',
      purpose ? `메시지 목적: ${purpose}` : ''
    ].filter(Boolean).join(' | ');
    const userMessage = `다음 정보를 바탕으로 채널톡 발송용 메시지를 작성해주세요.\n\n[발송 대상 정보]\n${audienceNote}\n\n[전달 내용]\n${brief.trim()}`;
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: BROADCAST_SYSTEM }, { role: 'user', content: userMessage }], temperature: 0.6, max_tokens: 1000 })
      });
      const data = await response.json();
      if (data.error) return res.status(502).json({ error: data.error.message });
      const raw = data.choices?.[0]?.message?.content;
      const jsonMatch = raw?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(502).json({ error: '응답 형식 오류. 다시 시도해주세요.' });
      const result = JSON.parse(jsonMatch[0]);
      if (!result.ko_message || !result.en_message) return res.status(502).json({ error: '응답 형식 오류: 필드 누락' });
      return res.status(200).json(result);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── send ──
  if (action === 'send') {
    const { message, tags } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: '메시지가 없습니다.' });
    if (!tags?.length) return res.status(400).json({ error: '태그가 없습니다.' });
    const key = process.env.CHANNELTALK_ACCESS_KEY;
    const secret = process.env.CHANNELTALK_ACCESS_SECRET;
    if (!key || !secret) return res.status(500).json({ error: '채널톡 API 키가 설정되지 않았습니다.' });
    try {
      const allChats = await fetchAllUserChats(key, secret);
      const matched = allChats.filter(chat => (chat.tags || []).some(t => tags.includes(t)));
      if (!matched.length) return res.status(200).json({ sent: 0, failed: 0, total: 0, skipped: allChats.length });
      let sent = 0, failed = 0;
      for (const chat of matched) {
        try {
          const r = await fetch(`${BASE}/user-chats/${chat.id}/messages`, { method: 'POST', headers: ctHeaders(key, secret), body: JSON.stringify({ blocks: [{ type: 'text', value: message }], options: ['actAsManager'] }) });
          if (r.ok) sent++; else failed++;
          await new Promise(r => setTimeout(r, 120));
        } catch { failed++; }
      }
      return res.status(200).json({ sent, failed, total: matched.length, scanned: allChats.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: '잘못된 action' });
};
