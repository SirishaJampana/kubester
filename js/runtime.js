/* Kubester — container runtime: image catalog, virtual filesystem, mini POSIX shell. No DOM. */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});
  const U = KS.util;

  // =====================================================================================
  // Image catalog
  // =====================================================================================
  const NGINX_INDEX = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;
  const PI = '3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067982148086513282306647093844609550582231725359408128481117450284102701938521105559644622948954930381964428810975665933446128475648233786783165271201909145648566923460348610454326648213393607260249141273724587006606315588174881520920962829254091715364367892590360011330530548820466521384146951941511609433057270365759591953092186117381932611793105118548074462379962749567351885752724891227938183011949129833673362440656643086021394946395224737190702179860943702770539217176293176752384674818467669405132000568127145263560827785771342757789609173637178721468440901224953430146549585371050792279689258923542019956112129021960864034418159813629774771309960518707211349999998372978049951059731732816096318595024459455346908302642522308253344685035261931188171010003137838752886587533208381420617177669147303598253490428755468731159562863882353787593751957781857780532171226806613001927876611195909216420198';

  // tags: list of regex sources (anchored) that exist in the "registry"
  const IMAGES = {
    'nginx': { tags: ['latest', 'stable', 'mainline', 'alpine', 'stable-alpine', 'mainline-alpine', 'perl', '1\\.(9|1[0-9]|2[0-9])(\\.[0-9])?(-alpine|-perl|-bookworm|-alpine-slim)?'], kind: 'server', flavor: 'nginx', ports: [80], user: 0, shell: true, mem: 4, cpu: 1, size: 70, start: 400 },
    'nginxinc/nginx-unprivileged': { tags: ['latest', 'stable', 'alpine', '1\\.(2[0-9])(\\.[0-9])?(-alpine)?'], kind: 'server', flavor: 'nginx', ports: [8080], user: 101, shell: true, mem: 4, cpu: 1, size: 72, start: 400 },
    'httpd': { tags: ['latest', 'alpine', '2', '2\\.4(\\.[0-9]+)?(-alpine)?'], kind: 'server', flavor: 'httpd', ports: [80], user: 0, shell: true, mem: 8, cpu: 1, size: 60, start: 500 },
    'redis': { tags: ['latest', 'alpine', '[67](\\.[0-9])?(\\.[0-9]+)?(-alpine)?'], kind: 'server', flavor: 'redis', ports: [6379], user: 999, shell: true, mem: 3, cpu: 2, size: 45, start: 300 },
    'postgres': { tags: ['latest', 'alpine', '1[3-7](\\.[0-9]+)?(-alpine)?'], kind: 'server', flavor: 'postgres', ports: [5432], user: 999, shell: true, mem: 28, cpu: 3, size: 150, start: 2500, requireEnv: [['POSTGRES_PASSWORD', 'POSTGRES_HOST_AUTH_METHOD']] },
    'mysql': { tags: ['latest', '8', '8\\.[0-4](\\.[0-9]+)?', '9(\\.[0-9])?'], kind: 'server', flavor: 'mysql', ports: [3306], user: 999, shell: true, mem: 360, cpu: 5, size: 180, start: 5000, requireEnv: [['MYSQL_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD']] },
    'busybox': { tags: ['latest', 'stable', 'musl', 'glibc', 'uclibc', '1\\.3[0-7](\\.[0-9])?(-musl|-glibc|-uclibc)?'], kind: 'shell', defaultCmd: ['sh'], user: 0, mem: 0.3, cpu: 0, size: 2 },
    'registry.k8s.io/busybox': { tags: ['.*'], kind: 'shell', defaultCmd: ['sh'], user: 0, mem: 0.3, cpu: 0, size: 2 },
    'alpine': { tags: ['latest', 'edge', '3(\\.(1[0-9]|2[0-2]))?(\\.[0-9]+)?'], kind: 'shell', defaultCmd: ['/bin/sh'], user: 0, mem: 0.4, cpu: 0, size: 4 },
    'ubuntu': { tags: ['latest', 'jammy', 'noble', 'focal', '2[0-4]\\.04'], kind: 'shell', defaultCmd: ['bash'], user: 0, mem: 1, cpu: 0, size: 30 },
    'curlimages/curl': { tags: ['latest', '8\\.[0-9]+\\.[0-9]+'], kind: 'shell', defaultCmd: ['curl'], user: 100, mem: 1, cpu: 0, size: 10 },
    'perl': { tags: ['latest', 'slim', '5(\\.[0-9]+)*(-slim)?'], kind: 'shell', defaultCmd: ['perl', '-de0'], user: 0, mem: 5, cpu: 1, size: 330 },
    'polinux/stress': { tags: ['latest', '1\\.0\\.4'], kind: 'shell', defaultCmd: ['stress'], user: 0, mem: 1, cpu: 0, size: 4 },
    'fluent/fluent-bit': { tags: ['latest', '[1-4](\\.[0-9]+)*'], kind: 'server', flavor: 'fluentbit', ports: [2020], user: 0, shell: false, mem: 12, cpu: 2, size: 40, start: 500 },
    'prom/node-exporter': { tags: ['latest', 'v1(\\.[0-9]+)*'], kind: 'server', flavor: 'nodeexporter', ports: [9100], user: 65534, shell: false, mem: 10, cpu: 1, size: 25, start: 300 },
    'kubester/hello': { tags: ['v1', 'v2', 'v3'], kind: 'server', flavor: 'hello', ports: [8080], user: 1000, shell: false, mem: 6, cpu: 1, size: 15, start: 1500 },
    'kubester/api': { tags: ['1\\.0', 'latest'], kind: 'server', flavor: 'api', ports: [8080], user: 1000, shell: false, mem: 12, cpu: 2, size: 18, start: 1200 },
    'registry.kubester.io/team/payments': { tags: ['1\\.0', '1\\.1'], kind: 'server', flavor: 'hello', ports: [8080], user: 1000, shell: false, mem: 8, cpu: 1, size: 20, start: 800, private: true },
    // system images
    'registry.k8s.io/pause': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [], user: 65535, shell: false, mem: 0.2, cpu: 0, size: 1 },
    'registry.k8s.io/etcd': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [2379], user: 0, shell: false, mem: 45, cpu: 25, size: 60 },
    'registry.k8s.io/kube-apiserver': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [6443], user: 0, shell: false, mem: 260, cpu: 45, size: 30 },
    'registry.k8s.io/kube-scheduler': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [10259], user: 0, shell: false, mem: 20, cpu: 3, size: 20 },
    'registry.k8s.io/kube-controller-manager': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [10257], user: 0, shell: false, mem: 45, cpu: 12, size: 30 },
    'registry.k8s.io/kube-proxy': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [10256], user: 0, shell: false, mem: 14, cpu: 1, size: 30 },
    'registry.k8s.io/coredns/coredns': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [53], user: 0, shell: false, mem: 13, cpu: 2, size: 18 },
    'registry.k8s.io/metrics-server/metrics-server': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [10250], user: 0, shell: false, mem: 16, cpu: 3, size: 20 },
    'registry.k8s.io/ingress-nginx/controller': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [80, 443], user: 101, shell: true, mem: 90, cpu: 3, size: 110 },
    'kindest/kindnetd': { tags: ['.*'], kind: 'server', flavor: 'system', ports: [], user: 0, shell: false, mem: 9, cpu: 1, size: 12 },
  };

  function parseRef(ref) {
    let s = String(ref || '').trim();
    let digest = null;
    if (s.includes('@')) { [s, digest] = s.split('@'); }
    let tag = 'latest';
    const lastSlash = s.lastIndexOf('/');
    const colon = s.lastIndexOf(':');
    if (colon > lastSlash) { tag = s.slice(colon + 1); s = s.slice(0, colon); }
    let registry = 'docker.io';
    let repo = s;
    const first = s.split('/')[0];
    if (s.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
      registry = first; repo = s.slice(first.length + 1);
    }
    if (registry === 'docker.io' && repo.startsWith('library/')) repo = repo.slice(8);
    const key = registry === 'docker.io' ? repo : registry + '/' + repo;
    const full = registry === 'docker.io' ? `docker.io/${repo.includes('/') ? repo : 'library/' + repo}:${tag}` : `${registry}/${repo}:${tag}`;
    return { key, registry, repo, tag, digest, full };
  }

  function resolveImage(ref) {
    const p = parseRef(ref);
    const def = IMAGES[p.key];
    if (!ref || /[A-Z\s]/.test(String(ref).split('@')[0].split(':')[0])) return { ...p, ok: false, error: 'invalid' };
    if (!def) return { ...p, ok: false, error: 'norepo' };
    const tagOk = p.digest || def.tags.some(t => new RegExp('^(' + t + ')$').test(p.tag));
    if (!tagOk) return { ...p, ok: false, error: 'notag', def };
    return { ...p, ok: true, def };
  }
  function pullError(res, ref) {
    const r = res.full;
    if (res.error === 'invalid') return `Failed to apply default image tag "${ref}": couldn't parse image name "${ref}": invalid reference format`;
    if (res.error === 'auth') return `Failed to pull image "${ref}": failed to pull and unpack image "${r}": failed to resolve reference "${r}": failed to authorize: failed to fetch anonymous token: unexpected status: 401 Unauthorized`;
    if (res.error === 'notag') return `Failed to pull image "${ref}": rpc error: code = NotFound desc = failed to pull and unpack image "${r}": failed to resolve reference "${r}": ${r}: not found`;
    return `Failed to pull image "${ref}": failed to pull and unpack image "${r}": failed to resolve reference "${r}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
  }

  // =====================================================================================
  // Virtual filesystem
  // =====================================================================================
  function normPath(p, cwd) {
    if (!p) return cwd || '/';
    let abs = p.startsWith('/') ? p : (cwd || '/') + '/' + p;
    if (abs.startsWith('~')) abs = '/root' + abs.slice(1);
    const out = [];
    for (const part of abs.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return '/' + out.join('/');
  }

  // A store is { files: Map<rel, string>, dirs: Set<rel>, readOnly, getFiles?() }
  function makeStore(readOnly) { return { files: new Map(), dirs: new Set(['']), readOnly: !!readOnly }; }

  class Fs {
    constructor() {
      this.mounts = [];
      this.root = makeStore(false);
      ['bin', 'dev', 'etc', 'home', 'lib', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'usr/bin', 'usr/local', 'usr/share', 'var', 'var/log', 'var/run', 'var/tmp']
        .forEach(d => this.root.dirs.add(d));
    }
    mount(path, store, opts) {
      this.mounts.push({ path: normPath(path), store, readOnly: !!(opts && opts.readOnly) || store.readOnly, name: opts && opts.name });
      this.mounts.sort((a, b) => b.path.length - a.path.length);
    }
    locate(p) {
      const abs = normPath(p);
      for (const m of this.mounts) {
        if (abs === m.path || abs.startsWith(m.path === '/' ? '/' : m.path + '/')) {
          const rel = abs === m.path ? '' : abs.slice(m.path.length + 1);
          return { store: m.store, rel, mount: m, abs };
        }
      }
      return { store: this.root, rel: abs.slice(1), mount: null, abs };
    }
    files(store) { return store.getFiles ? store.getFiles() : store.files; }
    read(p) { const l = this.locate(p); const f = this.files(l.store); return f.has(l.rel) ? f.get(l.rel) : null; }
    isDir(p) {
      const l = this.locate(p);
      if (l.rel === '') return true;
      if (l.store.dirs && l.store.dirs.has(l.rel)) return true;
      for (const k of this.files(l.store).keys()) if (k.startsWith(l.rel + '/')) return true;
      // a mount point below this path also makes it a directory
      const abs = normPath(p);
      return this.mounts.some(m => m.path.startsWith(abs === '/' ? '/' : abs + '/'));
    }
    exists(p) { return this.read(p) !== null || this.isDir(p); }
    write(p, data, append) {
      const l = this.locate(p);
      if (l.mount && l.mount.readOnly) return 'Read-only file system';
      if (l.store.getFiles) return 'Read-only file system';
      const parent = l.rel.includes('/') ? l.rel.slice(0, l.rel.lastIndexOf('/')) : '';
      if (parent && !this.isDir(normPath(p) + '/..')) return 'No such file or directory';
      if (this.isDir(p) && l.rel !== '' && !l.store.files.has(l.rel)) return 'Is a directory';
      const prev = append && l.store.files.has(l.rel) ? l.store.files.get(l.rel) : '';
      l.store.files.set(l.rel, prev + data);
      return null;
    }
    mkdir(p, parents) {
      const l = this.locate(p);
      if (l.mount && l.mount.readOnly) return 'Read-only file system';
      if (l.store.getFiles) return 'Read-only file system';
      const parts = l.rel.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        if (i < parts.length && !parents && !l.store.dirs.has(sub) && !this.isDir(l.mount ? l.mount.path + '/' + sub : '/' + sub)) return 'No such file or directory';
        l.store.dirs.add(sub);
      }
      return null;
    }
    rm(p, recursive) {
      const l = this.locate(p);
      if (l.mount && l.mount.readOnly) return 'Read-only file system';
      if (l.store.getFiles) return 'Read-only file system';
      if (l.store.files.has(l.rel)) { l.store.files.delete(l.rel); return null; }
      if (this.isDir(p)) {
        if (!recursive) return 'Is a directory';
        for (const k of [...l.store.files.keys()]) if (k.startsWith(l.rel + '/')) l.store.files.delete(k);
        for (const d of [...l.store.dirs]) if (d === l.rel || d.startsWith(l.rel + '/')) l.store.dirs.delete(d);
        return null;
      }
      return 'No such file or directory';
    }
    list(p) {
      const abs = normPath(p);
      const names = new Set();
      const l = this.locate(abs);
      const prefix = l.rel === '' ? '' : l.rel + '/';
      for (const k of this.files(l.store).keys()) if (k.startsWith(prefix) && k !== l.rel) names.add(k.slice(prefix.length).split('/')[0]);
      for (const d of l.store.dirs || []) if (d.startsWith(prefix) && d !== l.rel && d !== '') names.add(d.slice(prefix.length).split('/')[0]);
      for (const m of this.mounts) {
        if (m.path !== abs && m.path.startsWith(abs === '/' ? '/' : abs + '/')) names.add(m.path.slice(abs === '/' ? 1 : abs.length + 1).split('/')[0]);
      }
      return [...names].filter(Boolean).sort();
    }
  }

  // =====================================================================================
  // Mini shell: tokenizer -> parser -> generator-based interpreter (so `sleep` can pause)
  // =====================================================================================
  class ExitSignal { constructor(code) { this.code = code; } }

  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '#' ) { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '\n') { toks.push({ op: '\n' }); i++; continue; }
      const two = src.slice(i, i + 2);
      if (src.slice(i, i + 4) === '2>&1') { toks.push({ op: '2>&1' }); i += 4; continue; }
      if (two === '2>' && (i === 0 || /\s/.test(src[i - 1]))) { toks.push({ op: '2>' }); i += 2; continue; }
      if (two === '&&' || two === '||' || two === '>>' || two === ';;') { toks.push({ op: two }); i += 2; continue; }
      if (c === ';' || c === '|' || c === '>' || c === '<' || c === '&') { toks.push({ op: c }); i++; continue; }
      // word
      const parts = [];
      let buf = '';
      const flush = q => { if (buf || q) parts.push({ text: buf, q: q || null }); buf = ''; };
      while (i < n && !/[\s;|&<>]/.test(src[i])) {
        const ch = src[i];
        if (ch === "'") {
          flush(); i++;
          let s = '';
          while (i < n && src[i] !== "'") s += src[i++];
          if (i >= n) throw new Error('unterminated quoted string');
          i++; parts.push({ text: s, q: "'" });
        } else if (ch === '"') {
          flush(); i++;
          let s = '';
          while (i < n && src[i] !== '"') {
            if (src[i] === '\\' && /["\\$`]/.test(src[i + 1])) { s += '\\' + src[i + 1]; i += 2; continue; }
            if (src[i] === '$' && src[i + 1] === '(') { const end = matchParen(src, i + 1); s += src.slice(i, end + 1); i = end + 1; continue; }
            s += src[i++];
          }
          if (i >= n) throw new Error('unterminated quoted string');
          i++; parts.push({ text: s, q: '"' });
        } else if (ch === '\\') {
          buf += '\\' + (src[i + 1] || ''); i += 2;
        } else if (ch === '$' && src[i + 1] === '(') {
          const end = matchParen(src, i + 1);
          buf += src.slice(i, end + 1); i = end + 1;
        } else { buf += ch; i++; }
      }
      flush();
      toks.push({ word: parts });
    }
    return toks;
  }
  function matchParen(s, open) {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') { depth--; if (depth === 0) return j; }
    }
    throw new Error('unterminated $(');
  }
  const wordText = w => w.map(p => p.text).join('');
  const isKw = (t, kw) => t && t.word && t.word.length === 1 && !t.word[0].q && t.word[0].text === kw;

  function parse(src) {
    const toks = tokenize(src);
    let pos = 0;
    const peek = () => toks[pos];
    const skipNl = () => { while (peek() && (peek().op === '\n' || peek().op === ';')) pos++; };
    function expectKw(kw) {
      skipNl();
      if (!isKw(peek(), kw)) throw new Error(`syntax error: expected "${kw}"`);
      pos++;
    }
    function parseList(stopKws) {
      const items = [];
      let op = null;
      for (;;) {
        skipNlIfAllowed();
        const t = peek();
        if (!t) break;
        if (stopKws && stopKws.some(k => isKw(t, k))) break;
        const node = parsePipeline();
        items.push({ node, op });
        const nt = peek();
        if (!nt) break;
        if (nt.op === ';' || nt.op === '\n' || nt.op === '&') { op = ';'; pos++; continue; }
        if (nt.op === '&&' || nt.op === '||') { op = nt.op; pos++; continue; }
        if (stopKws && stopKws.some(k => isKw(nt, k))) break;
        if (nt.op === ')') break;
        throw new Error(`syntax error near unexpected token \`${nt.op || wordText(nt.word)}'`);
      }
      return { type: 'list', items };
      function skipNlIfAllowed() { while (peek() && peek().op === '\n') pos++; }
    }
    function parsePipeline() {
      const cmds = [parseCommand()];
      while (peek() && peek().op === '|') { pos++; while (peek() && peek().op === '\n') pos++; cmds.push(parseCommand()); }
      return cmds.length === 1 ? cmds[0] : { type: 'pipe', cmds };
    }
    function parseCommand() {
      const t = peek();
      if (isKw(t, 'while') || isKw(t, 'until')) {
        pos++;
        const cond = parseList(['do']);
        expectKw('do');
        const body = parseList(['done']);
        expectKw('done');
        return withRedirs({ type: 'while', until: isKw(t, 'until'), cond, body });
      }
      if (isKw(t, 'for')) {
        pos++;
        const v = peek(); pos++;
        const words = [];
        if (isKw(peek(), 'in')) { pos++; while (peek() && peek().word) words.push(toks[pos++].word); }
        skipNl();
        expectKw('do');
        const body = parseList(['done']);
        expectKw('done');
        return { type: 'for', name: wordText(v.word), words, body };
      }
      if (isKw(t, 'if')) {
        pos++;
        const cond = parseList(['then']);
        expectKw('then');
        const then = parseList(['else', 'elif', 'fi']);
        let els = null;
        if (isKw(peek(), 'else')) { pos++; els = parseList(['fi']); }
        else if (isKw(peek(), 'elif')) { throw new Error('elif is not supported in this shell'); }
        expectKw('fi');
        return { type: 'if', cond, then, els };
      }
      const cmd = { type: 'cmd', words: [], redirs: [], assigns: [] };
      while (peek()) {
        const tk = peek();
        if (tk.word) {
          const txt = wordText(tk.word);
          if (!cmd.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(txt) && !tk.word[0].q) {
            const eq = txt.indexOf('=');
            cmd.assigns.push({ name: txt.slice(0, eq), word: [{ text: tk.word[0].text.slice(eq + 1), q: null }].concat(tk.word.slice(1)) });
            pos++; continue;
          }
          if (cmd.words.length === 0 && ['do', 'done', 'then', 'fi', 'else'].includes(txt) && !tk.word[0].q) break;
          cmd.words.push(tk.word); pos++; continue;
        }
        if (tk.op === '>' || tk.op === '>>' || tk.op === '<' || tk.op === '2>') {
          pos++;
          const target = peek();
          if (!target || !target.word) throw new Error('syntax error: missing redirect target');
          pos++;
          cmd.redirs.push({ op: tk.op, target: target.word });
          continue;
        }
        if (tk.op === '2>&1') { pos++; cmd.redirs.push({ op: '2>&1' }); continue; }
        break;
      }
      if (!cmd.words.length && !cmd.assigns.length) {
        const tk = peek();
        throw new Error(`syntax error near unexpected token \`${tk ? (tk.op || wordText(tk.word)) : 'newline'}'`);
      }
      return cmd;
    }
    function withRedirs(node) {
      const redirs = [];
      while (peek() && (peek().op === '>' || peek().op === '>>')) {
        const op = toks[pos++].op;
        redirs.push({ op, target: toks[pos++].word });
      }
      if (redirs.length) node.redirs = redirs;
      return node;
    }
    const list = parseList(null);
    if (pos < toks.length) throw new Error(`syntax error near unexpected token \`${toks[pos].op || wordText(toks[pos].word)}'`);
    return list;
  }

  // ---- interpreter ----------------------------------------------------------
  // A ShellEnv binds the interpreter to a container: fs, env, hostname, cluster networking.
  class ShellEnv {
    constructor(opts) {
      this.fs = opts.fs;
      this.vars = Object.assign({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: opts.uid === 0 ? '/root' : '/home/app', HOSTNAME: opts.hostname || 'localhost' }, opts.env || {});
      this.cwd = opts.cwd || '/';
      this.uid = opts.uid || 0;
      this.hostname = opts.hostname || 'localhost';
      this.ip = opts.ip || '127.0.0.1';
      this.net = opts.net; // { resolve(name), request({url, method, headers}), ping(host) }
      this.now = opts.now || (() => Date.now());
      this.lastStatus = 0;
      this.image = opts.image || {};
      this.proc = opts.proc || null; // for stress etc
      this.tools = opts.tools || null; // extra commands (e.g. kubectl on host)
    }
  }

  function expandWord(env, word, out) {
    // returns array of fields (unquoted parts with spaces split)
    let fields = [''];
    let quotedAny = false;
    for (const part of word) {
      if (part.q === "'") { fields[fields.length - 1] += part.text; quotedAny = true; continue; }
      const expanded = expandVars(env, part.text, out);
      if (part.q === '"') { fields[fields.length - 1] += expanded.replace(/\\(["\\$`])/g, '$1'); quotedAny = true; continue; }
      // unquoted: unescape, then split on whitespace
      const unesc = expanded.replace(/\\(.)/g, '$1');
      const pieces = unesc.split(/[ \t\n]+/);
      fields[fields.length - 1] += pieces[0];
      for (let i = 1; i < pieces.length; i++) fields.push(pieces[i]);
    }
    if (!quotedAny) fields = fields.filter(f => f !== '');
    // glob expansion for simple "*" patterns
    const result = [];
    for (const f of fields) {
      if (!quotedAny && /[*?]/.test(f) && env.fs) {
        const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) || '/' : env.cwd;
        const pat = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const names = env.fs.list(normPath(dir, env.cwd)).filter(nm => re.test(nm) && !nm.startsWith('.'));
        if (names.length) { names.forEach(nm => result.push(f.includes('/') ? (dir === '/' ? '' : dir) + '/' + nm : nm)); continue; }
      }
      result.push(f);
    }
    return result;
  }
  function expandVars(env, text, out) {
    let res = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\' && i + 1 < text.length) { res += c + text[i + 1]; i++; continue; }
      if (c !== '$') { res += c; continue; }
      const nx = text[i + 1];
      if (nx === '(') {
        const end = matchParen(text, i + 1);
        const inner = text.slice(i + 2, end);
        res += runSync(env, inner).stdout.replace(/\n+$/, '');
        i = end; continue;
      }
      if (nx === '{') {
        const end = text.indexOf('}', i);
        const name = text.slice(i + 2, end);
        const m = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(:-(.*))?$/);
        if (m) res += env.vars[m[1]] != null && env.vars[m[1]] !== '' ? env.vars[m[1]] : (m[3] || '');
        i = end; continue;
      }
      if (nx === '?') { res += String(env.lastStatus); i++; continue; }
      if (nx === '$') { res += '1'; i++; continue; }
      const m = text.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (m) { res += env.vars[m[0]] != null ? env.vars[m[0]] : ''; i += m[0].length; continue; }
      res += '$';
    }
    return res;
  }

  function* execNode(env, node, io) {
    switch (node.type) {
      case 'list': {
        let status = 0;
        for (const it of node.items) {
          if (it.op === '&&' && status !== 0) continue;
          if (it.op === '||' && status === 0) continue;
          status = yield* execNode(env, it.node, io);
          env.lastStatus = status;
        }
        return status;
      }
      case 'pipe': {
        let input = io.stdin || '';
        let status = 0;
        for (let i = 0; i < node.cmds.length; i++) {
          const last = i === node.cmds.length - 1;
          let buf = '';
          const sub = { stdin: input, out: last ? io.out : s => (buf += s), err: io.err, maxLoops: io.maxLoops };
          status = yield* execNode(env, node.cmds[i], sub);
          input = buf;
        }
        return status;
      }
      case 'while': {
        let status = 0;
        let spins = 0;
        const runBody = withRedirect(env, node.redirs, io);
        for (;;) {
          const c = yield* execNode(env, node.cond, runBody.io);
          const ok = node.until ? c !== 0 : c === 0;
          if (!ok) break;
          status = yield* execNode(env, node.body, runBody.io);
          if (++spins % 50 === 0) yield { sleep: 100 };
          if (io.maxLoops && spins >= io.maxLoops) { io.err('^C\n(Kubester stopped an endless loop in this interactive shell)\n'); break; }
        }
        runBody.done();
        return status;
      }
      case 'for': {
        let status = 0;
        const vals = [];
        node.words.forEach(w => vals.push(...expandWord(env, w)));
        for (const v of vals) { env.vars[node.name] = v; status = yield* execNode(env, node.body, io); }
        return status;
      }
      case 'if': {
        const c = yield* execNode(env, node.cond, io);
        if (c === 0) return yield* execNode(env, node.then, io);
        if (node.els) return yield* execNode(env, node.els, io);
        return 0;
      }
      case 'cmd': return yield* execCmd(env, node, io);
    }
    return 0;
  }

  function withRedirect(env, redirs, io) {
    if (!redirs || !redirs.length) return { io, done() {} };
    let outTarget = null, errTarget = null, append = false, errAppend = false, errToOut = false, stdinFile = null;
    for (const r of redirs) {
      if (r.op === '>' || r.op === '>>') { outTarget = expandWord(env, r.target).join(' '); append = r.op === '>>'; }
      else if (r.op === '2>') { errTarget = expandWord(env, r.target).join(' '); errAppend = false; }
      else if (r.op === '2>&1') errToOut = true;
      else if (r.op === '<') stdinFile = expandWord(env, r.target).join(' ');
    }
    let outBuf = '', errBuf = '';
    const sub = {
      stdin: io.stdin,
      out: outTarget ? s => (outBuf += s) : io.out,
      err: errToOut ? (outTarget ? s => (outBuf += s) : io.out) : errTarget ? s => (errBuf += s) : io.err,
      maxLoops: io.maxLoops,
    };
    let error = null;
    if (stdinFile) {
      const content = env.fs.read(normPath(stdinFile, env.cwd));
      if (content === null) error = `sh: can't open '${stdinFile}': No such file or directory\n`;
      else sub.stdin = content;
    }
    // create/truncate the file up-front like a real shell
    if (outTarget && outTarget !== '/dev/null' && !append) {
      const e = env.fs.write(normPath(outTarget, env.cwd), '', false);
      if (e) error = `sh: can't create ${outTarget}: ${e}\n`;
    }
    return {
      io: sub, error,
      done() {
        if (outTarget && outTarget !== '/dev/null' && !error) {
          const e = env.fs.write(normPath(outTarget, env.cwd), outBuf, true);
          if (e) io.err(`sh: can't create ${outTarget}: ${e}\n`);
        }
        if (errTarget && errTarget !== '/dev/null') env.fs.write(normPath(errTarget, env.cwd), errBuf, errAppend);
      },
    };
  }

  function* execCmd(env, node, io) {
    const words = [];
    for (const w of node.words) words.push(...expandWord(env, w));
    if (!words.length) {
      for (const a of node.assigns) env.vars[a.name] = expandWord(env, a.word).join(' ');
      return 0;
    }
    const savedVars = {};
    for (const a of node.assigns) { savedVars[a.name] = env.vars[a.name]; env.vars[a.name] = expandWord(env, a.word).join(' '); }
    const r = withRedirect(env, node.redirs, io);
    if (r.error) { io.err(r.error); return 1; }
    let status;
    try {
      status = yield* runBuiltin(env, words, r.io);
    } finally {
      r.done();
      for (const k of Object.keys(savedVars)) { if (savedVars[k] === undefined) delete env.vars[k]; else env.vars[k] = savedVars[k]; }
    }
    return status;
  }

  function dateStr(ms) {
    const d = new Date(ms);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = n => String(n).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  }

  // Commands available in containers with a shell (busybox flavoured)
  const SHELL_CMDS = new Set(['echo', 'printf', 'sleep', 'touch', 'rm', 'mkdir', 'cat', 'ls', 'pwd', 'cd', 'date', 'hostname', 'whoami', 'id', 'env', 'printenv', 'true', 'false', 'exit', 'test', '[', 'nslookup', 'wget', 'curl', 'grep', 'head', 'tail', 'wc', 'ps', 'sh', 'bash', 'ash', 'exec', 'stress', 'perl', 'ping', 'nc', 'uname', 'base64', 'sort', 'uniq', 'tr', 'cut', 'df', 'free', 'mount', 'export', 'unset', 'seq', 'yes', 'expr', 'top', 'kill', 'chmod', 'chown', 'cp', 'mv', 'tee', 'sed', 'awk', 'apk', 'apt', 'apt-get', 'nginx', 'redis-cli', 'psql', 'mysql', 'xargs', 'basename', 'dirname', 'which', 'ln', 'stat', 'more', 'less', 'vi', 'nano', 'clear', 'history', 'help', 'trap', 'wait', 'read', 'set', ':']);

  function* runBuiltin(env, argv, io) {
    const [cmd, ...args] = argv;
    const out = s => io.out(s);
    const err = s => io.err(s);
    const fsPath = p => normPath(p, env.cwd);
    if (env.tools && env.tools[cmd]) return yield* env.tools[cmd](args, io, env);
    if (!SHELL_CMDS.has(cmd) && !cmd.startsWith('/') && !cmd.startsWith('./')) { err(`sh: ${cmd}: not found\n`); return 127; }
    switch (cmd) {
      case ':': case 'true': return 0;
      case 'false': return 1;
      case 'exit': throw new ExitSignal(args.length ? parseInt(args[0], 10) || 0 : env.lastStatus);
      case 'echo': {
        let nl = true, esc = false;
        const a = args.slice();
        while (a[0] && /^-[neE]+$/.test(a[0])) { if (a[0].includes('n')) nl = false; if (a[0].includes('e')) esc = true; a.shift(); }
        let s = a.join(' ');
        if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        out(s + (nl ? '\n' : ''));
        return 0;
      }
      case 'printf': {
        if (!args.length) return 0;
        let fmt = args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        let k = 1;
        fmt = fmt.replace(/%[sd]/g, () => args[k++] || '');
        out(fmt);
        return 0;
      }
      case 'sleep': {
        const a = args[0];
        if (!a) { err('sleep: missing operand\n'); return 1; }
        if (a === 'infinity') { for (;;) yield { sleep: 3.6e6 }; }
        const ms = U.parseDuration(/^\d+(\.\d+)?$/.test(a) ? a + 's' : a);
        if (ms == null) { err(`sleep: invalid number '${a}'\n`); return 1; }
        if (ms > 0) yield { sleep: ms };
        return 0;
      }
      case 'touch': {
        for (const f of args.filter(x => !x.startsWith('-'))) {
          const p = fsPath(f);
          if (env.fs.read(p) === null) { const e = env.fs.write(p, '', false); if (e) { err(`touch: ${f}: ${e}\n`); return 1; } }
        }
        return 0;
      }
      case 'rm': {
        const rec = args.some(a => /^-\w*r/i.test(a));
        const force = args.some(a => /^-\w*f/.test(a));
        let st = 0;
        for (const f of args.filter(x => !x.startsWith('-'))) {
          const e = env.fs.rm(fsPath(f), rec);
          if (e && !(force && e === 'No such file or directory')) { err(`rm: can't remove '${f}': ${e}\n`); st = 1; }
        }
        return st;
      }
      case 'mkdir': {
        const p = args.includes('-p');
        for (const f of args.filter(x => !x.startsWith('-'))) {
          const e = env.fs.mkdir(fsPath(f), p);
          if (e) { err(`mkdir: can't create directory '${f}': ${e}\n`); return 1; }
        }
        return 0;
      }
      case 'cat': case 'more': case 'less': {
        const files = args.filter(x => !x.startsWith('-') || x === '-');
        if (!files.length) { out(io.stdin || ''); return 0; }
        let st = 0;
        for (const f of files) {
          if (f === '-') { out(io.stdin || ''); continue; }
          const c = env.fs.read(fsPath(f));
          if (c === null) { err(`cat: can't open '${f}': ${env.fs.isDir(fsPath(f)) ? 'Is a directory' : 'No such file or directory'}\n`); st = 1; }
          else out(c);
        }
        return st;
      }
      case 'ls': {
        const long = args.some(a => /^-\w*l/.test(a));
        const all = args.some(a => /^-\w*a/.test(a));
        const targets = args.filter(a => !a.startsWith('-'));
        if (!targets.length) targets.push('.');
        let st = 0;
        targets.forEach((t, idx) => {
          const p = fsPath(t);
          if (env.fs.read(p) !== null) { out((long ? `-rw-r--r--    1 root     root     ${String(env.fs.read(p).length).padStart(8)} Nov 18 10:00 ` : '') + t + '\n'); return; }
          if (!env.fs.isDir(p)) { err(`ls: ${t}: No such file or directory\n`); st = 1; return; }
          let names = env.fs.list(p);
          if (!all) names = names.filter(nm => !nm.startsWith('.'));
          else names = ['.', '..'].concat(names);
          if (targets.length > 1) out((idx ? '\n' : '') + t + ':\n');
          if (long) names.forEach(nm => {
            const fp = normPath(nm, p);
            const isDir = env.fs.isDir(fp) && env.fs.read(fp) === null;
            const size = isDir ? 4096 : (env.fs.read(fp) || '').length;
            out(`${isDir ? 'drwxr-xr-x' : '-rw-r--r--'}    ${isDir ? 2 : 1} root     root     ${String(size).padStart(8)} Nov 18 10:00 ${nm}\n`);
          });
          else if (names.length) out(names.join('  ') + '\n');
        });
        return st;
      }
      case 'pwd': out(env.cwd + '\n'); return 0;
      case 'cd': {
        const t = fsPath(args[0] || env.vars.HOME || '/');
        if (!env.fs.isDir(t)) { err(`sh: cd: can't cd to ${args[0]}: No such file or directory\n`); return 2; }
        env.cwd = t; return 0;
      }
      case 'date': out(dateStr(env.now()) + '\n'); return 0;
      case 'hostname': out((args[0] === '-i' ? env.ip : env.hostname) + '\n'); return 0;
      case 'whoami': {
        const names = { 0: 'root', 101: 'nginx', 999: 'redis', 1000: 'app', 65534: 'nobody', 100: 'curl_user' };
        if (names[env.uid] == null) { err(`whoami: unknown uid ${env.uid}\n`); return 1; }
        out(names[env.uid] + '\n'); return 0;
      }
      case 'id': out(`uid=${env.uid}${env.uid === 0 ? '(root)' : ''} gid=${env.vars.__GID || env.uid}${env.uid === 0 ? '(root)' : ''} groups=${env.vars.__GID || env.uid}\n`); return 0;
      case 'env': case 'printenv': {
        const keys = Object.keys(env.vars).filter(k => !k.startsWith('__'));
        if (args[0]) { if (env.vars[args[0]] == null) return 1; out(env.vars[args[0]] + '\n'); return 0; }
        keys.sort().forEach(k => out(`${k}=${env.vars[k]}\n`));
        return 0;
      }
      case 'export': {
        for (const a of args) { const i = a.indexOf('='); if (i > 0) env.vars[a.slice(0, i)] = a.slice(i + 1); }
        return 0;
      }
      case 'unset': args.forEach(a => delete env.vars[a]); return 0;
      case 'test': case '[': {
        const a = cmd === '[' ? args.slice(0, -1) : args;
        let neg = false;
        if (a[0] === '!') { neg = true; a.shift(); }
        let r = false;
        if (a.length === 2 && a[0] === '-f') r = env.fs.read(fsPath(a[1])) !== null;
        else if (a.length === 2 && a[0] === '-e') r = env.fs.exists(fsPath(a[1]));
        else if (a.length === 2 && a[0] === '-d') r = env.fs.isDir(fsPath(a[1]));
        else if (a.length === 2 && a[0] === '-z') r = a[1] === '';
        else if (a.length === 2 && a[0] === '-n') r = a[1] !== '';
        else if (a.length === 3 && (a[1] === '=' || a[1] === '==')) r = a[0] === a[2];
        else if (a.length === 3 && a[1] === '!=') r = a[0] !== a[2];
        else if (a.length === 3 && /^-(eq|ne|lt|gt|le|ge)$/.test(a[1])) {
          const x = +a[0], y = +a[2];
          r = { '-eq': x === y, '-ne': x !== y, '-lt': x < y, '-gt': x > y, '-le': x <= y, '-ge': x >= y }[a[1]];
        } else if (a.length === 1) r = a[0] !== '';
        return (neg ? !r : r) ? 0 : 1;
      }
      case 'seq': {
        const nums = args.map(Number);
        const [from, to] = nums.length === 1 ? [1, nums[0]] : [nums[0], nums[1]];
        for (let i = from; i <= to && i - from < 10000; i++) out(i + '\n');
        return 0;
      }
      case 'expr': {
        try {
          if (!args.every(a => /^(-?\d+|[-+*/%()])$/.test(a))) throw new Error('bad');
          out(String(Math.trunc(Function('"use strict";return (' + args.join(' ') + ')')())) + '\n');
          return 0;
        } catch (e) { err('expr: syntax error\n'); return 2; }
      }
      case 'uname': out(args.includes('-a') ? `Linux ${env.hostname} 6.8.0-kubester #1 SMP x86_64 GNU/Linux\n` : 'Linux\n'); return 0;
      case 'nslookup': {
        const name = args.filter(a => !a.startsWith('-'))[0];
        if (!name) { err('Usage: nslookup HOST [DNS_SERVER]\n'); return 1; }
        const r = env.net ? env.net.resolve(name) : { error: 'NXDOMAIN', fqdn: name };
        if (r.timeout) { out(`;; connection timed out; no servers could be reached\n\n`); return 1; }
        out('Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n');
        if (r.error) { out(`** server can't find ${r.fqdn || name}: NXDOMAIN\n\n`); return 1; }
        r.records.forEach(rec => out(`Name:\t${rec.name}\nAddress: ${rec.ip}\n`));
        out('\n');
        return 0;
      }
      case 'curl': case 'wget': return yield* netFetch(env, cmd, args, io);
      case 'ping': {
        const host = args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a))[0];
        if (!host) { err('BusyBox v1.36.1 multi-call binary.\n\nUsage: ping [OPTIONS] HOST\n'); return 1; }
        const r = env.net ? env.net.ping(host) : { error: 'bad address' };
        if (r.error) { err(`ping: bad address '${host}'\n`); return 1; }
        out(`PING ${host} (${r.ip}): 56 data bytes\n`);
        if (r.reply) { for (let i = 0; i < 3; i++) out(`64 bytes from ${r.ip}: seq=${i} ttl=63 time=0.${100 + i * 37} ms\n`); out(`\n--- ${host} ping statistics ---\n3 packets transmitted, 3 packets received, 0% packet loss\n`); return 0; }
        out(`\n--- ${host} ping statistics ---\n3 packets transmitted, 0 packets received, 100% packet loss\n`);
        if (r.note) err(r.note + '\n');
        return 1;
      }
      case 'nc': {
        const pos = args.filter(a => !a.startsWith('-'));
        if (pos.length < 2) { err('usage: nc [-zv] host port\n'); return 1; }
        const r = env.net.request({ url: `tcp://${pos[0]}:${pos[1]}`, tcp: true });
        if (r.ok) { err(`${pos[0]} (${r.ip}:${pos[1]}) open\n`); return 0; }
        err(`nc: ${r.error || 'connection refused'}\n`); return 1;
      }
      case 'grep': return grepCmd(args, io);
      case 'head': case 'tail': {
        if (cmd === 'tail' && args.includes('-f')) {
          const f = args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a)).pop();
          if (!f) return 0;
          let seen = 0;
          for (;;) {
            const c = env.fs.read(fsPath(f));
            if (c === null) { err(`tail: can't open '${f}': No such file or directory\n`); yield { sleep: 1000 }; continue; }
            if (c.length > seen) { out(c.slice(seen)); seen = c.length; }
            yield { sleep: 500 };
          }
        }
        return headTail(cmd, args, io, env);
      }
      case 'wc': {
        const text = io.stdin || '';
        const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        if (args.includes('-l')) out(lines + '\n');
        else if (args.includes('-c')) out(text.length + '\n');
        else if (args.includes('-w')) out((text.match(/\S+/g) || []).length + '\n');
        else out(`${String(lines).padStart(7)} ${String((text.match(/\S+/g) || []).length).padStart(7)} ${String(text.length).padStart(7)}\n`);
        return 0;
      }
      case 'sort': { const l = (io.stdin || '').split('\n').filter(Boolean); l.sort(); if (args.includes('-r')) l.reverse(); out(l.join('\n') + (l.length ? '\n' : '')); return 0; }
      case 'uniq': { const l = (io.stdin || '').split('\n').filter(Boolean).filter((x, i, a) => i === 0 || a[i - 1] !== x); out(l.join('\n') + (l.length ? '\n' : '')); return 0; }
      case 'tr': {
        const del = args[0] === '-d';
        const s = io.stdin || '';
        if (del) { const set = args[1] || ''; out([...s].filter(ch => !set.replace(/\\n/g, '\n').includes(ch)).join('')); return 0; }
        const a = (args[0] || '').replace('a-z', 'abcdefghijklmnopqrstuvwxyz').replace('A-Z', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        const b = (args[1] || '').replace('a-z', 'abcdefghijklmnopqrstuvwxyz').replace('A-Z', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        out([...s].map(ch => { const i = a.indexOf(ch); return i >= 0 ? (b[i] || b[b.length - 1] || ch) : ch; }).join(''));
        return 0;
      }
      case 'cut': {
        const d = (args.find(a => a.startsWith('-d')) || '-d\t').slice(2) || '\t';
        const fArg = args.find(a => a.startsWith('-f'));
        const fi = fArg ? parseInt(fArg.slice(2), 10) : 1;
        (io.stdin || '').split('\n').filter((l, i, arr) => l || i < arr.length - 1).forEach(l => out((l.split(d)[fi - 1] || '') + '\n'));
        return 0;
      }
      case 'tee': { const s = io.stdin || ''; args.filter(a => !a.startsWith('-')).forEach(f => env.fs.write(fsPath(f), s, args.includes('-a'))); out(s); return 0; }
      case 'base64': {
        const dec = args.includes('-d') || args.includes('--decode');
        const file = args.find(a => !a.startsWith('-'));
        const input = file ? env.fs.read(fsPath(file)) || '' : io.stdin || '';
        try { out(dec ? U.b64decode(input.trim()) : U.b64encode(input) + '\n'); return 0; } catch (e) { err('base64: invalid input\n'); return 1; }
      }
      case 'cp': case 'mv': {
        const [src, dst] = args.filter(a => !a.startsWith('-'));
        const c = env.fs.read(fsPath(src || ''));
        if (c === null) { err(`${cmd}: can't stat '${src}': No such file or directory\n`); return 1; }
        let target = fsPath(dst || '');
        if (env.fs.isDir(target) && env.fs.read(target) === null) target = normPath(src.split('/').pop(), target);
        const e = env.fs.write(target, c, false);
        if (e) { err(`${cmd}: can't create '${dst}': ${e}\n`); return 1; }
        if (cmd === 'mv') env.fs.rm(fsPath(src));
        return 0;
      }
      case 'ps': {
        out('PID   USER     TIME  COMMAND\n');
        const user = env.uid === 0 ? 'root' : String(env.uid);
        out(`    1 ${user.padEnd(8)} 0:00 ${env.vars.__PID1 || 'sh'}\n`);
        out(`   ${String(7 + Math.floor(Math.random() * 20)).padStart(2)} ${user.padEnd(8)} 0:00 ps${args.length ? ' ' + args.join(' ') : ''}\n`);
        return 0;
      }
      case 'df': out('Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               61202244  18765432  39295680  32% /\ntmpfs                    65536         0     65536   0% /dev\n'); return 0;
      case 'free': out('              total        used        free      shared  buff/cache   available\nMem:        4026532     1201844     1544320        2048     1280368     2549104\nSwap:             0           0           0\n'); return 0;
      case 'mount': {
        out('overlay on / type overlay (rw,relatime)\n');
        env.fs.mounts.forEach(m => out(`${m.name && m.name.startsWith('kube-api-access') ? 'tmpfs' : '/dev/vda1'} on ${m.path} type ${m.name && /token|secret/.test(m.name) ? 'tmpfs' : 'ext4'} (${m.readOnly ? 'ro' : 'rw'},relatime)\n`));
        return 0;
      }
      case 'sh': case 'bash': case 'ash': {
        if (args[0] === '-c') return yield* runScriptGen(env, args[1] || '', io);
        if (args[0] && !args[0].startsWith('-')) {
          const c = env.fs.read(fsPath(args[0]));
          if (c === null) { err(`sh: can't open '${args[0]}': No such file or directory\n`); return 2; }
          return yield* runScriptGen(env, c, io);
        }
        return 0; // non-interactive shell with no stdin: exits immediately
      }
      case 'exec': return args.length ? yield* runBuiltin(env, args, io) : 0;
      case 'stress': {
        const vmBytes = args[args.indexOf('--vm-bytes') + 1];
        const mi = args.includes('--vm-bytes') ? U.parseMem(String(vmBytes).replace(/^(\d+)([KMG])$/i, (m, n, u) => n + u.toUpperCase() + 'i')) : 0;
        const cpus = args.includes('--cpu') ? parseInt(args[args.indexOf('--cpu') + 1], 10) || 1 : 0;
        out(`stress: info: [1] dispatching hogs: ${cpus} cpu, 0 io, ${args.includes('--vm') ? args[args.indexOf('--vm') + 1] : 0} vm, 0 hdd\n`);
        if (env.proc) { env.proc.extraMem = mi || 0; env.proc.extraCpu = cpus * 1000; }
        for (;;) yield { sleep: 3.6e6 };
      }
      case 'perl': {
        const code = args.join(' ');
        if (/bpi\((\d+)\)/.test(code)) {
          const digits = Math.min(+code.match(/bpi\((\d+)\)/)[1], PI.length - 2);
          yield { sleep: 2500 };
          out(PI.slice(0, digits + 1) + '\n');
          return 0;
        }
        if (args.includes('-de0') || !args.length) return 0;
        if (args[0] === '-e' || args[0] === '-le' || args[0] === '-wle') {
          const m = code.match(/print\s+["']([^"']*)["']/);
          if (m) out(m[1].replace(/\\n/g, '\n') + (args[0].includes('l') ? '\n' : ''));
          return 0;
        }
        return 0;
      }
      case 'apk': case 'apt': case 'apt-get':
        err(`${cmd}: package installs are not simulated in Kubester. Tip: use an image that already contains the tool, e.g. busybox or curlimages/curl.\n`);
        return 1;
      case 'vi': case 'nano':
        err(`${cmd}: interactive editors are not available inside containers here. Use echo "text" > file instead.\n`);
        return 1;
      case 'kill': return 0;
      case 'clear': out('\x1bc'); return 0;
      case 'which': {
        let st = 0;
        args.forEach(a => { if (SHELL_CMDS.has(a)) out(`/bin/${a}\n`); else st = 1; });
        return st;
      }
      case 'basename': out(String(args[0] || '').split('/').filter(Boolean).pop() + '\n'); return 0;
      case 'dirname': { const p = String(args[0] || ''); out((p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '.') + '\n'); return 0; }
      case 'chmod': case 'chown': case 'ln': case 'stat': case 'trap': case 'wait': case 'set': return 0;
      case 'read': return 1;
      case 'yes': for (;;) { out((args[0] || 'y') + '\n'); yield { sleep: 50 }; }
      case 'top': out('Mem: 1201844K used, 2824688K free\nCPU:   1% usr   1% sys   0% nic  98% idle\n  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND\n    1     0 root     S     1.2m   0%   0   0% ' + (env.vars.__PID1 || 'sh') + '\n'); return 0;
      case 'sed': case 'awk': case 'xargs': err(`${cmd}: not supported in this simulator\n`); return 1;
      case 'history': case 'help': out('Built-in shell. Try: ls, cat, echo, env, hostname, curl, wget, nslookup, ps, exit\n'); return 0;
      case 'nginx': out('nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)\n'); return 1;
      case 'redis-cli': out(args.includes('ping') || args.join(' ').toUpperCase().includes('PING') ? 'PONG\n' : 'OK\n'); return 0;
      case 'psql': out(' ?column? \n----------\n        1\n(1 row)\n\n'); return 0;
      case 'mysql': out('+---+\n| 1 |\n+---+\n| 1 |\n+---+\n'); return 0;
      default:
        err(`sh: ${cmd}: not found\n`);
        return 127;
    }
  }

  function grepCmd(args, io) {
    let inv = false, ci = false, count = false, after = 0, before = 0, onlyMatch = false;
    const pats = [];
    const a = args.slice();
    while (a.length) {
      const x = a.shift();
      if (x === '-e') { pats.push(a.shift()); continue; }
      let m;
      if ((m = x.match(/^-([ABC])(\d*)$/))) { const n = m[2] !== '' ? +m[2] : +a.shift(); if (m[1] !== 'B') after = n; if (m[1] !== 'A') before = n; continue; }
      if (/^-[ivcEFlwnoh]+$/.test(x)) { if (x.includes('v')) inv = true; if (x.includes('i')) ci = true; if (x.includes('c')) count = true; if (x.includes('o')) onlyMatch = true; continue; }
      if (x === '--color' || x.startsWith('--color=')) continue;
      pats.push(x);
    }
    const pat = pats[0];
    if (pat == null) { io.err('Usage: grep [OPTIONS] PATTERN [FILE]...\n'); return 2; }
    let re;
    try { re = new RegExp(pat.replace(/\\\|/g, '|'), ci ? 'i' : ''); } catch (e) { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : ''); }
    const lines = (io.stdin || '').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const hitIdx = [];
    lines.forEach((l, i) => { if (re.test(l) !== inv) hitIdx.push(i); });
    if (count) { io.out(hitIdx.length + '\n'); return hitIdx.length ? 0 : 1; }
    if (onlyMatch && !inv) { hitIdx.forEach(i => { const m = lines[i].match(re); if (m) io.out(m[0] + '\n'); }); return hitIdx.length ? 0 : 1; }
    if (!after && !before) { hitIdx.forEach(i => io.out(lines[i] + '\n')); return hitIdx.length ? 0 : 1; }
    const show = new Set();
    hitIdx.forEach(i => { for (let k = Math.max(0, i - before); k <= Math.min(lines.length - 1, i + after); k++) show.add(k); });
    let prev = -2;
    [...show].sort((x, y) => x - y).forEach(k => { if (prev >= 0 && k > prev + 1) io.out('--\n'); io.out(lines[k] + '\n'); prev = k; });
    return hitIdx.length ? 0 : 1;
  }
  function headTail(cmd, args, io, env) {
    let n = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === '-n') { n = parseInt(args[++i], 10); continue; }
      if (/^-n\d+$/.test(x)) { n = parseInt(x.slice(2), 10); continue; }
      if (/^-\d+$/.test(x)) { n = parseInt(x.slice(1), 10); continue; }
      if (/^\+?\d+$/.test(x) && args[i - 1] === '-n') continue;
      files.push(x);
    }
    let text = io.stdin || '';
    if (files.length && env && env.fs) text = env.fs.read(normPath(files[0], env.cwd)) || '';
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const sel = cmd === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n));
    if (sel.length) io.out(sel.join('\n') + '\n');
    return 0;
  }

  function* netFetch(env, cmd, args, io) {
    let url = null, outFile = null, quiet = false, head = false, maxTime = null, method = 'GET';
    const headers = {};
    let stdoutMode = cmd === 'curl';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-o' || a === '--output') { outFile = args[++i]; continue; }
      if (a === '-O') { stdoutMode = false; continue; }
      if (/^-q?O-$/.test(a) || a === '-qO-' || a === '-O-') { stdoutMode = true; quiet = quiet || a.includes('q'); continue; }
      if (a === '-q') { quiet = true; continue; }
      if (/^-[sSfLkv]+$/.test(a)) { if (a.includes('s')) quiet = true; continue; }
      if (a === '-I' || a === '--head') { head = true; continue; }
      if (a === '-H' || a === '--header') { const h = args[++i] || ''; const k = h.indexOf(':'); if (k > 0) headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim(); continue; }
      if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '-T' || a === '--timeout') { maxTime = +args[++i]; continue; }
      if (a === '-X') { method = args[++i]; continue; }
      if (a === '-w' || a === '-d' || a === '--data' || a === '-u') { i++; continue; }
      if (a.startsWith('-')) continue;
      url = a;
    }
    if (!url) {
      if (cmd === 'curl') { io.err("curl: try 'curl --help' or 'curl --manual' for more information\n"); return 2; }
      io.err('BusyBox v1.36.1 multi-call binary.\n\nUsage: wget [-cqS] [-O FILE] URL\n'); return 1;
    }
    const r = env.net ? env.net.request({ url, method, headers }) : { error: 'resolve', host: url };
    const host = r.host || url;
    if (r.waitMs) yield { sleep: Math.min(r.waitMs, (maxTime || 1e9) * 1000) };
    if (!r.ok) {
      if (cmd === 'curl') {
        if (r.error === 'resolve') io.err(`curl: (6) Could not resolve host: ${host}\n`);
        else if (r.error === 'refused') io.err(`curl: (7) Failed to connect to ${host} port ${r.port} after 0 ms: Couldn't connect to server\n`);
        else if (r.error === 'timeout') io.err(`curl: (28) ${maxTime ? 'Connection timed out after ' + Math.round(maxTime * 1000) + ' milliseconds' : 'Failed to connect to ' + host + ' port ' + r.port + ' after 130000 ms: Couldn\'t connect to server'}\n`);
        else if (r.error === 'empty') io.err('curl: (52) Empty reply from server\n');
        else io.err(`curl: (7) ${r.error}\n`);
        if (r.note) io.err(r.note + '\n');
        return r.error === 'resolve' ? 6 : r.error === 'timeout' ? 28 : 7;
      }
      if (r.error === 'resolve') io.err(`wget: bad address '${host}'\n`);
      else if (r.error === 'refused') io.err(`wget: can't connect to remote host (${r.ip}): Connection refused\n`);
      else if (r.error === 'timeout') io.err('wget: download timed out\n');
      else io.err(`wget: error getting response\n`);
      if (r.note) io.err(r.note + '\n');
      return 1;
    }
    if (head) {
      io.out(`HTTP/1.1 ${r.code} ${r.code === 200 ? 'OK' : r.code === 404 ? 'Not Found' : r.code === 403 ? 'Forbidden' : r.code === 502 ? 'Bad Gateway' : r.code === 503 ? 'Service Temporarily Unavailable' : ''}\r\nServer: ${r.server || 'nginx'}\r\nContent-Type: text/html\r\nContent-Length: ${(r.body || '').length}\r\n\r\n`);
      return 0;
    }
    if (cmd === 'wget' && r.code >= 400) { io.err(`wget: server returned error: HTTP/1.1 ${r.code} ${r.code === 404 ? 'Not Found' : 'Error'}\n`); return 1; }
    if (cmd === 'wget' && !stdoutMode) {
      const fname = outFile || url.split('/').pop() || 'index.html';
      env.fs.write(normPath(fname, env.cwd), r.body || '', false);
      if (!quiet) io.err(`Connecting to ${host} (${r.ip}:${r.port})\nsaving to '${fname}'\n'${fname}' saved\n`);
      return 0;
    }
    if (outFile) { env.fs.write(normPath(outFile, env.cwd), r.body || '', false); return 0; }
    if (cmd === 'wget' && !quiet) io.err(`Connecting to ${host} (${r.ip}:${r.port})\nwriting to stdout\n`);
    io.out(r.body || '');
    if (cmd === 'wget' && !quiet) io.err('-                    100% |********************************|   ' + (r.body || '').length + '  0:00:00 ETA\nwritten to stdout\n');
    return 0;
  }

  function* runScriptGen(env, src, io) {
    let ast;
    try { ast = parse(src); } catch (e) { io.err('sh: ' + e.message + '\n'); return 2; }
    return yield* execNode(env, ast, io);
  }

  // Run a script to completion synchronously (sleeps are skipped). Used for exec, probes, $(...).
  function runSync(env, src, opts) {
    let stdout = '', stderr = '';
    const io = { stdin: (opts && opts.stdin) || '', out: s => (stdout += s), err: s => (stderr += s), maxLoops: 200 };
    const gen = runScriptGen(env, src, io);
    let code = 0;
    let steps = 0;
    try {
      for (;;) {
        const r = gen.next();
        if (r.done) { code = r.value || 0; break; }
        if (r.value && r.value.sleep >= 3.6e6) { stderr += '(Kubester: this command never finishes on its own — it would block forever, so it was stopped)\n'; code = 130; break; }
        if (++steps > 5000) { stderr += '^C\n'; code = 130; break; }
      }
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code;
      else { stderr += 'sh: ' + e.message + '\n'; code = 2; }
    }
    env.lastStatus = code;
    return { stdout, stderr, code };
  }

  // A long-running main process driven by sim time. Returns status when it finishes.
  class ScriptProc {
    constructor(env, src, onOut) {
      this.env = env;
      this.onOut = onOut;
      this.io = { stdin: '', out: s => onOut(s), err: s => onOut(s) };
      this.gen = runScriptGen(env, src, this.io);
      this.resumeAt = 0;
      this.done = false;
      this.code = null;
    }
    step(now) {
      let guard = 0;
      while (!this.done && now >= this.resumeAt && guard++ < 200) {
        let r;
        try { r = this.gen.next(); } catch (e) {
          this.done = true;
          this.code = e instanceof ExitSignal ? e.code : 2;
          if (!(e instanceof ExitSignal)) this.onOut('sh: ' + e.message + '\n');
          return;
        }
        if (r.done) { this.done = true; this.code = r.value || 0; return; }
        this.resumeAt = now + (r.value && r.value.sleep != null ? r.value.sleep : 0);
      }
    }
  }

  // shell quoting for joining argv into a script
  function shQuote(a) { return /^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'"; }

  KS.runtime = {
    IMAGES, NGINX_INDEX, PI, parseRef, resolveImage, pullError,
    Fs, makeStore, normPath, ShellEnv, parseShell: parse, runSync, ScriptProc, ExitSignal, shQuote, dateStr,
    runBuiltin, grepCmd, headTail, SHELL_CMDS, __execNode: execNode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
