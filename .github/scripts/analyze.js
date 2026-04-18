const CT_BASE = 'https://api.channel.io';
const CT_HEADERS = () => ({
  'x-access-key': process.env.CHANNELTALK_ACCESS_KEY,
  'x-access-secret': process.env.CHANNELTALK_ACCESS_SECRET,
  'Content-Type': 'application/json'
});

async function ctFetch(path) {
  const res = await fetch(`${CT_BASE}${path}`, { headers: CT_HEADERS() });
  if (!res.ok) throw new Error(`ChannelTalk ${path} → HTTP ${res.status}`);
  return res.json();
}

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

async function fetchAllClosedChats() {
  let allChats = [], since = null, page = 0;
  do {
    const qs = `state=closed&limit=200${since ? `&since=${since}` : ''}`;
    const data = await ctFetch(`/open/v5/user-chats?${qs}`);
    const chats = data.userChats || [];
    allChats = allChats.concat(chats);
    since = data.next || null;
    page++;
    console.log(`  page ${page}: ${chats.length} chats (cumulative: ${allChats.length})`);
    if (chats.length < 200) break;
  } while (since && page < 100);
  return allChats;
}

async function fetchMessages(chatId) {
  try {
    const data = await ctFetch(`/open/v5/user-chats/${chatId}/messages?limit=20`);
    return (data.messages || [])
      .filter(m => m.plainText && m.plainText.trim())
      .map(m => m.plainText.trim())
      .join('\n')
      .slice(0, 600);
  } catch { return ''; }
}

async function groqBatch(texts) {
  const prompt = texts.map((t, i) => `[상담${i + 1}]\n${t}`).join('\n\n---\n\n');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `부동산 임대 CX 분석가. 주어진 상담 내용들을 분석해 JSON만 반환.
카테고리: 가격/비용 문의, 예약/입주 방법, 위치/지역 문의, 룸 타입/인원, 입주 기간/단기, 서류/계약, 반려동물, 서울 외 지역, 시설/편의, 비자/서류 지원, 기타
형식: {"categories":{"카테고리":건수},"locations":{"지역":건수},"faqs":[{"question":"질문","answer":"답변","category":"카테고리","freq":숫자}]}`
        },
        { role: 'user', content: `${texts.length}개 상담 분석:\n\n${prompt}` }
      ]
    })
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Dashboard Analysis Start ===');

  const allChats = await fetchAllClosedChats();
  console.log(`Total closed chats: ${allChats.length}`);

  // Compute from metadata — no AI needed
  const monthlyData = {};
  const tagData = {};
  allChats.forEach(chat => {
    const d = new Date(chat.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyData[key] = (monthlyData[key] || 0) + 1;
    (chat.tags || []).forEach(t => { tagData[t] = (tagData[t] || 0) + 1; });
  });

  // Top 20 tags only
  const sortedTagData = Object.fromEntries(
    Object.entries(tagData).sort((a, b) => b[1] - a[1]).slice(0, 20)
  );

  // Fetch messages for 50 most recent chats
  console.log('Fetching messages for 50 recent chats...');
  const recent = allChats.slice(0, 50);
  const chatTexts = [];
  for (const chat of recent) {
    chatTexts.push(await fetchMessages(chat.id));
    await sleep(100);
  }
  const validTexts = chatTexts.filter(t => t.length > 50);
  console.log(`Valid chat texts: ${validTexts.length}`);

  // Batch AI analysis (10 per batch, max 5 batches)
  const BATCH = 10, MAX_BATCHES = 5;
  let catData = {}, locData = {}, faqItems = [];

  for (let i = 0; i < Math.min(Math.ceil(validTexts.length / BATCH), MAX_BATCHES); i++) {
    const batch = validTexts.slice(i * BATCH, (i + 1) * BATCH);
    if (!batch.length) break;
    console.log(`AI batch ${i + 1}: ${batch.length} chats...`);
    const result = await groqBatch(batch);
    Object.entries(result.categories || {}).forEach(([k, v]) => { catData[k] = (catData[k] || 0) + v; });
    Object.entries(result.locations || {}).forEach(([k, v]) => { locData[k] = (locData[k] || 0) + v; });
    if (result.faqs) faqItems = faqItems.concat(result.faqs);
    if (i < MAX_BATCHES - 1) await sleep(3000);
  }

  // Scale counts to represent full dataset
  const sampleSize = Math.min(validTexts.length, BATCH * MAX_BATCHES);
  if (sampleSize > 0 && allChats.length > sampleSize) {
    const scale = allChats.length / sampleSize;
    Object.keys(catData).forEach(k => { catData[k] = Math.round(catData[k] * scale); });
    Object.keys(locData).forEach(k => { locData[k] = Math.round(locData[k] * scale); });
  }

  // Deduplicate FAQ items (keep highest freq per category+question prefix)
  const faqMap = {};
  faqItems.forEach(item => {
    const key = (item.category || '') + '|' + (item.question || '').slice(0, 30);
    if (!faqMap[key] || (faqMap[key].freq || 0) < (item.freq || 0)) faqMap[key] = item;
  });
  const faqData = Object.values(faqMap)
    .filter(f => f.question && f.answer)
    .sort((a, b) => (b.freq || 0) - (a.freq || 0))
    .slice(0, 20);

  const adCount = (tagData['광고'] || 0);
  const dashboardData = {
    updatedAt: new Date().toISOString(),
    kpi: {
      total: allChats.length,
      real: allChats.length - adCount,
      spam: adCount,
      categories: Object.keys(catData).length || 11
    },
    monthlyData,
    catData,
    tagData: sortedTagData,
    locData,
    faqData
  };

  await redis(['SET', 'dashboard:data', JSON.stringify(dashboardData)]);
  console.log('=== Stored to Upstash ===');
  console.log(JSON.stringify({ total: allChats.length, faqs: faqData.length, cats: Object.keys(catData).length }));
}

main().catch(err => { console.error(err); process.exit(1); });
