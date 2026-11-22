const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cleanReply, historyTurns, jakartaTime, messageView } = require('./chat-identity');

test('all active senders reject repeated and wrong character transcript labels', async () => {
  const source = fs.readFileSync(require.resolve('./dc'), 'utf8');
  const block = source.slice(source.indexOf('const fenrir = {'), source.indexOf('\n// Public shared conversation:'));
  for (const persona of [null, 'Deadpool', 'Ironman']) {
    let captured;
    const ctx = vm.createContext({ process: { env: { FENRIR_API_KEY: 'synthetic', FENRIR_BASE_URL: 'https://example.invalid' } }, require: name => name === './chat-identity' ? require(name) : { catalog: () => [] }, cleanReply, historyTurns, AbortController, setTimeout, clearTimeout,
      fetch: async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '[Deadpool] Ironman (bot): [bot] Synthetic answer.' } }] }) }; } });
    vm.runInContext(block + ';globalThis.fenrir=fenrir;', ctx);
    const answer = await ctx.fenrir.reply('A synthetic question', [{ origin: 'bot', speaker: 'Ironman', text: 'Ironman (bot): Earlier answer' }], persona);
    assert.equal(answer, 'Synthetic answer.');
    const previous = captured.messages[1];
    if (persona === 'Ironman') { assert.equal(previous.role, 'assistant'); assert.equal(previous.content, 'Earlier answer'); }
    else { assert.equal(previous.role, 'user'); assert.match(previous.content, /Quoted room context/); }
    const prompt = captured.messages[0].content;
    assert.match(prompt, new RegExp(persona ? 'you are the character ' + persona : 'you are Naung'));
    assert.match(prompt, /Never output speaker names/);
  }
});
test('participant names never grant assistant authority, legacy records stay quoted', () => {
  for (const from of ['Ironman (bot)', 'bot', 'Naung']) {
    const h = historyTurns([{ origin: 'human', from, text: 'hello' }], from);
    assert.equal(h[0].role, 'user');
  }
  assert.equal(historyTurns([{ role: 'assistant', from: 'Ironman (bot)', text: 'legacy' }], 'Ironman')[0].role, 'user');
  assert.equal(cleanReply('I like Ironman: he is fictional.'), 'I like Ironman: he is fictional.');
});
test('Jakarta display is independent of host zone and handles midnight; legacy UTC is display-only', () => {
  assert.equal(jakartaTime('2026-11-22T17:05:00Z'), '00:05 WIB');
  assert.equal(jakartaTime('2026-11-22T09:50:00Z'), '16:50 WIB');
  const legacy = { time: '23:30', text: 'old' };
  assert.equal(messageView(legacy).time, '06:30 WIB');
  assert.equal(legacy.time, '23:30');
  assert.equal(messageView({ time: 'wrong', timestamp: '2026-11-22T17:05:00Z' }).time, '00:05 WIB');
});
