// throne. dc-lite: a 120-line stand-in for the design tool's runtime so the exported pages run as plain HTML.
// Supports: {{ path }} in text, {{ path }} inside attributes, <sc-for list="{{ arr }}" as="x">…</sc-for>,
// onClick/onChange="{{ fn }}", value="{{ path }}". A page defines `class Component extends DCLogic` with
// state, componentDidMount(), renderVals(); setState() re-binds. No virtual DOM: text spans and attributes
// are patched in place, loops are re-rendered from their template.
(function () {
  const RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const HAS = /\{\{\s*[^}]+?\s*\}\}/; // non-global: safe for .test()
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const EV = { onclick: 'click', onchange: 'input', oninput: 'input' };

  function compile(root) {
    // loops first (so their inner bindings are left as text templates)
    root.querySelectorAll('sc-for').forEach((el) => {
      const t = document.createElement('template');
      t.dataset.for = (el.getAttribute('list') || '').replace(RE, '$1').trim();
      t.dataset.as = el.getAttribute('as') || 'it';
      t.innerHTML = el.innerHTML;
      el.replaceWith(t);
    });
    root.querySelectorAll('sc-if').forEach((el) => {
      const t = document.createElement('template');
      t.dataset.if = (el.getAttribute('value') || '').replace(RE, '$1').trim();
      t.innerHTML = el.innerHTML;
      el.replaceWith(t);
    });
    // attribute bindings
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const els = [];
    while (walker.nextNode()) els.push(walker.currentNode);
    for (const el of els) {
      if (el.tagName === 'TEMPLATE') continue;
      for (const a of [...el.attributes]) {
        if (a.name.startsWith('hint-')) { el.removeAttribute(a.name); continue; }
        if (!HAS.test(a.value)) continue;
        const low = a.name.toLowerCase();
        if (EV[low]) { (el.__ev = el.__ev || {})[EV[low]] = a.value.replace(RE, '$1').trim(); el.removeAttribute(a.name); }
        else { (el.__tpl = el.__tpl || {})[low] = a.value; el.removeAttribute(a.name); }
      }
    }
    // text bindings
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (tw.nextNode()) if (HAS.test(tw.currentNode.nodeValue)) texts.push(tw.currentNode);
    for (const tn of texts) {
      if (tn.parentNode.closest && tn.parentNode.closest('template')) continue;
      const frag = document.createDocumentFragment();
      let last = 0, m; const s = tn.nodeValue; RE.lastIndex = 0;
      while ((m = RE.exec(s))) {
        if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        const sp = document.createElement('span'); sp.dataset.v = m[1].trim(); frag.appendChild(sp); last = RE.lastIndex;
      }
      if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
      tn.replaceWith(frag);
    }
  }

  function bindEl(el, vals, scope) {
    const v = (p) => { const r = get(scope, p); return r === undefined ? get(vals, p) : r; };
    if (el.dataset && el.dataset.v !== undefined) { const x = v(el.dataset.v); el.textContent = x == null ? '' : String(x); }
    for (const attr in el.__tpl || {}) {
      const val = el.__tpl[attr].replace(RE, (_, p) => { const x = v(p.trim()); return x == null ? '' : String(x); });
      if (attr === 'value') { if (el.value !== val) el.value = val; }
      else el.setAttribute(attr, val);
    }
    for (const type in el.__ev || {}) {
      const fn = v(el.__ev[type]);
      if (typeof fn === 'function' && el['__h_' + type] !== fn) {
        if (el['__h_' + type]) el.removeEventListener(type, el['__h_' + type]);
        el.addEventListener(type, fn); el['__h_' + type] = fn;
      }
    }
  }

  function inGen(el) { for (let n = el.parentNode; n; n = n.parentNode) if (n.__gen) return true; return false; }
  function renderTemplates(root, vals, scope) {
    const v = (p) => { const r = get(scope, p); return r === undefined ? get(vals, p) : r; };
    const tpls = [...root.querySelectorAll('template[data-for],template[data-if]')].filter((t) => !inGen(t) || t.__fromScope === scope);
    for (const t of tpls) {
      let n = t.nextSibling; while (n && n.__gen) { const d = n; n = n.nextSibling; d.remove(); }
      const frag = document.createDocumentFragment();
      const build = (itemScope) => {
        const tt = document.createElement('template'); tt.innerHTML = t.innerHTML;
        const holder = tt.content; compile(holder);
        holder.querySelectorAll('*').forEach((el) => { el.__scoped = true; bindEl(el, vals, itemScope); });
        holder.querySelectorAll('template').forEach((x) => { x.__fromScope = itemScope; });
        renderTemplates(holder, vals, itemScope);
        [...holder.childNodes].forEach((c) => { c.__gen = true; frag.appendChild(c); });
      };
      if (t.dataset.for !== undefined) { const list = v(t.dataset.for) || []; list.forEach((item) => build(Object.assign({}, scope, { [t.dataset.as]: item }))); }
      else if (v(t.dataset.if)) build(scope);
      t.after(frag);
    }
  }
  function render(root, vals) {
    renderTemplates(root, vals, {});
    root.querySelectorAll('*').forEach((el) => { if (el.tagName !== 'TEMPLATE' && !el.__scoped && !el.closest('template')) bindEl(el, vals, {}); });
  }

  class DCLogic {
    constructor() { this.state = {}; }
    setState(patch, cb) {
      const p = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = Object.assign({}, this.state, p);
      this._flush(); if (cb) cb();
    }
    _flush() { try { render(document.body, this.renderVals()); } catch (e) { console.error('render', e); } }
    mount() { compile(document.body); this._flush(); if (this.componentDidMount) this.componentDidMount(); }
    renderVals() { return {}; }
  }
  window.DCLogic = DCLogic;
  window.addEventListener('DOMContentLoaded', () => { if (window.Component) { window.__c = new window.Component(); window.__c.mount(); } });
})();
