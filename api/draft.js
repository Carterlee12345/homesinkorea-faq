async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

const OUTPUT_FORMAT = `
OUTPUT FORMAT — respond ONLY with a single valid JSON object, no markdown, no extra text:
{
  "ko_draft": "완성된 한국어 답변 (바로 전송 가능한 형태)",
  "en_draft": "Complete English reply (ready to send)",
  "internal_memo": "내부 메모 (Korean): 1) 요청 요약 2) 담당자 확인 사항 3) 주의점/리스크",
  "clarifying_question": "추가 확인이 필요한 경우 고객에게 물어볼 질문 (Korean, 없으면 빈 문자열)"
}`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { inquiry, type = 'message' } = req.body;
  if (!inquiry?.trim()) return res.status(400).json({ error: '내용이 없습니다.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '서버 설정 오류: API 키가 없습니다.' });

  const rawRules = await redis(['GET', 'draft:rules']);
  const rules = rawRules ? JSON.parse(rawRules) : null;
  const activeRules = rules?.[type] || (type === 'email'
    ? `형식: 이메일 형식 준수 (인사말→본문→마무리), 제목 제안 포함 ([제목:...]/[Subject:...])\n톤앤매너: 친근하지만 전문적, 고객님 호칭, ~합니다/드립니다체\n금지: "어쩔 수 없습니다", "저희 정책상"(단독), "기다려 주세요"(시간 없이)`
    : `톤앤매너: 친근하지만 전문적, 고객님 호칭, ~합니다/드립니다체, 공감 표현 필수\n금지: "어쩔 수 없습니다", "저희 정책상"(단독), "기다려 주세요"(시간 없이)`
  );

  const isEmail = type === 'email';
  const typeLabel = isEmail ? '이메일 (Email)' : '메시지 (Message)';

  const systemPrompt = `You are a response draft writer for HOMESINKOREA, a short/mid-term furnished rental service for international residents in Seoul, Korea.

Generate professional ${typeLabel} response drafts in both Korean and English.
${isEmail ? '\nFor email: include a suggested subject line at the top of each draft in format "[제목: ...]" (Korean) and "[Subject: ...]" (English).' : ''}

RULES TO FOLLOW:
${activeRules}
${OUTPUT_FORMAT}`;

  const userMessage = `다음 내용에 대한 ${typeLabel} 답변 초안을 생성해주세요:\n\n---\n${inquiry.trim()}\n---`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
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
    for (const key of ['ko_draft', 'en_draft', 'internal_memo', 'clarifying_question']) {
      if (result[key] === undefined) return res.status(502).json({ error: `응답 형식 오류: ${key} 누락` });
    }

    return res.status(200).json(result);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
