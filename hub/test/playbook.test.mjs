import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frontMatter, kitSummary, buildPlaybook, render } from '../scripts/playbook.mjs';

test('front matter is read line by line, quotes removed', () => {
  assert.deepEqual(frontMatter('---\nname: wrapup\ndescription: "Run before /clear."\nargument-hint: <client>\n---\nBody'),
    { name: 'wrapup', description: 'Run before /clear.', 'argument-hint': '<client>' });
  assert.deepEqual(frontMatter('No front matter'), {});
});

test('a kit summary is its title and first paragraph, as plain text', () => {
  const k = kitSummary('# Showcase kit\n\nSend a **PDF** from [one page](https://x.example), in `5` minutes.\nSecond line.\n\n## Make a PDF\nmore');
  assert.equal(k.title, 'Showcase kit');
  assert.equal(k.summary, 'Send a PDF from one page, in 5 minutes. Second line.');
});

test('the playbook takes only names and one-liners, skips hidden commands and kits without a README', () => {
  const root = mkdtempSync(join(tmpdir(), 'playbook-'));
  const skills = join(root, 'skills'), kits = join(root, 'kits');
  for (const [name, fm] of [['b-cmd', 'name: b-cmd\ndescription: Second.'], ['a-cmd', 'name: a-cmd\nargument-hint: <client>\ndescription: First.'], ['hidden', 'name: hidden\ndescription: Internal.\nuser-invocable: false']]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, 'SKILL.md'), `---\n${fm}\n---\nSECRET STEPS`);
  }
  mkdirSync(join(skills, 'synced'), { recursive: true });
  mkdirSync(join(kits, 'showcase'), { recursive: true });
  mkdirSync(join(kits, 'video'), { recursive: true });
  writeFileSync(join(kits, 'showcase', 'README.md'), '# Showcase kit\n\nOne page.');
  writeFileSync(join(kits, 'requirements.md'), '# Requirements\n\nThe rule.');
  const p = buildPlaybook({ skillsDir: skills, kitsDir: kits });
  assert.deepEqual(p.commands, [{ name: 'a-cmd', args: '<client>', description: 'First.' }, { name: 'b-cmd', args: '', description: 'Second.' }]);
  assert.deepEqual(p.kits.map(k => k.path), ['kits/requirements.md', 'kits/showcase/']);
  assert.ok(!render(p).includes('SECRET STEPS'));
});
