/**
 * Парсер расписания массовых катаний для «Каток Минск».
 * Запускается GitHub Actions ежедневно, пишет app/schedule.json.
 * Node 20+, playwright (chromium) — для сайтов, рендерящихся JS.
 *
 * Принцип: каждая арена парсится независимо; ошибка одной арены не валит остальных.
 * Если арена не распарсилась — её сеансы просто отсутствуют в выпуске.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'app', 'schedule.json');
const YEAR_NOW = new Date().getFullYear();

const MONTHS_RU = {
  'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,
  'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12
};

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function normTime(t) {
  // "09.00" | "9:00" -> "09:00"
  const m = t.match(/(\d{1,2})[.:](\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2,'0')}:${m[2]}`;
}
// год для даты "26 августа": берём ближайший к сегодня (важно на стыке годов)
function guessYear(month, day) {
  const now = new Date();
  let best = null, bestDiff = Infinity;
  for (const y of [YEAR_NOW - 1, YEAR_NOW, YEAR_NOW + 1]) {
    const d = new Date(y, month - 1, day);
    const diff = Math.abs(d - now);
    if (diff < bestDiff) { bestDiff = diff; best = y; }
  }
  return best;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) nakatok-schedule-bot' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const raw = await r.text();
  // нормализуем HTML-сущности, которые ломают разбор дат («24&nbsp;августа»)
  return raw
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;/gi, '-')
    .replace(/&amp;/gi, '&');
}

/* ---------- Чижовка-Арена: статический HTML с таблицами по неделям ---------- */
async function parseChizhovka() {
  const html = await fetchText('https://chizhovka-arena.by/fizkultura-i-sport/katanie-na-konkah?redirect=0');
  const sessions = [];
  // Вырезаем таблицы
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    // Заголовки колонок: "Понедельник<br>24 августа" и т.п.
    const headRow = (table.match(/<tr[\s\S]*?<\/tr>/i) || [''])[0];
    const headCells = headRow.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
    const dates = headCells.map(c => {
      const txt = c.replace(/<[^>]+>/g, ' ');
      const m = txt.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
      if (!m) return null;
      const day = +m[1], mon = MONTHS_RU[m[2].toLowerCase()];
      return isoDate(guessYear(mon, day), mon, day);
    });
    if (!dates.some(Boolean)) continue; // не расписание
    // Остальные строки: ячейки вида "09.00 МА", "19.15 БА", возможно "билеты проданы"
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows.slice(1)) {
      const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      cells.forEach((cell, i) => {
        if (!dates[i]) return;
        const txt = cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const m = txt.match(/(\d{1,2}[.:]\d{2})\s*(МА|БА)/i);
        if (!m) return;
        const t = normTime(m[1]);
        if (!t) return;
        const big = m[2].toUpperCase() === 'БА';
        sessions.push({
          d: dates[i], t, a: 'chizhovka', type: 'mass', dur: 60,
          place: big ? 'Большая арена · вход №1' : 'Малая арена · вход №50'
        });
      });
    }
  }
  return sessions;
}

/* ---------- Ледовый дворец (Притыцкого), led.by: статический HTML ---------- */
async function parsePritytskogo() {
  const html = await fetchText('https://led.by/category/timetable/');
  const sessions = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    // Определяем порядок колонок по заголовку
    const headTxt = rows[0] ? rows[0].replace(/<[^>]+>/g, ' ').toUpperCase() : '';
    if (!headTxt.includes('МАССОВОЕ')) continue;
    const headCells = (rows[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, ' ').toUpperCase());
    let ohmCol = headCells.findIndex(c => c.includes('ХОККЕЙНОГО'));
    let mkCol = headCells.findIndex(c => c.includes('МАССОВОЕ'));
    for (const row of rows.slice(1)) {
      const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      if (!cells.length) continue;
      const first = cells[0].replace(/<[^>]+>/g, ' ');
      // "Пн.24.08.2026"
      const dm = first.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (!dm) continue;
      const d = isoDate(+dm[3], +dm[2], +dm[1]);
      const handle = (cellHtml, type) => {
        if (!cellHtml) return;
        const txt = cellHtml.replace(/<[^>]+>/g, ' ');
        const bold = /<(b|strong)\b/i.test(cellHtml);
        const tm = txt.match(/(\d{1,2}[.:]\d{2})/);
        if (!tm) return;
        const t = normTime(tm[1]);
        // длительность "(1 час)" | "(45 мин)" | "(1 час 15 минут)"
        let dur = 60;
        if (/45\s*мин/i.test(txt)) dur = 45;
        else if (/1\s*час\s*15/i.test(txt)) dur = 75;
        // жирный сеанс МК в вых. дни на led.by означает форму дискотеки (сноска «Массовое катание*»)
        const finalType = (type === 'mass' && (bold || txt.includes('*'))) ? 'disco' : type;
        const dow = new Date(d).getDay();
        const weekend = dow === 0 || dow === 6;
        const price = type === 'mass'
          ? (weekend ? '10 руб. / детский 8 руб. (выходной)' : '9 руб. / детский 7 руб.')
          : undefined;
        sessions.push({ d, t, a: 'pritytskogo', type: finalType, dur, ...(price ? { price } : {}) });
      };
      if (ohmCol > 0) handle(cells[ohmCol], 'ohm');
      if (mkCol > 0) handle(cells[mkCol], 'mass');
    }
  }
  return sessions;
}

/* ---------- JS-сайты (ledlife.by, minskarena.by): через Playwright ---------- */
async function withBrowser(fn) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'ru-RU' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// СДЮШОР Малиновка (Каролинский пр-д, 5) — ledlife.by
async function parseKarolinsky() {
  return await withBrowser(async page => {
    const sessions = [];
    for (const url of ['https://ledlife.by/massovye_kataniya/', 'https://ledlife.by/raspisanie/']) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      } catch (e) { continue; }
      const text = await page.evaluate(() => document.body.innerText);
      // Ищем блоки вида "26 августа" / "26.08" со временем "17:00", "19:30-20:30" рядом
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      let curDate = null;
      for (const line of lines) {
        let m = line.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
        if (m) {
          const mon = MONTHS_RU[m[2].toLowerCase()];
          curDate = isoDate(guessYear(mon, +m[1]), mon, +m[1]);
          continue;
        }
        m = line.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/);
        if (m && +m[2] >= 1 && +m[2] <= 12) {
          curDate = isoDate(m[3] ? +m[3] : guessYear(+m[2], +m[1]), +m[2], +m[1]);
          continue;
        }
        if (curDate) {
          // все времена в строке; "17:00-18:00" -> начало 17:00
          const times = [...line.matchAll(/(\d{1,2}[:.]\d{2})(?:\s*[-–]\s*(\d{1,2}[:.]\d{2}))?/g)];
          for (const tm of times) {
            const t = normTime(tm[1]);
            if (!t) continue;
            let dur = 60;
            if (tm[2]) {
              const t2 = normTime(tm[2]);
              if (t2) {
                const mins = (+t2.slice(0,2))*60 + (+t2.slice(3)) - ((+t.slice(0,2))*60 + (+t.slice(3)));
                if (mins > 0 && mins <= 120) dur = mins;
              }
            }
            const type = /тематич|диско/i.test(line) ? 'disco' : 'mass';
            sessions.push({ d: curDate, t, a: 'karolinsky', type, dur });
          }
        }
      }
      if (sessions.length) break;
    }
    // дедупликация
    const seen = new Set();
    return sessions.filter(s => {
      const k = `${s.d}|${s.t}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  });
}

// Минск-Арена — страница рендерится JS
async function parseMinskArena() {
  return await withBrowser(async page => {
    const sessions = [];
    try {
      await page.goto('https://www.minskarena.by/page.html?slug=massovie-katania',
        { waitUntil: 'networkidle', timeout: 45000 });
    } catch (e) { return sessions; }
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    let curDate = null;
    for (const line of lines) {
      let m = line.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
      if (m) {
        const mon = MONTHS_RU[m[2].toLowerCase()];
        curDate = isoDate(guessYear(mon, +m[1]), mon, +m[1]);
        continue;
      }
      m = line.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
      if (m) { curDate = isoDate(+m[3], +m[2], +m[1]); continue; }
      if (curDate && /катан/i.test(text)) {
        const tm = line.match(/(\d{1,2}[:.]\d{2})/);
        if (tm && !/касс|работ|тел/i.test(line)) {
          const t = normTime(tm[1]);
          if (t) sessions.push({ d: curDate, t, a: 'minskarena', type: 'mass', dur: 45,
            place: /конькобеж/i.test(line) ? 'Конькобежный стадион' : undefined });
        }
      }
    }
    const seen = new Set();
    return sessions.filter(s => {
      const k = `${s.d}|${s.t}|${s.place || ''}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  });
}

/* ---------- Сборка ---------- */
(async () => {
  const all = [];
  const errors = [];
  const counts = {};
  const jobs = [
    ['chizhovka', parseChizhovka],
    ['pritytskogo', parsePritytskogo],
    ['karolinsky', parseKarolinsky],
    ['minskarena', parseMinskArena]
  ];
  for (const [name, fn] of jobs) {
    try {
      const s = await fn();
      counts[name] = s.length;
      console.log(`${name}: ${s.length} сеансов`);
      all.push(...s);
    } catch (e) {
      counts[name] = 0;
      console.error(`${name}: ошибка — ${e.message}`);
      errors.push(name);
    }
  }

  // Защита от пропажи данных: если арена сегодня дала 0 сеансов,
  // сохраняем её будущие сеансы из предыдущего выпуска schedule.json.
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev && Array.isArray(prev.sessions)) {
      for (const [name] of jobs) {
        if (!counts[name]) {
          const kept = prev.sessions.filter(s => s.a === name);
          if (kept.length) {
            console.log(`${name}: 0 новых — оставляем ${kept.length} сеансов из прошлого выпуска`);
            all.push(...kept);
          }
        }
      }
    }
  } catch (e) { /* прошлого файла нет — пропускаем */ }

  // Оставляем только даты от вчера и на 14 дней вперёд
  const now = new Date(); now.setDate(now.getDate() - 1);
  const min = now.toISOString().slice(0, 10);
  const max = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  // дедупликация (новые + сохранённые старые могут пересекаться)
  const seen = new Set();
  const filtered = all.filter(s => {
    if (s.d < min || s.d > max) return false;
    const k = `${s.a}|${s.d}|${s.t}|${s.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));

  if (!filtered.length) {
    console.error('Ни одного сеанса не собрано — schedule.json не перезаписываем.');
    process.exit(errors.length === jobs.length ? 1 : 0);
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    sessions: filtered
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Записано ${filtered.length} сеансов в ${OUT}`);
})();
