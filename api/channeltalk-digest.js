/**
 * channeltalk-digest.js
 * 매일 10:10 KST (01:10 UTC) Vercel Cron으로 실행
 * 채널톡에서 18:00~10:00 사이 예약/계약/집문의 분류 후 슬랙 전송
 */

const KEYWORDS = {
  '📅 예약문의': [
    '예약','투어','방문','견학','구경','스케줄','날짜','언제','몇시','시간',
    'tour','visit','schedule','booking','reservation','when','available',
    'exchange','semester','appointment',
  ],
  '📝 계약문의': [
    '계약','서류','입금','사인','확정','진행','결정','보내주','작성',
    'contract','sign','document','deposit','proceed','confirm',
    'move in','move-in','lease','agreement',
  ],
  '🏠 집문의': [
    '보증금','월세','방','원룸','투룸','쓰리룸','관리비','층','크기',
    '주소','위치','가격','얼마','시설','주차','반려','옵션','넓이','평',
    'rent','room','studio','price','how much','fee','floor','size',
    'location','address','recommend','budget','furnished','utility',
    'available','vacancy','apartment','unit',
  ],
};

function classify(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

async function ctGet(path) {
  const res = await fetch(`https://api.channel.io${path}`, {
    headers: {
      'x-access-key': process.env.CHANNELTALK_ACCESS_KEY,
      'x-access-secret': process.env.CHANNELTALK_ACCESS_SECRET,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Channel Talk API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function slackPost(endpoint, body) {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_CX_BOT?.split('|')[0]}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  // Vercel Cron 인증
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 시간 범위: 어제 18:00 KST ~ 오늘 10:00 KST
    // KST = UTC+9 → 18:00 KST = 09:00 UTC, 10:00 KST = 01:00 UTC
    const now = new Date();

    const since = new Date(now);
    since.setUTCDate(since.getUTCDate() - 1);
    since.setUTCHours(9, 0, 0, 0); // 어제 18:00 KST

    const until = new Date(now);
    until.setUTCHours(1, 0, 0, 0); // 오늘 10:00 KST

    // 채널톡 대화 목록 가져오기
    let allConversations = [];
    let cursor = null;

    // 페이지네이션 처리 (최대 5페이지)
    for (let page = 0; page < 5; page++) {
      const url = `/open/v1/conversations?state=all&limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const data = await ctGet(url);
      const convs = data.conversations || [];
      allConversations = allConversations.concat(convs);
      cursor = data.cursor;
      if (!cursor || convs.length === 0) break;
    }

    // 시간 범위 필터링
    const inRange = allConversations.filter(c => {
      const t = c.createdAt || c.updatedAt;
      if (!t) return false;
      const ts = new Date(t).getTime();
      return ts >= since.getTime() && ts <= until.getTime();
    });

    // 각 대화의 첫 번째 고객 메시지로 분류
    const filtered = [];

    for (const conv of inRange) {
      try {
        const msgData = await ctGet(`/open/v1/conversations/${conv.id}/messages?limit=10`);
        const messages = msgData.messages || [];

        // 고객(user) 메시지 찾기
        const userMsg = messages.find(m => m.personType === 'user' || m.personType === 'guest');
        if (!userMsg) continue;

        const text = userMsg.plainText || userMsg.text || '';
        const category = classify(text);
        if (!category) continue;

        // 고객 이름
        const userName =
          conv.user?.name ||
          conv.user?.profile?.name ||
          conv.guest?.name ||
          '이름없음';

        // 시간
        const createdAt = new Date(conv.createdAt || Date.now());

        filtered.push({ convId: conv.id, category, userName, message: text, createdAt });
      } catch (e) {
        console.warn(`conv ${conv.id} 처리 오류:`, e.message);
      }
    }

    const dateStr = now.toLocaleDateString('ko-KR', {
      timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short',
    });

    // 문의 없을 때
    if (filtered.length === 0) {
      await slackPost('chat.postMessage', {
        channel: process.env.SLACK_CX_BOT?.split('|')[1],
        text: `📋 ${dateStr} 오전 문의 정리 — 분류된 문의 없음`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `📋 ${dateStr} 오전 문의 정리`, emoji: true } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `어젯밤 18:00 ~ 오늘 10:00 | 예약 · 계약 · 집문의 분류` }] },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '✅ 해당 시간대에 분류된 문의가 없습니다.' } },
        ],
      });
      return res.status(200).json({ sent: 0, total: allConversations.length });
    }

    // 슬랙 블록 구성
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📋 ${dateStr} 오전 문의 정리 — 총 ${filtered.length}건`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `어젯밤 18:00 ~ 오늘 10:00 수집 | 예약 · 계약 · 집문의 분류 | *답장하기* 버튼으로 채널톡에 직접 답장 가능` }] },
      { type: 'divider' },
    ];

    for (const item of filtered) {
      const timeStr = item.createdAt.toLocaleTimeString('ko-KR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul',
      });
      const preview = item.message.length > 120 ? item.message.slice(0, 120) + '…' : item.message;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${item.category}  |  👤 *${item.userName}*  |  🕐 ${timeStr}\n> ${preview}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ 답장하기', emoji: true },
          style: 'primary',
          value: item.convId,
          action_id: 'reply_to_ct',
        },
      });
      blocks.push({ type: 'divider' });
    }

    const slackRes = await slackPost('chat.postMessage', {
      channel: process.env.SLACK_CX_BOT?.split('|')[1],
      text: `📋 ${dateStr} 오전 문의 정리 — ${filtered.length}건`,
      blocks,
    });

    if (!slackRes.ok) {
      console.error('Slack 전송 실패:', slackRes.error);
      return res.status(500).json({ error: 'Slack 전송 실패', detail: slackRes.error });
    }

    return res.status(200).json({ sent: filtered.length, total: allConversations.length, inRange: inRange.length });

  } catch (e) {
    console.error('digest 오류:', e);
    return res.status(500).json({ error: e.message });
  }
};
