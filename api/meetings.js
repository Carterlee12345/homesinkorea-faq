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

async function getApprovedUsers() {
  const emails = await redis(['SMEMBERS', 'users']) || [];
  const users = (await Promise.all(emails.map(async e => {
    const raw = await redis(['GET', `user:${e}`]);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u.approved ? { email: u.email, nickname: u.nickname || '', slackUserId: u.slackUserId || '' } : null;
  }))).filter(Boolean);
  return users;
}

async function sendSlackMention(slackUserId, mentionedBy, meetingTitle, commentText) {
  let webhook = null;
  try { webhook = (JSON.parse(process.env.SLACK_WEBHOOKS || '{}')).meetings || null; }
  catch { webhook = null; }
  if (!webhook || !slackUserId) return;
  const text = `<@${slackUserId}> 님, *${mentionedBy}*님이 회의록 *"${meetingTitle}"*에서 태그했습니다.\n\n> ${commentText.slice(0, 200)}`;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization']?.replace('Bearer ', '');
  const authorEmail = verifyToken(token);
  if (!authorEmail) return res.status(401).json({ error: '인증이 필요합니다.' });

  const action = req.query.action;

  // ── get-users (for mention autocomplete) ──
  if (action === 'get-users' && req.method === 'GET') {
    const users = await getApprovedUsers();
    return res.status(200).json({ users });
  }

  // ── list ──
  if (action === 'list' && req.method === 'GET') {
    const raw = await redis(['GET', 'meetings:index']) || '[]';
    const index = JSON.parse(raw);
    return res.status(200).json({ meetings: index.filter(m => !m.deleted) });
  }

  // ── get ──
  if (action === 'get' && req.method === 'GET') {
    const { id } = req.query;
    const raw = await redis(['GET', `meeting:${id}`]);
    if (!raw) return res.status(404).json({ error: '회의록을 찾을 수 없습니다.' });
    return res.status(200).json({ meeting: JSON.parse(raw) });
  }

  // ── save (create/update) ──
  if (action === 'save' && req.method === 'POST') {
    const { id, title, date, tags, content, attachments } = req.body;
    const users = await getApprovedUsers();
    const author = users.find(u => u.email === authorEmail);
    const authorNickname = author?.nickname || authorEmail.split('@')[0];
    const now = new Date().toISOString();

    if (id) {
      // update
      const raw = await redis(['GET', `meeting:${id}`]);
      if (!raw) return res.status(404).json({ error: '회의록을 찾을 수 없습니다.' });
      const meeting = JSON.parse(raw);
      const updated = { ...meeting, title, date, tags: tags || [], content, attachments: attachments || meeting.attachments || [], updatedAt: now };
      await redis(['SET', `meeting:${id}`, JSON.stringify(updated)]);
      // update index
      const indexRaw = await redis(['GET', 'meetings:index']) || '[]';
      const index = JSON.parse(indexRaw).map(m => m.id === id ? { ...m, title, date, tags: tags || [], updatedAt: now } : m);
      await redis(['SET', 'meetings:index', JSON.stringify(index)]);
      return res.status(200).json({ success: true, id });
    } else {
      // create
      const newId = Date.now().toString();
      const meeting = { id: newId, title, date, tags: tags || [], content, attachments: attachments || [], authorEmail, authorNickname, createdAt: now, updatedAt: now, comments: [] };
      await redis(['SET', `meeting:${newId}`, JSON.stringify(meeting)]);
      const indexRaw = await redis(['GET', 'meetings:index']) || '[]';
      const index = JSON.parse(indexRaw);
      index.unshift({ id: newId, title, date, tags: tags || [], authorNickname, createdAt: now, updatedAt: now, commentCount: 0 });
      await redis(['SET', 'meetings:index', JSON.stringify(index)]);
      return res.status(200).json({ success: true, id: newId });
    }
  }

  // ── delete ──
  if (action === 'delete' && req.method === 'POST') {
    const { id } = req.body;
    const indexRaw = await redis(['GET', 'meetings:index']) || '[]';
    const index = JSON.parse(indexRaw).map(m => m.id === id ? { ...m, deleted: true } : m);
    await redis(['SET', 'meetings:index', JSON.stringify(index)]);
    return res.status(200).json({ success: true });
  }

  // ── add-comment ──
  if (action === 'add-comment' && req.method === 'POST') {
    const { id, text, mentions } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: '댓글 내용이 없습니다.' });
    const raw = await redis(['GET', `meeting:${id}`]);
    if (!raw) return res.status(404).json({ error: '회의록을 찾을 수 없습니다.' });
    const meeting = JSON.parse(raw);
    const users = await getApprovedUsers();
    const author = users.find(u => u.email === authorEmail);
    const authorNickname = author?.nickname || authorEmail.split('@')[0];
    const comment = { id: Date.now().toString(), authorEmail, authorNickname, text: text.trim(), mentions: mentions || [], createdAt: new Date().toISOString() };
    if (!meeting.comments) meeting.comments = [];
    meeting.comments.push(comment);
    await redis(['SET', `meeting:${id}`, JSON.stringify(meeting)]);
    // update commentCount in index
    const indexRaw = await redis(['GET', 'meetings:index']) || '[]';
    const index = JSON.parse(indexRaw).map(m => m.id === id ? { ...m, commentCount: meeting.comments.length } : m);
    await redis(['SET', 'meetings:index', JSON.stringify(index)]);
    // send Slack mentions
    const noSlackId = [];
    for (const nickname of (mentions || [])) {
      const u = users.find(u => u.nickname === nickname);
      if (u?.slackUserId) {
        await sendSlackMention(u.slackUserId, authorNickname, meeting.title, text);
      } else if (u) {
        noSlackId.push(nickname);
      }
    }
    return res.status(200).json({ success: true, noSlackId });
  }

  // ── save-slack-id ──
  if (action === 'save-slack-id' && req.method === 'POST') {
    const { slackUserId } = req.body;
    const raw = await redis(['GET', `user:${authorEmail}`]);
    if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await redis(['SET', `user:${authorEmail}`, JSON.stringify({ ...JSON.parse(raw), slackUserId: (slackUserId || '').trim() })]);
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: '잘못된 action' });
};
