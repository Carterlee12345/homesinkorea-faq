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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brief, purpose, tags, statusFilter } = req.body;
  if (!brief || !brief.trim()) return res.status(400).json({ error: '전달 내용이 없습니다.' });

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
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: BROADCAST_SYSTEM },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.6,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return res.status(502).json({ error: '응답 파싱 실패. 다시 시도해주세요.' });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: '응답 형식 오류. 다시 시도해주세요.' });

    const result = JSON.parse(jsonMatch[0]);
    if (!result.ko_message || !result.en_message)
      return res.status(502).json({ error: '응답 형식 오류: 필드 누락' });

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
