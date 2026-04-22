const crypto = require('crypto');

function slackWebhook(key) {
  try { return (JSON.parse(process.env.SLACK_WEBHOOKS || '{}'))[key] || null; }
  catch { return null; }
}
const SLACK_WEBHOOK = slackWebhook('deposit');

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

  // ── review-get-form (public) ──
  if (action === 'review-get-form' && req.method === 'GET') {
    const [rawFields, rawConfig] = await Promise.all([
      redis(['GET', 'review:fields']),
      redis(['GET', 'review:config'])
    ]);
    const fields = rawFields ? JSON.parse(rawFields) : getDefaultReviewFields();
    const config = rawConfig ? JSON.parse(rawConfig) : { alertFieldId: null, alertThreshold: 3 };
    return res.status(200).json({ fields, config });
  }

  // ── review-submit (public) ──
  if (action === 'review-submit' && req.method === 'POST') {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: '답변이 없습니다.' });
    const submission = { id: Date.now(), answers, submittedAt: new Date().toISOString() };
    await redis(['LPUSH', 'review:submissions', JSON.stringify(submission)]);
    return res.status(200).json({ success: true });
  }

  // ── review-save-fields (auth) ──
  if (action === 'review-save-fields' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { fields } = req.body;
    await redis(['SET', 'review:fields', JSON.stringify(fields)]);
    return res.status(200).json({ success: true });
  }

  // ── review-save-config (auth) ──
  if (action === 'review-save-config' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { config } = req.body;
    await redis(['SET', 'review:config', JSON.stringify(config)]);
    return res.status(200).json({ success: true });
  }

  // ── review-get-submissions (auth) ──
  if (action === 'review-get-submissions' && req.method === 'GET') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const raw = await redis(['LRANGE', 'review:submissions', 0, 499]) || [];
    const submissions = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ submissions });
  }

  // ── review-delete (auth) ──
  if (action === 'review-delete' && req.method === 'POST') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });
    const { id } = req.body;
    const raw = await redis(['LRANGE', 'review:submissions', 0, 499]) || [];
    const filtered = raw.filter(r => { try { return JSON.parse(r).id !== id; } catch { return true; } });
    await redis(['DEL', 'review:submissions']);
    if (filtered.length) {
      for (const item of filtered.reverse()) await redis(['RPUSH', 'review:submissions', item]);
    }
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: '올바르지 않은 action입니다.' });
};

function getDefaultReviewFields() {
  return [
    { id: 'f1', label: '전체 만족도', type: 'star', placeholder: '전반적인 경험을 별점으로 평가해주세요', required: true },
    { id: 'f2', label: '국적', type: 'nationality', placeholder: '고객님의 국적을 선택해주세요', required: false },
    { id: 'f3', label: '서비스 만족도', type: 'star', placeholder: '직원 응대 및 서비스 품질을 평가해주세요', required: false },
    { id: 'f4', label: '시설 만족도', type: 'star', placeholder: '숙소 시설 및 청결도를 평가해주세요', required: false },
    { id: 'f5', label: '재방문 의향', type: 'yesno', placeholder: '다시 방문할 의향이 있으신가요?', required: false },
    { id: 'f6', label: '추가 의견', type: 'textarea', placeholder: '자유롭게 의견을 남겨주세요 (선택)', required: false }
  ];
}
