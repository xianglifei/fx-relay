/**
 * relay dashboard — served by the kernel at GET /.
 * Single file, no build step. Token entered once, kept in localStorage.
 */
export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relay — Git collaboration kernel for AI agents</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2129; --border: #2d333b;
    --ink: #e6edf3; --dim: #8b949e; --accent: #7048e8; --green: #3fb950;
    --amber: #d29922; --red: #f85149; --cyan: #39c5cf; --blue: #58a6ff; --orange: #f0883e;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  a { color: var(--blue); text-decoration: none; }
  header { padding: 20px 28px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-size: 20px; letter-spacing: 0.5px; }
  header h1 .logo { color: var(--accent); }
  header .tag { color: var(--dim); font-size: 12px; }
  header .spacer { flex: 1; }
  header .health { font-size: 12px; color: var(--dim); }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 18px; padding: 18px 28px; max-width: 1500px; margin: 0 auto; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  section.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  section.panel > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--dim); padding: 12px 16px; border-bottom: 1px solid var(--border); display:flex; gap:8px; align-items:center; }
  .count { background: var(--panel2); border-radius: 10px; padding: 0 8px; font-size: 11px; }
  .task { padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .task:last-child { border-bottom: 0; }
  .task .row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
  .task .id { font-family: ui-monospace, monospace; font-size: 12px; color: var(--dim); }
  .task .spec { font-size: 13px; margin-bottom: 6px; }
  .task .meta { font-size: 11.5px; color: var(--dim); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .chip { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .file { font-family: ui-monospace, monospace; font-size: 11px; background: var(--panel2); border: 1px solid var(--border); border-radius: 5px; padding: 0 6px; }
  .hg { display: inline-flex; gap: 5px; }
  .hg button { background: var(--panel2); border: 1px solid var(--border); color: var(--ink); border-radius: 6px; padding: 1px 8px; font-size: 11px; cursor: pointer; }
  .hg button:hover { border-color: var(--accent); }
  .hg button:first-child:hover { color: var(--green); }
  .hg button:last-child:hover { color: var(--red); }
  .sha { font-family: ui-monospace, monospace; color: var(--cyan); }
  .agent { color: var(--ink); font-weight: 600; }
  .verdict-approve { color: var(--green); } .verdict-reject { color: var(--red); }
  .feed { max-height: 78vh; overflow-y: auto; }
  .ev { padding: 9px 16px; border-bottom: 1px solid var(--border); font-size: 12.5px; display: flex; gap: 9px; align-items: baseline; }
  .ev:last-child { border-bottom: 0; }
  .ev .t { color: var(--dim); font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; }
  .ev .k { font-family: ui-monospace, monospace; font-weight: 700; white-space: nowrap; }
  .ev .d { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #gate { max-width: 460px; margin: 15vh auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 30px; }
  #gate h2 { margin-bottom: 6px; } #gate p { color: var(--dim); font-size: 13px; margin-bottom: 16px; }
  #gate input { width: 100%; padding: 10px 12px; background: var(--panel2); color: var(--ink); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
  #gate button { width: 100%; padding: 10px; background: var(--accent); border: 0; color: #fff; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .empty { padding: 26px; text-align: center; color: var(--dim); font-size: 13px; }
  .tabs { display: flex; gap: 4px; padding: 10px 16px 0; }
  .tabs button { background: none; border: 1px solid transparent; border-bottom: 0; color: var(--dim); padding: 7px 14px; font-size: 12.5px; cursor: pointer; border-radius: 8px 8px 0 0; }
  .tabs button.on { color: var(--ink); background: var(--panel); border-color: var(--border); }
  footer { text-align: center; color: var(--dim); font-size: 11.5px; padding: 18px; }
</style>
</head>
<body>
<div id="app"></div>
<footer>Relay kernel · D1 schedules · git notes remember · mainline stays linear</footer>
<script>
const STATUS = {
  queued:        ['queued',        'var(--dim)'],
  assigned:      ['agent working', 'var(--blue)'],
  pushed:        ['pushed',        'var(--amber)'],
  awaiting_merge:['review passed', 'var(--cyan)'],
  needs_human:   ['needs human ⏸', 'var(--amber)'],
  merging:       ['merging',       'var(--accent)'],
  merged:        ['merged',        'var(--green)'],
  re_forked:     ['re-forked',     'var(--orange)'],
  review_failed: ['review reject', 'var(--red)'],
  failed:        ['failed',        'var(--red)'],
};
const evColor = k => k.includes('approved')||k.includes('merged') ? 'var(--green)'
  : k.includes('rejected')||k.includes('failed')||k.includes('error') ? 'var(--red)'
  : k.includes('reforked')||k.includes('conflict') ? 'var(--orange)'
  : k.includes('held') ? 'var(--amber)'
  : k.includes('granted') ? 'var(--accent)' : 'var(--cyan)';

let TOKEN = localStorage.getItem('relay_token') || '';
let URL_BASE = location.origin;
let tab = 'tasks';
let timer = null;

function gate() {
  document.getElementById('app').innerHTML = \`
  <div id="gate">
    <h2><span style="color:var(--accent)">⇄</span> Relay Kernel</h2>
    <p>输入 kernel 访问令牌(RELAY_TOKEN)查看看板。令牌只保存在本机浏览器。</p>
    <input id="tk" type="password" placeholder="relay token" />
    <button onclick="saveToken()">进入看板</button>
  </div>\`;
  document.getElementById('tk').focus();
  document.getElementById('tk').addEventListener('keydown', e => { if (e.key === 'Enter') saveToken(); });
}
async function saveToken() {
  TOKEN = document.getElementById('tk').value.trim();
  const r = await fetch('/tasks', { headers: { authorization: 'Bearer ' + TOKEN } });
  if (r.ok) { localStorage.setItem('relay_token', TOKEN); boot(); }
  else alert('令牌无效(' + r.status + ')');
}

const fmt = iso => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '';
const short = s => (s || '').slice(0, 8);
const esc = s => (s ?? '').toString().replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

function taskCard(t) {
  const [label, color] = STATUS[t.status] || [t.status, 'var(--dim)'];
  const files = (t.touch_set ? JSON.parse(t.touch_set) : []).map(f => '<span class="file">' + esc(f) + '</span>').join(' ');
  const review = t.review ? JSON.parse(t.review) : null;
  const rv = review ? '<span class="' + (review.verdict === 'approve' ? 'verdict-approve' : 'verdict-reject') + '">⚖ ' + esc(review.model === 'human' ? 'human' : review.verdict) + (review.reason ? ' · ' + esc(review.reason) : '') + '</span>' : '';
  const gate = t.status === 'needs_human'
    ? '<span class="hg"><button onclick="humanReview(\\'' + esc(t.id) + '\\',true)">✓ 放行</button><button onclick="humanReview(\\'' + esc(t.id) + '\\',false)">✗ 打回</button></span>' : '';
  return \`<div class="task">
    <div class="row1"><span class="chip" style="background:\${color}22;color:\${color}">\${label}</span>
      <span class="id">\${t.id}</span>\${t.attempt > 0 ? '<span class="id">attempt ' + t.attempt + '</span>' : ''}\${gate}</div>
    <div class="spec">\${esc(t.spec.length > 110 ? t.spec.slice(0, 110) + '…' : t.spec)}</div>
    <div class="meta">
      \${t.assigned_agent ? '<span class="agent">🤖 ' + esc(t.assigned_agent) + '</span>' : ''}
      \${t.head_sha ? '<span class="sha">' + short(t.head_sha) + '</span>' : ''}
      \${t.merged_sha ? '<span class="sha">→ main ' + short(t.merged_sha) + '</span>' : ''}
      \${files}
      \${rv}
      <span>\${fmt(t.updated_at)}</span>
    </div>
  </div>\`;
}

async function humanReview(id, approve) {
  const note = approve ? '' : (prompt('打回原因(将成为下一轮整改指令):') || '人工打回,请对照任务规格重做');
  const r = await fetch('/tasks/' + id + '/human_review', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: approve ? 'approve' : 'reject', note }),
  });
  if (!r.ok) alert('人审失败(' + r.status + ') — 需要 admin 令牌');
  refresh();
}

function renderEvents(evs) {
  if (!evs.length) return '<div class="empty">暂无事件</div>';
  return evs.map(e => {
    let d = '';
    try { const p = JSON.parse(e.payload || '{}');
      d = p.spec ? esc(p.spec.slice(0, 60)) : [p.agent, p.after, p.mode, p.why, p.detail]
        .map(v => v ? esc(String(v).slice(0, 60)) : '').filter(Boolean).join(' · ');
    } catch {}
    return \`<div class="ev"><span class="t">\${fmt(e.created_at)}</span><span class="k" style="color:\${evColor(e.type)}">\${esc(e.type)}</span><span class="d">\${e.task_id ? esc(e.task_id) + ' ' : ''}\${d}</span></div>\`;
  }).join('');
}

function renderProvenance(rows) {
  if (!rows.length) return '<div class="empty">暂无溯源记录</div>';
  return rows.map(r => {
    let note = {}; try { note = JSON.parse(r.note || '{}'); } catch {}
    return \`<div class="task">
      <div class="row1"><span class="id">\${r.repo}</span><span class="sha">\${short(r.commit_sha)}</span></div>
      <div class="meta"><span class="agent">🤖 \${esc(note.agent || r.agent || '?')}</span><span>\${esc(note.model || r.model || '')}</span><span>task \${esc(r.task_id || '')}</span><span>\${fmt(r.created_at)}</span></div>
      \${note.spec_digest ? '<div class="spec" style="color:var(--dim);font-size:12px">“' + esc(note.spec_digest.slice(0, 90)) + '…”</div>' : ''}
      \${note.summary ? '<div class="spec" style="font-size:12px;border-left:2px solid var(--border);padding-left:8px;margin-top:4px;color:var(--dim);white-space:pre-wrap">' + esc(note.summary.slice(0, 220)) + '</div>' : ''}
    </div>\`;
  }).join('');
}

async function refresh() {
  const h = { authorization: 'Bearer ' + TOKEN };
  try {
    const [tasks, evs, prov, health] = await Promise.all([
      fetch('/tasks', { headers: h }).then(r => r.json()),
      fetch('/events', { headers: h }).then(r => r.json()),
      fetch('/provenance', { headers: h }).then(r => r.json()),
      fetch('/healthz').then(r => r.json()).catch(() => null),
    ]);
    const ts = tasks.tasks || [];
    const open = ts.filter(t => !['merged','failed'].includes(t.status));
    const done = ts.filter(t => ['merged','failed'].includes(t.status));
    document.getElementById('board').innerHTML =
      (open.length ? open : []).map(taskCard).join('') + (done.length ? done.map(taskCard).join('') : '') || '<div class="empty">还没有任务</div>';
    document.getElementById('feed').innerHTML = renderEvents(evs.events || []);
    document.getElementById('prov').innerHTML = renderProvenance(prov.provenance || []);
    document.getElementById('health').textContent = health && health.ok ? '● kernel ok' : '● kernel unreachable';
    document.getElementById('health').style.color = health && health.ok ? 'var(--green)' : 'var(--red)';
    document.getElementById('cnt-open').textContent = open.length;
    document.getElementById('cnt-ev').textContent = (evs.events || []).length;
  } catch (e) { console.error(e); }
}

function boot() {
  document.getElementById('app').innerHTML = \`
  <header>
    <h1><span class="logo">⇄</span> Relay</h1>
    <span class="tag">a Git collaboration kernel for AI agents</span>
    <span class="spacer"></span>
    <span class="health" id="health">● …</span>
  </header>
  <main>
    <section class="panel">
      <h2>任务板 <span class="count" id="cnt-open">0</span>
        <span class="spacer" style="flex:1"></span>
        <span class="tabs" style="padding:0">
          <button id="tab-tasks" class="on" onclick="switchTab('tasks')">任务</button>
          <button id="tab-prov" onclick="switchTab('prov')">溯源</button>
        </span>
      </h2>
      <div id="board" style="max-height:76vh;overflow-y:auto"></div>
      <div id="prov" style="display:none;max-height:76vh;overflow-y:auto"></div>
    </section>
    <section class="panel">
      <h2>活动流 <span class="count" id="cnt-ev">0</span></h2>
      <div class="feed" id="feed"></div>
    </section>
  </main>\`;
  refresh();
  timer = setInterval(refresh, 4000);
}
function switchTab(t) {
  tab = t;
  document.getElementById('tab-tasks').className = t === 'tasks' ? 'on' : '';
  document.getElementById('tab-prov').className = t === 'prov' ? 'on' : '';
  document.getElementById('board').style.display = t === 'tasks' ? '' : 'none';
  document.getElementById('prov').style.display = t === 'prov' ? '' : 'none';
}
TOKEN ? boot() : gate();
</script>
</body>
</html>`;
