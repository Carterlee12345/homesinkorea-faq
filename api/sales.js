const crypto = require('crypto');

const SLACK_SALES_WEBHOOK = process.env.SLACK_SALES_WEBHOOK;

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

function defaultConfig() {
  return {
    areaLabels: [
      { label: '한국외대', color: '#1d4ed8' },
      { label: '용산', color: '#d97706' },
      { label: '홍대', color: '#db2777' },
      { label: '신촌', color: '#047857' },
      { label: '종로', color: '#7c3aed' }
    ],
    statusLabels: [
      { label: 'not for sale', color: '#6b7280' },
      { label: 'working on', color: '#d97706' },
      { label: 'available', color: '#16a34a' }
    ],
    periodLabels: ['1개월', '2개월', '3개월', '4개월', '6개월', '10개월', '12개월'],
    sourceLabels: ['Recommendation', 'Airbnb', 'Booking.com', 'Instagram', 'Direct', 'Others']
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });

  const action = req.query.action;

  if (action === 'get-all' && req.method === 'GET') {
    const [rowsRaw, configRaw, emailSet] = await Promise.all([
      redis(['GET', 'sales:data']),
      redis(['GET', 'sales:config']),
      redis(['SMEMBERS', 'users'])
    ]);
    const rows = rowsRaw ? JSON.parse(rowsRaw) : [];
    const config = configRaw ? JSON.parse(configRaw) : defaultConfig();
    const emails = emailSet || [];
    const userDetails = await Promise.all(emails.map(async e => {
      const raw = await redis(['GET', `user:${e}`]);
      if (!raw) return null;
      const u = JSON.parse(raw);
      return u.approved ? { email: u.email } : null;
    }));
    return res.status(200).json({ rows, config, users: userDetails.filter(Boolean) });
  }

  if (action === 'save-rows' && req.method === 'POST') {
    await redis(['SET', 'sales:data', JSON.stringify(req.body.rows)]);
    return res.status(200).json({ success: true });
  }

  if (action === 'save-config' && req.method === 'POST') {
    await redis(['SET', 'sales:config', JSON.stringify(req.body.config)]);
    return res.status(200).json({ success: true });
  }

  if (action === 'notify-hold' && req.method === 'POST') {
    const { branch, deposit, rent, contractPeriod, nationality, contractSource } = req.body;
    if (!SLACK_SALES_WEBHOOK) return res.status(200).json({ skipped: true });
    const parts = [];
    if (nationality || contractSource) {
      const inner = [nationality, contractSource].filter(Boolean).join(', ');
      parts.push(`(${inner})`);
    }
    const line3 = `예약 완료되었습니다! ${parts.join(' ')}`;
    const text = `*${branch || '(지점 미입력)'}이*\n${deposit||'?'}/${rent||'?'}, ${contractPeriod||'?'}의 조건으로\n${line3}`;
    await fetch(SLACK_SALES_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).catch(() => {});
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: '잘못된 action' });
};
