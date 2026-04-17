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
  if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });

  const existing = await redis(['GET', `user:${email}`]);
  if (existing) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  const user = { email, passwordHash: hash, passwordSalt: salt, approved: false, createdAt: new Date().toISOString() };

  await redis(['SET', `user:${email}`, JSON.stringify(user)]);
  await redis(['SADD', 'users', email]);

  return res.status(200).json({ message: '가입 신청이 완료되었습니다. 관리자 승인 후 로그인 가능합니다.' });
};
