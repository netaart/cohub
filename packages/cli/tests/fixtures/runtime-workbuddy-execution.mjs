import { createInterface } from 'node:readline';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
const option = (key) => argv[argv.indexOf(key) + 1];
const sessionId = argv.includes('--resume') ? option('--resume') : option('--session-id');
const project = process.cwd().replace(/[/\\:]/g, '-').replace(/^-+/, '').replace(/-+$/, '').replace(/-+/g, '-');
const path = join(process.env.CODEBUDDY_CONFIG_DIR, 'projects', project, `${sessionId}.jsonl`);
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const event = JSON.parse(line);
  if (event.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { models: [{ id: 'fixture-model', name: 'Fixture' }], currentModelId: 'fixture-model' } } });
  } else if (event.type === 'user') {
    const text = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    let parentId = null;
    if (argv.includes('--resume')) {
      const history = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
      parentId = history.at(-1)?.id ?? null;
    }
    await mkdir(dirname(path), { recursive: true });
    const user = { type: 'message', role: 'user', id: randomUUID(), parentId, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), content: event.message.content.map((block) => ({ type: 'input_text', text: block.text })) };
    await appendFile(path, `${JSON.stringify(user)}\n`);
    send({ type: 'user', uuid: user.id, session_id: sessionId, message: event.message, isReplay: true });
    if (text === 'wait') { send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } } }); continue; }
    if (text === 'fail') { send({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true, errors: ['Fixture execution failed'] }); continue; }
    const answer = `echo:${text}`;
    const assistant = { type: 'message', role: 'assistant', id: randomUUID(), parentId: user.id, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), content: [{ type: 'output_text', text: answer }], status: 'completed' };
    await appendFile(path, `${JSON.stringify(assistant)}\n`);
    send({ type: 'assistant', message: { id: assistant.id, model: 'fixture-model', content: [{ type: 'text', text: answer }] } });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: answer });
  }
}
