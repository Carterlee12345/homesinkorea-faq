const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

function createToken(email) {
  const payload = Buffer.from(email).toString('base64');
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  return `${payload}.${ts}.${sig}`;
}

function verifyTokenSync(token) {
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;

  // ── signup ──
  if (action === 'signup') {
    const { email, password, nickname } = req.body;
    if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
    if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
    if (!nickname || !nickname.trim()) return res.status(400).json({ error: '닉네임을 입력해주세요.' });
    const existing = await redis(['GET', `user:${email}`]);
    if (existing) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
    await redis(['SET', `user:${email}`, JSON.stringify({ email, nickname: nickname.trim(), passwordHash: hash, passwordSalt: salt, approved: false, createdAt: new Date().toISOString() })]);
    await redis(['SADD', 'users', email]);
    return res.status(200).json({ message: '가입 신청 완료. 관리자 승인 후 로그인 가능합니다.' });
  }

  // ── login ──
  if (action === 'login') {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
    const raw = await redis(['GET', `user:${email}`]);
    if (!raw) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    const user = JSON.parse(raw);
    const hash = crypto.createHmac('sha256', user.passwordSalt).update(password).digest('hex');
    if (hash !== user.passwordHash) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    if (!user.approved) return res.status(403).json({ error: 'pending', message: '관리자 승인 대기 중입니다.' });
    return res.status(200).json({ token: createToken(email), email, nickname: user.nickname || '', isAdmin: user.isAdmin === true });
  }

  // ── verify ──
  if (action === 'verify') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const email = verifyTokenSync(token);
    if (!email) return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    const raw = await redis(['GET', `user:${email}`]);
    const user = raw ? JSON.parse(raw) : {};
    return res.status(200).json({ email, nickname: user.nickname || '', isAdmin: user.isAdmin === true });
  }

  // ── log ──
  if (action === 'log') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const email = verifyTokenSync(token);
    if (!email) return res.status(401).json({ error: 'Unauthorized' });
    const { action: act, detail } = req.body;
    if (!act) return res.status(400).json({ error: 'action required' });
    const entry = JSON.stringify({ email, action: act, detail: detail || '', ts: new Date().toISOString() });
    await redis(['LPUSH', 'logs:all', entry]);
    await redis(['LPUSH', `logs:${email}`, entry]);
    await redis(['LTRIM', 'logs:all', 0, 999]);
    await redis(['LTRIM', `logs:${email}`, 0, 199]);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: '올바르지 않은 action입니다.' });
};
