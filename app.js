/* Transport Fare Calculator (single-file, static)
 * - Reads data/fare_source.tsv (TSV) and optional data/place_aliases.csv
 * - Normalizes and searches fares for multiple itinerary legs
 * - Keeps both text input and dropdown add
 */
const DB = {
  meta: { loadedAt: null, rowCount: 0 },
  faresRows: [],      // array of normalized fare rows
  routeMap: new Map(), // key=from||to -> array of rows
  places: [],
  aliasToCanon: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));



// ---- key normalization & flexible column mapping ----
function stripBOM(s){ return (s || '').toString().replace(/^\uFEFF/, ''); }
function normHeaderKey(k){
  return stripBOM(k)
    .replace(/[\u3000\s]+/g,'')   // remove spaces (incl full-width)
    .replace(/[()（）\[\]【】]/g,'')
    .replace(/[‐‑–—―ー]/g,'-')
    .toLowerCase();
}
function canonicalKey(k){
  const nk = normHeaderKey(k);
  // JP / EN variants -> canonical tokens
  if (['出発地','発地','出発','from','origin','出発場所','発駅','乗車地'].some(x=>nk.includes(normHeaderKey(x)))) return 'from';
  if (['到着地','着地','到着','to','destination','到着場所','着駅','降車地'].some(x=>nk.includes(normHeaderKey(x)))) return 'to';
  if (['運賃','金額','料金','fare','price','運賃額'].some(x=>nk.includes(normHeaderKey(x)))) return 'fare';
  if (['価格タイプ','価格ﾀｲﾌﾟ','シーズン','season','type','区分'].some(x=>nk.includes(normHeaderKey(x)))) return 'priceType';
  if (['搭乗期間開始','搭乗開始','boardfrom','validfrom','搭乗期間from'].some(x=>nk.includes(normHeaderKey(x)))) return 'wholeFrom';
  if (['搭乗期間終了','搭乗終了','boardto','validto','搭乗期間to'].some(x=>nk.includes(normHeaderKey(x)))) return 'wholeTo';
  if (['価格適用期間開始','適用開始','periodfrom','farefrom','価格適用開始'].some(x=>nk.includes(normHeaderKey(x)))) return 'validFrom';
  if (['価格適用期間終了','適用終了','periodto','fareto','価格適用終了'].some(x=>nk.includes(normHeaderKey(x)))) return 'validTo';
  if (['根拠','備考','rule','注記','参照'].some(x=>nk.includes(normHeaderKey(x)))) return 'rule';
  if (['価格適用期間','適用期間'].some(x=>nk.includes(normHeaderKey(x)))) return 'validRange';
  if (['alias','別名','入力','候補','表記ゆれ','表記揺れ','synonym'].some(x=>nk.includes(normHeaderKey(x)))) return 'alias';
  if (['canonical','正規','正規名','統一名','正式名称'].some(x=>nk.includes(normHeaderKey(x)))) return 'canonical';
  return nk; // fallback
}
function normalizeRowKeys(row){
  const out = {};
  for (const [k,v] of Object.entries(row||{})){
    const ck = canonicalKey(k);
    // keep first non-empty value if duplicates appear
    const val = (v ?? '').toString().trim();
    if (!(ck in out) || (out[ck] === '' && val !== '')) out[ck] = val;
  }
  return out;
}
// ---- robust fetch helpers (avoid SPA fallback returning index.html) ----
async function fetchTextFirstOk(urls){
  let lastErr = null;
  for (const u of urls){
    try{
      const res = await fetch(u, { cache: "no-cache" });
      if (!res.ok) { lastErr = new Error(`${u} => ${res.status}`); continue; }
      const txt = await res.text();
      return { url: u, text: txt, status: res.status };
    } catch (e){
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("fetch failed");
}

function looksLikeHTML(text){
  const t = (text ?? "").toString().trim().slice(0,200).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.includes("<head") || t.includes("<body");
}

function hasAnyKey(obj, keys){
  return keys.some(k => Object.prototype.hasOwnProperty.call(obj, k));
}

function validateFareRows(rows){
  // Accept either JP headers or EN headers (TSV sample)
  if (!Array.isArray(rows) || !rows.length) return false;
  const first = rows[0] || {};
  const jpOk = hasAnyKey(first, ["出発地"]) && hasAnyKey(first, ["到着地"]) && hasAnyKey(first, ["運賃"]);
  const enOk = hasAnyKey(first, ["origin"]) && hasAnyKey(first, ["destination"]) && hasAnyKey(first, ["fare"]);
  return jpOk || enOk;
}

function norm(s){
  return (s ?? "").toString().trim()
    .replace(/[\s\u3000]+/g,"")
    .replace(/[‐‑–—−]/g,"-")
    .toLowerCase();
}

// Normalize key for matching (places / aliases)
function normKey(s) {
  // Based on norm(), plus remove Japanese middle dots etc.
  return norm(s).replace(/[・･]/g, '').replace(/[()（）\[\]【】]/g, '');
}


function parseDateLoose(s){
  const t = (s ?? "").toString().trim();
  if (!t) return null;

  // YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));

  // YYYY/MM/DD
  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));

  // YYYY/MM
  m = t.match(/^(\d{4})\/(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2])-1, 1);

  // M/D or M-D (assume current year)
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const y = new Date().getFullYear();
    return new Date(y, Number(m[1])-1, Number(m[2]));
  }

  return null;
}

function ymd(d){
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function money(n){
  if (n == null || !Number.isFinite(n)) return "-";
  return Math.trunc(n).toLocaleString("ja-JP");
}

function parseTSV(text){
  const lines = text.replace(/\r/g,"").split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split("\t").map(h=>h.trim());
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split("\t");
    const r = {};
    for (let j=0;j<header.length;j++){
      r[header[j]] = (cols[j] ?? "").trim();
    }
    rows.push(r);
  }
  return rows;
}

function parseCSV(text){
  // minimal CSV parser (handles quoted commas)
  const rows = [];
  let cur = [];
  let cell = "";
  let inQ = false;
  for (let i=0;i<text.length;i++){
    const ch = text[i];
    const next = text[i+1];
    if (inQ){
      if (ch === '"' && next === '"'){ cell += '"'; i++; }
      else if (ch === '"'){ inQ = false; }
      else cell += ch;
    } else {
      if (ch === '"'){ inQ = true; }
      else if (ch === ','){ cur.push(cell); cell = ""; }
      else if (ch === '\n'){ cur.push(cell); rows.push(cur); cur = []; cell = ""; }
      else if (ch === '\r'){ /* skip */ }
      else cell += ch;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  if (!rows.length) return [];
  const header = rows[0].map(h=> (h ?? "").toString().replace(/^\ufeff/, "").trim());
  const out = [];
  for (let i=1;i<rows.length;i++){
    if (rows[i].every(x => (x ?? "").trim() === "")) continue;
    const obj = {};
    for (let j=0;j<header.length;j++){
      obj[header[j]] = (rows[i][j] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

function splitPeriods(periodStr){
  // "2025-06-01〜2025-06-30 / 2025-09-01〜2025-10-25"
  const t = (periodStr ?? "").toString().trim();
  if (!t) return [];
  const parts = t.split("/").map(p=>p.trim()).filter(Boolean);
  const ranges = [];
  for (const p of parts){
    const m = p.match(/(\d{4}-\d{2}-\d{2})\s*[〜~\-]\s*(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const a = parseDateLoose(m[1]);
    const b = parseDateLoose(m[2]);
    if (a && b) ranges.push([a,b]);
  }
  return ranges;
}

function buildAliasDefaultsFromPlaces(places){
  // also accept "東京都" -> "東京" style: strip 都道府県 suffix if exact match
  const m = new Map();
  for (const p of places){
    m.set(norm(p), p);
  }
  // common suffix variants
  for (const p of places){
    const np = norm(p);
    // if place ends with 空港 etc keep itself as canonical
    // create variants with 都/道/府/県 removed
    const variants = [
      p.replace(/(都|道|府|県)$/,""),
      p.replace(/空港$/,""),
    ].filter(v=>v && v !== p);
    for (const v of variants){
      if (!m.has(norm(v))) m.set(norm(v), p);
    }
  }
  // hard common arrows / city tokens:
  const common = [
    ["東京","東京"],["羽田","東京"],["成田","東京"],
    ["沖縄","沖縄"],["那覇","沖縄"],
  ];
  for (const [a,c] of common){
    if (places.includes(c) && !m.has(norm(a))) m.set(norm(a), c);
  }
  return m;
}

function resolvePlace(name){
  const k = norm(name);
  if (!k) return "";
  return DB.aliasToCanon.get(k) || name.trim();
}

function inRange(d, a, b){
  // inclusive
  const x = d.getTime();
  return x >= a.getTime() && x <= b.getTime();
}

function findFare(date, from, to){
  const d = date;
  const f = resolvePlace(from);
  const t = resolvePlace(to);

  // Use routeMap when available (faster and avoids full-scan)
  const keyFT = normKey(f) + '||' + normKey(t);
  const keyTF = normKey(t) + '||' + normKey(f);
  const listFT = DB.routeMap?.get(keyFT) || null;
  const listTF = DB.routeMap?.get(keyTF) || null;

  const pick = (arr) => {
    const cands = (arr || []).filter(r => inRange(d, r.validFrom, r.validTo));
    if (!cands.length) return null;
    cands.sort((a,b)=> (a.validTo-a.validFrom) - (b.validTo-b.validFrom) || (a.priceType === "ピーク" ? -1 : 1));
    return cands[0];
  };

  // exact direction first
  let best = pick(listFT || DB.routeMap.filter(r => r.from === f && r.to === t));
  if (best){
    return { hit:true, row:best, from:f, to:t, tried:[`${f}→${t}`] };
  }

  // try reverse direction (some data may be one-way)
  best = pick(listTF || DB.routeMap.filter(r => r.from === t && r.to === f));
  if (best){
    return { hit:true, row:{...best, note:"※逆方向データを使用"}, from:f, to:t, tried:[`${f}→${t}`, `${t}→${f}`] };
  }

  // no hit
  // show top 5 near matches by from/to only
  const near = DB.routeMap.filter(r => (r.from===f && r.to===t) || (r.from===t && r.to===f));
  near.sort((a,b)=> a.validFrom - b.validFrom);
  return { hit:false, row:null, from:f, to:t, tried:[`${f}→${t}`, `${t}→${f}`], near: near.slice(0,5) };
}

function parseItineraryLines(text){
  const lines = (text ?? "").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const legs = [];
  const errors = [];
  for (const line of lines){
    // date token at start
    const m = line.match(/^([0-9]{4}[\/-][0-9]{1,2}[\/-][0-9]{1,2}|[0-9]{1,2}[\/-][0-9]{1,2})\s*(.+)$/);
    if (!m){ errors.push(`日付が読み取れません: ${line}`); continue; }
    const d = parseDateLoose(m[1]);
    if (!d){ errors.push(`日付形式が不正: ${line}`); continue; }
    const rest = m[2].trim();

    // split by arrow or hyphen
    const arrow = rest.replace(/→/g,"->").replace(/⇒/g,"->").replace(/ー/g,"-");
    const m2 = arrow.match(/^(.+?)\s*(?:->|〜|~|-)\s*(.+)$/);
    if (!m2){ errors.push(`出発地/到着地が読み取れません: ${line}`); continue; }
    const from = m2[1].trim();
    const to = m2[2].trim();
    if (!from || !to){ errors.push(`出発地/到着地が空です: ${line}`); continue; }
    legs.push({ date: d, from, to, raw: line });
  }
  return { legs, errors };
}

function renderLegs(){
  const wrap = $("#legsList");
  wrap.innerHTML = "";
  if (!window.__legs || !window.__legs.length){
    wrap.innerHTML = `<div class="msg">まだ旅程がありません。</div>`;
    return;
  }
  window.__legs.forEach((leg, idx)=>{
    const el = document.createElement("div");
    el.className = "legItem";
    el.innerHTML = `
      <div class="meta">
        <div class="m1">${ymd(leg.date)}　${leg.from} → ${leg.to}</div>
        <div class="m2">${leg.raw || ""}</div>
      </div>
      <div class="actions">
        <button class="btn ghost" data-act="up" data-idx="${idx}">↑</button>
        <button class="btn ghost" data-act="down" data-idx="${idx}">↓</button>
        <button class="btn" data-act="del" data-idx="${idx}">削除</button>
      </div>
    `;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const act = btn.getAttribute("data-act");
      const idx = Number(btn.getAttribute("data-idx"));
      if (act === "del"){ window.__legs.splice(idx,1); }
      if (act === "up" && idx>0){
        const t = window.__legs[idx-1]; window.__legs[idx-1]=window.__legs[idx]; window.__legs[idx]=t;
      }
      if (act === "down" && idx<window.__legs.length-1){
        const t = window.__legs[idx+1]; window.__legs[idx+1]=window.__legs[idx]; window.__legs[idx]=t;
      }
      renderLegs();
      runSearch();
    });
  });
}

function renderSelectOptions(){
  const fromSel = $("#fromSelect");
  const toSel = $("#toSelect");
  const via1Sel = $("#via1Select");
  const via2Sel = $("#via2Select");

  const prev = {
    from: fromSel?.value || "",
    to: toSel?.value || "",
    via1: via1Sel?.value || "",
    via2: via2Sel?.value || ""
  };

  const opts = DB.places.slice().sort((a,b)=>a.localeCompare(b,"ja"));

  function fill(sel, includeBlank){
    if (!sel) return;
    sel.innerHTML = "";
    if (includeBlank){
      const ob = document.createElement("option");
      ob.value = ""; ob.textContent = "（未指定）";
      sel.appendChild(ob);
    }
    for (const p of opts){
      const o = document.createElement("option");
      o.value = p; o.textContent = p;
      sel.appendChild(o);
    }
  }

  fill(fromSel, false);
  fill(toSel, false);
  fill(via1Sel, true);
  fill(via2Sel, true);

  if (prev.from && opts.includes(prev.from)) fromSel.value = prev.from;
  if (prev.to && opts.includes(prev.to)) toSel.value = prev.to;
  if (prev.via1 && opts.includes(prev.via1)) via1Sel.value = prev.via1;
  if (prev.via2 && opts.includes(prev.via2)) via2Sel.value = prev.via2;

  if (!fromSel.value && opts.includes("東京")) fromSel.value = "東京";
  if (!toSel.value && opts.includes("沖縄")) toSel.value = "沖縄";
}


function renderResults(rows, misses){
  const tbody = $("#resultTable tbody");
  tbody.innerHTML = "";
  let sum = 0;
  let hit = 0;
  for (const r of rows){
    const tr = document.createElement("tr");
    const fare = r.hit ? r.row.fare : null;
    if (Number.isFinite(fare)) sum += Math.trunc(fare);
    if (r.hit) hit++;
    tr.innerHTML = `
      <td>${ymd(r.leg.date)}</td>
      <td>${r.from}</td>
      <td>${r.to}</td>
      <td>${r.hit ? (r.row.priceType || "-") : `<span class="pill red">未ヒット</span>`}</td>
      <td class="num">${r.hit ? money(r.row.fare) : "-"}</td>
      <td>${r.hit ? (r.row.seasonLabel ? `${r.row.seasonLabel}${r.row.note?` ${r.row.note}`:""}` : (r.row.note||"")) : (r.near && r.near.length ? `候補あり（期間外/逆方向）` : "データなし")}</td>
    `;
    tbody.appendChild(tr);
  }

  $("#sumFare").textContent = hit ? money(sum) : "-";
  $("#hitCount").textContent = String(hit);
  $("#missCount").textContent = String(rows.length - hit);
  // keep DB status visible even after search rerenders
  if (DB.meta?.source){
    $("#dbMeta").textContent = `DB: ${DB.meta.source} / routes=${DB.meta.routes} / fares=${DB.meta.fares} / places=${DB.meta.places} / updated=${DB.meta.updatedAt}`;
  }

  // diagnostics
  const missLines = misses.map(m => `- ${ymd(m.leg.date)} ${m.from}→${m.to} | tried: ${m.tried.join(" / ")}\n  candidates: ${m.near?.map(n=>`${n.from}→${n.to} ${ymd(n.validFrom)}〜${ymd(n.validTo)} ${n.priceType} ${money(n.fare)}`).join(" | ") || "-"}`).join("\n");
  $("#diagMisses").textContent = missLines || "（未ヒットなし）";

  // show a small alias map sample
  const aliasSample = Array.from(DB.aliasToCanon.entries()).slice(0, 200).map(([k,v])=>`${k} => ${v}`).join("\n");
  $("#diagAliases").textContent = aliasSample || "（aliasなし）";
}

function runSearch(){
  if (!DB.faresRows || DB.faresRows.length === 0) {
    renderResults([], []);
    $("#parseMsg").textContent = "DB未読み込み（運賃データ0件）です。data/transport.csv を確認してください。";
    return;
  }

  const legs = window.__legs || [];
  if (!legs.length){
    renderResults([], []);
    $("#parseMsg").textContent = "旅程がありません。テキスト貼り付けかフォームで追加してください。";
    return;
  }
  $("#parseMsg").textContent = "";

  const results = [];
  const misses = [];
  for (const leg of legs){
    const res = findFare(leg.date, leg.from, leg.to);
    results.push({ ...res, leg });
    if (!res.hit) misses.push({ ...res, leg });
  }
  renderResults(results, misses);
}

async function loadDB(){
  // 1) fares: prefer CSV master (data/transport.csv). fallback to TSV sample.
  let fareRows = null;
  let sourceName = '';

  // Candidate URLs (covers: file root, subdir, Netlify/GitHub Pages base URL)
  const csvUrls = [
    new URL('./data/transport.csv', location.href).toString(),
    new URL('data/transport.csv', location.href).toString(),
    './data/transport.csv',
    'data/transport.csv',
  ];
  const tsvUrls = [
    new URL('./data/fare_source.tsv', location.href).toString(),
    new URL('data/fare_source.tsv', location.href).toString(),
    './data/fare_source.tsv',
    'data/fare_source.tsv',
  ];

  // Try CSV first
  try {
    const got = await fetchTextFirstOk(csvUrls);
    if (looksLikeHTML(got.text)) throw new Error(`transport.csv resolved to HTML (SPA fallback). url=${got.url}`);
    const rows = parseCSV(got.text);
    if (!validateFareRows(rows)) throw new Error(`transport.csv parsed but missing expected headers. url=${got.url}`);
    fareRows = rows;
    sourceName = 'transport.csv';
  } catch (e){
    // fallback TSV
    const got = await fetchTextFirstOk(tsvUrls);
    if (looksLikeHTML(got.text)) throw new Error(`fare_source.tsv resolved to HTML (SPA fallback). url=${got.url}`);
    const rows = parseTSV(got.text);
    if (!validateFareRows(rows)) throw new Error(`fare_source.tsv parsed but missing expected headers. url=${got.url}`);
    fareRows = rows;
    sourceName = 'fare_source.tsv';
  }


  // 2) aliases (optional)
  let aliasRows = [];
  try {
    const resA = await fetch("./data/place_aliases.csv", { cache: "no-cache" });
    if (resA.ok){
      const a = await resA.text();
      aliasRows = parseCSV(a).map(normalizeRowKeys);
    }
  } catch {}

  // -------------------------
  // build DB
  // -------------------------
  const fares = [];
  const placesSet = new Set();

  const seen = new Set();
  function keyOf(from,to,ptype,fromD,toD){
    return `${from}||${to}||${ptype}||${ymd(fromD)}||${ymd(toD)}`;
  }

  function shiftYear(d, plus){
    const x = new Date(d);
    x.setFullYear(x.getFullYear() + plus);
    return x;
  }

  // 「価格適用期間」の年ズレを補正：
  // 搭乗期間が年跨ぎ（例: 2025-10-26〜2026-03-28）のとき、
  // 価格適用期間が 2025-01/02/03… と入っていたら 2026 に寄せる。
  function alignToWholeRange(pFrom, pTo, wholeFrom, wholeTo){
    let from = pFrom;
    let to = pTo;
    if (!from || !to) return null;
    if (!(wholeFrom instanceof Date) || !(wholeTo instanceof Date)) return { from, to };

    // if whole crosses years
    const crosses = wholeTo.getFullYear() > wholeFrom.getFullYear();
    if (crosses){
      const startY = wholeFrom.getFullYear();
      const startM = wholeFrom.getMonth();

      // common data issue: Jan-Mar written with startY instead of endY
      if (from.getFullYear() == startY && from.getMonth() < startM) {
        from = shiftYear(from, +1);
      }
      if (to.getFullYear() == startY && to.getMonth() < startM) {
        to = shiftYear(to, +1);
      }

      // if still entirely before wholeFrom, move forward by 1 year (safety)
      if (to < wholeFrom) {
        from = shiftYear(from, +1);
        to = shiftYear(to, +1);
      }
    }

    // clamp (safety) — don't extend beyond the declared boarding window
    const vf = new Date(Math.max(from.getTime(), wholeFrom.getTime()));
    const vt = new Date(Math.min(to.getTime(), wholeTo.getTime()));
    if (vf > vt) return null;
    return { from: vf, to: vt };
  }

  for (const r of fareRows){
    const rr = normalizeRowKeys(r);

    const fromRaw = (rr.from ?? "").toString().trim();
    const toRaw   = (rr.to   ?? "").toString().trim();
    if (!fromRaw || !toRaw) continue;

    const priceType = (rr.priceType ?? "").toString().trim() || "通常";
    const fare = parseInt((rr.fare ?? "0").toString().replace(/[^0-9-]/g, ""), 10) || 0;

    // whole range (optional, but used for year-alignment)
 (optional, but used for year-alignment)
    const wholeFrom = parseDateLoose((rr.wholeFrom ?? rr.valid_from ?? "").toString().trim());
    const wholeTo   = parseDateLoose((rr.wholeTo ?? rr.valid_to ?? "").toString().trim());

    // periods (preferred)
    let periods = splitPeriods((r["価格適用期間"] ?? "").toString().trim());
    if (!periods.length){
      // fallback to whole range if no explicit periods
      if (wholeFrom && wholeTo) periods = [{ from: wholeFrom, to: wholeTo }];
    }

    for (const p of periods){
      const aligned = alignToWholeRange(p.from, p.to, wholeFrom, wholeTo);
      if (!aligned) continue;

      const key = keyOf(fromRaw, toRaw, priceType, aligned.from, aligned.to);
      if (seen.has(key)) continue;
      seen.add(key);

      fares.push({
        from: fromRaw,
        to: toRaw,
        priceType,
        fare,
        validFrom: aligned.from,
        validTo: aligned.to,
        source: sourceName
      });

      placesSet.add(fromRaw);
      placesSet.add(toRaw);
    }
  }

  // alias map (external CSV + built-in)
  const places = Array.from(placesSet).sort();
  const aliasToCanon = buildAliasDefaultsFromPlaces(places);

  // merge external aliases: csv columns = alias, canonical
  for (const a of aliasRows){
        const alias = (a.alias ?? '').toString().trim();
    const canon = (a.canonical ?? '').toString().trim();
    if (!alias || !canon) continue;
    aliasToCanon.set(normKey(alias), canon);
  }

  // build lookup map
  const map = new Map();
  for (const f of fares){
    const k = normKey(f.from) + '||' + normKey(f.to);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f);
  }
  for (const [k, arr] of map.entries()){
    arr.sort((a,b)=> a.validFrom - b.validFrom || a.validTo - b.validTo || a.fare - b.fare);
  }

  // store
  DB.faresRows = fares;
  DB.routeMap = map;
  DB.places = places;
  DB.aliasToCanon = aliasToCanon;
  DB.meta = {
    source: sourceName,
    fares: fares.length,
    routes: map.size,
    places: places.length,
    updatedAt: new Date().toISOString().slice(0,19).replace('T',' ')
  };

  // UI meta
  const meta = DB.meta;
  $("#dbMeta").textContent = `DB: ${meta.source} / routes=${meta.routes} / fares=${meta.fares} / places=${meta.places} / updated=${meta.updatedAt}`;
  if (meta.fares === 0 || meta.places === 0){
    $("#dbMeta").textContent += "  ※DB未反映の可能性：Netlify/GitHub Pagesの公開フォルダに data/ が含まれるか、SPAリダイレクト設定で /data/* を潰していないか確認";
  }
}


function bindUI(){
  window.__legs = [];

  $("#btnParse").addEventListener("click", ()=>{
    const { legs, errors } = parseItineraryLines($("#itineraryText").value);
    if (errors.length){
      $("#parseMsg").textContent = errors.slice(0,8).join(" / ");
    } else {
      $("#parseMsg").textContent = `解析OK：${legs.length}件`;
    }
    // merge (append) not replace: business use often adds
    window.__legs = legs;
    renderLegs();
    runSearch();
  });

  $("#btnClear").addEventListener("click", ()=>{
    $("#itineraryText").value = "";
    $("#parseMsg").textContent = "";
  });

  $("#btnAddLeg").addEventListener("click", ()=>{
    const d = $("#legDate").value ? parseDateLoose($("#legDate").value) : null;
    const from = $("#fromSelect").value;
    const to = $("#toSelect").value;
    const via1 = $("#via1Select") ? $("#via1Select").value : "";
    const via2 = $("#via2Select") ? $("#via2Select").value : "";

    if (!d || !from || !to){
      $("#parseMsg").textContent = "日付・出発地・到着地を指定してください。";
      return;
    }

    const legsToAdd = [];
    if (via1 || via2){
      legsToAdd.push({ date: d, from, to, raw: `${ymd(d)} ${from}→${to}（直行候補）`, tag: "direct" });

      if (via1 && via2){
        legsToAdd.push({ date: d, from, to: via1, raw: `${ymd(d)} ${from}→${via1}（経由①）`, tag: "via" });
        legsToAdd.push({ date: d, from: via1, to: via2, raw: `${ymd(d)} ${via1}→${via2}（経由②）`, tag: "via" });
        legsToAdd.push({ date: d, from: via2, to, raw: `${ymd(d)} ${via2}→${to}（経由③）`, tag: "via" });
      } else if (via1){
        legsToAdd.push({ date: d, from, to: via1, raw: `${ymd(d)} ${from}→${via1}（経由①）`, tag: "via" });
        legsToAdd.push({ date: d, from: via1, to, raw: `${ymd(d)} ${via1}→${to}（経由②）`, tag: "via" });
      } else if (via2){
        legsToAdd.push({ date: d, from, to: via2, raw: `${ymd(d)} ${from}→${via2}（経由①）`, tag: "via" });
        legsToAdd.push({ date: d, from: via2, to, raw: `${ymd(d)} ${via2}→${to}（経由②）`, tag: "via" });
      }
    } else {
      legsToAdd.push({ date: d, from, to, raw: `${ymd(d)} ${from}→${to}`, tag: "" });
    }

    window.__legs.push(...legsToAdd);
    renderLegs();
    runSearch();
  });

  $("#btnResetLegs").addEventListener("click", ()=>{
    window.__legs = [];
    renderLegs();
    runSearch();
  });
}

(async function main(){
  try{
    await loadDB();
    renderSelectOptions();
    bindUI();
    renderLegs();
    runSearch();
  } catch (e){
    console.error(e);
    $("#parseMsg").textContent = "読み込みエラー：" + (e?.message || e);
    $("#dbMeta").textContent = "読み込み失敗";
  }
})();