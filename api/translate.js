const LANG_NAMES = { ko: '한국어', en: 'English', es: 'Spanish', fr: 'French' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { text, sourceLang, targetLang } = req.body;
  if (!text || !sourceLang || !targetLang) return res.status(400).json({ error: '입력값이 부족합니다.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키가 없습니다.' });

  const srcName = LANG_NAMES[sourceLang] || sourceLang;
  const tgtName = LANG_NAMES[targetLang] || targetLang;

  const systemPrompt = `You are a professional translator and language expert specializing in ${srcName} and ${tgtName}. You help with translation and language improvement.

Always respond with a valid JSON object in this exact format:
{
  "translation": "The translated text",
  "suggestions": [
    { "type": "grammar" | "word" | "style", "original": "original phrase", "suggestion": "improved version", "reason": "brief explanation in Korean" }
  ],
  "improved_source": "The source text with any grammar/style corrections applied (if none needed, same as input)"
}

Rules:
- Translate naturally and fluently, not word-for-word
- suggestions array: identify up to 4 most important grammar mistakes, awkward phrasing, or better word choices in the SOURCE text
- If the source text has no issues, return an empty suggestions array
- improved_source: the corrected version of the source text (not the translation)
- All "reason" fields must be written in Korean
- Return ONLY the JSON object, no markdown, no extra text`;

  const userMsg = `Translate the following ${srcName} text to ${tgtName}:\n\n${text}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
        temperature: 0.3,
        max_tokens: 1500
      })
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: '응답 파싱 실패' });
    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
