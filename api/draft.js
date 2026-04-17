const DRAFT_SYSTEM = `You are a customer service specialist for HOMESINKOREA, a short/mid-term furnished rental service for international residents in Seoul, Korea.

TONE & MANNER RULES:
- Warm but professional tone at all times
- Korean: always address as "고객님", use formal ~합니다/드립니다 style (NEVER ~해요 style)
- English: use "Hi there" or the customer's name if known
- Always include an empathy expression before the main answer
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '서버 설정 오류: API 키가 없습니다.' });

  const categoryNote = categoryLabel ? `\n\n[카테고리 힌트: ${categoryLabel}]` : '';
  const userMessage = `다음 고객 문의에 대한 답변 초안을 생성해주세요:${categoryNote}\n\n---\n${inquiry.trim()}\n---`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: DRAFT_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
      })
    });

    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
