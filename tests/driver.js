// Synchronous driver for HostShell generators (used by tests): simulated time instead of real timers.
module.exports = function makeDriver(KS, cluster, shell) {
  return function run(line, opts) {
    opts = opts || {};
    let out = '', err = '';
    const io = { out: s => (out += s), err: s => (err += s) };
    const gen = shell.run(line, io, opts.stdin);
    let v = gen.next();
    const feedInteractive = (inter) => {
      for (const l of opts.interactive || []) {
        out += inter.prompt() + l + '\n';
        const r = inter.run(l, io);
        if (r && r.exit) return r.code || 0;
      }
      return 0;
    };
    while (!v.done) {
      const y = v.value || {};
      if (y.sleep != null) { cluster.advance(Math.min(y.sleep, 120000)); v = gen.next(); }
      else if (y.fastForward) { cluster.fastForward(y.fastForward); v = gen.next(); }
      else if (y.clear) v = gen.next();
      else if (y.editor) {
        const content = typeof opts.editor === 'function' ? opts.editor(y.editor.content) : opts.editor;
        let r = { close: true };
        if (content != null) { r = y.editor.save(content); if (r.message) out += r.message + '\n'; if (r.error) err += r.error + '\n'; }
        v = gen.next({ code: r.error ? 1 : 0 });
      } else if (y.interactive) { const c = feedInteractive(y.interactive); v = gen.next({ code: c }); }
      else if (y.task) {
        const limit = opts.taskLimit || 60000;
        let res = false, t = 0;
        while (t < limit) {
          cluster.advance(100); t += 100;
          res = y.task.tick(100);
          if (res) break;
        }
        if (res && res.interactive) { const c = feedInteractive(res.interactive); v = gen.next({ code: c }); }
        else v = gen.next({ code: res && res.code != null ? res.code : (res ? 0 : 130) });
      } else v = gen.next();
    }
    return { out, err, code: v.value, all: out + err };
  };
};
