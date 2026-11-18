/* Kubester — shared helpers (no DOM). */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});

  // ---------- deterministic randomness (tests replay identically) ----------
  function makeRng(seed) {
    let a = seed >>> 0 || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Kubernetes' "safe" alphabet for generated names (no vowels, no confusable chars)
  const ALNUM = 'bcdfghjklmnpqrstvwxz2456789';
  function randSuffix(rng, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += ALNUM[Math.floor(rng() * ALNUM.length)];
    return s;
  }
  function hashString(str) {
    // FNV-1a 32 then encoded with the safe alphabet -> stable pod-template-hash
    const fnv = s => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return h;
    };
    let out = '';
    for (let i = 0; i < 10; i++) out += ALNUM[fnv(i + ':' + str) % ALNUM.length];
    return out;
  }
  function uuid(rng) {
    const hex = () => Math.floor(rng() * 16).toString(16);
    let s = '';
    for (const c of 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx') {
      s += c === 'x' ? hex() : c === 'y' ? ((Math.floor(rng() * 4) + 8).toString(16)) : c;
    }
    return s;
  }

  // ---------- time ----------
  function humanDuration(ms) {
    if (ms < -1000) return '<invalid>';
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 120) return sec + 's';
    const min = Math.floor(sec / 60);
    if (min < 10) { const s = sec % 60; return s === 0 ? min + 'm' : min + 'm' + s + 's'; }
    if (min < 180) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 8) { const m = min % 60; return m === 0 ? hr + 'h' : hr + 'h' + m + 'm'; }
    if (hr < 48) return hr + 'h';
    const d = Math.floor(hr / 24);
    if (hr < 24 * 8) { const h = hr % 24; return h === 0 ? d + 'd' : d + 'd' + h + 'h'; }
    if (d < 365 * 2) return d + 'd';
    return Math.floor(d / 365) + 'y';
  }
  function parseDuration(s) {
    if (s == null) return null;
    const str = String(s).trim();
    if (/^\d+$/.test(str)) return +str * 1000;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
    let m, total = 0, matched = '';
    while ((m = re.exec(str))) {
      matched += m[0];
      const v = parseFloat(m[1]);
      total += m[2] === 'ms' ? v : m[2] === 's' ? v * 1e3 : m[2] === 'm' ? v * 6e4 : m[2] === 'h' ? v * 3.6e6 : v * 8.64e7;
    }
    return matched === str ? total : null;
  }
  function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  // ---------- quantities ----------
  // CPU -> millicores
  function parseCpu(v) {
    if (v == null || v === '') return 0;
    const s = String(v).trim();
    if (/^\d+(\.\d+)?m$/.test(s)) return parseFloat(s);
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 1000;
    return NaN;
  }
  // memory -> MiB (float)
  const MEM_UNITS = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1e3 / 1048576, k: 1e3 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 };
  function parseMem(v) {
    if (v == null || v === '') return 0;
    const s = String(v).trim();
    const m = s.match(/^(\d+(?:\.\d+)?)([KMGT]i?|k)?$/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    if (!m[2]) return n / 1048576; // bytes
    return n * MEM_UNITS[m[2]];
  }
  function fmtCpu(m) { return m % 1000 === 0 ? String(m / 1000) : Math.round(m) + 'm'; }
  function fmtMem(mi) {
    if (mi >= 1024 && Math.abs(mi / 1024 - Math.round(mi / 1024)) < 1e-9) return Math.round(mi / 1024) + 'Gi';
    if (mi >= 1) return Math.round(mi) + 'Mi';
    return Math.round(mi * 1024) + 'Ki';
  }
  function parseStorage(v) { return parseMem(v); } // MiB
  function fmtStorage(mi) { return fmtMem(mi); }

  // ---------- objects ----------
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function deepEqual(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
  function sortKeys(o) {
    if (Array.isArray(o)) return o.map(sortKeys);
    if (isObj(o)) { const r = {}; Object.keys(o).sort().forEach(k => (r[k] = sortKeys(o[k]))); return r; }
    return o;
  }
  // RFC 7386 JSON merge patch
  function mergePatch(target, patch) {
    if (!isObj(patch)) return clone(patch);
    const out = isObj(target) ? clone(target) : {};
    for (const k of Object.keys(patch)) {
      if (patch[k] === null) delete out[k];
      else out[k] = mergePatch(out[k], patch[k]);
    }
    return out;
  }
  // RFC 6902 subset: add / remove / replace
  function jsonPatch(target, ops) {
    const doc = clone(target);
    for (const op of ops) {
      const parts = String(op.path || '').split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!parts.length) throw new Error('invalid path');
      let parent = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = Array.isArray(parent) ? +parts[i] : parts[i];
        if (parent[key] === undefined) {
          if (op.op === 'add') parent[key] = {};
          else throw new Error(`doc is missing path: "${op.path}": missing value`);
        }
        parent = parent[key];
      }
      const last = parts[parts.length - 1];
      if (op.op === 'remove') {
        if (Array.isArray(parent)) { if (+last >= parent.length) throw new Error(`doc is missing path: "${op.path}"`); parent.splice(+last, 1); }
        else { if (!(last in parent)) throw new Error(`doc is missing path: "${op.path}": missing value`); delete parent[last]; }
      } else if (op.op === 'add') {
        if (Array.isArray(parent)) { if (last === '-') parent.push(op.value); else parent.splice(+last, 0, op.value); }
        else parent[last] = op.value;
      } else if (op.op === 'replace') {
        if (Array.isArray(parent)) parent[+last] = op.value;
        else { if (!(last in parent)) throw new Error(`doc is missing path: "${op.path}": missing value`); parent[last] = op.value; }
      } else throw new Error('Unsupported json patch op: ' + op.op);
    }
    return doc;
  }
  function getPath(obj, path) {
    // ".spec.containers[0].image" or "spec.containers.0.image"
    const parts = String(path).replace(/^\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }

  // ---------- labels ----------
  function matchSelector(selector, labels) {
    labels = labels || {};
    if (!selector) return false;
    const ml = selector.matchLabels || {};
    for (const k of Object.keys(ml)) if (labels[k] !== String(ml[k])) return false;
    for (const e of selector.matchExpressions || []) {
      const has = Object.prototype.hasOwnProperty.call(labels, e.key);
      const vals = (e.values || []).map(String);
      switch (e.operator) {
        case 'In': if (!has || !vals.includes(labels[e.key])) return false; break;
        case 'NotIn': if (has && vals.includes(labels[e.key])) return false; break;
        case 'Exists': if (!has) return false; break;
        case 'DoesNotExist': if (has) return false; break;
        case 'Gt': if (!has || !(parseInt(labels[e.key], 10) > parseInt(vals[0], 10))) return false; break;
        case 'Lt': if (!has || !(parseInt(labels[e.key], 10) < parseInt(vals[0], 10))) return false; break;
        default: return false;
      }
    }
    return true;
  }
  function matchMapSelector(sel, labels) { // Service-style {k: v}
    if (!sel || !Object.keys(sel).length) return false;
    labels = labels || {};
    return Object.keys(sel).every(k => labels[k] === String(sel[k]));
  }
  // "app=web,tier!=db,env in (a,b),!legacy,canary"
  function parseSelectorString(s) {
    const out = { matchLabels: {}, matchExpressions: [] };
    if (!s) return out;
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) parts.push(cur);
    for (let p of parts) {
      p = p.trim();
      let m;
      if ((m = p.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/i))) {
        out.matchExpressions.push({ key: m[1], operator: m[2].toLowerCase() === 'in' ? 'In' : 'NotIn', values: m[3].split(',').map(x => x.trim()).filter(Boolean) });
      } else if ((m = p.match(/^([\w./-]+)\s*!=\s*([\w.-]*)$/))) {
        out.matchExpressions.push({ key: m[1], operator: 'NotIn', values: [m[2]] });
      } else if ((m = p.match(/^([\w./-]+)\s*==?\s*([\w.-]*)$/))) {
        out.matchLabels[m[1]] = m[2];
      } else if ((m = p.match(/^!([\w./-]+)$/))) {
        out.matchExpressions.push({ key: m[1], operator: 'DoesNotExist' });
      } else if ((m = p.match(/^([\w./-]+)$/))) {
        out.matchExpressions.push({ key: m[1], operator: 'Exists' });
      } else {
        throw new Error(`unable to parse requirement: "${p}"`);
      }
    }
    return out;
  }
  function selectorToString(sel) {
    if (!sel) return '<none>';
    if (!sel.matchLabels && !sel.matchExpressions) return Object.keys(sel).map(k => `${k}=${sel[k]}`).join(',') || '<none>';
    const parts = Object.keys(sel.matchLabels || {}).map(k => `${k}=${sel.matchLabels[k]}`);
    for (const e of sel.matchExpressions || []) {
      if (e.operator === 'In') parts.push(`${e.key} in (${e.values.join(',')})`);
      else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${e.values.join(',')})`);
      else if (e.operator === 'Exists') parts.push(e.key);
      else if (e.operator === 'DoesNotExist') parts.push('!' + e.key);
    }
    return parts.join(',') || '<none>';
  }
  function labelsToString(l) {
    const keys = Object.keys(l || {});
    return keys.length ? keys.map(k => `${k}=${l[k]}`).join(',') : '<none>';
  }

  // ---------- validation ----------
  const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
  function validName(n) { return typeof n === 'string' && n.length > 0 && n.length <= 253 && DNS1123.test(n); }
  const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
  function validLabelValue(v) { return typeof v === 'string' && v.length <= 63 && LABEL_VALUE.test(v); }

  // ---------- base64 (UTF-8 safe, works in browser + node) ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    bytes.forEach(b => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- kubectl-style table ----------
  function table(headers, rows) {
    const all = [headers].concat(rows).map(r => r.map(c => (c == null ? '<none>' : String(c))));
    const widths = headers.map((_, i) => Math.max.apply(null, all.map(r => (r[i] || '').length)));
    return all.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3))).join('').replace(/\s+$/, ''));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  KS.util = {
    makeRng, randSuffix, hashString, uuid, humanDuration, parseDuration, iso,
    parseCpu, parseMem, fmtCpu, fmtMem, parseStorage, fmtStorage,
    clone, isObj, deepEqual, mergePatch, jsonPatch, getPath,
    matchSelector, matchMapSelector, parseSelectorString, selectorToString, labelsToString,
    validName, validLabelValue, b64encode, b64decode, table, escapeHtml, plural, ALNUM,
  };
})(typeof window !== 'undefined' ? window : globalThis);
