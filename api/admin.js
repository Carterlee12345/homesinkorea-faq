const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

async function checkAdminAuth(key) {
  if (key === process.env.ADMIN_PASSWORD) return true;
  if (!key?.startsWith('bearer:')) return false;
  const token = key.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected || Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return false;
  const email = Buffer.from(payload, 'base64').toString();
  const raw = await redis(['GET', `user:${email}`]);
  if (!raw) return false;
  return JSON.parse(raw).isAdmin === true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── login ──
  if (action === 'login' && req.method === 'POST') {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    const user = JSON.parse(raw);
    const hash = crypto.createHmac('sha256', user.passwordSalt).update(password).digest('hex');
    if (hash !== user.passwordHash) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    if (!user.isAdmin) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
    const payload = Buffer.from(email).toString('base64');
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
    return res.status(200).json({ token: `${payload}.${ts}.${sig}`, email });
  }

  // ── users ──
  if (action === 'users' && req.method === 'GET') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const emails = await redis(['SMEMBERS', 'users']) || [];
    const users = (await Promise.all(emails.map(async e => {
      const raw = await redis(['GET', `user:${e}`]);
      return raw ? JSON.parse(raw) : null;
    }))).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.status(200).json({ users });
  }

  // ── approve ──
  if (action === 'approve' && req.method === 'POST') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const { email, approved } = req.body;
    if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await redis(['SET', `user:${email}`, JSON.stringify({ ...JSON.parse(raw), approved })]);
    return res.status(200).json({ success: true });
  }

  // ── set-role ──
  if (action === 'set-role' && req.method === 'POST') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const { email, isAdmin } = req.body;
    if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await redis(['SET', `user:${email}`, JSON.stringify({ ...JSON.parse(raw), isAdmin: !!isAdmin })]);
    return res.status(200).json({ success: true });
  }

  // ── set-nickname ──
  if (action === 'set-nickname' && req.method === 'POST') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const { email, nickname } = req.body;
    if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await redis(['SET', `user:${email}`, JSON.stringify({ ...JSON.parse(raw), nickname: (nickname || '').trim() })]);
    return res.status(200).json({ success: true });
  }

  // ── set-slack-id ──
  if (action === 'set-slack-id' && req.method === 'POST') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const { email, slackUserId } = req.body;
    if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await redis(['SET', `user:${email}`, JSON.stringify({ ...JSON.parse(raw), slackUserId: (slackUserId || '').trim() })]);
    return res.status(200).json({ success: true });
  }

  // ── get-tab-order (no auth — index.html reads this publicly) ──
  if (action === 'get-tab-order' && req.method === 'GET') {
    const raw = await redis(['GET', 'tabs:order']);
    return res.status(200).json({ order: raw ? JSON.parse(raw) : null });
  }

  // ── save-tab-order ──
  if (action === 'save-tab-order' && req.method === 'POST') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const { order } = req.body;
    await redis(['SET', 'tabs:order', JSON.stringify(order)]);
    return res.status(200).json({ success: true });
  }

  // ── logs ──
  if (action === 'logs' && req.method === 'GET') {
    if (!await checkAdminAuth(req.headers['x-admin-key'])) return res.status(401).json({ error: '관리자 권한이 없습니다.' });
    const email = req.query.email;
    const key = email ? `logs:${email}` : 'logs:all';
    const raw = await redis(['LRANGE', key, 0, 199]) || [];
    const logs = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ logs });
  }

  return res.status(400).json({ error: '올바르지 않은 action입니다.' });
};
