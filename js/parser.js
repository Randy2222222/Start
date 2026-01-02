
// js/parser.js
// Single-file Brisnet-style parser for browser (iPad-friendly) and Node.
// Drop into your project as js/parser.js and include BEFORE pdfReader.js
// Exposes: window.parsePPTable(text), window.parseHorseBlockFull(blockOrRaw), window.parseText(text)
// Also module.exports for Node.

// --- Universal wrapper so file works both in browser and Node ---
(function (global) {
  'use strict';

  // ---------- Anchor that we used before ----------
  // post position 1-20, 1-3 spaces, horse name, "(" immediate
  const HORSE_ANCHOR = /(?:^|\n)([1-9]|1[0-9]|20)\s{1,3}([A-Za-z0-9\/'’.\-\s]+?)\s*\(/g;

  // ---------- Utility helpers ----------
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function trim(s) { return (s || '').toString().trim(); }
  function firstLineAfter(key, block) {
    if (!block) return '';
    // match "Key:" on same line
    const re = new RegExp('^\\s*' + escapeRegex(key) + '\\s*:\\s*(.+)$', 'im');
    const m = block.match(re);
    if (m) return trim(m[1]);
    // or key on its own line then value next
    const re2 = new RegExp('^\\s*' + escapeRegex(key) + '\\s*$[\\r\\n]+\\s*([^\\r\\n]+)', 'im');
    const m2 = block.match(re2);
    return m2 ? trim(m2[1]) : '';
  }

  // find uppercase jockey like "CIVACI SAHIN (12 1-2-0 8%)"
  function parseJockey(block) {
    if (!block) return { name: '', record: '' };
    // prefer lines with parentheses
    const m = block.match(/^([A-Z][A-Z\.\-\'\s]{2,60})\s*\(([^)]+)\)/m);
    if (m) return { name: trim(m[1]), record: trim(m[2]) };
    // fallback: uppercase single line near top
    const lines = block.split(/\r?\n/).slice(0, 10);
    for (const line of lines) {
      const mm = line.match(/^([A-Z0-9\.\s]{3,60})\s*\(([^)]+)\)/);
      if (mm) return { name: trim(mm[1]), record: trim(mm[2]) };
    }
    // fallback: any uppercase name line near top
    for (const line of lines) {
      if (/^[A-Z][A-Z\.\s]{2,40}$/.test(trim(line))) {
        // see if next line looks like record
        const next = lines[lines.indexOf(line)+1] || '';
        if (/\d+\s+\d+\-\d+\-\d+/.test(next)) return { name: trim(line), record: trim(next) };
        return { name: trim(line), record: '' };
      }
    }
    return { name: '', record: '' };
  }

  function parseOdds(block) {
    if (!block) return '';
    const m = block.match(/\b(\d+\/\d+|\d+\.\d+|\d+)\b/);
    return m ? m[1] : '';
  }

  function parseSexAge(block) {
    if (!block) return { sex: '', age: '' };
    // patterns like "B.   f.   3" or multi-line "B.\n\nf.\n\n3"
    let m = block.match(/\b([A-Z][a-zA-Z\.]{0,6})\s+([fmcb]\.)\s+(\d{1,2})\b/i);
    if (m) return { sex: m[2].replace(/\./, ''), age: m[3] };
    m = block.match(/\n\s*([A-Z][a-zA-Z\.]{0,6})\s*\n\s*([fmcb]\.)\s*\n\s*(\d{1,2})/i);
    if (m) return { sex: m[2].replace(/\./, ''), age: m[3] };
    m = block.match(/([fmcb]\.)\s*(\d{1,2})/i);
    if (m) return { sex: m[1].replace(/\./, ''), age: m[2] };
    return { sex: '', age: '' };
  }
    
  function parsePrimePower(block) {
    if (!block) return '';
    const m = block.match(/Prime Power:\s*([0-9.]+\s*(?:\([^)]*\))?)/i);
    return m ? trim(m[1]) : '';
 }

  function parseLifeYears(block) {
    const out = { life: '', by_year: {} };
    if (!block) return out;
    const lifeM = block.match(/\bLife:\s*([^\n]+)/i);
    if (lifeM) out.life = trim(lifeM[1]);
    const yearRe = /^(\s*20\d{2})\s+(.+)$/gim;
    let mm;
    while ((mm = yearRe.exec(block)) !== null) {
      out.by_year[trim(mm[1])] = trim(mm[2]);
    }
    return out;
  }

  function parseWorkouts(block) {
    if (!block) return [];
    const lines = block.split(/\r?\n/);
    const out = [];
    const wRe = /^\s*\d{2}[A-Za-z]{3}\b.*\b(?:ft|fm|my|yl|sf|gd|ft|tr\.)\b.*$/i;
    for (const l of lines) {
      if (wRe.test(l) && l.length < 200) out.push(trim(l));
    }
    return out;
  }

  // General stat lines: hold everything with %, Sire Stats, SoldAt, StudFee, or special markers
  function parseStatLines(block) {
    if (!block) return [];
    const lines = block.split(/\r?\n/);
    const out = [];
    for (const l of lines) {
      if (/%/.test(l) || /Sire Stats|Dam'sSire|SoldAt|StudFee|Prime Power|JKYw/i.test(l) || /^ñ|^×|^—|^•/.test(trim(l))) {
        out.push(trim(l));
      }
    }
    return out;
  }

  function parseNotes(block) {
    if (!block) return [];
    const lines = block.split(/\r?\n/);
    const out = [];
    for (const l of lines) {
      const t = trim(l);
      if (!t) continue;
      if (/^[\u00F1\u00D1ñ×•\*¶\u2022\-\—\+]/.test(t) || /Beaten by weaker|Failed as favorite|Won last race|Moves up in class|Finished 3rd in last race/i.test(t)) {
        out.push(t);
      }
    }
    return out;
  }

  // Parse DATE/TRK... section into PP rows (best-effort)
  function parsePastPerformances(block) {
    if (!block) return [];
    // try to isolate DATE TRK header section
    const startIdx = block.search(/DATE TRK/i);
    const text = (startIdx >= 0) ? block.slice(startIdx) : block;
    const lines = text.split(/\r?\n/).map(l => trim(l)).filter(l => l !== '');
    const rows = [];
    // row starts are usually tokens like "09Oct25Baq" or "10Sep25KD"
    const dateTokenRe = /^(\d{2}[A-Za-z]{3}\d{2}[A-Za-z]*)\b/;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = ln.match(dateTokenRe);
      if (!m) continue;
      // gather continuation lines (up to next date token)
      let chunk = ln;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (dateTokenRe.test(lines[j])) break;
        // stop if next line looks like the top of the page again (short)
        chunk += ' ' + lines[j];
      }
      // extract common tokens
      const dateRaw = (chunk.match(/^(\d{2}[A-Za-z]{3}\d{2}[A-Za-z]*)/) || [''])[0];
      const trackMatch = chunk.match(/\b([A-Za-z]{2,4})\b/); // crude
      // distance patterns like "1ˆ" "1m" "1‰" or "6f"
      const distM = chunk.match(/\b(\d+(?:[\/\d]*|m|f|ˆ|‰))\b/);
      const times = (chunk.match(/:\d{2}(?::\d{2})?/g) || []).join(' ');
      // racetype often contains Mdn, G1, G2, OC etc
      const raceTypeM = chunk.match(/\b(Mdn|OC|A\d+k|G\d|n1x|n2x|Regret|PuckerUp|QEIICup|DGOaks|PENOaksB|SarOkInv|Regret|MsGrillo|Mdn\s+\d+k|OC\d+k)/i);
      const racetype = raceTypeM ? raceTypeM[0] : '';
      // final numeric speed/figure — attempt to find numbers 2-digit near tokens like '76'
      const speedM = chunk.match(/\b(\d{2,3})(?=\b[^$]{0,40}$)/);
      const speed = speedM ? speedM[1] : '';
      // finish position — often a single digit near the end of chunk; pick last small integer 1-20
      const finM = chunk.match(/\b([1-9]|1[0-9]|20)\b(?!.*\b[1-9]|1[0-9]|20\b)/);
      const fin = finM ? finM[1] : '';
      // jockey token — look for uppercase name followed by accented coding or odd characters
      const jockeyM = chunk.match(/([A-Z][A-Za-z\.\-]{2,30}(?:\s[A-Z][A-Za-z\.\-]{2,30})?)(?=\s*[A-Z¨\u00A8\(\[\*]|$)/);
      const jockey = jockeyM ? jockeyM[1] : '';
      // odds — decimals or fractional
      const oddsM = chunk.match(/(\*?\d+\.\d+|\d+\/\d+|\d{1,2}\.\d{2}|\*\d+)/);
      const odds = oddsM ? oddsM[0] : '';
      // comment — last part after keywords "Comment" or typical commentary words
      const commentM = chunk.match(/(Ins[^.;]*|Stmbld[^.;]*|Stumble[^.;]*|brush[^.;]*|drift[^.;]*|bumped[^.;]*|bpd[^.;]*|split[^.;]*|rallied[^.;]*|tracked[^.;]*|stumble[^.;]*|fought[^.;]*)/i);
      const comment = commentM ? trim(commentM[0]) : '';

      rows.push({
        raw: chunk,
        date: dateRaw,
        track: jockeyM ? (chunk.split(/\s+/)[0].replace(dateRaw, '').slice(0, 6).trim()) : '',
        dist: distM ? distM[1] : '',
        times: times,
        racetype: racetype,
        speed: speed,
        fin: fin,
        jockey: jockey,
        odds: odds,
        comment: comment
      });
    }
    return rows;
  }

  // Split into horse blocks using the anchor; preserve raw text
  function parsePPTable(text) {
    // Add Header with cuts
        // ---------- CLEAN TOP-OF-PAGE BLOCK BEFORE HORSE PARSING ----------
     //  if (!text) return [];

    // Normalize CRLF → LF
  // let t = text.replace(/\r/g, '\n');

    // 1) Strip COPYRIGHT + any invisible pre-header junk
   // t = t.replace(/^[\s\S]{0,300}(?=Aqueduct)/i, '');

    // 2) Extract real header (one full line) 
   // let headerLine = '';
   // const headerMatch = t.match(/^(Aqueduct[^\n]+)/i);
   // if (headerMatch) headerLine = headerMatch[1].trim();

    // 3) Remove the 4 TOP BLOCKS (Speed Last Race / Prime Power / Class Rating / Best Speed)
  //  t = t.replace(/#\s+Speed[\s\S]+?National Archive\s+85/, '');

    // 4) Remove PARS block
 //  t = t.replace(/E1[\s\S]+?88/, '');

    // 5) Extract FOOTER paragraph (the big description block)
   // let footer = '';
    // const footMatch = t.match(/(\d{1,2}\…\s+Mile[\s\S]+?Post Time:[^\n]+)/i);
    // if (footMatch) footer = footMatch[1].trim();

    // 6) Save results so pdfReader can output them
   // window._brisHeader = headerLine;
   // window._brisFooter = footer;

    // Replace original text with stripped version
    //text = t;
    // Header cuts ends
    if (!text) return [];
    const t = text.replace(/\r/g, '\n');
    const anchors = [];
    let m;
    while ((m = HORSE_ANCHOR.exec(t)) !== null) {
      anchors.push({ idx: m.index, post: Number(m[1]), name: trim(m[2]) });
    }
    if (!anchors.length) {
      // fallback: try lines like "1\n\nName" (multiline headers)
      const fallbackRe = /(?:^|\n)\s*([1-9]|1[0-9]|20)\s*\n+\s*([A-Za-z0-9\/'’.\-\s]+)\s*\n/ig;
      let fm;
      const fallback = [];
      while ((fm = fallbackRe.exec(t)) !== null) {
        fallback.push({ idx: fm.index, post: Number(fm[1]), name: trim(fm[2]) });
      }
      if (fallback.length) {
        const blocks = [];
        for (let i = 0; i < fallback.length; i++) {
          const start = fallback[i].idx;
          const end = (i + 1 < fallback.length) ? fallback[i + 1].idx : t.length;
          blocks.push({ post: fallback[i].post, name: fallback[i].name, raw: trim(t.slice(start, end)) });
        }
        return blocks;
      }
      // no anchors: return the whole text as a single block
      return [{ post: null, name: null, raw: t }];
    }
    const blocks = [];
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i].idx;
      const end = (i + 1 < anchors.length) ? anchors[i + 1].idx : t.length;
      const slice = t.slice(start, end);
      blocks.push({ post: anchors[i].post, name: anchors[i].name, raw: trim(slice) });
    }
    return blocks;
  }

  // Parse a single horse block object OR accept a raw string
  function parseHorseBlock(blockOrRaw) {
    // Accept either: blockObj {post,name,raw} OR raw string
    let blockObj = null;
    if (!blockOrRaw) return null;
    if (typeof blockOrRaw === 'string') {
      blockObj = { post: null, name: null, raw: blockOrRaw };
    } else {
      blockObj = Object.assign({ post: null, name: null, raw: '' }, blockOrRaw);
    }
    const raw = blockObj.raw || '';

    // header
    const headerLine = raw.split(/\r?\n/).slice(0, 3).join(' ');
    const headerMatch = headerLine.match(/^\s*(\d+)\s+(.+?)\s*(\([^\)]*\))?/);
    const post = blockObj.post || (headerMatch ? Number(headerMatch[1]) : null);
    const name = blockObj.name || (headerMatch ? trim(headerMatch[2]) : '');
    const tag = headerMatch && headerMatch[3] ? headerMatch[3] : '';

    // basic items
    const owner = firstLineAfter('Own', raw) || firstLineAfter('Owner', raw);
    const silks = (() => {
      // try line(s) immediately after owner or on same header zone
      const top = raw.split(/\r?\n/).slice(0, 8).map(l => trim(l)).filter(Boolean);
      // the silks line typically follows owner/odds; pick first comma-containing long line
      for (const L of top) {
        if (/,/.test(L) && L.length > 8 && !/^CIVACI|^VELAZQUEZ|^[A-Z]{2,20}\s*\(/.test(L)) return L;
      }
      // or pick the first long line after the owner token
      if (owner) {
        const parts = raw.split(owner);
        if (parts[1]) {
          const cand = parts[1].split(/\r?\n/).map(l => trim(l)).filter(Boolean)[0] || '';
          if (cand && cand.length > 6) return cand;
        }
      }
      return '';
    })();

    const odds = parseOdds(headerLine + '\n' + raw.split(/\r?\n/).slice(0, 4).join(' '));
    const jockey = parseJockey(raw);
    const { sex, age } = parseSexAge(raw);
    const sire = firstLineAfter('Sire', raw);
    const dam = firstLineAfter('Dam', raw);
    const breeder = firstLineAfter('Brdr', raw) || firstLineAfter('Brdr:', raw);
    const trainer = firstLineAfter('Trnr', raw) || firstLineAfter('Trnr:', raw);
    const prime_power = parsePrimePower(raw); 
    const lifeYears = parseLifeYears(raw);
    const workouts = parseWorkouts(raw);
    const stat_lines = parseStatLines(raw);
    const notes = parseNotes(raw);
    const pastPerformances = parsePastPerformances(raw);

    // surfaces: gather lines with Fst/Off/Trf/AQU etc and their following data
    const surfaces = {};
    const surfaceRe = /^\s*(AQU|Fst|Off|Dis|Trf|AW|ft|fm|yl)\b.*$/gim;
    let sm;
    while ((sm = surfaceRe.exec(raw)) !== null) {
      const key = trim(sm[1]);
      // capture that whole line and the next few tokens after
      const line = raw.slice(sm.index, Math.min(raw.length, sm.index + 160)).split(/\r?\n/)[0];
      if (!surfaces[key]) surfaces[key] = [];
      surfaces[key].push(trim(line));
    }

    return {
      post, name, tag, raw,
      owner: owner || '',
      silks: silks || '',
      odds: odds || '',
      jockey,
      sex, age,
      sire: sire || '',
      dam: dam || '',
      breeder: breeder || '',
      trainer: trainer || '',
      prime_power: prime_power || '', 
      life: lifeYears.life || '',
      by_year: lifeYears.by_year || {},
      surfaces,
      stat_lines,
      workouts,
      notes,
      pastPerformances
    };
  }

  // parse full text returning all horses parsed (convenience)
  function parseText(text) {
    const blocks = parsePPTable(text);
    const horses = blocks.map(b => {
      const parsed = parseHorseBlock(b);
      return parsed;
    });
    return horses;
  }

  // ---------- Exports ----------
  // Browser exports
  try {
    if (typeof window !== 'undefined') {
      window.parsePPTable = parsePPTable;
      window.parseHorseBlockFull = function (blockOrRaw) {
        // accept either block {post,name,raw} or raw string
        if (!blockOrRaw) return null;
        if (typeof blockOrRaw === 'string') return parseHorseBlock({ post: null, name: null, raw: blockOrRaw });
        return parseHorseBlock(blockOrRaw);
      };
      window.parseText = parseText;
    }
  } catch (e) { /* ignore */ }

  // Node exports (so you can `node parser.js /path/file`)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parsePPTable, parseHorseBlock: parseHorseBlock, parseText };
    // Optional CLI: node js/parser.js /path/to/brisnet_raw.txt
    if (require && require.main === module) {
      const fs = require('fs');
      const f = process.argv[2] || '/mnt/data/brisnet_raw.txt'; // your uploaded path if using Node
      if (!fs.existsSync(f)) {
        console.error('File not found:', f);
        process.exit(2);
      }
      const raw = fs.readFileSync(f, 'utf8');
      const out = parseText(raw);
      console.log(JSON.stringify(out, null, 2));
    }
  }

})(typeof window !== 'undefined' ? window : global);
