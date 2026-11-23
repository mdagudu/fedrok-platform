// Sprout: Fedrok's AI project guide, built on Claude.
//
// Sprout lives on every project page. Right after someone creates a project it
// opens by itself and interviews the owner, writing each answer to the
// project record on-chain. Afterwards the owner can talk to Sprout at any time
// to change the project, until it is locked & submitted.
//
// How the lock holds: Sprout has no lock or retire tool, only the owner can
// press those buttons. Its one write tool, update_project, signs an ordinary
// project_update transaction with the owner's wallet. The ProjectRegistry
// contract rejects that transaction for any project that is locked or
// retired, so even a confused or manipulated assistant cannot change a locked
// project. On a locked project the tool is not offered at all, and Sprout only
// answers questions.
//
// Connection to Claude (claude-opus-5-5 by default), in this order:
//   1. the node's proxy (POST /api/assistant/v1/messages), when the node was
//      started with ANTHROPIC_API_KEY: visitors need no key;
//   2. an Anthropic API key the visitor enters, kept only in this browser and
//      sent straight to api.anthropic.com;
//   3. otherwise "guided mode": a scripted interview without AI, so the
//      project page still works.
// fedrok.com: Sprout may read pages on fedrok.com with Claude's web fetch
// tool (limited to that domain) to answer questions about Fedrok.
import Anthropic from '@anthropic-ai/sdk';
import { DETAIL_FIELDS, CORE_FIELDS, missingFields, completeness } from '/core/project-fields.js';

export const AGENT_NAME = 'Sprout';
const MODEL = 'claude-opus-5-5';
const FEDROK_SITE = 'https://fedrok.com';
const KEY_STORE = 'fedrok.sprout.apiKey';
const MAX_STEPS = 8;
const ALL_FIELDS = CORE_FIELDS.concat(DETAIL_FIELDS);
const label = (k) => ALL_FIELDS.find((f) => f.key === k)?.label || k;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

function systemPrompt() {
  const fields = ALL_FIELDS.map((f) => `- ${f.key}: ${f.label}${f.hint ? `. ${f.hint}` : ''}${f.list ? ' (a list of short items)' : ''}`).join('\n');
  return `You are ${AGENT_NAME}, the project guide of the Fedrok registry. Fedrok is a simple blockchain platform that records environmental data: people register environmental projects they run, or propose projects they would like to see, and every detail is kept on a public digital ledger. Fedrok's website is ${FEDROK_SITE}; you may read pages on it with the web_fetch tool when someone asks about Fedrok itself.

You are talking with someone on the page of one project. Your job is to build a complete, accurate and well written project page with them.

How the project page works:
- Each project has core fields (name, summary, location, country) and structured details. The fields are:
${fields}
- While a project is a draft, its owner can change it. You change it with the update_project tool, which writes a transaction to the Fedrok ledger signed by the owner's wallet. Every change becomes a new revision in the public history.
- When the record is complete, the owner can press "Lock & submit". After that the project is permanently read-only for everyone, including you: the registry contract rejects every change. The only action left is retiring the project. You cannot lock or retire a project yourself; those buttons are for the owner only. You may remind them where the buttons are.

Interviewing:
- Use get_project first to see what is already filled in.
- Ask about one topic at a time (at most two short questions per message), starting with what matters most: what the project does and why, where exactly, who is involved and benefits, scale and timeline, expected impact, how progress will be monitored, then permissions, partners, funding, risks and the rest.
- As soon as the owner gives you information, save it with update_project, then briefly say what you saved and ask the next question. Do not wait until the end to save.
- Write in clear, plain, factual language. You may tidy up wording, but never invent facts, numbers, partners, certifications or dates. If something is unknown, leave the field empty rather than guessing.
- Keep personal data off the ledger: no private phone numbers, home addresses or ID numbers. Everything you save is public and permanent once locked.
- When the important fields are filled, suggest the owner reviews the page and, when happy, presses Lock & submit.
- If the person asks for a change, make exactly that change with update_project and confirm it.
- If the project is locked or retired, or the person is not the owner, you can only answer questions about it. Say so plainly if asked to change it.

Style: warm, encouraging and brief. Plain text with short paragraphs; no headings or tables.`;
}

const tools = (canEdit) => [
  {
    name: 'get_project',
    description: 'Read the current on-chain record of this project: status, core fields, details, revision and which fields are still empty.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  ...(canEdit ? [{
    name: 'update_project',
    description: 'Save changes to this draft project on the Fedrok ledger (one transaction signed by the owner). Only include the fields that change. To clear a detail field, list it in remove_fields. Fails if the project is locked or retired.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name, 3-120 characters.' },
        summary: { type: 'string', description: 'Two or three sentence summary, max 1000 characters.' },
        location: { type: 'string', description: 'Region, district or site name.' },
        country: { type: 'string' },
        details: {
          type: 'object',
          description: 'Detail fields to set. Keys: ' + DETAIL_FIELDS.map((f) => f.key).join(', ') + '. List fields (' + DETAIL_FIELDS.filter((f) => f.list).map((f) => f.key).join(', ') + ') take an array of strings; the others take a string.',
          properties: Object.fromEntries(DETAIL_FIELDS.map((f) => [f.key, f.list ? { type: 'array', items: { type: 'string' }, description: f.label } : { type: 'string', description: f.label }])),
          additionalProperties: false,
        },
        remove_fields: { type: 'array', items: { type: 'string', enum: DETAIL_FIELDS.map((f) => f.key) }, description: 'Detail fields to clear.' },
      },
      additionalProperties: false,
    },
  }] : []),
];
const webFetch = { type: 'web_fetch_20260209', name: 'web_fetch', allowed_domains: ['fedrok.com', 'www.fedrok.com'], max_uses: 3 };

export function createSprout({ api, sendTx, render, toast, esc, status }) {
  const chats = new Map(); // projectId -> { messages: Anthropic messages, log: displayed bubbles, guided }
  let project = null;
  let wallet = null;
  let busy = false;
  let welcomeFor = null;
  let fetchToolOk = true;
  let isOpen = false;

  // ---------------------------------------------------------------- panel
  const root = document.createElement('aside');
  root.className = 'sprout';
  root.setAttribute('aria-label', `${AGENT_NAME} project guide`);
  root.innerHTML = `
    <button class="sprout-fab" type="button" aria-label="Open ${AGENT_NAME}"><span class="sprout-orb"></span><span>${AGENT_NAME}</span></button>
    <section class="sprout-panel" hidden>
      <header class="sprout-head">
        <span class="sprout-orb big"></span>
        <div><b>${AGENT_NAME}</b><small>Fedrok project guide · powered by Claude</small></div>
        <button class="sprout-icon" data-act="settings" type="button" title="Connection settings" aria-label="Connection settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
        <button class="sprout-icon" data-act="close" type="button" title="Close" aria-label="Close">×</button>
      </header>
      <div class="sprout-mode"></div>
      <div class="sprout-settings" hidden></div>
      <div class="sprout-log" aria-live="polite"></div>
      <form class="sprout-input">
        <textarea rows="2" placeholder="Tell ${AGENT_NAME} about your project…" aria-label="Message ${AGENT_NAME}"></textarea>
        <button class="btn sm" type="submit">Send</button>
      </form>
      <div class="sprout-foot"><a href="${FEDROK_SITE}" target="_blank" rel="noopener">fedrok.com ↗</a><span class="sprout-lockstate"></span></div>
    </section>`;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const panel = $('.sprout-panel');
  const log = $('.sprout-log');
  const input = $('.sprout-input textarea');

  $('.sprout-fab').addEventListener('click', () => open());
  $('[data-act=close]').addEventListener('click', () => close());
  $('[data-act=settings]').addEventListener('click', () => toggleSettings());
  $('.sprout-input').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('.sprout-input').requestSubmit();
    }
  });

  // ---------------------------------------------------------- connection
  function connection() {
    const st = status();
    if (st?.assistant?.proxy) return { mode: 'proxy', label: 'Connected to Claude through this Fedrok node' };
    if (store.get(KEY_STORE)) return { mode: 'key', label: 'Connected to Claude with your API key' };
    return { mode: 'guided', label: 'Guided mode: AI not connected' };
  }

  function client() {
    const c = connection();
    if (c.mode === 'proxy') return new Anthropic({ apiKey: 'proxied-by-fedrok-node', baseURL: `${location.origin}${status().assistant.proxy}`, dangerouslyAllowBrowser: true, maxRetries: 1 });
    return new Anthropic({ apiKey: store.get(KEY_STORE), dangerouslyAllowBrowser: true, maxRetries: 1 });
  }

  function toggleSettings(force) {
    const box = $('.sprout-settings');
    const show = force ?? box.hidden;
    box.hidden = !show;
    if (!show) return;
    const c = connection();
    const hasKey = Boolean(store.get(KEY_STORE));
    box.innerHTML = c.mode === 'proxy'
      ? `<p>${AGENT_NAME} reaches Claude through this Fedrok node, which holds the API key. Nothing to set up.</p>`
      : `<p><b>Connect ${AGENT_NAME} to Claude.</b> Paste an Anthropic API key (from <a href="https://platform.claude.com" target="_blank" rel="noopener">platform.claude.com</a>). It is stored only in this browser and sent only to api.anthropic.com. Use a key with a spending limit; anyone with access to this browser profile could read it.</p>
         <form class="sprout-keyform"><input type="password" name="key" placeholder="${hasKey ? '•••••••• saved' : 'sk-ant-…'}" autocomplete="off"><button class="btn sm" type="submit">Save key</button>${hasKey ? '<button class="btn ghost sm" type="button" data-act="forget">Forget key</button>' : ''}</form>
         <p class="small">Without a key, ${AGENT_NAME} runs a guided interview without AI. A site operator can instead start the node with <code>ANTHROPIC_API_KEY</code> so visitors need no key.</p>`;
    box.querySelector('.sprout-keyform')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const k = new FormData(e.target).get('key').trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(k)) return toast('That does not look like an Anthropic API key (sk-ant-…).', 'err');
      store.set(KEY_STORE, k);
      toast(`${AGENT_NAME} is now connected to Claude.`, 'ok');
      toggleSettings(false);
      refreshMode();
      const chat = chatFor();
      if (chat && chat.guided) {
        chat.guided = false;
        chat.messages = [];
        note(`${AGENT_NAME} is now using Claude. Tell me about your project, or ask me to continue the interview.`);
      }
    });
    box.querySelector('[data-act=forget]')?.addEventListener('click', () => {
      store.set(KEY_STORE, null);
      toggleSettings(false);
      refreshMode();
    });
  }

  function canEdit() {
    return Boolean(project && wallet && wallet.address === project.owner && project.status === 'draft');
  }

  function refreshMode() {
    const c = connection();
    $('.sprout-mode').innerHTML = `<span class="dot ${c.mode === 'guided' ? '' : 'live'}"></span>${esc(c.label)}${c.mode === 'guided' ? ' · <button type="button" class="linkish" data-act="connect">connect Claude</button>' : ''}`;
    $('.sprout-mode [data-act=connect]')?.addEventListener('click', () => toggleSettings(true));
    const ls = $('.sprout-lockstate');
    if (!project) return;
    if (project.status !== 'draft') {
      ls.innerHTML = `🔒 ${project.status === 'locked' ? 'Locked & submitted' : 'Retired'}: read-only`;
      input.placeholder = `Ask ${AGENT_NAME} about this project (it can no longer be changed)`;
    } else if (!canEdit()) {
      ls.textContent = wallet ? 'Read-only: you are not the owner' : 'Read-only: sign in as the owner to edit';
      input.placeholder = `Ask ${AGENT_NAME} about this project…`;
    } else {
      ls.textContent = `Editing enabled · ${completeness(project)}% complete`;
      input.placeholder = `Tell ${AGENT_NAME} about your project…`;
    }
  }

  // ---------------------------------------------------------- chat state
  function chatFor() {
    if (!project) return null;
    if (!chats.has(project.id)) chats.set(project.id, { messages: [], log: [], guided: connection().mode === 'guided', step: null });
    return chats.get(project.id);
  }

  function bubble(role, html, cls = '') {
    const chat = chatFor();
    const item = { role, html, cls };
    chat.log.push(item);
    log.insertAdjacentHTML('beforeend', `<div class="vb ${role} ${cls}">${html}</div>`);
    log.scrollTop = log.scrollHeight;
    return log.lastElementChild;
  }
  const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  const say = (t) => bubble('assistant', fmt(t));
  const note = (t) => bubble('note', esc(t));

  function redraw() {
    const chat = chatFor();
    log.innerHTML = chat ? chat.log.map((b) => `<div class="vb ${b.role} ${b.cls}">${b.html}</div>`).join('') : '';
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(v, text = `${AGENT_NAME} is thinking…`) {
    busy = v;
    $('.sprout-input button').disabled = v;
    log.querySelector('.vb.typing')?.remove();
    if (v) {
      log.insertAdjacentHTML('beforeend', `<div class="vb assistant typing"><span></span><span></span><span></span> ${esc(text)}</div>`);
      log.scrollTop = log.scrollHeight;
    }
  }

  // ---------------------------------------------------------- tools
  async function fresh() {
    project = await api.get('/api/project/' + project.id);
    return project;
  }

  function projectForModel(p) {
    return {
      id: p.id, status: p.status, kind: p.kind, projectType: p.projectType, owner: p.owner, revision: p.revision,
      name: p.name, summary: p.summary, location: p.location, country: p.country, details: p.details,
      emptyFields: missingFields(p), completeness: completeness(p) + '%',
      youCanEdit: canEdit(),
      ...(p.status === 'locked' ? { lockedAt: new Date(p.lockedAt).toISOString(), note: 'Locked & submitted: permanently read-only.' } : {}),
      ...(p.status === 'retired' ? { retiredReason: p.retireReason } : {}),
      page: `${location.href.split('#')[0]}#project-${p.id}`,
    };
  }

  /** Merge changes into the latest on-chain content and save them as one project_update transaction. */
  async function applyUpdate(changes) {
    const p = await fresh();
    // Checked here for a clear message; the ProjectRegistry contract enforces it regardless.
    if (p.status !== 'draft') throw new Error(`the project is ${p.status === 'locked' ? 'locked & submitted' : 'retired'} and can no longer be changed by anyone`);
    if (!wallet || wallet.address !== p.owner) throw new Error('only the project owner can change it, and the owner is not signed in');
    const details = { ...p.details };
    for (const [k, v] of Object.entries(changes.details || {})) {
      if (!DETAIL_FIELDS.find((f) => f.key === k)) continue;
      details[k] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : String(v).trim();
    }
    for (const k of changes.remove_fields || []) delete details[k];
    const next = {
      projectId: p.id,
      name: changes.name !== undefined ? String(changes.name).trim() : p.name,
      summary: changes.summary !== undefined ? String(changes.summary).trim() : p.summary,
      location: changes.location !== undefined ? String(changes.location).trim() : p.location,
      country: changes.country !== undefined ? String(changes.country).trim() : p.country,
      details,
    };
    const changed = ['name', 'summary', 'location', 'country'].filter((k) => next[k] !== p[k]);
    for (const k of new Set([...Object.keys(p.details), ...Object.keys(details)])) if (JSON.stringify(p.details[k]) !== JSON.stringify(details[k])) changed.push(k);
    if (!changed.length) return { saved: false, message: 'nothing changed' };
    const r = await sendTx('project_update', next);
    await fresh();
    render();
    return { saved: true, revision: project.revision, block: r.height, tx: r.tx.hash, changed };
  }

  async function runTool(block) {
    try {
      if (block.name === 'get_project') return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(projectForModel(await fresh())) };
      if (block.name === 'update_project') {
        if (!canEdit()) throw new Error('this project cannot be changed (it is locked, retired, or you are not the owner)');
        setBusy(true, 'Saving to the Fedrok ledger…');
        const r = await applyUpdate(block.input || {});
        if (r.saved) note(`Saved to the ledger: ${r.changed.map(label).join(', ')} (revision ${r.revision}, block #${r.block})`);
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r) };
      }
      throw new Error(`unknown tool ${block.name}`);
    } catch (e) {
      return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: e.message };
    }
  }

  // ---------------------------------------------------------- Claude loop
  async function claudeTurn(chat) {
    const c = client();
    for (let step = 0; step < MAX_STEPS; step++) {
      const req = {
        model: MODEL,
        max_tokens: 16000,
        system: systemPrompt(),
        tools: [...tools(canEdit()), ...(fetchToolOk ? [webFetch] : [])],
        output_config: { effort: 'medium' },
        messages: [...chat.messages, { role: 'system', content: `Current page: ${project.id} (${project.status}). The person ${canEdit() ? 'is the owner and can edit it' : 'cannot edit it'}.` }],
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      };
      let resp;
      try {
        resp = await c.beta.messages.create(req);
      } catch (e) {
        // Some accounts or proxies do not offer web fetch or mid-conversation system messages: retry without them once.
        if (e instanceof Anthropic.BadRequestError && (fetchToolOk || req.messages.at(-1).role === 'system')) {
          fetchToolOk = false;
          resp = await c.beta.messages.create({ ...req, tools: tools(canEdit()), messages: chat.messages });
        } else throw e;
      }
      chat.messages.push({ role: 'assistant', content: resp.content });
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      setBusy(false);
      if (text) say(text);
      if (resp.stop_reason === 'refusal') {
        note(`${AGENT_NAME} could not help with that request.`);
        return;
      }
      if (resp.stop_reason === 'pause_turn') {
        setBusy(true);
        continue;
      }
      if (resp.stop_reason !== 'tool_use') return;
      const uses = resp.content.filter((b) => b.type === 'tool_use');
      setBusy(true);
      const results = [];
      for (const u of uses) results.push(await runTool(u));
      chat.messages.push({ role: 'user', content: results });
      setBusy(true);
    }
    setBusy(false);
  }

  function apiError(e) {
    if (e instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Open the settings (gear icon) to fix it.';
    if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the model.';
    if (e instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now. Try again in a moment.';
    if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check the connection and try again.';
    if (e instanceof Anthropic.APIError) return `Claude API error ${e.status || ''}: ${e.message}`;
    return e.message || String(e);
  }

  // ---------------------------------------------------------- guided mode (no AI)
  const GUIDED_ORDER = ['summary', 'location', 'country', ...DETAIL_FIELDS.map((f) => f.key)];
  function nextGuided(p, after) {
    const missing = new Set(missingFields(p));
    const start = after ? GUIDED_ORDER.indexOf(after) + 1 : 0;
    return GUIDED_ORDER.slice(start).find((k) => missing.has(k)) || null;
  }
  function askGuided(chat, key) {
    chat.step = key;
    if (!key) {
      say(`That covers every field I ask about. Review the page, and when you're happy press **Lock & submit**. You can still change anything by telling me "change <field>: <new text>", or with "Edit by hand".`);
      return;
    }
    const f = ALL_FIELDS.find((x) => x.key === key);
    const hint = DETAIL_FIELDS.find((x) => x.key === key)?.hint || (key === 'summary' ? 'Two or three sentences: what the project does, for whom, and where.' : '');
    say(`**${f.label}.** ${hint}${DETAIL_FIELDS.find((x) => x.key === key)?.list ? ' Separate items with commas or new lines.' : ''}\n(Type "skip" to leave it for later.)`);
  }
  async function guidedTurn(chat, text) {
    if (!canEdit()) {
      say(project.status !== 'draft' ? `This project is ${project.status === 'locked' ? 'locked & submitted' : 'retired'}, so it can no longer be changed. Connect Claude (gear icon) if you want to ask questions about it.` : 'Only the project owner can change this project. Sign in as the owner first.');
      return;
    }
    const m = text.match(/^change\s+([\w ]+?)\s*:\s*([\s\S]+)$/i);
    let key = chat.step, value = text;
    if (m) {
      const want = m[1].trim().toLowerCase();
      const f = ALL_FIELDS.find((x) => x.key.toLowerCase() === want || x.label.toLowerCase() === want || x.label.toLowerCase().startsWith(want));
      if (!f) return say(`I don't know the field "${m[1]}". Fields: ${ALL_FIELDS.map((x) => x.label).join(', ')}.`);
      key = f.key;
      value = m[2];
    }
    if (!key) return askGuided(chat, nextGuided(project));
    if (!m && /^skip$/i.test(text)) return askGuided(chat, nextGuided(project, key));
    const f = DETAIL_FIELDS.find((x) => x.key === key);
    const changes = f ? { details: { [key]: f.list ? value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) : value.trim() } } : { [key]: value.trim() };
    setBusy(true, 'Saving to the Fedrok ledger…');
    try {
      const r = await applyUpdate(changes);
      setBusy(false);
      if (r.saved) note(`Saved to the ledger: ${label(key)} (revision ${r.revision}, block #${r.block})`);
      askGuided(chat, m ? chat.step && missingFields(project).includes(chat.step) ? chat.step : nextGuided(project) : nextGuided(project, key));
    } catch (e) {
      setBusy(false);
      say(`I couldn't save that: ${e.message}`);
    }
  }

  // ---------------------------------------------------------- turns
  async function send(text, { silent = false } = {}) {
    const chat = chatFor();
    if (!chat) return;
    if (!silent) bubble('user', esc(text));
    setBusy(true);
    try {
      if (chat.guided || connection().mode === 'guided') {
        chat.guided = true;
        setBusy(false);
        await guidedTurn(chat, text);
      } else {
        chat.messages.push({ role: 'user', content: text });
        await claudeTurn(chat);
      }
    } catch (e) {
      setBusy(false);
      // Drop the unanswered turn so the conversation stays valid for the next try.
      while (chat.messages.length && chat.messages.at(-1).role === 'user') chat.messages.pop();
      note(apiError(e));
    } finally {
      setBusy(false);
      refreshMode();
    }
  }

  function kickoff() {
    const chat = chatFor();
    if (chat.started) return;
    chat.started = true;
    const owner = canEdit();
    if (chat.guided) {
      say(owner
        ? `Hi, I'm ${AGENT_NAME}, your Fedrok project guide. Your project **${project.name}** is now on the Fedrok ledger as a draft. I'll ask you a few questions and write each answer to the project page.\n\n(I'm in guided mode because no AI is connected. Use the gear icon to connect Claude for a real conversation.)`
        : `Hi, I'm ${AGENT_NAME}. This project is ${project.status === 'draft' ? 'a draft owned by someone else' : project.status === 'locked' ? 'locked & submitted' : 'retired'}, so it is read-only for you.`);
      if (owner) askGuided(chat, nextGuided(project));
      return;
    }
    send(owner
      ? `I have just created this project (${project.id}). Please greet me briefly, then interview me so we can fill in the project page.`
      : `Briefly introduce yourself and this project, and say what you can help with here.`, { silent: true });
  }

  // ---------------------------------------------------------- public API
  function open() {
    if (!project) return;
    isOpen = true;
    panel.hidden = false;
    root.classList.add('open');
    document.body.classList.add('sprout-docked');
    refreshMode();
    redraw();
    const chat = chatFor();
    if (!chat.log.length && !chat.messages.length) {
      if (chat.guided || canEdit()) kickoff();
      else say(`Hi, I'm ${AGENT_NAME}, Fedrok's project guide. Ask me anything about **${project.name}**. ${project.status === 'draft' ? 'Only its owner can change it.' : 'It is ' + (project.status === 'locked' ? 'locked & submitted' : 'retired') + ', so nobody can change it any more, me included.'}`);
    }
    input.focus();
  }
  function close() {
    isOpen = false;
    panel.hidden = true;
    root.classList.remove('open');
    document.body.classList.remove('sprout-docked');
  }

  return {
    open,
    close,
    /** Called after a project is created: its page opens with Sprout starting the interview. */
    welcome(id) {
      welcomeFor = id;
    },
    attach(p, w) {
      const switched = !project || project.id !== p.id;
      project = p;
      wallet = w;
      root.classList.add('on');
      if (switched) redraw();
      refreshMode();
      if (welcomeFor === p.id) {
        welcomeFor = null;
        open();
      } else if (switched && isOpen) open();
    },
    detach() {
      project = null;
      root.classList.remove('on');
      close();
    },
    notify(text) {
      if (!project) return;
      note(text);
      const chat = chatFor();
      if (chat && !chat.guided && chat.messages.length) chat.messages.push({ role: 'user', content: `[Page notice, not from the owner] ${text}` });
    },
  };
}
