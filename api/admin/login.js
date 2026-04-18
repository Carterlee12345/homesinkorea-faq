const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
  const token = `${payload}.${ts}.${sig}`;

  return res.status(200).json({ token, email });
};
