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

async function getUser(email) {
  const raw = await redis(['GET', `user:${email}`]);
  return raw ? JSON.parse(raw) : null;
}

function uid() { return crypto.randomBytes(6).toString('hex'); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const token = req.headers['authorization']?.replace('Bearer ', '');

  // ── list projects ──
  if (action === 'list' && req.method === 'GET') {
    const ids = await redis(['SMEMBERS', 'projects']);
    if (!ids || !ids.length) return res.status(200).json({ projects: [] });
    const raws = await Promise.all(ids.map(id => redis(['GET', `project:${id}`])));
    const projects = raws.filter(Boolean).map(r => JSON.parse(r));
    projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.status(200).json({ projects });
  }

  // ── list users for @mention ──
  if (action === 'users' && req.method === 'GET') {
    const emails = await redis(['SMEMBERS', 'users']);
    if (!emails || !emails.length) return res.status(200).json({ users: [] });
    const raws = await Promise.all(emails.map(e => redis(['GET', `user:${e}`])));
    const users = raws.filter(Boolean).map(r => {
      const u = JSON.parse(r);
      return { email: u.email, nickname: u.nickname };
    }).filter(u => u.nickname);
    return res.status(200).json({ users });
  }

  // ── get notifications ──
  if (action === 'notifications' && req.method === 'GET') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const raws = await redis(['LRANGE', `notifications:${email}`, '0', '29']);
    const notifications = (raws || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ notifications });
  }

  // ── mark notifications read ──
  if (action === 'mark-read' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    await redis(['DEL', `notifications:${email}`]);
    return res.status(200).json({ ok: true });
  }

  // ── create project ──
  if (action === 'create' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const user = await getUser(email);
    if (!user) return res.status(401).json({ error: '사용자 없음' });
    const { title, description, status, priority, assignees, dueDate } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: '제목을 입력해주세요.' });
    const id = `proj_${uid()}`;
    const project = {
      id, title: title.trim(), description: description?.trim() || '',
      status: status || 'todo', priority: priority || 'medium',
      assignees: Array.isArray(assignees) ? assignees : [],
      dueDate: dueDate || null, favoritedBy: [],
      comments: [], createdBy: email, createdByNickname: user.nickname,
      createdAt: new Date().toISOString()
    };
    await redis(['SET', `project:${id}`, JSON.stringify(project)]);
    await redis(['SADD', 'projects', id]);
    return res.status(200).json({ project });
  }

  // ── update project ──
  if (action === 'update' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const { id, ...updates } = req.body;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    const raw = await redis(['GET', `project:${id}`]);
    if (!raw) return res.status(404).json({ error: '프로젝트 없음' });
    const project = JSON.parse(raw);
    ['title', 'description', 'status', 'priority', 'assignees', 'dueDate'].forEach(k => {
      if (updates[k] !== undefined) project[k] = updates[k];
    });
    project.updatedAt = new Date().toISOString();
    await redis(['SET', `project:${id}`, JSON.stringify(project)]);
    return res.status(200).json({ project });
  }

  // ── toggle favorite ──
  if (action === 'toggle-favorite' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const { id } = req.body;
    const raw = await redis(['GET', `project:${id}`]);
    if (!raw) return res.status(404).json({ error: '프로젝트 없음' });
    const project = JSON.parse(raw);
    const idx = (project.favoritedBy || []).indexOf(email);
    if (idx === -1) project.favoritedBy.push(email);
    else project.favoritedBy.splice(idx, 1);
    await redis(['SET', `project:${id}`, JSON.stringify(project)]);
    return res.status(200).json({ favoritedBy: project.favoritedBy });
  }

  // ── delete project ──
  if (action === 'delete' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const user = await getUser(email);
    const { id } = req.body;
    const raw = await redis(['GET', `project:${id}`]);
    if (!raw) return res.status(404).json({ error: '프로젝트 없음' });
    const project = JSON.parse(raw);
    if (project.createdBy !== email && !user?.isAdmin) return res.status(403).json({ error: '권한 없음 (작성자 또는 관리자만 삭제 가능)' });
    await redis(['DEL', `project:${id}`]);
    await redis(['SREM', 'projects', id]);
    return res.status(200).json({ ok: true });
  }

  // ── add comment ──
  if (action === 'comment' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const user = await getUser(email);
    if (!user) return res.status(401).json({ error: '사용자 없음' });
    const { id, text, images } = req.body;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    if (!text?.trim() && (!images || !images.length)) return res.status(400).json({ error: '내용을 입력해주세요.' });
    const raw = await redis(['GET', `project:${id}`]);
    if (!raw) return res.status(404).json({ error: '프로젝트 없음' });
    const project = JSON.parse(raw);
    const comment = {
      id: `cmt_${uid()}`, author: email, authorNickname: user.nickname,
      text: text?.trim() || '', images: images || [],
      createdAt: new Date().toISOString()
    };
    if (!project.comments) project.comments = [];
    project.comments.push(comment);

    // handle @mention notifications
    const mentions = [...(text || '').matchAll(/@(\S+)/g)].map(m => m[1]);
    if (mentions.length) {
      const allEmails = await redis(['SMEMBERS', 'users']);
      const allRaws = allEmails ? await Promise.all(allEmails.map(e => redis(['GET', `user:${e}`]))) : [];
      const nicknameMap = {};
      allRaws.filter(Boolean).map(r => JSON.parse(r)).forEach(u => { nicknameMap[u.nickname] = u.email; });
      for (const nick of mentions) {
        const targetEmail = nicknameMap[nick];
        if (targetEmail && targetEmail !== email) {
          const notif = JSON.stringify({
            id: `notif_${uid()}`, type: 'mention',
            projectId: id, projectTitle: project.title,
            commentText: (text || '').slice(0, 120),
            fromNickname: user.nickname,
            createdAt: new Date().toISOString()
          });
          await redis(['LPUSH', `notifications:${targetEmail}`, notif]);
          await redis(['LTRIM', `notifications:${targetEmail}`, '0', '49']);
        }
      }
    }

    await redis(['SET', `project:${id}`, JSON.stringify(project)]);
    return res.status(200).json({ comment, comments: project.comments });
  }

  // ── delete comment ──
  if (action === 'delete-comment' && req.method === 'POST') {
    const email = verifyToken(token);
    if (!email) return res.status(401).json({ error: '인증 필요' });
    const user = await getUser(email);
    const { id, commentId } = req.body;
    const raw = await redis(['GET', `project:${id}`]);
    if (!raw) return res.status(404).json({ error: '프로젝트 없음' });
    const project = JSON.parse(raw);
    const cmtIdx = project.comments.findIndex(c => c.id === commentId);
    if (cmtIdx === -1) return res.status(404).json({ error: '댓글 없음' });
    if (project.comments[cmtIdx].author !== email && !user?.isAdmin) return res.status(403).json({ error: '권한 없음' });
    project.comments.splice(cmtIdx, 1);
    await redis(['SET', `project:${id}`, JSON.stringify(project)]);
    return res.status(200).json({ ok: true, comments: project.comments });
  }

  return res.status(400).json({ error: '잘못된 action' });
};
