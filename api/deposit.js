const crypto = require('crypto');

const SLACK_WEBHOOK = process.env.SLACK_DEPOSIT_WEBHOOK;

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── get-form (public) ──
  if (action === 'get-form' && req.method === 'GET') {
    const raw = await redis(['GET', 'deposit:form']) || '[]';
    return res.status(200).json({ fields: JSON.parse(raw) });
  }

  // ── submit (public) ──
  if (action === 'submit' && req.method === 'POST') {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: '답변이 없습니다.' });
    const submission = { id: Date.now(), answers, submittedAt: new Date().toISOString() };
    await redis(['LPUSH', 'deposit:submissions', JSON.stringify(submission)]);

    if (SLACK_WEBHOOK) {
      const lines = answers.map(a => `*${a.label}*: ${a.value || '(미입력)'}`).join('\n');
      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🏦 *새 보증금 정보가 접수되었습니다*\n${lines}\n제출 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
        })
      }).catch(() => {});
    }
    return res.status(200).json({ success: true });
  }

  // ── save-form (auth required) ──
  if (action === 'save-form' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { fields } = req.body;
    if (!Array.isArray(fields)) return res.status(400).json({ error: '잘못된 형식입니다.' });
    await redis(['SET', 'deposit:form', JSON.stringify(fields)]);
    return res.status(200).json({ success: true });
  }

  // ── get-submissions (auth required) ──
  if (action === 'get-submissions' && req.method === 'GET') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const raw = await redis(['LRANGE', 'deposit:submissions', 0, 199]) || [];
    const submissions = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ submissions });
  }

  // ── get-all-meta (auth) ──
  if (action === 'get-all-meta' && req.method === 'GET') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const raw = await redis(['LRANGE', 'deposit:submissions', 0, 199]) || [];
    const ids = raw.map(r => { try { return JSON.parse(r).id; } catch { return null; } }).filter(Boolean);
    if (!ids.length) return res.status(200).json({ meta: {} });
    const metas = await Promise.all(ids.map(id => redis(['GET', `deposit:meta:${id}`])));
    const meta = {};
    ids.forEach((id, i) => {
      meta[id] = metas[i] ? JSON.parse(metas[i]) : { status: 'pending', comments: [], attachments: [] };
    });
    return res.status(200).json({ meta });
  }

  // ── update-status (auth) ──
  if (action === 'update-status' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { id, status } = req.body;
    const raw = await redis(['GET', `deposit:meta:${id}`]) || '{}';
    const meta = JSON.parse(raw);
    meta.status = status;
    if (status === 'completed') meta.completedAt = new Date().toISOString();
    await redis(['SET', `deposit:meta:${id}`, JSON.stringify(meta)]);
    return res.status(200).json({ success: true });
  }

  // ── add-comment (auth) ──
  if (action === 'add-comment' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { id, text } = req.body;
    const raw = await redis(['GET', `deposit:meta:${id}`]) || '{}';
    const meta = JSON.parse(raw);
    if (!meta.comments) meta.comments = [];
    meta.comments.push({ text, createdAt: new Date().toISOString() });
    await redis(['SET', `deposit:meta:${id}`, JSON.stringify(meta)]);
    return res.status(200).json({ success: true });
  }

  // ── add-attachment (auth) ──
  if (action === 'add-attachment' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { id, name, type, data } = req.body;
    const key = `deposit:file:${id}:${Date.now()}`;
    await redis(['SET', key, data]);
    const raw = await redis(['GET', `deposit:meta:${id}`]) || '{}';
    const meta = JSON.parse(raw);
    if (!meta.attachments) meta.attachments = [];
    meta.attachments.push({ name, type, key, uploadedAt: new Date().toISOString() });
    await redis(['SET', `deposit:meta:${id}`, JSON.stringify(meta)]);
    return res.status(200).json({ success: true });
  }

  // ── delete-submission (auth) ──
  if (action === 'delete-submission' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { id } = req.body;
    const raw = await redis(['GET', `deposit:meta:${id}`]) || '{}';
    const meta = JSON.parse(raw);
    meta.deleted = true;
    await redis(['SET', `deposit:meta:${id}`, JSON.stringify(meta)]);
    return res.status(200).json({ success: true });
  }

  // ── get-attachment (auth) ──
  if (action === 'get-attachment' && req.method === 'GET') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const data = await redis(['GET', req.query.key]);
    return res.status(200).json({ data });
  }

  return res.status(400).json({ error: '올바르지 않은 action입니다.' });
};
