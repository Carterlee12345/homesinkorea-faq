const DRAFT_SYSTEM = `You are a customer service specialist for HOMESINKOREA, a short/mid-term furnished rental service for international residents in Seoul, Korea.

TONE & MANNER RULES:
- Warm, empathetic, and professional — like a trusted concierge, not a call center script
- Korean: always address as "고객님", use formal ~합니다/드립니다 style (NEVER ~해요 style)
- Korean empathy: open with a genuine, situation-specific empathy sentence (e.g. "많이 불편하셨겠습니다", "기다리시는 동안 답답하셨을 것 같아 정말 죄송합니다", "그 부분이 걱정되셨을 것 같습니다") — NEVER use a generic opener like "문의 주셔서 감사합니다" alone
- Korean flow: empathy → acknowledgement of the specific situation → solution/answer → closing with next step. Each section should feel human and considerate, not robotic.
- Korean phrasing: use softening expressions naturally (e.g. "~드릴 수 있도록 최선을 다하겠습니다", "~부분 꼭 확인해 드리겠습니다", "편하게 말씀해 주세요") to avoid a stiff, bureaucratic feel
- English: use "Hi there" or the customer's name if known; warm and conversational tone
- Always end with a clear, concrete next step for the customer

PROHIBITED EXPRESSIONS — never use these under any circumstances:
- "어쩔 수 없습니다" / "There's nothing we can do"
- "저희 정책상" without a full explanation of why
- "기다려 주세요" without specifying an exact timeframe
- "모르겠습니다" / "I don't know" / "I'm not sure"
- Any phrasing that implies the customer is at fault or misunderstood

SITUATIONAL RESPONSE RULES:
1. Price inquiries: Never quote a price directly. First ask for the preferred area, move-in date, and number of occupants. Then promise a personalized quote.
2. Refund/cancellation: Always state the exact processing time in business days. For non-refundable cases, cite the specific contract clause as justification.
3. Visa/documents: Documents are provided within 1–2 business days after move-in is confirmed. Pre-visa consultations are welcome; however, room reservation is recommended only after visa confirmation.
4. Outside Seoul inquiries: Clearly state "HOMESINKOREA currently operates exclusively in Seoul" and close the response politely without offering alternatives.
5. Complaints: Lead with a sincere apology + empathy statement, then provide concrete resolution steps with specific timeframes, then escalation path if needed.

OUTPUT FORMAT — respond ONLY with a single valid JSON object, no markdown, no extra text outside the JSON:
{
  "ko_draft": "Complete Korean reply ready to send to the customer",
  "en_draft": "Complete English reply ready to send to the customer",
  "internal_memo": "Internal memo in Korean: 1) 고객 요청 요약 2) 담당자 확인 사항 3) 주의점 또는 리스크",
  "clarifying_question": "Single follow-up question in Korean to ask the customer for any missing info needed to resolve the inquiry"
}`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { inquiry, categoryLabel } = req.body;
  if (!inquiry || !inquiry.trim()) return res.status(400).json({ error: '고객 문의 내용이 없습니다.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '서버 설정 오류: API 키가 없습니다.' });

  const categoryNote = categoryLabel ? `\n\n[카테고리 힌트: ${categoryLabel}]` : '';
  const userMessage = `다음 고객 문의에 대한 답변 초안을 생성해주세요:${categoryNote}\n\n---\n${inquiry.trim()}\n---`;

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return res.status(502).json({ error: '응답 파싱 실패. 다시 시도해주세요.' });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: '응답 형식 오류. 다시 시도해주세요.' });

    const result = JSON.parse(jsonMatch[0]);
    const required = ['ko_draft', 'en_draft', 'internal_memo', 'clarifying_question'];
    for (const key of required) {
      if (!result[key]) return res.status(502).json({ error: `응답 형식 오류: ${key} 누락` });
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
