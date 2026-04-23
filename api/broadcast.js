const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected || Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return null;
  return Buffer.from(payload, 'base64').toString();
}

async function checkIsAdmin(token) {
  const email = verifyToken(token);
  if (!email) return false;
  const raw = await redis(['GET', `user:${email}`]);
  if (!raw) return false;
  return JSON.parse(raw).isAdmin === true;
}

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

/* ── 채널톡 키워드 분류 ── */
const KEYWORDS = {
  '📅 예약문의': ['예약','투어','방문','견학','구경','스케줄','날짜','언제','몇시','시간',
    'tour','visit','schedule','booking','reservation','when','available','exchange','semester','appointment'],
  '📝 계약문의': ['계약','서류','입금','사인','확정','진행','결정','보내주','작성',
    'contract','sign','document','deposit','proceed','confirm','move in','move-in','lease','agreement'],
  '🏠 집문의': ['보증금','월세','방','원룸','투룸','쓰리룸','관리비','층','크기','주소','위치','가격','얼마','시설','주차','반려','옵션','넓이','평',
    'rent','room','studio','price','how much','fee','floor','size','location','address','recommend','budget','furnished','utility','available','vacancy','apartment','unit'],
};
function classify(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}
async function ctGet(url, fullUrl=false) {
  const endpoint = fullUrl ? url : `https://api.channel.io${url}`;
  const res = await fetch(endpoint, {
    headers: { 'x-access-key': process.env.CHANNELTALK_ACCESS_KEY, 'x-access-secret': process.env.CHANNELTALK_ACCESS_SECRET },
  });
  if (!res.ok) throw new Error(`CT API ${res.status}: ${await res.text()}`);
  return res.json();
}
async function ctPost2(chatId, text) {
  // v5 API: user-chats/{id}/messages
  const res = await fetch(`https://api.channel.io/open/v5/user-chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-key': process.env.CHANNELTALK_ACCESS_KEY, 'x-access-secret': process.env.CHANNELTALK_ACCESS_SECRET },
    body: JSON.stringify({ blocks: [{ type: 'text', value: text }], options: ['actAsManager'] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`CT API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function slackApi(endpoint, body) {
  const [token] = (process.env.SLACK_CX_BOT || '').split('|');
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ── RSS 파싱 ── */
async function fetchRSS(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,application/xml,text/xml' } });
  if (!res.ok) throw new Error(`RSS ${res.status}: ${url}`);
  return res.text();
}
function parseRSSItems(xml, max) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, max)) {
    const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] || block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<[^>]+>/g,'').trim();
    const link  = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || '').trim();
    const desc  = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] || block.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] || '').replace(/<[^>]+>/g,'').trim().slice(0,80);
    if (title) items.push({ title, link, desc });
  }
  return items;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'generate';

  /* ── GET: 뉴스 브리핑 + 채널톡 오전 문의 다이제스트 (Vercel Cron 10:00 KST) ── */
  if (req.method === 'GET') {
    try {
      const now = new Date();
      const [,channelId] = (process.env.SLACK_CX_BOT||'').split('|');
      const dateStr = now.toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'short'});

      /* 1) 뉴스 브리핑 ─────────────────────────────── */
      try {
        const [sbsXml, aiXml] = await Promise.all([
          fetchRSS('https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=00'),
          fetchRSS('https://news.google.com/rss/search?q=AI+인공지능+ChatGPT&hl=ko&gl=KR&ceid=KR:ko'),
        ]);
        const sbsItems = parseRSSItems(sbsXml, 8);
        const aiItems  = parseRSSItems(aiXml,  3);

        const newsBlocks = [
          { type:'header', text:{type:'plain_text', text:`📰 ${dateStr} 뉴스 브리핑`, emoji:true} },
          { type:'divider' },
        ];

        if (sbsItems.length) {
          newsBlocks.push({ type:'section', text:{type:'mrkdwn', text:'*📺 SBS 주요 뉴스*'} });
          sbsItems.forEach((n,i)=>{
            newsBlocks.push({ type:'section', text:{type:'mrkdwn',
              text:`${i+1}. ${n.link ? `<${n.link}|${n.title}>` : n.title}${n.desc?`\n_${n.desc}…_`:''}`
            }});
          });
          newsBlocks.push({ type:'divider' });
        }

        if (aiItems.length) {
          newsBlocks.push({ type:'section', text:{type:'mrkdwn', text:'*🤖 AI & 테크 변화*'} });
          aiItems.forEach((n,i)=>{
            newsBlocks.push({ type:'section', text:{type:'mrkdwn',
              text:`${i+1}. ${n.link ? `<${n.link}|${n.title}>` : n.title}${n.desc?`\n_${n.desc}…_`:''}`
            }});
          });
        }

        await slackApi('chat.postMessage',{channel:channelId, text:`📰 ${dateStr} 뉴스 브리핑`, blocks:newsBlocks});
      } catch(e){ console.error('뉴스 fetch 오류:',e.message); }

      /* 2) 채널톡 오전 문의 다이제스트 ────────────── */
      const since = new Date(now); since.setUTCDate(since.getUTCDate()-1); since.setUTCHours(9,0,0,0);
      const until = new Date(now); until.setUTCHours(1,0,0,0);
      // v5 API: 여러 상태별로 가져와서 합치기 (state=all 미지원)
      const STATES = ['initial','opened','closed','missed'];
      let allConvs = [];
      for (const state of STATES) {
        let sinceParam = null;
        for (let p=0; p<3; p++) {
          const url = new URL('https://api.channel.io/open/v5/user-chats');
          url.searchParams.set('state', state); url.searchParams.set('limit','50');
          if (sinceParam) url.searchParams.set('since', sinceParam);
          const data = await ctGet(url.toString(), true);
          const chats = data.userChats||[];
          allConvs = allConvs.concat(chats);
          sinceParam = data.next||null;
          if (!sinceParam || !chats.length) break;
        }
      }
      // 중복 제거
      const seen = new Set();
      allConvs = allConvs.filter(c=>{ if(seen.has(c.id)) return false; seen.add(c.id); return true; });
      const inRange = allConvs.filter(c=>{const t=c.createdAt||c.updatedAt;if(!t)return false;const ts=new Date(t).getTime();return ts>=since.getTime()&&ts<=until.getTime();});
      const filtered = [];
      for (const conv of inRange) {
        try {
          const msgData = await ctGet(`https://api.channel.io/open/v5/user-chats/${conv.id}/messages?limit=10`, true);
          const messages = msgData.messages||[];
          const userMsg = messages.find(m=>m.personType==='user'||m.personType==='guest');
          if (!userMsg) continue;
          const text = userMsg.plainText||(userMsg.blocks||[]).map(b=>b.value||'').join(' ')||'';
          const category = classify(text);
          if (!category) continue;
          const userName = conv.user?.name||conv.user?.profile?.name||conv.guest?.name||'이름없음';
          filtered.push({convId:conv.id,category,userName,message:text,createdAt:new Date(conv.createdAt||Date.now())});
        } catch(e){ console.warn(`conv ${conv.id}:`,e.message); }
      }
      if (!filtered.length) {
        await slackApi('chat.postMessage',{channel:channelId,text:`📋 ${dateStr} 오전 문의 — 없음`,blocks:[
          {type:'header',text:{type:'plain_text',text:`📋 ${dateStr} 오전 문의 정리`,emoji:true}},
          {type:'context',elements:[{type:'mrkdwn',text:'어젯밤 18:00 ~ 오늘 10:00 | 예약 · 계약 · 집문의 분류'}]},
          {type:'divider'},{type:'section',text:{type:'mrkdwn',text:'✅ 해당 시간대에 분류된 문의가 없습니다.'}}
        ]});
        return res.status(200).json({sent:0,inRange:inRange.length});
      }
      const blocks = [
        {type:'header',text:{type:'plain_text',text:`📋 ${dateStr} 오전 문의 정리 — 총 ${filtered.length}건`,emoji:true}},
        {type:'context',elements:[{type:'mrkdwn',text:'어젯밤 18:00 ~ 오늘 10:00 | 예약 · 계약 · 집문의 | *답장하기* 로 채널톡 직접 답장'}]},
        {type:'divider'},
      ];
      for (const item of filtered) {
        const timeStr = item.createdAt.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
        const preview = item.message.length>120?item.message.slice(0,120)+'…':item.message;
        blocks.push({type:'section',text:{type:'mrkdwn',text:`${item.category}  |  👤 *${item.userName}*  |  🕐 ${timeStr}\n> ${preview}`},
          accessory:{type:'button',text:{type:'plain_text',text:'✏️ 답장하기',emoji:true},style:'primary',value:item.convId,action_id:'reply_to_ct'}});
        blocks.push({type:'divider'});
      }
      const r = await slackApi('chat.postMessage',{channel:channelId,text:`📋 ${dateStr} 오전 문의 — ${filtered.length}건`,blocks});
      if (!r.ok) return res.status(500).json({error:'Slack 전송 실패',detail:r.error});
      return res.status(200).json({sent:filtered.length,inRange:inRange.length});
    } catch(e){ console.error('digest error:',e); return res.status(500).json({error:e.message}); }
  }

  /* ── POST: Slack 인터랙티브 액션 (답장하기 버튼) ── */
  if (req.method === 'POST' && (req.body?.payload || req.query.action === 'slack-action')) {
    let payload;
    try {
      if (req.body?.payload) payload = typeof req.body.payload==='string'?JSON.parse(req.body.payload):req.body.payload;
      else if (typeof req.body==='string') { const p=new URLSearchParams(req.body); payload=JSON.parse(p.get('payload')||'{}'); }
      else payload = req.body;
    } catch(e){ return res.status(400).json({error:'Bad payload'}); }
    const {type,trigger_id,actions,view} = payload;
    if (type==='block_actions' && actions?.[0]?.action_id==='reply_to_ct') {
      const convId = actions[0].value;
      await slackApi('views.open',{trigger_id,view:{
        type:'modal',callback_id:'send_reply',private_metadata:convId,
        title:{type:'plain_text',text:'채널톡 답장',emoji:true},
        submit:{type:'plain_text',text:'📤 전송',emoji:true},
        close:{type:'plain_text',text:'취소',emoji:true},
        blocks:[
          {type:'section',text:{type:'mrkdwn',text:'💬 *채널톡 대화에 직접 답장*됩니다.\n고객에게 보낼 메시지를 입력해주세요.'}},
          {type:'input',block_id:'reply_block',label:{type:'plain_text',text:'답장 내용',emoji:true},
            element:{type:'plain_text_input',action_id:'reply_text',multiline:true,min_length:1,
              placeholder:{type:'plain_text',text:'예) 안녕하세요! 문의 주셔서 감사합니다...'}}}
        ]
      }});
      return res.status(200).end();
    }
    if (type==='view_submission' && view?.callback_id==='send_reply') {
      const convId = view.private_metadata;
      const replyText = view.state?.values?.reply_block?.reply_text?.value?.trim();
      if (replyText && convId) {
        try { await ctPost2(convId, replyText); }
        catch(e){ return res.status(200).json({response_action:'errors',errors:{reply_block:`전송 실패: ${e.message}`}}); }
      }
      return res.status(200).json({response_action:'clear'});
    }
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

  // ── send (admin only) ──
  if (action === 'send') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!await checkIsAdmin(token)) return res.status(403).json({ error: '공지 발송은 관리자만 가능합니다.' });
    const { message, tags, tagMode } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: '메시지가 없습니다.' });
    if (!tags?.length) return res.status(400).json({ error: '태그가 없습니다.' });
    const key = process.env.CHANNELTALK_ACCESS_KEY;
    const secret = process.env.CHANNELTALK_ACCESS_SECRET;
    if (!key || !secret) return res.status(500).json({ error: '채널톡 API 키가 설정되지 않았습니다.' });
    try {
      const allChats = await fetchAllUserChats(key, secret);
      const matched = allChats.filter(chat => {
        const chatTags = chat.tags || [];
        return tagMode === 'and'
          ? tags.every(t => chatTags.includes(t))
          : chatTags.some(t => tags.includes(t));
      });
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
