import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const dataDir = join(__dirname, 'data');
await mkdir(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'hamkari.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL,
    location TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pieces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    target_value TEXT NOT NULL,
    order_no INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('view','follow','interest','proposal','commit')),
    created_at TEXT NOT NULL,
    UNIQUE(piece_id, actor_id, action),
    FOREIGN KEY(piece_id) REFERENCES pieces(id)
  );

  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    piece_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(piece_id) REFERENCES pieces(id)
  );
`);

seed();

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (count > 0) return;

  const projectId = 'greenhouse-20ha';
  db.prepare(`INSERT INTO projects(id,title,subtitle,location,summary,created_at)
    VALUES(?,?,?,?,?,?)`).run(
      projectId,
      'گلخانه مشارکتی ۲۰ هکتاری',
      'ساخت یک مجموعه تولیدی از طریق تقسیم روشن مسئولیت‌ها و آورده‌ها',
      'استان مرکزی، ایران',
      'این طرح از قطعات مستقلی تشکیل شده است. هر قطعه زمانی تثبیت می‌شود که یک شریک مسئولیت آن را به‌طور رسمی بپذیرد.',
      new Date().toISOString()
    );

  const pieces = [
    ['land','زمین و زیرساخت اولیه','تأمین زمین دارای دسترسی مناسب، سند روشن و امکان دریافت مجوز.','دارایی','۲۰ هکتار'],
    ['capital','سرمایه ساخت سازه','تأمین مالی مرحله‌ای برای سازه، پوشش و تأسیسات اصلی.','سرمایه','۲۵۰ میلیارد ریال'],
    ['water','آب و انرژی','تأمین پایدار آب، برق، گاز یا انرژی جایگزین.','زیرساخت','ظرفیت کامل پروژه'],
    ['technical','دانش فنی گلخانه','طراحی کشت، انتخاب محصول، کنترل اقلیم و بهره‌برداری.','دانش و تجربه','تیم فنی کامل'],
    ['execution','مدیریت و اجرای پروژه','برنامه‌ریزی، پیمانکاران، کنترل هزینه و تحویل مرحله‌ای.','اجرا','مدیر پروژه و تیم'],
    ['equipment','تجهیزات و ماشین‌آلات','تأمین تجهیزات آبیاری، کنترل اقلیم، بسته‌بندی و حمل.','تأمین','فهرست تجهیزات مصوب'],
    ['market','بازار فروش و صادرات','قرارداد فروش، کانال توزیع و امکان صادرات محصول.','بازار','فروش حداقل ۷۰٪ ظرفیت'],
    ['legal','مجوزها و امور حقوقی','مجوزهای کشاورزی، محیط‌زیست، قراردادها و ساختار حقوقی تعاون.','حقوقی','مجوز و قرارداد نهایی']
  ];

  const insert = db.prepare(`INSERT INTO pieces(id,project_id,title,description,category,target_value,order_no)
    VALUES(?,?,?,?,?,?,?)`);
  pieces.forEach((p, index) => insert.run(p[0], projectId, p[1], p[2], p[3], p[4], index + 1));

  const demo = [
    ['land','demo-owner','commit'],
    ['technical','demo-expert','proposal'],
    ['technical','demo-market','follow'],
    ['market','demo-exporter','proposal'],
    ['market','demo-user','interest'],
    ['capital','demo-investor','interest'],
    ['capital','demo-user','follow'],
    ['execution','demo-manager','follow'],
    ['equipment','demo-supplier','interest'],
    ['water','demo-user','view'],
    ['legal','demo-lawyer','follow']
  ];
  const addInteraction = db.prepare(`INSERT OR IGNORE INTO interactions(piece_id,actor_id,action,created_at) VALUES(?,?,?,?)`);
  demo.forEach(x => addInteraction.run(x[0], x[1], x[2], new Date().toISOString()));
  db.prepare(`INSERT INTO commitments(id,piece_id,actor_id,actor_name,note,status,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(crypto.randomUUID(), 'land', 'demo-owner', 'گروه توسعه سبز', 'تأمین زمین پس از تکمیل بررسی حقوقی', 'approved', new Date().toISOString());
}

const weights = { view: 4, follow: 12, interest: 24, proposal: 42, commit: 100 };

function calculatePiece(piece) {
  const counts = db.prepare(`SELECT action, COUNT(*) AS count FROM interactions WHERE piece_id=? GROUP BY action`).all(piece.id);
  const byAction = Object.fromEntries(counts.map(x => [x.action, Number(x.count)]));
  const approved = db.prepare(`SELECT COUNT(*) AS c FROM commitments WHERE piece_id=? AND status='approved'`).get(piece.id).c;
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM commitments WHERE piece_id=? AND status='pending'`).get(piece.id).c;

  let score = Math.min(92,
    (byAction.view || 0) * weights.view +
    (byAction.follow || 0) * weights.follow +
    (byAction.interest || 0) * weights.interest +
    (byAction.proposal || 0) * weights.proposal
  );
  if (pending > 0) score = Math.max(score, 78);
  if (approved > 0) score = 100;

  let stage = 'مرزبندی شده';
  if (score >= 100) stage = 'تعهد قطعی';
  else if (score >= 78) stage = 'در آستانه تعهد';
  else if (score >= 52) stage = 'مذاکره جدی';
  else if (score >= 28) stage = 'اعلام آمادگی';
  else if (score >= 10) stage = 'دنبال می‌شود';
  else if (score > 0) stage = 'دیده شده';

  return {
    ...piece,
    score,
    stage,
    stats: {
      views: byAction.view || 0,
      followers: byAction.follow || 0,
      interests: byAction.interest || 0,
      proposals: byAction.proposal || 0,
      commitments: Number(approved),
      pendingCommitments: Number(pending)
    }
  };
}

function projectPayload() {
  const project = db.prepare('SELECT * FROM projects LIMIT 1').get();
  const pieces = db.prepare('SELECT * FROM pieces WHERE project_id=? ORDER BY order_no').all(project.id).map(calculatePiece);
  return { project, pieces };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function parseJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Payload too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function actorId(req, body) {
  return String(body.actorId || req.headers['x-actor-id'] || '').trim().slice(0, 100);
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/project') {
    return json(res, 200, projectPayload());
  }

  const interactionMatch = url.pathname.match(/^\/api\/pieces\/([^/]+)\/interactions$/);
  if (req.method === 'POST' && interactionMatch) {
    const pieceId = interactionMatch[1];
    const body = await parseJson(req);
    const actor = actorId(req, body);
    const action = String(body.action || '');
    if (!actor || !['view','follow','interest','proposal'].includes(action)) {
      return json(res, 400, { error: 'actorId یا action معتبر نیست.' });
    }
    const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(pieceId);
    if (!piece) return json(res, 404, { error: 'قطعه پیدا نشد.' });

    if (action === 'follow' && body.remove === true) {
      db.prepare(`DELETE FROM interactions WHERE piece_id=? AND actor_id=? AND action='follow'`).run(pieceId, actor);
    } else {
      db.prepare(`INSERT OR IGNORE INTO interactions(piece_id,actor_id,action,created_at) VALUES(?,?,?,?)`)
        .run(pieceId, actor, action, new Date().toISOString());
    }
    return json(res, 200, calculatePiece(piece));
  }

  const commitMatch = url.pathname.match(/^\/api\/pieces\/([^/]+)\/commitments$/);
  if (req.method === 'POST' && commitMatch) {
    const pieceId = commitMatch[1];
    const body = await parseJson(req);
    const actor = actorId(req, body);
    const actorName = String(body.actorName || '').trim().slice(0, 120);
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!actor || actorName.length < 2 || note.length < 5) {
      return json(res, 400, { error: 'نام و توضیح مشارکت را کامل وارد کنید.' });
    }
    const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(pieceId);
    if (!piece) return json(res, 404, { error: 'قطعه پیدا نشد.' });

    db.prepare(`INSERT OR IGNORE INTO interactions(piece_id,actor_id,action,created_at) VALUES(?,?,?,?)`)
      .run(pieceId, actor, 'proposal', new Date().toISOString());
    db.prepare(`INSERT INTO commitments(id,piece_id,actor_id,actor_name,note,status,created_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(crypto.randomUUID(), pieceId, actor, actorName, note, new Date().toISOString());
    return json(res, 201, calculatePiece(piece));
  }

  return json(res, 404, { error: 'مسیر API وجود ندارد.' });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

async function staticFile(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const path = join(publicDir, safe);
  if (!path.startsWith(publicDir) || !existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const file = await readFile(path);
  res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
  res.end(file);
}

const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'خطای داخلی سرور.' });
  }
}).listen(port, () => console.log(`Hamkari MVP: http://localhost:${port}`));
