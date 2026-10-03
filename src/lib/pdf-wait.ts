// The "compiling…" page shown in the pdf tab while the server runs LaTeX.
// Written into a blank tab with document.write, so it must be one
// self-contained document: inline styles, no imports, no external assets.
//
// It polls /api/pdfstatus — the server's own view of the fragment cache — so
// the list is not decoration: entries flip to ready as their fragment pdfs
// actually land in the scratch dir, and the count line ends on "assembling"
// when only the wrapper is left to do.
export function pdfWaitPage(statusUrl: string, force: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>compiling</title>
<style>
:root{--bg:#fbfbfc;--fg:#3f4652;--dim:#8a92a0;--line:#e3e7ed;--acc:#2f6fd0;--err:#b4453c}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--fg:#c8cdd7;--dim:#79808e;--line:#2a2e36;--acc:#74a9f7;--err:#e0776c}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.6 Literata,Georgia,'Times New Roman',serif}
main{max-width:33rem;margin:0 auto;padding:11vh 1.5rem 3rem}
h1{font-size:1.05rem;font-weight:600;margin:0;overflow-wrap:anywhere}
.meta{color:var(--dim);font-size:.78rem;margin:.3rem 0 1.8rem}
.bar{height:2px;background:var(--line)}
.bar i{display:block;height:100%;width:0;background:var(--acc);transition:width .4s ease}
.count{color:var(--dim);font-size:.78rem;margin:.7rem 0 1.4rem}
.count.err{color:var(--err)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:.55rem;align-items:baseline;padding:.26rem 0;border-top:1px solid var(--line)}
li .g{flex:none;width:.85rem;text-align:center;color:var(--dim);font-size:.72rem;line-height:1.9}
li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li.part{border-top-color:transparent;margin-top:.75rem;font-weight:600}
li.ch .t{color:var(--dim)}
li.ready .g{color:var(--acc)}
li.ch.ready .t{color:var(--fg)}
.spin{display:inline-block;width:.6rem;height:.6rem;border:1.5px solid var(--acc);border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-1px}
@keyframes sp{to{transform:rotate(1turn)}}
</style>
</head>
<body>
<main>
<h1 id="scope">compiling…</h1>
<div class="meta" id="meta">lualatex</div>
<div class="bar"><i id="bar"></i></div>
<div class="count" id="count">reading the fragment cache</div>
<ul id="list"></ul>
</main>
<script>
var STATUS = ${JSON.stringify(statusUrl)};
var FORCE = ${force ? 'true' : 'false'};
var list = document.getElementById('list');
var scopeEl = document.getElementById('scope');
var metaEl = document.getElementById('meta');
var barEl = document.getElementById('bar');
var countEl = document.getElementById('count');
var rows = [];
var sigCache = '';

function pretty(s){ return String(s || '').replace(/_/g, ' '); }

function build(items) {
  var sig = items.map(function (i) { return i.kind + ':' + i.title; }).join('|');
  if (sig === sigCache) return;
  sigCache = sig;
  list.textContent = '';
  rows = items.map(function (i) {
    var li = document.createElement('li');
    li.className = i.kind;
    var g = document.createElement('span');
    g.className = 'g';
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = pretty(i.title);
    li.appendChild(g);
    li.appendChild(t);
    list.appendChild(li);
    return { kind: i.kind, li: li, g: g };
  });
}

function paint(i, cached, working) {
  var r = rows[i];
  if (!r) return;
  r.li.className = r.kind + (cached ? ' ready' : working ? ' work' : '');
  r.g.innerHTML = cached ? '&#10003;' : working ? '<span class="spin"></span>' : '&middot;';
}

function fail(msg) {
  countEl.className = 'count err';
  countEl.textContent = msg;
}

function tick() {
  fetch(STATUS, { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (p) {
      if (p.error) { fail(p.error); return; }
      var items = p.items || [];
      build(items);
      var ready = 0;
      var next = -1;
      items.forEach(function (i, n) {
        if (i.cached) ready++;
        else if (next < 0) next = n;
      });
      var total = items.length;
      scopeEl.textContent = pretty(p.scope);
      metaEl.textContent = p.style + ' \\u00b7 ' + (p.fragments ? 'chapters and part pages' : 'single chapter');
      barEl.style.width = (total ? Math.round((100 * ready) / total) : 0) + '%';
      countEl.className = 'count';
      countEl.textContent = FORCE
        ? 'rebuilding all ' + total + ' pieces'
        : ready + ' of ' + total + ' ready \\u00b7 ' +
          (total - ready ? total - ready + ' to compile' : 'assembling');
      items.forEach(function (i, n) { paint(n, i.cached, n === next); });
      // everything cached: the wrapper is assembling, and the app is about
      // to navigate this tab to the pdf itself
      if (ready === total && !FORCE) return;
      setTimeout(tick, 700);
    })
    .catch(function () { setTimeout(tick, 1500); });
}

tick();
</script>
</body>
</html>`;
}