// Context registry + subsystem lifecycle.
//
// The registry is the ONLY way one subsystem reaches another. Subsystems never
// import each other - they call ctx.get('render') at runtime. That is what
// makes the build resumable and parallelizable: a later session can rewrite an
// entire directory without reading any other.
//
// Registration order is resolved topologically from `static deps`. A cycle is a
// hard error at boot, not a warning.

export class Context {
  constructor({ bus, rng, config, quality }) {
    this.bus = bus;
    this.rng = rng;
    this.config = config;
    this.quality = quality;
    this._systems = Object.create(null);
    this._order = [];            // resolved init order
    this._disposed = false;
  }

  get(id) {
    const s = this._systems[id];
    if (!s) {
      throw new Error(
        'Context: no subsystem "' + id + '". Registered: ' +
        (this._order.join(', ') || '(none)') +
        '. A subsystem must be registered before another can get() it.'
      );
    }
    return s;
  }

  has(id) { return !!this._systems[id]; }
  get order() { return this._order.slice(); }
}

function resolveOrder(classes) {
  const byId = Object.create(null);
  for (const C of classes) {
    if (!C.id) throw new Error('Registry: subsystem class is missing `static id`');
    if (byId[C.id]) throw new Error('Registry: duplicate subsystem id "' + C.id + '"');
    byId[C.id] = C;
  }

  const order = [];
  const mark = Object.create(null);   // 1 = visiting, 2 = done
  const stack = [];

  const visit = (id) => {
    if (mark[id] === 2) return;
    if (mark[id] === 1) {
      throw new Error(
        'Registry: dependency cycle: ' + stack.concat(id).join(' -> ') +
        '. Break it by moving the shared piece into src/core/.'
      );
    }
    const C = byId[id];
    if (!C) {
      throw new Error(
        'Registry: unknown dependency "' + id + '" required by ' +
        (stack[stack.length - 1] || '(root)') + '. Registered: ' + Object.keys(byId).join(', ')
      );
    }
    mark[id] = 1; stack.push(id);
    const deps = C.deps || [];
    for (let i = 0; i < deps.length; i++) visit(deps[i]);
    stack.pop(); mark[id] = 2;
    order.push(C);
  };

  // Deterministic: iterate the declared array order, not object key order.
  for (const C of classes) visit(C.id);
  return order;
}

export class Registry {
  constructor(ctx) {
    this.ctx = ctx;
    this.systems = [];           // in resolved init order
    // Preallocated hook lists. Built once at boot so the per-frame loop walks
    // flat arrays and never filters or allocates.
    this.fixed = [];
    this.updates = [];
    this.lates = [];
  }

  register(classes) {
    const ordered = resolveOrder(classes);
    for (const C of ordered) {
      const inst = new C();
      inst.id = C.id;
      this.ctx._systems[C.id] = inst;
      this.ctx._order.push(C.id);
      this.systems.push(inst);
    }
    // init AFTER every instance is in the registry, so a dependency lookup in
    // init() always resolves regardless of order.
    for (const s of this.systems) {
      if (typeof s.init === 'function') s.init(this.ctx);
      if (typeof s.fixedUpdate === 'function') this.fixed.push(s);
      if (typeof s.update === 'function') this.updates.push(s);
      if (typeof s.lateUpdate === 'function') this.lates.push(s);
    }
    return this;
  }

  fixedUpdate(dt) {
    const a = this.fixed;
    for (let i = 0; i < a.length; i++) a[i].fixedUpdate(dt);
  }

  update(dt, alpha) {
    const a = this.updates;
    for (let i = 0; i < a.length; i++) a[i].update(dt, alpha);
  }

  lateUpdate(dt) {
    const a = this.lates;
    for (let i = 0; i < a.length; i++) a[i].lateUpdate(dt);
  }

  // Reverse registration order: a subsystem is torn down before anything it
  // depends on disappears underneath it.
  dispose() {
    for (let i = this.systems.length - 1; i >= 0; i--) {
      const s = this.systems[i];
      if (typeof s.dispose === 'function') s.dispose();
    }
    this.systems.length = 0;
    this.fixed.length = 0;
    this.updates.length = 0;
    this.lates.length = 0;
    this.ctx._disposed = true;
  }
}
