const REPO = 'netpuzyaka/up';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_TOKEN || '';

function ghHeaders() {
  return {
    'User-Agent': 'up-bot-site',
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
  };
}

async function ghGet(path) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: ghHeaders(),
    cache: 'no-store',
  });
  if (resp.status === 404) return { sha: null, content: null };
  if (!resp.ok) throw new Error('GitHub GET ' + path + ': ' + resp.status);
  const data = await resp.json();
  const content = data.content
    ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
    : null;
  return { sha: data.sha, content };
}

async function ghPut(path, content, message, sha) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: BRANCH,
      sha,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error('GitHub PUT ' + path + ': ' + resp.status + ' ' + text.slice(0, 300));
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function updateRegistry(clientId, name, lastSeen, statsPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, content } = await ghGet('data/clients.json');
    let root;
    try { root = content ? JSON.parse(content) : {}; } catch { root = {}; }
    root.clients = root.clients || {};
    root.clients[clientId] = { name, lastSeen, statsPath };
    try {
      await ghPut('data/clients.json', JSON.stringify(root, null, 2), 'Client heartbeat', sha);
      return;
    } catch (e) {
      if (e.status === 409 && attempt < 2) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      throw e;
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const registryData = await ghGet('data/clients.json');
      const registry = registryData.content ? JSON.parse(registryData.content) : {};
      const entries = (registry.clients || {});
      const clients = [];
      for (const id of Object.keys(entries)) {
        const entry = entries[id];
        let stats = null;
        try {
          const s = await ghGet(entry.statsPath || `data/clients/${id}/stats.json`);
          if (s.content) stats = JSON.parse(s.content);
        } catch {}
        clients.push({ id, name: entry.name || id, lastSeen: entry.lastSeen || '', stats });
      }
      let settings = null;
      try {
        const st = await ghGet('data/settings.json');
        if (st.content) settings = JSON.parse(st.content);
      } catch {}
      return res.status(200).json({ clients, settings });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const clientId = String(body.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
      const name = String(body.name || 'client').slice(0, 60);
      if (!clientId) return res.status(400).json({ error: 'clientId required' });

      const lastSeen = new Date().toISOString();
      const statsPath = `data/clients/${clientId}/stats.json`;

      if (body.stats && typeof body.stats === 'object') {
        let sha = null;
        try { sha = (await ghGet(statsPath)).sha; } catch {}
        await ghPut(statsPath, JSON.stringify(body.stats, null, 2), 'Update stats', sha);
      }

      await updateRegistry(clientId, name, lastSeen, statsPath);
      return res.status(200).json({ ok: true, lastSeen });
    }

    res.status(404).json({ error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
